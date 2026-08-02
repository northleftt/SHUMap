import type { SessionPrincipal } from "../domain/types";
import type { D1PreparedStatement, Env } from "../types/cloudflare";
import { all, first } from "../lib/db";
import { HttpError, json, readJson } from "../lib/http";
import { assertActiveMapFilterCategory } from "../lib/taxonomy";
import { isoNow, makeId, oneOf, optionalNumber, optionalString, requiredString } from "../lib/values";
import { audit } from "./audit";

// ---------------------------------------------------------------------------
// 设施类型（标签）维护。facility_types 是引用表，facility_instances.facility_type_id
// 指向它，因此「不要这个标签了」在语义上分成两步：
//
//   1. status='disabled' —— 停用。既有实例照常展示与发布，只是不再作为新建选项。
//      有实例引用的类型只能走这条路，物理删除会破坏历史数据的类型指向。
//   2. DELETE —— 仅当没有任何实例引用时允许，真正把行删掉。
//
// icon_key 只能取 SUPPORTED_ICON_KEYS 里的值，与 src/lib/facilityIcons.tsx 的
// FACILITY_ICON_BY_KEY 一一对应；这里是校验用的权威列表，接口把它连同中文
// 说明一起回给后台，界面据此渲染带预览的下拉。
// ---------------------------------------------------------------------------

const STATUSES = ["active", "disabled"] as const;
type FacilityTypeStatus = (typeof STATUSES)[number];

/** 与 src/lib/facilityIcons.tsx 的 FACILITY_ICON_BY_KEY 保持同步。 */
export const SUPPORTED_ICON_KEYS = [
  "printer", "desk", "restroom", "water", "elevator", "vending", "battery", "charging", "service",
  "wifi", "food", "parking", "bike", "bus", "mail", "health", "lounge", "locker", "security",
  "landmark", "sports", "trash", "generic",
] as const;

/** 已有种子数据用到的分类 + other 兜底。分类只用于后台分组展示。 */
export const CATEGORIES = ["service", "study", "amenity", "navigation", "commercial", "transport", "other"] as const;

/**
 * 新建类型的默认可见性策略。与种子数据里最常见的一组取值一致：可搜索、可筛选、
 * 进楼宇概览，不默认铺满校区图和楼层图。后续如需精细控制再单独做界面。
 */
const DEFAULT_VISIBILITY_POLICY = {
  searchable: true,
  filterable: true,
  campusDefault: false,
  buildingSummary: true,
  floorDefault: false,
  showOnSearch: true,
  showOnFilter: true,
  showWhenUnavailable: true,
};

const CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

interface FacilityTypeRow {
  id: string;
  code: string;
  name: string;
  category: string;
  iconKey: string | null;
  status: string;
  verificationIntervalDays: number | null;
  createdAt: string;
  updatedAt: string;
  instanceCount: number;
  collectionReferenceCount: number;
  mapFilterMemberId: string;
  mapFilterCategoryId: string;
  mapFilterLabel: string;
  mapFilterActive: number;
}

interface MapFilterCategoryRow {
  id: string;
  label: string;
  active: number;
  sortOrder: number;
}

interface FacilityTypeInstanceRow {
  id: string;
  facilityTypeId: string;
  displayName: string;
  lifecycleStatus: string;
  operationalStatus: string;
  hostPlaceId: string | null;
  placeName: string | null;
  floorId: string | null;
  floorName: string | null;
  floorLevelCode: string | null;
  spaceName: string | null;
  editorialStatus: string | null;
}

interface WriteBody {
  code?: unknown;
  name?: unknown;
  category?: unknown;
  iconKey?: unknown;
  status?: unknown;
  verificationIntervalDays?: unknown;
  mapFilterCategoryId?: unknown;
}

/**
 * GET /api/admin/facility-types
 *
 * 全量类型（含停用）+ 每个类型下挂着的点位。点位名取当前修订的 display_name，
 * 没有修订时退回类型名；楼宇名同理走 place_revisions，草稿地点也能显示出来。
 */
export async function listFacilityTypes(env: Env): Promise<Response> {
  const [types, instances, mapFilterCategories] = await Promise.all([
    all<FacilityTypeRow>(
      env.DB,
      `select t.id,t.code,t.name,t.category,t.icon_key as iconKey,t.status,
              t.verification_interval_days as verificationIntervalDays,
              t.created_at as createdAt,t.updated_at as updatedAt,
              m.id as mapFilterMemberId,m.category_id as mapFilterCategoryId,
              c.label as mapFilterLabel,c.active as mapFilterActive,
              (select count(*) from facility_instances f where f.facility_type_id=t.id) as instanceCount,
              (
                select count(*) from (
                  select ct.building_place_id
                    from collection_tasks ct
                    join json_each(ct.payload_json,'$.floors') floor
                    join json_each(floor.value,'$.facilities') facility
                   where json_extract(facility.value,'$.typeCode')=t.code
                  union all
                  select cs.id
                    from content_submissions cs
                    join json_each(cs.payload_json,'$.collection.floors') floor
                    join json_each(floor.value,'$.facilities') facility
                   where json_extract(cs.payload_json,'$.submissionKind')='collection'
                     and json_extract(facility.value,'$.typeCode')=t.code
                )
              ) as collectionReferenceCount
         from facility_types t
         join map_filter_members m on m.facility_type_id=t.id
         join map_filter_categories c on c.id=m.category_id
        order by t.status='disabled',t.category,t.name`,
    ),
    all<FacilityTypeInstanceRow>(
      env.DB,
      `select f.id,f.facility_type_id as facilityTypeId,
              coalesce(fr.display_name,t.name) as displayName,
              f.lifecycle_status as lifecycleStatus,f.operational_status as operationalStatus,
              f.host_place_id as hostPlaceId,
              coalesce(pr.display_name,
                (select r2.display_name from place_revisions r2 where r2.place_id=pl.id order by r2.revision_no desc limit 1)
              ) as placeName,
              f.floor_id as floorId,fl.display_name as floorName,fl.level_code as floorLevelCode,
              sp.display_name as spaceName,fr.editorial_status as editorialStatus
         from facility_instances f
         join facility_types t on t.id=f.facility_type_id
         left join facility_revisions fr on fr.id=coalesce(
           f.current_revision_id,
           (select fr2.id from facility_revisions fr2 where fr2.facility_id=f.id order by fr2.revision_no desc limit 1)
         )
         left join places pl on pl.id=f.host_place_id
         left join place_revisions pr on pr.id=pl.current_revision_id
         left join floors fl on fl.id=f.floor_id
         left join indoor_spaces sp on sp.id=f.indoor_space_id
        order by t.name,placeName,fl.level_order,displayName`,
    ),
    all<MapFilterCategoryRow>(
      env.DB,
      "select id,label,active,sort_order as sortOrder from map_filter_categories order by sort_order,label,id",
    ),
  ]);

  return json({
    items: types.map((type) => ({
      ...type,
      mapFilterActive: Number(type.mapFilterActive) === 1,
      instances: instances.filter((instance) => instance.facilityTypeId === type.id),
    })),
    iconKeys: SUPPORTED_ICON_KEYS,
    categories: CATEGORIES,
    mapFilterCategories: mapFilterCategories.map((category) => ({
      ...category,
      active: Number(category.active) === 1,
    })),
  });
}

/** GET /api/public/facility-types —— 采集读写共用的轻量完整类型表。 */
export async function listPublicFacilityTypes(env: Env): Promise<Response> {
  const items = await all<{ code: string; name: string; iconKey: string | null; status: string }>(
    env.DB,
    `select t.code,t.name,t.icon_key as iconKey,t.status from facility_types t
      join map_filter_members m on m.facility_type_id=t.id
      join map_filter_categories c on c.id=m.category_id
      order by t.status='disabled',t.category,t.name`,
  );
  return json({ items }, { headers: { "cache-control": "public, max-age=300, stale-while-revalidate=600" } });
}

export async function createFacilityType(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  requestId: string,
): Promise<Response> {
  const body = await readJson<WriteBody>(request);
  const code = requiredString(body.code, "code", 50).toLowerCase();
  if (!CODE_PATTERN.test(code)) {
    throw new HttpError(400, "invalid_code", "code must be lowercase letters, digits and underscores, starting with a letter");
  }
  const name = requiredString(body.name, "name", 50);
  const category = body.category === undefined || body.category === null || body.category === ""
    ? "other"
    : oneOf(body.category, "category", CATEGORIES);
  const iconKey = normalizeIconKey(body.iconKey);
  const verificationIntervalDays = normalizeInterval(body.verificationIntervalDays);
  const mapFilterCategoryId = requiredString(body.mapFilterCategoryId, "mapFilterCategoryId", 100);
  await assertActiveMapFilterCategory(env, mapFilterCategoryId);

  const existing = await first<{ id: string }>(env.DB, "select id from facility_types where code=?", [code]);
  if (existing) throw new HttpError(409, "code_taken", "A facility type with this code already exists");

  const id = makeId("facility_type");
  const memberId = makeId("mapfiltermember");
  const now = isoNow();
  await env.DB.batch([
    env.DB.prepare(
      `insert into facility_types(id,code,name,category,icon_key,visibility_policy_json,verification_interval_days,status,created_at,updated_at)
       values(?,?,?,?,?,?,?,'disabled',?,?)`,
    ).bind(id, code, name, category, iconKey, JSON.stringify(DEFAULT_VISIBILITY_POLICY), verificationIntervalDays, now, now),
    env.DB.prepare(
      `insert into map_filter_members(id,category_id,place_kind_id,facility_type_id,includes_merchants,sort_order,created_at)
       values(?,?,null,?,0,100,?)`,
    ).bind(memberId, mapFilterCategoryId, id, now),
    env.DB.prepare("update facility_types set status='active' where id=?").bind(id),
  ]);

  await audit(env, principal, "facility_type.create", "facility_type", id, requestId, null, {
    code, name, category, iconKey, verificationIntervalDays, mapFilterCategoryId,
  });
  return json({
    id,
    code,
    name,
    category,
    iconKey,
    status: "active",
    verificationIntervalDays,
    instanceCount: 0,
    mapFilterMemberId: memberId,
    mapFilterCategoryId,
  }, { status: 201 });
}

/**
 * PATCH /api/admin/facility-types/:id
 *
 * code 不可改：它是 release manifest、采集草稿与前端图标表共同依赖的稳定键，
 * 改掉会让既有数据对不上。要换编码就新建一个类型再把旧的停用。
 */
export async function updateFacilityType(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  id: string,
  requestId: string,
): Promise<Response> {
  const current = await first<{
    id: string;
    code: string;
    name: string;
    category: string;
    icon_key: string | null;
    status: string;
    verification_interval_days: number | null;
    map_filter_member_id: string | null;
    map_filter_category_id: string | null;
  }>(
    env.DB,
    `select t.id,t.code,t.name,t.category,t.icon_key,t.status,t.verification_interval_days,
            m.id as map_filter_member_id,m.category_id as map_filter_category_id
       from facility_types t left join map_filter_members m on m.facility_type_id=t.id
      where t.id=?`,
    [id],
  );
  if (!current) throw new HttpError(404, "not_found", "Facility type does not exist");
  if (!current.map_filter_member_id || !current.map_filter_category_id) {
    throw new Error(`Facility type ${id} has no map filter membership`);
  }

  const body = await readJson<WriteBody>(request);
  if (body.code !== undefined && String(body.code).toLowerCase() !== current.code) {
    throw new HttpError(409, "code_immutable", "The code of an existing facility type cannot be changed");
  }
  const name = body.name === undefined ? null : requiredString(body.name, "name", 50);
  const category = body.category === undefined ? null : oneOf(body.category, "category", CATEGORIES);
  const iconKey = body.iconKey === undefined ? undefined : normalizeIconKey(body.iconKey);
  const status = body.status === undefined ? null : oneOf<FacilityTypeStatus>(body.status, "status", STATUSES);
  const verificationIntervalDays = body.verificationIntervalDays === undefined ? undefined : normalizeInterval(body.verificationIntervalDays);
  const mapFilterCategoryId = body.mapFilterCategoryId === undefined
    ? current.map_filter_category_id
    : requiredString(body.mapFilterCategoryId, "mapFilterCategoryId", 100);
  const targetCategory = await first<{ id: string; active: number }>(
    env.DB,
    "select id,active from map_filter_categories where id=?",
    [mapFilterCategoryId],
  );
  if (!targetCategory) throw new HttpError(400, "validation_error", "Map filter does not exist");
  const nextStatus = status ?? current.status;
  if (nextStatus === "active") await assertActiveMapFilterCategory(env, mapFilterCategoryId);
  if (current.status === "active" && nextStatus === "disabled") {
    const editableReference = await first<{ id: string }>(
      env.DB,
      `select referenced.id from (
         select ct.building_place_id as id
           from collection_tasks ct
           join json_each(ct.payload_json,'$.floors') floor
           join json_each(floor.value,'$.facilities') facility
          where ct.status in ('collecting','submitted','needs_recollection')
            and json_extract(facility.value,'$.typeCode')=?
         union all
         select cs.id
           from content_submissions cs
           join json_each(cs.payload_json,'$.collection.floors') floor
           join json_each(floor.value,'$.facilities') facility
          where cs.status in ('pending','in_review')
            and json_extract(cs.payload_json,'$.submissionKind')='collection'
            and json_extract(facility.value,'$.typeCode')=?
       ) referenced limit 1`,
      [current.code, current.code],
    );
    if (editableReference) {
      throw new HttpError(409, "facility_type_in_use", "An active collection workflow still uses this facility type");
    }
  }
  if (Number(targetCategory.active) !== 1) {
    const liveInstance = await first<{ id: string }>(
      env.DB,
      "select id from facility_instances where facility_type_id=? and lifecycle_status<>'retired' limit 1",
      [id],
    );
    if (liveInstance) {
      throw new HttpError(409, "facility_type_in_use", "A facility type with live facilities cannot move to an inactive map filter");
    }
  }

  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (name !== null) { sets.push("name=?"); values.push(name); }
  if (category !== null) { sets.push("category=?"); values.push(category); }
  if (iconKey !== undefined) { sets.push("icon_key=?"); values.push(iconKey); }
  if (status !== null) { sets.push("status=?"); values.push(status); }
  if (verificationIntervalDays !== undefined) { sets.push("verification_interval_days=?"); values.push(verificationIntervalDays); }
  const categoryChanged = mapFilterCategoryId !== current.map_filter_category_id;
  if (!sets.length && !categoryChanged) throw new HttpError(400, "validation_error", "Nothing to update");

  const now = isoNow();
  sets.push("updated_at=?");
  values.push(now, id);
  const updateType = env.DB.prepare(`update facility_types set ${sets.join(",")} where id=?`).bind(...values);
  const statements: D1PreparedStatement[] = [];
  const moveMember = categoryChanged
    ? env.DB.prepare("update map_filter_members set category_id=? where id=?")
      .bind(mapFilterCategoryId, current.map_filter_member_id)
    : null;
  if (current.status === "active" && nextStatus === "disabled") {
    statements.push(updateType);
    if (moveMember) statements.push(moveMember);
  } else {
    if (moveMember) statements.push(moveMember);
    statements.push(updateType);
  }
  await env.DB.batch(statements);

  await audit(
    env, principal, "facility_type.update", "facility_type", id, requestId,
    { name: current.name, category: current.category, iconKey: current.icon_key, status: current.status, verificationIntervalDays: current.verification_interval_days, mapFilterCategoryId: current.map_filter_category_id },
    {
      name: name ?? current.name,
      category: category ?? current.category,
      iconKey: iconKey === undefined ? current.icon_key : iconKey,
      status: nextStatus,
      verificationIntervalDays: verificationIntervalDays === undefined ? current.verification_interval_days : verificationIntervalDays,
      mapFilterCategoryId,
    },
  );

  const count = await instanceCount(env, id);
  return json({
    id,
    code: current.code,
    name: name ?? current.name,
    category: category ?? current.category,
    iconKey: iconKey === undefined ? current.icon_key : iconKey,
    status: nextStatus,
    verificationIntervalDays: verificationIntervalDays === undefined ? current.verification_interval_days : verificationIntervalDays,
    instanceCount: count,
    mapFilterMemberId: current.map_filter_member_id,
    mapFilterCategoryId,
  });
}

/** DELETE /api/admin/facility-types/:id —— 仅无点位或采集数据引用时物理删除。 */
export async function deleteFacilityType(
  env: Env,
  principal: SessionPrincipal,
  id: string,
  requestId: string,
): Promise<Response> {
  const current = await first<{ id: string; code: string; name: string; status: string; memberId: string | null }>(
    env.DB,
    `select t.id,t.code,t.name,t.status,m.id as memberId from facility_types t
      left join map_filter_members m on m.facility_type_id=t.id where t.id=?`,
    [id],
  );
  if (!current) throw new HttpError(404, "not_found", "Facility type does not exist");
  const count = await instanceCount(env, id);
  if (count > 0) {
    throw new HttpError(409, "facility_type_in_use", `This facility type is still used by ${count} facilities; disable it instead`);
  }
  const collectionReference = await first<{ id: string }>(
    env.DB,
    `select referenced.id from (
       select ct.building_place_id as id
         from collection_tasks ct
         join json_each(ct.payload_json,'$.floors') floor
         join json_each(floor.value,'$.facilities') facility
        where json_extract(facility.value,'$.typeCode')=?
       union all
       select cs.id
         from content_submissions cs
         join json_each(cs.payload_json,'$.collection.floors') floor
         join json_each(floor.value,'$.facilities') facility
        where json_extract(cs.payload_json,'$.submissionKind')='collection'
          and json_extract(facility.value,'$.typeCode')=?
     ) referenced limit 1`,
    [current.code, current.code],
  );
  if (collectionReference) {
    throw new HttpError(409, "facility_type_in_use", "This facility type is still referenced by collection data; disable it instead");
  }
  if (!current.memberId) throw new Error(`Facility type ${id} has no map filter membership`);
  await env.DB.batch([
    env.DB.prepare("update facility_types set status='disabled',updated_at=? where id=?").bind(isoNow(), id),
    env.DB.prepare("delete from map_filter_members where id=?").bind(current.memberId),
    env.DB.prepare("delete from facility_types where id=?").bind(id),
  ]);
  await audit(env, principal, "facility_type.delete", "facility_type", id, requestId, current, null);
  return json({ id, deleted: true });
}

async function instanceCount(env: Env, id: string): Promise<number> {
  const row = await first<{ count: number }>(env.DB, "select count(*) as count from facility_instances where facility_type_id=?", [id]);
  if (!row) throw new Error("Facility instance count query returned no row");
  return row.count;
}

function normalizeIconKey(value: unknown): string | null {
  const raw = optionalString(value, "iconKey", 50);
  if (raw === null) return null;
  if (!(SUPPORTED_ICON_KEYS as readonly string[]).includes(raw)) {
    throw new HttpError(400, "unsupported_icon_key", `iconKey must be one of: ${SUPPORTED_ICON_KEYS.join(", ")}`);
  }
  return raw;
}

function normalizeInterval(value: unknown): number | null {
  const days = optionalNumber(value, "verificationIntervalDays");
  if (days === null) return null;
  if (!Number.isInteger(days) || days <= 0 || days > 3650) {
    throw new HttpError(400, "validation_error", "verificationIntervalDays must be an integer between 1 and 3650");
  }
  return days;
}

export async function activeFacilityTypeCodes(env: Env): Promise<Set<string>> {
  const rows = await all<{ code: string }>(
    env.DB,
    `select t.code from facility_types t
      join map_filter_members m on m.facility_type_id=t.id
      join map_filter_categories c on c.id=m.category_id and c.active=1
      where t.status='active'`,
  );
  return new Set(rows.map((row) => row.code));
}
