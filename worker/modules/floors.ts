import type { SessionPrincipal } from "../domain/types";
import type { Env } from "../types/cloudflare";
import { all, first } from "../lib/db";
import { HttpError, json, readJson } from "../lib/http";
import { exactObject, isoNow, oneOf } from "../lib/values";
import { audit } from "./audit";

// ---------------------------------------------------------------------------
// 楼层详情与楼层图管理。
//
// 楼层本身的增改在 spaces.ts（createFloor / updateFloor）——那里只管 floors 表的
// 几个标量列。这里管的是「一层楼上都挂了什么」：平面图版本、设施、商户、锚点。
//
// 双向同步靠的是同一个 floor_id 外键，而不是复制数据：
//   · 设施 / 商户在各自编辑器里选楼层（facility_instances.floor_id / merchant_outlets.floor_id）
//   · 本模块把这些引用**反查**出来，所以楼层页看到的永远是设施侧的现状，不会过期
//   · 楼层图（map_versions.floor_id）一旦就绪，设施编辑器的服务位置面板立刻能在图上点选
//     （FacilityEditorPage 按 floorId + svg_viewbox + ready/published 找图）
//
// 因此「删除楼层」必须先解除这些引用，否则会留下悬空的设施与看不到的图纸。
// ---------------------------------------------------------------------------

interface FloorRow {
  id: string;
  buildingPlaceId: string;
  levelCode: string;
  levelOrder: number;
  displayName: string;
  isPublic: number;
  lifecycleStatus: string;
}

// ---------------------------------------------------------------------------
// 楼层编号的规范形式：F<n> / B<n>，n 不带前导零。
//
// 这不是洁癖：0016 迁移专门修过一行 level_code='一层' 的数据，成因就是
// POST /api/admin/floors 当时把 levelCode 当自由文本收下（requiredString，无格式
// 校验），而 reviews.ts 的 formatFloorDisplayName / floorOrderOf 只认 F<n>/B<n>，
// 于是手工建的楼层和审核流建的楼层格式不一致，前者在用户端显示成半成品。
//
// 0016 结尾的契约断言正是 `level_code glob 'F[0-9]*' or 'B[0-9]*'` 且
// `level_code = 首字母 || cast(其余 as integer)`。这里在写入口把它挡住，
// 免得同一个坑再挖一遍。
// ---------------------------------------------------------------------------

/**
 * "3" / "f3" / "F03" / "3F" → "F3"；"b1" / "B01" / "1B" → "B1"。不合法则 400。
 *
 * 前后缀都收：中文语境里「3F」「B1」两种写法都常见，全都规范化到 F<n>/B<n> 这一种
 * 存储形式，比让用户去猜后台要哪种更省事。
 */
export function canonicalLevelCode(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new HttpError(400, "validation_error", "levelCode must be a string");
  }
  const code = raw.trim().toUpperCase();
  const above = code.match(/^(?:F(\d{1,3})|(\d{1,3})F?)$/);
  if (above) return `F${Number(above[1] ?? above[2])}`;
  const below = code.match(/^(?:B(\d{1,2})|(\d{1,2})B)$/);
  if (below) return `B${Number(below[1] ?? below[2])}`;
  throw new HttpError(
    400,
    "validation_error",
    `楼层编号只支持 F<数字> 或 B<数字>（如 F3、3F、B1），收到 ${raw}`,
  );
}

/** 规范编号的排序值：地上为正、地下为负。与 reviews.ts 的 floorOrderOf 同口径。 */
export function levelOrderOf(levelCode: string): number {
  const above = levelCode.match(/^F(\d{1,3})$/);
  if (above) return Number(above[1]);
  const below = levelCode.match(/^B(\d{1,2})$/);
  if (below) return -Number(below[1]);
  throw new HttpError(400, "validation_error", `Unsupported floor level code: ${levelCode}`);
}

/** 规范编号的中文显示名。与 reviews.ts 的 formatFloorDisplayName 同口径。 */
export function levelDisplayName(levelCode: string): string {
  const above = levelCode.match(/^F(\d{1,3})$/);
  if (above) return `${Number(above[1])} 层`;
  const below = levelCode.match(/^B(\d{1,2})$/);
  if (below) return `地下 ${Number(below[1])} 层`;
  throw new HttpError(400, "validation_error", `Unsupported floor level code: ${levelCode}`);
}

/** 一层楼的引用计数：非零就不允许删除，前端据此说明「为什么删不掉」。 */
export interface FloorUsage {
  facilities: number;
  merchants: number;
  spaces: number;
  mapVersions: number;
  anchors: number;
}

async function floorUsage(env: Env, floorId: string): Promise<FloorUsage> {
  const [facilities, merchants, spaces, mapVersions, anchors] = await Promise.all([
    first<{ count: number }>(env.DB, "select count(*) as count from facility_instances where floor_id=?", [floorId]),
    first<{ count: number }>(env.DB, "select count(*) as count from merchant_outlets where floor_id=?", [floorId]),
    first<{ count: number }>(env.DB, "select count(*) as count from indoor_spaces where floor_id=?", [floorId]),
    first<{ count: number }>(env.DB, "select count(*) as count from map_versions where floor_id=?", [floorId]),
    first<{ count: number }>(env.DB, "select count(*) as count from location_anchors where floor_id=?", [floorId]),
  ]);
  return {
    facilities: facilities?.count ?? 0,
    merchants: merchants?.count ?? 0,
    spaces: spaces?.count ?? 0,
    mapVersions: mapVersions?.count ?? 0,
    anchors: anchors?.count ?? 0,
  };
}

/**
 * GET /api/admin/floors?buildingPlaceId=... — 一栋楼的楼层总览。
 *
 * 每层带上平面图版本与引用计数，管理端因此能一屏回答：这层有图吗、图是就绪还是
 * 已发布、这层挂了几个设施几个商户、能不能删。
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

  const floors = await all<FloorRow>(
    env.DB,
    `select id,building_place_id as buildingPlaceId,level_code as levelCode,level_order as levelOrder,
            display_name as displayName,is_public as isPublic,lifecycle_status as lifecycleStatus
       from floors where building_place_id=? order by level_order desc`,
    [buildingPlaceId],
  );
  const items = await Promise.all(floors.map(async (floor) => ({
    ...floor,
    isPublic: floor.isPublic === 1,
    plans: await all(
      env.DB,
      `select mv.id,mv.version_label as versionLabel,mv.lifecycle_status as lifecycleStatus,
              mv.coordinate_space_type as coordinateSpaceType,mv.created_at as createdAt,
              (select count(*) from map_features mf where mf.map_version_id=mv.id) as featureCount
         from map_versions mv where mv.floor_id=? order by mv.created_at desc`,
      [floor.id],
    ),
    usage: await floorUsage(env, floor.id),
  })));
  return json({ building, items });
}

/**
 * GET /api/admin/floors/:id — 单层详情：图纸 + 该层的设施 / 商户 / 锚点。
 *
 * 设施与商户是**反查**出来的（按 floor_id），所以这里显示的就是内容侧的当前状态；
 * 在设施编辑器里改了楼层归属，这里刷新即变，无需任何同步动作。
 */
export async function getFloorDetail(env: Env, floorId: string): Promise<Response> {
  const floor = await first<FloorRow & { buildingName: string | null }>(
    env.DB,
    `select f.id,f.building_place_id as buildingPlaceId,f.level_code as levelCode,f.level_order as levelOrder,
            f.display_name as displayName,f.is_public as isPublic,f.lifecycle_status as lifecycleStatus,
            r.display_name as buildingName
       from floors f
       join places p on p.id=f.building_place_id
       left join place_revisions r on r.id=p.current_revision_id
      where f.id=?`,
    [floorId],
  );
  if (!floor) throw new HttpError(404, "not_found", "Floor does not exist");

  const [plans, facilities, merchants, spaces, anchors, usage] = await Promise.all([
    all(
      env.DB,
      `select mv.id,mv.version_label as versionLabel,mv.lifecycle_status as lifecycleStatus,
              mv.coordinate_space_type as coordinateSpaceType,mv.created_at as createdAt,
              (select count(*) from map_features mf where mf.map_version_id=mv.id) as featureCount
         from map_versions mv where mv.floor_id=? order by mv.created_at desc`,
      [floorId],
    ),
    // 设施名取「待审修订优先，否则当前修订」，与 listFacilities 的口径一致，
    // 这样楼层页看到的名字和内容管理列表里是同一个。
    all(
      env.DB,
      `select f.id,f.facility_type_id as facilityTypeId,t.name as facilityTypeName,f.lifecycle_status as lifecycleStatus,
              f.operational_status as operationalStatus,f.indoor_space_id as indoorSpaceId,
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
      `select m.id,m.lifecycle_status as lifecycleStatus,m.indoor_space_id as indoorSpaceId,
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
      `select id,space_type as spaceType,stable_code as stableCode,display_name as displayName,
              lifecycle_status as lifecycleStatus
         from indoor_spaces where floor_id=? order by display_name`,
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

  return json({
    floor: { ...floor, isPublic: floor.isPublic === 1 },
    plans,
    facilities,
    merchants,
    spaces,
    anchors,
    usage,
  });
}

/**
 * DELETE /api/admin/floors/:id — 只在这层完全空了之后才允许。
 *
 * 楼层被五种东西引用（设施、商户、室内空间、平面图版本、位置锚点），其中前四种在
 * schema 里是 `on delete restrict`，硬删会直接撞外键报 500。所以这里先数一遍，非零
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
  const floor = await first<FloorRow>(
    env.DB,
    `select id,building_place_id as buildingPlaceId,level_code as levelCode,level_order as levelOrder,
            display_name as displayName,is_public as isPublic,lifecycle_status as lifecycleStatus
       from floors where id=?`,
    [floorId],
  );
  if (!floor) throw new HttpError(404, "not_found", "Floor does not exist");
  const usage = await floorUsage(env, floorId);
  const total = usage.facilities + usage.merchants + usage.spaces + usage.mapVersions + usage.anchors;
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

/**
 * PATCH /api/admin/floors/:id/plan-status — 楼层图版本的就绪 / 归档。
 *
 * 楼层图与校区图共用 map_versions 的生命周期，但校区图靠发版（release）切换，楼层图
 * 目前没有独立发版入口：导入完成后是 `ready`，客户端与设施编辑器都认 ready/published，
 * 所以这里只需要能把过期的旧图 `archived` 掉，避免同一层出现两张可用图纸。
 *
 * 不允许在这里改成 published —— 那是发版流程的职责（releases.ts 会把选中的版本升上去）。
 */
export async function updateFloorPlanStatus(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  mapVersionId: string,
  requestId: string,
): Promise<Response> {
  const body = exactObject(await readJson<unknown>(request), "floorPlanStatus", ["lifecycleStatus"]);
  const lifecycleStatus = oneOf(body.lifecycleStatus, "lifecycleStatus", ["ready", "archived"] as const);
  const version = await first<{ id: string; floorId: string | null; lifecycleStatus: string }>(
    env.DB,
    "select id,floor_id as floorId,lifecycle_status as lifecycleStatus from map_versions where id=?",
    [mapVersionId],
  );
  if (!version) throw new HttpError(404, "not_found", "Map version does not exist");
  if (version.floorId === null) {
    throw new HttpError(400, "validation_error", "This endpoint only manages floor plans");
  }
  if (version.lifecycleStatus === "published") {
    throw new HttpError(409, "invalid_state", "A published floor plan is changed through the release flow");
  }
  if (version.lifecycleStatus === "draft") {
    throw new HttpError(409, "invalid_state", "This floor plan is still importing");
  }
  await env.DB.prepare("update map_versions set lifecycle_status=? where id=?")
    .bind(lifecycleStatus, mapVersionId).run();
  await audit(
    env,
    principal,
    "floor.plan.status",
    "map_version",
    mapVersionId,
    requestId,
    { lifecycleStatus: version.lifecycleStatus },
    { lifecycleStatus },
  );
  return json({ id: mapVersionId, lifecycleStatus, updatedAt: isoNow() });
}
