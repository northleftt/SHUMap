import type { SessionPrincipal } from "../domain/types";
import type { Env } from "../types/cloudflare";
import { all, assertExists, first } from "../lib/db";
import { HttpError, json, readBodyLimited, readJson } from "../lib/http";
import { booleanValue, exactObject, isoNow, makeId, numberValue, optionalString, partialObject, requiredString, sha256 } from "../lib/values";
import { audit } from "./audit";
import { publicMediaPath } from "./media";

// ---------------------------------------------------------------------------
// 楼层管理：一层楼就是 floors 表里的一行 + 可选的一张平面图图片。
//
// 楼内平面图是「每层一张 PNG/JPEG/WebP」（0032 起），不再有 SVG 导入、图纸版本、
// 图上锚点那一套。楼层本身的骨架（编号、排序、显示名、是否公开）在这里增改；
// 设施 / 商户在各自编辑器里选楼层（facility_instances.floor_id 等），本模块把
// 这些引用**反查**出来，所以楼层页看到的永远是内容侧的现状。
//
// 因此「删除楼层」必须先解除这些引用，否则会留下悬空的设施。
// ---------------------------------------------------------------------------

interface FloorRow {
  id: string;
  buildingPlaceId: string;
  levelCode: string;
  levelOrder: number;
  displayName: string;
  isPublic: number;
  lifecycleStatus: string;
  imageMediaId: string | null;
}

const FLOOR_SELECT = `id,building_place_id as buildingPlaceId,level_code as levelCode,level_order as levelOrder,
       display_name as displayName,is_public as isPublic,lifecycle_status as lifecycleStatus,image_media_id as imageMediaId`;

function floorJson(floor: FloorRow) {
  return {
    ...floor,
    isPublic: floor.isPublic === 1,
    imageUrl: floor.imageMediaId ? publicMediaPath(floor.imageMediaId) : null,
  };
}

/** 一层楼的引用计数：非零就不允许删除，前端据此说明「为什么删不掉」。 */
export interface FloorUsage {
  facilities: number;
  merchants: number;
  mapVersions: number;
  anchors: number;
}

async function floorUsage(env: Env, floorId: string): Promise<FloorUsage> {
  const [facilities, merchants, mapVersions, anchors] = await Promise.all([
    first<{ count: number }>(env.DB, "select count(*) as count from facility_instances where floor_id=?", [floorId]),
    first<{ count: number }>(env.DB, "select count(*) as count from merchant_outlets where floor_id=?", [floorId]),
    first<{ count: number }>(env.DB, "select count(*) as count from map_versions where floor_id=?", [floorId]),
    first<{ count: number }>(env.DB, "select count(*) as count from location_anchors where floor_id=?", [floorId]),
  ]);
  return {
    facilities: facilities?.count ?? 0,
    merchants: merchants?.count ?? 0,
    mapVersions: mapVersions?.count ?? 0,
    anchors: anchors?.count ?? 0,
  };
}

/**
 * GET /api/admin/floors?buildingPlaceId=... — 一栋楼的楼层总览。
 *
 * 每层带上平面图图片地址与引用计数，管理端因此能一屏回答：这层有图吗、
 * 这层挂了几个设施几个商户、能不能删。
 */
export async function listFloorsForBuilding(request: Request, env: Env): Promise<Response> {
  const buildingPlaceId = new URL(request.url).searchParams.get("buildingPlaceId");
  if (!buildingPlaceId) {
    throw new HttpError(400, "validation_error", "buildingPlaceId is required");
  }
  const building = await first<{ placeId: string; displayName: string | null; campusId: string | null }>(
    env.DB,
    `select b.place_id as placeId,r.display_name as displayName,p.campus_id as campusId
       from buildings b join places p on p.id=b.place_id
       left join place_revisions r on r.id=p.current_revision_id
      where b.place_id=?`,
    [buildingPlaceId],
  );
  if (!building) throw new HttpError(404, "not_found", "Building does not exist");

  const floors = await all<FloorRow>(env.DB, `select ${FLOOR_SELECT} from floors where building_place_id=? order by level_order desc`, [buildingPlaceId]);
  const items = await Promise.all(floors.map(async (floor) => ({
    ...floorJson(floor),
    usage: await floorUsage(env, floor.id),
  })));
  return json({ building, items });
}

/**
 * GET /api/admin/floors/:id — 单层详情：图片 + 该层的设施 / 商户 / 锚点。
 *
 * 设施与商户是**反查**出来的（按 floor_id），所以这里显示的就是内容侧的当前状态；
 * 在设施编辑器里改了楼层归属，这里刷新即变，无需任何同步动作。
 */
export async function getFloorDetail(env: Env, floorId: string): Promise<Response> {
  const floor = await first<FloorRow & { buildingName: string | null }>(
    env.DB,
    `select f.id,f.building_place_id as buildingPlaceId,f.level_code as levelCode,f.level_order as levelOrder,
            f.display_name as displayName,f.is_public as isPublic,f.lifecycle_status as lifecycleStatus,
            f.image_media_id as imageMediaId,r.display_name as buildingName
       from floors f
       join places p on p.id=f.building_place_id
       left join place_revisions r on r.id=p.current_revision_id
      where f.id=?`,
    [floorId],
  );
  if (!floor) throw new HttpError(404, "not_found", "Floor does not exist");

  const [facilities, merchants, anchors, usage] = await Promise.all([
    // 设施名取「待审修订优先，否则当前修订」，与 listFacilities 的口径一致，
    // 这样楼层页看到的名字和内容管理列表里是同一个。
    all(
      env.DB,
      `select f.id,f.facility_type_id as facilityTypeId,t.name as facilityTypeName,f.lifecycle_status as lifecycleStatus,
              f.operational_status as operationalStatus,
              coalesce(r.display_name,t.name) as displayName,r.editorial_status as editorialStatus,
              (select count(*) from entity_locations el
                 join location_anchors la on la.id=el.anchor_id
                where el.entity_type='facility' and el.entity_id=f.id and el.valid_to is null
                  and la.role='service_position' and la.geometry_json is not null) as positionedCount
         from facility_instances f join facility_types t on t.id=f.facility_type_id
         left join facility_revisions r on r.id=coalesce(
           (select pending.id from facility_revisions pending
             where pending.facility_id=f.id and pending.editorial_status in ('draft','in_review')
             order by case pending.editorial_status when 'in_review' then 0 else 1 end,pending.revision_no desc limit 1),
           f.current_revision_id
         )
        where f.floor_id=? order by coalesce(r.display_name,t.name)`,
      [floorId],
    ),
    all(
      env.DB,
      `select m.id,m.lifecycle_status as lifecycleStatus,
              r.display_name as displayName,r.business_type as businessType,r.editorial_status as editorialStatus
         from merchant_outlets m
         left join merchant_revisions r on r.id=coalesce(
           (select pending.id from merchant_revisions pending
             where pending.outlet_id=m.id and pending.editorial_status in ('draft','in_review')
             order by case pending.editorial_status when 'in_review' then 0 else 1 end,pending.revision_no desc limit 1),
           m.current_revision_id
         )
        where m.floor_id=? order by coalesce(r.display_name,m.id)`,
      [floorId],
    ),
    all(
      env.DB,
      `select la.id,la.role,la.geometry_type as geometryType,la.precision_level as precisionLevel,
              la.map_version_id as mapVersionId,la.location_hint as locationHint,
              el.entity_type as entityType,el.entity_id as entityId
         from location_anchors la
         left join entity_locations el on el.anchor_id=la.id and el.valid_to is null
        where la.floor_id=? order by la.role,la.id`,
      [floorId],
    ),
    floorUsage(env, floorId),
  ]);

  return json({ floor: { ...floorJson(floor), buildingName: floor.buildingName }, facilities, merchants, anchors, usage });
}

/**
 * POST /api/admin/floors — 新建楼层。
 *
 * levelCode 是这一层在楼内的唯一标签（如 F3、B1），只做去空白与非空校验；
 * levelOrder 由调用方给出（地上为正、地下为负的排序值），显示名留空时按编号顶上。
 * 同层重复由 unique(building_place_id, level_code) 兜底，这里先查一次以便回
 * 可读的 409 而不是外键错误。
 */
export async function createFloor(request: Request, env: Env, principal: SessionPrincipal, requestId: string): Promise<Response> {
  const body = exactObject(await readJson<unknown>(request), "floor", [
    "buildingPlaceId",
    "levelCode",
    "levelOrder",
    "displayName",
    "isPublic",
  ]);
  const buildingPlaceId = requiredString(body.buildingPlaceId, "buildingPlaceId", 100);
  await assertExists(env.DB, "buildings", buildingPlaceId, "Building");
  const levelCode = requiredString(body.levelCode, "levelCode", 50).trim();
  const levelOrder = numberValue(body.levelOrder, "levelOrder");
  const isPublic = booleanValue(body.isPublic, "isPublic");
  const existing = await first<{ id: string }>(
    env.DB,
    "select id from floors where building_place_id=? and level_code=?",
    [buildingPlaceId, levelCode],
  );
  if (existing) {
    throw new HttpError(409, "floor_exists", `这栋楼已经有 ${levelCode} 层了`);
  }
  const displayName = optionalString(body.displayName, "displayName", 100)?.trim() || levelCode;
  const id = makeId("floor");
  const now = isoNow();
  await env.DB.prepare(
    `insert into floors(id,building_place_id,level_code,level_order,display_name,is_public,lifecycle_status,created_at,updated_at)
     values(?,?,?,?,?,?,'active',?,?)`,
  ).bind(
    id,
    buildingPlaceId,
    levelCode,
    levelOrder,
    displayName,
    isPublic ? 1 : 0,
    now,
    now,
  ).run();
  await audit(env, principal, "floor.create", "floor", id, requestId, null, { ...body, levelCode, levelOrder, displayName });
  return json({ id, levelCode, levelOrder, displayName }, { status: 201 });
}

/**
 * PATCH /api/admin/floors/:id — 楼层显示名 / 排序 / 是否对外可见。
 *
 * 楼层不进修订流（floors 没有修订表），改动即时生效并记审计。level_code 是
 * 楼层在同一楼内的唯一键，且已被设施/锚点按 id 引用，这里不允许改。
 */
export async function updateFloor(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  floorId: string,
  requestId: string,
): Promise<Response> {
  const before = await first<Record<string, unknown>>(
    env.DB,
    "select id,building_place_id,level_code,level_order,display_name,is_public from floors where id=?",
    [floorId],
  );
  if (!before) throw new HttpError(404, "not_found", "Floor does not exist");
  const body = partialObject(await readJson<unknown>(request), "floorUpdate", ["displayName", "levelOrder", "isPublic"]);
  const displayName = !Object.hasOwn(body, "displayName")
    ? String(before.display_name)
    : requiredString(body.displayName, "displayName", 100);
  const levelOrder = !Object.hasOwn(body, "levelOrder")
    ? Number(before.level_order)
    : numberValue(body.levelOrder, "levelOrder");
  const isPublic = !Object.hasOwn(body, "isPublic")
    ? Number(before.is_public)
    : booleanValue(body.isPublic, "isPublic") ? 1 : 0;
  const now = isoNow();
  await env.DB.prepare("update floors set display_name=?,level_order=?,is_public=?,updated_at=? where id=?")
    .bind(displayName, levelOrder, isPublic, now, floorId).run();
  await audit(env, principal, "floor.update", "floor", floorId, requestId, before, { displayName, levelOrder, isPublic });
  return json({ id: floorId, displayName, levelOrder, isPublic });
}

/** 平面图图片只接受位图；svg 会带脚本，永不放行。与管理端直传同口径。 */
const FLOOR_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_FLOOR_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * PUT /api/admin/floors/:id/image — 上传 / 替换这一层的平面图图片（raw body）。
 *
 * 复用管理端图片直传的防线（声明类型白名单 + 魔术字节校验 + 8 MiB 上限，
 * 见 media.ts 的 createAdminMediaUpload），落盘 `public/media/`、行记
 * bucket_scope='public' / status='published'，因此 GET /api/public/media/:id
 * 立刻可读，下一次发版随 manifest.floors[].imageUrl 下发。
 *
 * 重复 PUT 即替换：floors.image_media_id 指向新图。旧图的对象与行原地保留
 * （media_assets 其它引用方也可能指着它），不做级联清理。
 */
export async function uploadFloorImage(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  floorId: string,
  requestId: string,
): Promise<Response> {
  const floor = await first<{ id: string; imageMediaId: string | null }>(
    env.DB,
    "select id,image_media_id as imageMediaId from floors where id=?",
    [floorId],
  );
  if (!floor) throw new HttpError(404, "not_found", "Floor does not exist");

  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!FLOOR_IMAGE_TYPES.has(contentType)) {
    throw new HttpError(415, "unsupported_media_type", "Only image/jpeg, image/png and image/webp are accepted");
  }
  const bytes = await readBodyLimited(request, MAX_FLOOR_IMAGE_BYTES);
  if (bytes.byteLength === 0) throw new HttpError(400, "validation_error", "Image body is empty");
  if (bytes.byteLength > MAX_FLOOR_IMAGE_BYTES) {
    throw new HttpError(413, "payload_too_large", "Each floor plan image must be at most 8 MiB");
  }
  if (sniffImageType(bytes) !== contentType) {
    throw new HttpError(415, "unsupported_media_type", "Image bytes do not match the declared image type");
  }

  const mediaId = makeId("media");
  const objectKey = `public/media/${mediaId}.${contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg"}`;
  const digest = await sha256(bytes);
  const now = isoNow();
  await env.SHUMAP_BUCKET.put(objectKey, bytes, {
    httpMetadata: { contentType, cacheControl: "public, max-age=31536000, immutable" },
    customMetadata: { scope: "public", uploadedBy: principal.userId },
  });
  await env.DB.prepare(
    `insert into media_assets(id,bucket_scope,object_key,original_name,content_type,byte_size,sha256,status,uploaded_by,created_at,approved_at)
     values(?,'public',?,null,?,?,?,'published',?,?,?)`,
  ).bind(mediaId, objectKey, contentType, bytes.byteLength, digest, principal.userId, now, now).run();
  await env.DB.prepare("update floors set image_media_id=?,updated_at=? where id=?").bind(mediaId, now, floorId).run();
  await audit(env, principal, "floor.image", "floor", floorId, requestId, { imageMediaId: floor.imageMediaId }, { imageMediaId: mediaId });
  return json({ id: floorId, imageMediaId: mediaId, imageUrl: publicMediaPath(mediaId) });
}

/** 只认 JPEG/PNG/WebP 的文件头，避免声明 image/* 却上传别的东西。 */
function sniffImageType(bytes: ArrayBuffer): string | null {
  const view = new Uint8Array(bytes);
  if (view.length >= 3 && view[0] === 0xff && view[1] === 0xd8 && view[2] === 0xff) return "image/jpeg";
  if (
    view.length >= 8 && view[0] === 0x89 && view[1] === 0x50 && view[2] === 0x4e && view[3] === 0x47
    && view[4] === 0x0d && view[5] === 0x0a && view[6] === 0x1a && view[7] === 0x0a
  ) return "image/png";
  if (
    view.length >= 12 && view[0] === 0x52 && view[1] === 0x49 && view[2] === 0x46 && view[3] === 0x46
    && view[8] === 0x57 && view[9] === 0x45 && view[10] === 0x42 && view[11] === 0x50
  ) return "image/webp";
  return null;
}

/**
 * DELETE /api/admin/floors/:id — 只在这层完全空了之后才允许。
 *
 * 楼层被四种东西引用（设施、商户、历史图纸版本、位置锚点），schema 里是
 * `on delete restrict`，硬删会直接撞外键报 500。所以这里先数一遍，非零
 * 就回 409 并带上明细，让管理端能说清「先把 3 个设施移走」而不是丢一个数据库错误。
 *
 * 想「下架」而不是删除的，应该把 is_public 改成 false（PATCH /api/admin/floors/:id），
 * 楼层与其内容都留着，只是不对外显示。
 */
export async function deleteFloor(
  env: Env,
  principal: SessionPrincipal,
  floorId: string,
  requestId: string,
): Promise<Response> {
  const floor = await first<FloorRow>(env.DB, `select ${FLOOR_SELECT} from floors where id=?`, [floorId]);
  if (!floor) throw new HttpError(404, "not_found", "Floor does not exist");
  const usage = await floorUsage(env, floorId);
  const total = usage.facilities + usage.merchants + usage.mapVersions + usage.anchors;
  if (total > 0) {
    throw new HttpError(
      409,
      "floor_in_use",
      "This floor still has content attached; move or remove it first",
      usage,
    );
  }
  await env.DB.prepare("delete from floors where id=?").bind(floorId).run();
  await audit(env, principal, "floor.delete", "floor", floorId, requestId, floor, null);
  return json({ id: floorId, deleted: true });
}
