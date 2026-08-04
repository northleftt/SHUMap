import type { SessionPrincipal } from "../domain/types";
import type { D1PreparedStatement, Env } from "../types/cloudflare";
import { all, first } from "../lib/db";
import { HttpError, json, readJson } from "../lib/http";
import { allocateMapFilterKey } from "../lib/taxonomy";
import { isoNow, makeId, objectValue, oneOf, optionalNumber, optionalString, parseJsonObject, requiredString } from "../lib/values";
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
 * 进楼宇概览，不默认铺满校区图和楼层图。
 *
 * `campusDefault` 是「不选任何筛选时校区图上直接显示」的开关。它默认 false，而
 * 楼外设施的图钉正是由它决定要不要画（见 useMapPageState 的 shouldRenderPointPoi：
 * 没有搜索词也没有选筛选时，只看 visibility.default）。默认关着是对的——否则一个
 * 校区几百个卫生间会糊满地图——但必须能在后台改，否则新建的楼外点位永远不出现，
 * 而管理员没有任何办法自己解决。
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
  visibilityPolicyJson: string;
  instanceCount: number;
  collectionReferenceCount: number;
  mapFilterMemberId: string;
  mapFilterCategoryId: string;
  /** 这个类型自己那个筛选按钮：名称、排序、是否显示。 */
  filterLabel: string;
  filterActive: number;
  filterSortOrder: number;
  /** >1 表示这个按钮还挂着别的成员（历史数据），此时不允许就地改按钮属性。 */
  filterMemberCount: number;
}

/** 后台能改的那几个可见性开关。其余键（buildingSummary / floorDefault）原样保留。 */
const EDITABLE_VISIBILITY_KEYS = [
  "campusDefault", "searchable", "filterable", "showOnSearch", "showOnFilter", "showWhenUnavailable",
] as const;

type VisibilityPatch = Partial<Record<(typeof EDITABLE_VISIBILITY_KEYS)[number], boolean>>;

/**
 * 读出存着的策略。这一列是 `not null check(json_valid(...))`，所以解析失败属于
 * 数据损坏，不能静默兜底成默认值——那会让「我明明打开了校区默认显示」变成谜。
 */
function visibilityPolicyOf(raw: string, typeId: string): Record<string, unknown> {
  const parsed = parseJsonObject(raw, `facility_types ${typeId} visibility_policy_json`);
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "boolean") {
      throw new Error(`facility_types ${typeId} visibility_policy_json.${key} must be a boolean`);
    }
  }
  return parsed;
}

/** 请求体里的可见性开关 → 补丁。全部缺省时返回 null，表示这次不动策略。 */
function visibilityPatch(value: unknown, field: string): VisibilityPatch | null {
  if (value === undefined) return null;
  const body = objectValue(value, field);
  const patch: VisibilityPatch = {};
  for (const key of Object.keys(body)) {
    if (!(EDITABLE_VISIBILITY_KEYS as readonly string[]).includes(key)) {
      throw new HttpError(400, "validation_error", `${field}.${key} is not an editable visibility switch`);
    }
  }
  for (const key of EDITABLE_VISIBILITY_KEYS) {
    if (!Object.hasOwn(body, key)) continue;
    const raw = body[key];
    if (typeof raw !== "boolean") throw new HttpError(400, "validation_error", `${field}.${key} must be a boolean`);
    patch[key] = raw;
  }
  if (Object.keys(patch).length === 0) {
    throw new HttpError(400, "validation_error", `${field} must contain at least one switch`);
  }
  return patch;
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
  visibilityPolicy?: unknown;
  /** 这个类型自己那个筛选按钮的属性。缺省时按钮名沿用类型名。 */
  filterLabel?: unknown;
  filterSortOrder?: unknown;
  filterActive?: unknown;
}

function integerValue(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new HttpError(400, "validation_error", `${field} must be an integer`);
  }
  return value;
}

function booleanFlag(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new HttpError(400, "validation_error", `${field} must be a boolean`);
  return value;
}

/**
 * GET /api/admin/facility-types
 *
 * 全量类型（含停用）+ 每个类型下挂着的点位。点位名取当前修订的 display_name，
 * 没有修订时退回类型名；楼宇名同理走 place_revisions，草稿地点也能显示出来。
 */
export async function listFacilityTypes(env: Env): Promise<Response> {
  const [types, instances] = await Promise.all([
    all<FacilityTypeRow>(
      env.DB,
      `select t.id,t.code,t.name,t.category,t.icon_key as iconKey,t.status,
              t.verification_interval_days as verificationIntervalDays,
              t.created_at as createdAt,t.updated_at as updatedAt,
              t.visibility_policy_json as visibilityPolicyJson,
              m.id as mapFilterMemberId,m.category_id as mapFilterCategoryId,
              c.label as filterLabel,c.active as filterActive,c.sort_order as filterSortOrder,
              (select count(*) from map_filter_members m2 where m2.category_id=c.id) as filterMemberCount,
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
  ]);

  return json({
    items: types.map((type) => {
      const { visibilityPolicyJson, ...fields } = type;
      return {
        ...fields,
        filterActive: Number(type.filterActive) === 1,
        // 界面要能看见并改这几个开关，尤其是 campusDefault —— 它决定楼外点位在
        // 不选筛选时到底画不画。原样回全量策略，界面只渲染可编辑的那几个。
        visibilityPolicy: visibilityPolicyOf(visibilityPolicyJson, type.id),
        instances: instances.filter((instance) => instance.facilityTypeId === type.id),
      };
    }),
    iconKeys: SUPPORTED_ICON_KEYS,
    visibilityKeys: EDITABLE_VISIBILITY_KEYS,
    categories: CATEGORIES,
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
  const filterLabel = body.filterLabel === undefined ? name : requiredString(body.filterLabel, "filterLabel", 80);
  const filterSortOrder = body.filterSortOrder === undefined
    ? 100
    : integerValue(body.filterSortOrder, "filterSortOrder");

  const existing = await first<{ id: string }>(env.DB, "select id from facility_types where code=?", [code]);
  if (existing) throw new HttpError(409, "code_taken", "A facility type with this code already exists");

  const id = makeId("facility_type");
  const mapFilterCategoryId = makeId("mapfilter");
  const memberId = makeId("mapfiltermember");
  const filterKeyValue = await allocateMapFilterKey(env, code);
  const now = isoNow();
  // 顺序有讲究：0012 的 require_facility_type_active_map_filter_insert 要求类型在
  // status='active' 时就已经归属一个启用标签，所以先建 disabled 的类型行、建按钮、
  // 建成员，最后才把状态改成 active。
  await env.DB.batch([
    env.DB.prepare(
      `insert into facility_types(id,code,name,category,icon_key,visibility_policy_json,verification_interval_days,status,created_at,updated_at)
       values(?,?,?,?,?,?,?,'disabled',?,?)`,
    ).bind(id, code, name, category, iconKey, JSON.stringify(DEFAULT_VISIBILITY_POLICY), verificationIntervalDays, now, now),
    env.DB.prepare(
      "insert into map_filter_categories(id,key,label,active,sort_order,created_at,updated_at) values(?,?,?,1,?,?,?)",
    ).bind(mapFilterCategoryId, filterKeyValue, filterLabel, filterSortOrder, now, now),
    env.DB.prepare(
      `insert into map_filter_members(id,category_id,place_kind_id,facility_type_id,includes_merchants,sort_order,created_at)
       values(?,?,null,?,0,100,?)`,
    ).bind(memberId, mapFilterCategoryId, id, now),
    env.DB.prepare("update facility_types set status='active' where id=?").bind(id),
  ]);

  await audit(env, principal, "facility_type.create", "facility_type", id, requestId, null, {
    code, name, category, iconKey, verificationIntervalDays, mapFilterCategoryId, filterLabel, filterSortOrder,
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
 *
 * 类型自身的属性和它那个筛选按钮的属性在同一个请求里改。此前这里收的是
 * `mapFilterCategoryId`（「把这个类型挪到哪个按钮下」），但按钮与类型本来就是
 * 一对一的，那个字段等于让维护者去搬一个只装着它自己的容器。
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
    visibility_policy_json: string;
    map_filter_member_id: string | null;
    map_filter_category_id: string | null;
    filter_label: string | null;
    filter_active: number | null;
    filter_sort_order: number | null;
    filter_member_count: number;
  }>(
    env.DB,
    `select t.id,t.code,t.name,t.category,t.icon_key,t.status,t.verification_interval_days,
            t.visibility_policy_json,
            m.id as map_filter_member_id,m.category_id as map_filter_category_id,
            c.label as filter_label,c.active as filter_active,c.sort_order as filter_sort_order,
            coalesce((select count(*) from map_filter_members m2 where m2.category_id=c.id),0) as filter_member_count
       from facility_types t
       left join map_filter_members m on m.facility_type_id=t.id
       left join map_filter_categories c on c.id=m.category_id
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
  // 补丁式合并：只覆盖请求里给到的开关，buildingSummary / floorDefault 这些界面上
  // 没有的键原样留着，别因为一次改「校区默认显示」把种子里的其他策略抹平。
  const patch = visibilityPatch(body.visibilityPolicy, "visibilityPolicy");
  const currentPolicy = visibilityPolicyOf(current.visibility_policy_json, id);
  const nextPolicy = patch === null ? null : { ...currentPolicy, ...patch };
  // 这个类型自己那个筛选按钮的属性。归属不再可改——按钮与类型一对一，「把类型搬到
  // 别的按钮下」这件事在真实数据里从未发生过，留着它只会让人以为要先去理解按钮。
  const mapFilterCategoryId = current.map_filter_category_id;
  const touchesFilter = body.filterLabel !== undefined
    || body.filterSortOrder !== undefined
    || body.filterActive !== undefined;
  if (touchesFilter && Number(current.filter_member_count) > 1) {
    throw new HttpError(409, "map_filter_shared", "This map filter carries other members; edit it as a group first");
  }
  const filterLabel = body.filterLabel === undefined
    ? String(current.filter_label)
    : requiredString(body.filterLabel, "filterLabel", 80);
  const filterSortOrder = body.filterSortOrder === undefined
    ? Number(current.filter_sort_order)
    : integerValue(body.filterSortOrder, "filterSortOrder");
  const filterActive = body.filterActive === undefined
    ? Number(current.filter_active) === 1
    : booleanFlag(body.filterActive, "filterActive");
  const nextStatus = status ?? current.status;
  // 0012 的 require_facility_type_active_map_filter_update 要求类型转 active 时按钮
  // 已经是启用的。同一个请求里既启用类型又停用按钮无法同时满足，先在这里说清楚。
  if (nextStatus === "active" && !filterActive) {
    throw new HttpError(400, "inactive_map_filter", "An enabled facility type needs its map filter enabled too");
  }
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
  // 停用按钮而底下还挂着在用点位，会被 0012 的 protect_used_map_filter_deactivation
  // 拦掉。先在这里给出可读的错误，否则界面上只能看到一条原始的 SQLite abort 文本。
  if (Number(current.filter_active) === 1 && !filterActive) {
    const liveInstance = await first<{ id: string }>(
      env.DB,
      "select id from facility_instances where facility_type_id=? and lifecycle_status<>'retired' limit 1",
      [id],
    );
    if (liveInstance) {
      throw new HttpError(409, "map_filter_in_use", "A map filter with live facilities cannot be hidden");
    }
  }

  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (name !== null) { sets.push("name=?"); values.push(name); }
  if (category !== null) { sets.push("category=?"); values.push(category); }
  if (iconKey !== undefined) { sets.push("icon_key=?"); values.push(iconKey); }
  if (status !== null) { sets.push("status=?"); values.push(status); }
  if (verificationIntervalDays !== undefined) { sets.push("verification_interval_days=?"); values.push(verificationIntervalDays); }
  if (nextPolicy !== null) { sets.push("visibility_policy_json=?"); values.push(JSON.stringify(nextPolicy)); }
  if (!sets.length && !touchesFilter) throw new HttpError(400, "validation_error", "Nothing to update");

  const now = isoNow();
  const statements: D1PreparedStatement[] = [];
  const updateFilter = touchesFilter
    ? env.DB.prepare("update map_filter_categories set label=?,active=?,sort_order=?,updated_at=? where id=?")
      .bind(filterLabel, filterActive ? 1 : 0, filterSortOrder, now, mapFilterCategoryId)
    : null;
  if (sets.length) {
    sets.push("updated_at=?");
    values.push(now, id);
    const updateType = env.DB.prepare(`update facility_types set ${sets.join(",")} where id=?`).bind(...values);
    // 顺序跟着触发器走：类型转 active 前按钮必须已经启用，类型转 disabled 后才能
    // 动按钮，否则中间态会撞上 require_facility_type_active_map_filter_update。
    if (current.status === "active" && nextStatus === "disabled") {
      statements.push(updateType);
      if (updateFilter) statements.push(updateFilter);
    } else {
      if (updateFilter) statements.push(updateFilter);
      statements.push(updateType);
    }
  } else if (updateFilter) {
    statements.push(updateFilter);
  }
  await env.DB.batch(statements);

  await audit(
    env, principal, "facility_type.update", "facility_type", id, requestId,
    { name: current.name, category: current.category, iconKey: current.icon_key, status: current.status, verificationIntervalDays: current.verification_interval_days, filterLabel: current.filter_label, filterActive: Number(current.filter_active) === 1, filterSortOrder: current.filter_sort_order, visibilityPolicy: currentPolicy },
    {
      name: name ?? current.name,
      category: category ?? current.category,
      iconKey: iconKey === undefined ? current.icon_key : iconKey,
      status: nextStatus,
      verificationIntervalDays: verificationIntervalDays === undefined ? current.verification_interval_days : verificationIntervalDays,
      filterLabel,
      filterActive,
      filterSortOrder,
      visibilityPolicy: nextPolicy ?? currentPolicy,
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
    visibilityPolicy: nextPolicy ?? currentPolicy,
    instanceCount: count,
    mapFilterMemberId: current.map_filter_member_id,
    mapFilterCategoryId,
    filterLabel,
    filterActive,
    filterSortOrder,
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
