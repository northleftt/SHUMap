import type { SessionPrincipal } from "../domain/types";
import type { Env } from "../types/cloudflare";
import { all, first } from "../lib/db";
import { HttpError, json, readJson } from "../lib/http";
import { allocateMapFilterKey } from "../lib/taxonomy";
import { isoNow, makeId, objectValue, requiredString } from "../lib/values";
import { audit } from "./audit";

// ---------------------------------------------------------------------------
// 筛选按钮（map_filter_categories）与地点类型 / 设施类型 / 商户的归属关系。
//
// 库里 19 个按钮对应 19 个成员，一个按钮从来没有装过两样东西——所谓「容器」在真实
// 数据里一次都没用上。于是后台不再把它当成一层独立对象让人先建再挑：新建类型时
// 顺手建好它自己的按钮，按钮的名称与排序作为类型的属性一并维护。
//
// 底层表结构不动（一个按钮仍可挂多个成员），发布产物 manifest.mapFilters 的形状
// 也不变，所以前台代码与已发布的版本都不受影响。真出现一个按钮挂多个成员的历史
// 数据，读接口会在 groups 里如实报出来，而不是假装它不存在。
// ---------------------------------------------------------------------------

/**
 * 挂在一个地点类型下的单个地点。
 *
 * 此前这里只给一个 usageCount，「建筑」下面写着 121 个地点却一个都看不到、点不开。
 * 这份明细让归属关系可核对：某个地点到底算在哪个筛选按钮里。
 */
interface PlaceKindEntryRow {
  id: string;
  kindId: string;
  displayName: string;
  lifecycleStatus: string;
  isBuilding: number;
  campusId: string | null;
  campusName: string | null;
  editorialStatus: string | null;
}

type PlaceKindEntryResponse = Omit<PlaceKindEntryRow, "isBuilding"> & { isBuilding: boolean };

interface MapFilterMemberTarget {
  placeKindId: string | null;
  facilityTypeId: string | null;
  includesMerchants: number;
}

/**
 * 一个地点类型，连同它自己那个筛选按钮。
 *
 * filterLabel 与 name 经常不同（`building`「建筑」的按钮叫「教学楼」，`residence`
 * 「宿舍」的按钮叫「宿舍楼」），所以两者都留着，只是在同一张卡片里编辑。
 */
interface PlaceKindRow {
  id: string;
  name: string;
  sortOrder: number;
  isSearchable: number;
  placeCount: number;
  mapFilterMemberId: string | null;
  categoryId: string | null;
  filterKey: string | null;
  filterLabel: string | null;
  filterActive: number | null;
  filterSortOrder: number | null;
  /** 这个按钮下还挂着别的成员时不能就地改名，否则会牵连另一个类型。 */
  filterMemberCount: number;
}

/** 商户整类纳入的那一个按钮。它没有「类型」可挂，所以单独成一行。 */
interface MerchantFilterRow {
  memberId: string;
  categoryId: string;
  filterKey: string;
  filterLabel: string;
  filterActive: number;
  filterSortOrder: number;
  outletCount: number;
  filterMemberCount: number;
}

/** 一个按钮挂了多个成员的历史数据。正常库里为空。 */
interface FilterGroupRow {
  id: string;
  key: string;
  label: string;
  active: number;
  sortOrder: number;
  memberCount: number;
  memberLabels: string;
}

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

function writeBody(
  value: unknown,
  field: string,
  allowed: readonly string[],
  required: readonly string[] = [],
  requireAny = false,
): Record<string, unknown> {
  const body = objectValue(value, field);
  const allowedFields = new Set(allowed);
  for (const key of Object.keys(body)) {
    if (!allowedFields.has(key)) throw new HttpError(400, "validation_error", `${field}.${key} is not supported`);
  }
  for (const key of required) {
    if (!Object.hasOwn(body, key)) throw new HttpError(400, "validation_error", `${field}.${key} is required`);
  }
  if (requireAny && Object.keys(body).length === 0) {
    throw new HttpError(400, "validation_error", `${field} must contain at least one field`);
  }
  return body;
}

function integer(value: unknown, field: string, defaultValue?: number): number {
  if (value === undefined && defaultValue !== undefined) return defaultValue;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new HttpError(400, "validation_error", `${field} must be an integer`);
  }
  return value;
}

function booleanValue(value: unknown, field: string, defaultValue?: boolean): boolean {
  if (value === undefined && defaultValue !== undefined) return defaultValue;
  if (typeof value !== "boolean") throw new HttpError(400, "validation_error", `${field} must be a boolean`);
  return value;
}

function filterKey(value: unknown): string {
  const key = requiredString(value, "key", 60);
  if (!KEY_PATTERN.test(key)) throw new HttpError(400, "validation_error", "key contains unsupported characters");
  return key;
}

async function assertUniqueKey(env: Env, key: string, exceptId?: string): Promise<void> {
  const duplicate = await first<{ id: string }>(
    env.DB,
    "select id from map_filter_categories where key=? and (? is null or id<>?)",
    [key, exceptId ?? null, exceptId ?? null],
  );
  if (duplicate) throw new HttpError(409, "duplicate_map_filter_key", "Another map filter already uses this key");
}

function memberTarget(body: Record<string, unknown>): MapFilterMemberTarget {
  const placeKindId = typeof body.placeKindId === "string" && body.placeKindId.trim() ? body.placeKindId.trim() : null;
  const facilityTypeId = typeof body.facilityTypeId === "string" && body.facilityTypeId.trim() ? body.facilityTypeId.trim() : null;
  const includesMerchants = body.includesMerchants === true ? 1 : 0;
  if (body.includesMerchants !== undefined && body.includesMerchants !== true) {
    throw new HttpError(400, "validation_error", "includesMerchants must be true when supplied");
  }
  if (Number(placeKindId !== null) + Number(facilityTypeId !== null) + includesMerchants !== 1) {
    throw new HttpError(400, "validation_error", "A member must select exactly one target");
  }
  return { placeKindId, facilityTypeId, includesMerchants };
}

async function assertTargetExists(env: Env, target: MapFilterMemberTarget): Promise<void> {
  if (target.placeKindId) {
    const row = await first<{ id: string }>(env.DB, "select id from place_kinds where id=?", [target.placeKindId]);
    if (!row) throw new HttpError(400, "validation_error", "Place kind does not exist");
  }
  if (target.facilityTypeId) {
    const row = await first<{ id: string }>(env.DB, "select id from facility_types where id=?", [target.facilityTypeId]);
    if (!row) throw new HttpError(400, "validation_error", "Facility type does not exist");
  }
}

async function assertTargetUnassigned(env: Env, target: MapFilterMemberTarget): Promise<void> {
  const row = await first<{ id: string }>(
    env.DB,
    `select id from map_filter_members
      where (? is not null and place_kind_id=?)
         or (? is not null and facility_type_id=?)
         or (?=1 and includes_merchants=1)`,
    [target.placeKindId, target.placeKindId, target.facilityTypeId, target.facilityTypeId, target.includesMerchants],
  );
  if (row) throw new HttpError(409, "map_filter_target_assigned", "This target already belongs to a map filter");
}

async function targetHasLiveUsage(env: Env, target: MapFilterMemberTarget): Promise<boolean> {
  if (target.placeKindId) {
    return Boolean(await first<{ id: string }>(
      env.DB,
      "select id from places where kind_id=? and lifecycle_status<>'retired' limit 1",
      [target.placeKindId],
    ));
  }
  if (target.facilityTypeId) {
    return Boolean(await first<{ id: string }>(
      env.DB,
      `select t.id from facility_types t
        left join facility_instances f on f.facility_type_id=t.id and f.lifecycle_status<>'retired'
       where t.id=? and (t.status='active' or f.id is not null) limit 1`,
      [target.facilityTypeId],
    ));
  }
  return Boolean(await first<{ id: string }>(
    env.DB,
    "select id from merchant_outlets where lifecycle_status<>'retired' limit 1",
  ));
}

async function memberHasLiveUsage(env: Env, id: string): Promise<boolean> {
  const member = await first<{
    placeKindId: string | null;
    facilityTypeId: string | null;
    includesMerchants: number;
  }>(
    env.DB,
    `select place_kind_id as placeKindId,facility_type_id as facilityTypeId,includes_merchants as includesMerchants
       from map_filter_members where id=?`,
    [id],
  );
  if (!member) throw new HttpError(404, "not_found", "Map filter member does not exist");
  return targetHasLiveUsage(env, {
    placeKindId: member.placeKindId,
    facilityTypeId: member.facilityTypeId,
    includesMerchants: Number(member.includesMerchants),
  });
}

async function categoryHasLiveUsage(env: Env, categoryId: string): Promise<boolean> {
  const row = await first<{ id: string }>(
    env.DB,
    `select m.id from map_filter_members m
      where m.category_id=? and (
        (m.place_kind_id is not null and exists(
          select 1 from places p where p.kind_id=m.place_kind_id and p.lifecycle_status<>'retired'
        ))
        or (m.facility_type_id is not null and exists(
          select 1 from facility_types t
          left join facility_instances f on f.facility_type_id=t.id and f.lifecycle_status<>'retired'
          where t.id=m.facility_type_id and (t.status='active' or f.id is not null)
        ))
        or (m.includes_merchants=1 and exists(
          select 1 from merchant_outlets o where o.lifecycle_status<>'retired'
        ))
      ) limit 1`,
    [categoryId],
  );
  return Boolean(row);
}

/** 地点类型 + 它自己那个筛选按钮。三处读接口共用，避免各写一份走形。 */
const PLACE_KIND_SELECT = `
  select pk.id,pk.name,pk.sort_order as sortOrder,pk.is_searchable as isSearchable,
         (select count(*) from places p where p.kind_id=pk.id) as placeCount,
         m.id as mapFilterMemberId,m.category_id as categoryId,
         c.key as filterKey,c.label as filterLabel,c.active as filterActive,
         c.sort_order as filterSortOrder,
         coalesce((select count(*) from map_filter_members m2 where m2.category_id=c.id),0) as filterMemberCount
    from place_kinds pk
    left join map_filter_members m on m.place_kind_id=pk.id
    left join map_filter_categories c on c.id=m.category_id`;

export async function listMapFilters(env: Env): Promise<Response> {
  const [placeKinds, merchantFilter, groups, placeEntries] = await Promise.all([
    all<PlaceKindRow>(env.DB, `${PLACE_KIND_SELECT} order by pk.sort_order,pk.name,pk.id`),
    first<MerchantFilterRow>(
      env.DB,
      `select m.id as memberId,m.category_id as categoryId,c.key as filterKey,c.label as filterLabel,
              c.active as filterActive,c.sort_order as filterSortOrder,
              (select count(*) from merchant_outlets) as outletCount,
              (select count(*) from map_filter_members m2 where m2.category_id=c.id) as filterMemberCount
         from map_filter_members m
         join map_filter_categories c on c.id=m.category_id
        where m.includes_merchants=1`,
    ),
    // 一个按钮挂了不止一个成员（或一个都没挂）的历史数据。正常库里为空，所以界面
    // 平时看不到这一段；真出现了必须如实报出来 —— 那种按钮改名会牵连多个类型，
    // 而空按钮会被发版校验直接拒。
    all<FilterGroupRow>(
      env.DB,
      `select c.id,c.key,c.label,c.active,c.sort_order as sortOrder,
              (select count(*) from map_filter_members m where m.category_id=c.id) as memberCount,
              coalesce((
                select group_concat(case when m.place_kind_id is not null then pk.name
                                         when m.facility_type_id is not null then ft.name
                                         else '商户' end, '、')
                  from map_filter_members m
                  left join place_kinds pk on pk.id=m.place_kind_id
                  left join facility_types ft on ft.id=m.facility_type_id
                 where m.category_id=c.id
              ),'') as memberLabels
         from map_filter_categories c
        where (select count(*) from map_filter_members m where m.category_id=c.id) <> 1
        order by c.sort_order,c.label,c.id`,
    ),
    // 每个地点类型下到底有哪些地点。此前这里只给一个 usageCount 计数，界面上
    // 「建筑」下面挂了 121 个地点却一个都点不开。名称走 coalesce(当前修订, 最新修订)，
    // 草稿地点同样能显示出来 —— 与设施类型的 instances 一致。
    all<PlaceKindEntryRow>(
      env.DB,
      `select p.id,p.kind_id as kindId,
              coalesce(pr.display_name,
                (select r2.display_name from place_revisions r2 where r2.place_id=p.id order by r2.revision_no desc limit 1),
                p.id
              ) as displayName,
              p.lifecycle_status as lifecycleStatus,
              case when b.place_id is null then 0 else 1 end as isBuilding,
              p.campus_id as campusId,c.name as campusName,
              pr.editorial_status as editorialStatus
         from places p
         left join buildings b on b.place_id=p.id
         left join campuses c on c.id=p.campus_id
         left join place_revisions pr on pr.id=p.current_revision_id
        order by p.kind_id,displayName,p.id`,
    ),
  ]);
  const entriesByKind = new Map<string, PlaceKindEntryResponse[]>();
  for (const row of placeEntries) {
    const list = entriesByKind.get(row.kindId) ?? [];
    list.push({ ...row, isBuilding: Number(row.isBuilding) === 1 });
    entriesByKind.set(row.kindId, list);
  }
  return json({
    placeKinds: placeKinds.map((kind) => ({
      ...placeKindResponse(kind),
      entries: entriesByKind.get(kind.id) ?? [],
    })),
    merchants: merchantFilter === null ? null : {
      ...merchantFilter,
      filterActive: Number(merchantFilter.filterActive) === 1,
    },
    groups: groups.map((group) => ({ ...group, active: Number(group.active) === 1 })),
  });
}

async function getPlaceKindRow(env: Env, id: string): Promise<PlaceKindRow | null> {
  return first<PlaceKindRow>(env.DB, `${PLACE_KIND_SELECT} where pk.id=?`, [id]);
}

function placeKindResponse(row: PlaceKindRow) {
  return {
    ...row,
    isSearchable: Number(row.isSearchable) === 1,
    filterActive: row.filterActive === null ? null : Number(row.filterActive) === 1,
  };
}

export async function listPlaceKinds(env: Env): Promise<Response> {
  const rows = await all<PlaceKindRow>(env.DB, `${PLACE_KIND_SELECT} order by pk.sort_order,pk.name,pk.id`);
  return json({ items: rows.map(placeKindResponse) });
}

/**
 * POST /api/admin/place-kinds
 *
 * 不再要求调用方先挑一个标签：这里自己建一个筛选按钮并把新类型放进去。
 * 库里 19 个标签对应 19 个成员，一个标签从来没有装过两样东西，所以「选容器」
 * 这一步对维护者只是多一道无从判断的选择题。
 *
 * filterLabel 缺省时沿用类型名称。它们经常不同（`building`「建筑」的按钮叫
 * 「教学楼」，`residence`「宿舍」的按钮叫「宿舍楼」），所以仍然可以单独填、单独改。
 */
export async function createPlaceKind(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  requestId: string,
): Promise<Response> {
  const body = writeBody(await readJson<unknown>(request), "placeKind", [
    "id", "name", "sortOrder", "isSearchable", "filterLabel", "filterSortOrder",
  ], ["id", "name"]);
  const id = requiredString(body.id, "id", 80);
  if (!/^[a-z][a-z0-9_]*$/.test(id)) {
    throw new HttpError(400, "validation_error", "id must use lowercase letters, digits, and underscores");
  }
  const duplicate = await first<{ id: string }>(env.DB, "select id from place_kinds where id=?", [id]);
  if (duplicate) throw new HttpError(409, "duplicate_place_kind", "This place kind id already exists");
  const name = requiredString(body.name, "name", 100);
  const sortOrder = integer(body.sortOrder, "sortOrder", 100);
  const isSearchable = booleanValue(body.isSearchable, "isSearchable", true);
  const filterLabel = body.filterLabel === undefined
    ? name
    : requiredString(body.filterLabel, "filterLabel", 80);
  const filterSortOrder = integer(body.filterSortOrder, "filterSortOrder", sortOrder);
  const now = isoNow();
  const categoryId = makeId("mapfilter");
  const filterKeyValue = await allocateMapFilterKey(env, id);
  const memberId = makeId("mapfiltermember");
  const statements = [
    env.DB.prepare("insert into place_kinds(id,name,sort_order,is_searchable) values(?,?,?,?)")
      .bind(id, name, sortOrder, isSearchable ? 1 : 0),
    env.DB.prepare(
      "insert into map_filter_categories(id,key,label,active,sort_order,created_at,updated_at) values(?,?,?,1,?,?,?)",
    ).bind(categoryId, filterKeyValue, filterLabel, filterSortOrder, now, now),
    env.DB.prepare(
      `insert into map_filter_members(id,category_id,place_kind_id,facility_type_id,includes_merchants,sort_order,created_at)
       values(?,?,?,null,0,100,?)`,
    ).bind(memberId, categoryId, id, now),
  ];
  await env.DB.batch(statements);
  const after = await getPlaceKindRow(env, id);
  if (!after) throw new Error("Created place kind is unavailable");
  await audit(env, principal, "place_kind.create", "place_kind", id, requestId, null, placeKindResponse(after));
  return json(placeKindResponse(after), { status: 201 });
}

/**
 * PATCH /api/admin/place-kinds/:id
 *
 * 类型自身的属性和它那个筛选按钮的属性在同一个请求里改：维护者眼里这是一件事
 * （「宿舍这一类怎么显示」），拆成两个入口只会让人不知道该改哪边。
 *
 * 按钮下挂着不止一个成员时（历史数据）拒绝就地改按钮属性——那会牵连另一个类型，
 * 得先在异常分组里处理。
 */
export async function updatePlaceKind(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  id: string,
  requestId: string,
): Promise<Response> {
  const before = await getPlaceKindRow(env, id);
  if (!before) throw new HttpError(404, "not_found", "Place kind does not exist");
  const body = writeBody(await readJson<unknown>(request), "placeKindUpdate", [
    "name", "sortOrder", "isSearchable", "filterLabel", "filterSortOrder", "filterActive",
  ], [], true);
  const name = body.name === undefined ? before.name : requiredString(body.name, "name", 100);
  const sortOrder = body.sortOrder === undefined ? Number(before.sortOrder) : integer(body.sortOrder, "sortOrder");
  const isSearchable = body.isSearchable === undefined
    ? Number(before.isSearchable) === 1
    : booleanValue(body.isSearchable, "isSearchable");

  const touchesFilter = body.filterLabel !== undefined
    || body.filterSortOrder !== undefined
    || body.filterActive !== undefined;
  const statements = [
    env.DB.prepare("update place_kinds set name=?,sort_order=?,is_searchable=? where id=?")
      .bind(name, sortOrder, isSearchable ? 1 : 0, id),
  ];
  if (touchesFilter) {
    if (before.categoryId === null) {
      throw new HttpError(409, "place_kind_unmapped", "This place kind has no map filter of its own");
    }
    if (Number(before.filterMemberCount) > 1) {
      throw new HttpError(409, "map_filter_shared", "This map filter carries other members; edit it as a group first");
    }
    const filterLabel = body.filterLabel === undefined
      ? String(before.filterLabel)
      : requiredString(body.filterLabel, "filterLabel", 80);
    const filterSortOrder = body.filterSortOrder === undefined
      ? Number(before.filterSortOrder)
      : integer(body.filterSortOrder, "filterSortOrder");
    const filterActive = body.filterActive === undefined
      ? Number(before.filterActive) === 1
      : booleanValue(body.filterActive, "filterActive");
    // 停用一个还挂着在用地点的按钮会被 0012 的触发器拒掉。先在这里给出可读的错误，
    // 否则界面上只能看到一条原始的 SQLite abort 文本。
    if (Number(before.filterActive) === 1 && !filterActive && await categoryHasLiveUsage(env, before.categoryId)) {
      throw new HttpError(409, "map_filter_in_use", "A map filter with live members cannot be deactivated");
    }
    statements.push(
      env.DB.prepare("update map_filter_categories set label=?,active=?,sort_order=?,updated_at=? where id=?")
        .bind(filterLabel, filterActive ? 1 : 0, filterSortOrder, isoNow(), before.categoryId),
    );
  }
  await env.DB.batch(statements);
  const after = await getPlaceKindRow(env, id);
  if (!after) throw new Error("Updated place kind is unavailable");
  await audit(env, principal, "place_kind.update", "place_kind", id, requestId, placeKindResponse(before), placeKindResponse(after));
  return json(placeKindResponse(after));
}

/** 类型和它自己那个按钮一起删。留下一个空按钮会被发版校验拒绝。 */
export async function deletePlaceKind(
  env: Env,
  principal: SessionPrincipal,
  id: string,
  requestId: string,
): Promise<Response> {
  const before = await getPlaceKindRow(env, id);
  if (!before) throw new HttpError(404, "not_found", "Place kind does not exist");
  if (Number(before.placeCount) > 0) {
    throw new HttpError(409, "place_kind_in_use", "This place kind is assigned to places and cannot be deleted");
  }
  const statements = [env.DB.prepare("delete from map_filter_members where place_kind_id=?").bind(id)];
  if (before.categoryId !== null && Number(before.filterMemberCount) === 1) {
    statements.push(env.DB.prepare("delete from map_filter_categories where id=?").bind(before.categoryId));
  }
  statements.push(env.DB.prepare("delete from place_kinds where id=?").bind(id));
  await env.DB.batch(statements);
  await audit(env, principal, "place_kind.delete", "place_kind", id, requestId, placeKindResponse(before), null);
  return new Response(null, { status: 204 });
}

export async function createMapFilter(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  requestId: string,
): Promise<Response> {
  const body = writeBody(await readJson<unknown>(request), "mapFilter", [
    "key", "label", "active", "sortOrder",
  ], ["key", "label"]);
  const key = filterKey(body.key);
  await assertUniqueKey(env, key);
  const id = makeId("mapfilter");
  const now = isoNow();
  const active = booleanValue(body.active, "active", true);
  const sortOrder = integer(body.sortOrder, "sortOrder", 100);
  const label = requiredString(body.label, "label", 80);
  await env.DB.prepare(
    "insert into map_filter_categories(id,key,label,active,sort_order,created_at,updated_at) values(?,?,?,?,?,?,?)",
  ).bind(id, key, label, active ? 1 : 0, sortOrder, now, now).run();
  await audit(env, principal, "map_filter.create", "map_filter", id, requestId, null, { key, label, active, sortOrder });
  return json({ id, key, label, active, sortOrder, members: [] }, { status: 201 });
}

export async function updateMapFilter(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  id: string,
  requestId: string,
): Promise<Response> {
  const before = await first<Record<string, unknown>>(env.DB, "select * from map_filter_categories where id=?", [id]);
  if (!before) throw new HttpError(404, "not_found", "Map filter does not exist");
  const body = writeBody(await readJson<unknown>(request), "mapFilterUpdate", [
    "label", "active", "sortOrder",
  ], [], true);
  const key = String(before.key);
  const label = body.label === undefined ? String(before.label) : requiredString(body.label, "label", 80);
  const active = body.active === undefined ? Number(before.active) === 1 : booleanValue(body.active, "active");
  const sortOrder = body.sortOrder === undefined ? Number(before.sort_order) : integer(body.sortOrder, "sortOrder");
  if (Number(before.active) === 1 && !active && await categoryHasLiveUsage(env, id)) {
    throw new HttpError(409, "map_filter_in_use", "A map filter with live members cannot be deactivated");
  }
  await env.DB.prepare(
    "update map_filter_categories set key=?,label=?,active=?,sort_order=?,updated_at=? where id=?",
  ).bind(key, label, active ? 1 : 0, sortOrder, isoNow(), id).run();
  await audit(env, principal, "map_filter.update", "map_filter", id, requestId, before, { key, label, active, sortOrder });
  return json({ id, key, label, active, sortOrder });
}

export async function deleteMapFilter(
  env: Env,
  principal: SessionPrincipal,
  id: string,
  requestId: string,
): Promise<Response> {
  const before = await first<Record<string, unknown>>(env.DB, "select * from map_filter_categories where id=?", [id]);
  if (!before) throw new HttpError(404, "not_found", "Map filter does not exist");
  const member = await first<{ id: string }>(env.DB, "select id from map_filter_members where category_id=? limit 1", [id]);
  if (member) throw new HttpError(409, "map_filter_not_empty", "Remove every member before deleting this map filter");
  await env.DB.prepare("delete from map_filter_categories where id=?").bind(id).run();
  await audit(env, principal, "map_filter.delete", "map_filter", id, requestId, before, null);
  return new Response(null, { status: 204 });
}

export async function createMapFilterMember(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  categoryId: string,
  requestId: string,
): Promise<Response> {
  const category = await first<{ id: string; active: number }>(env.DB, "select id,active from map_filter_categories where id=?", [categoryId]);
  if (!category) throw new HttpError(404, "not_found", "Map filter does not exist");
  const body = writeBody(await readJson<unknown>(request), "mapFilterMember", [
    "placeKindId", "facilityTypeId", "includesMerchants", "sortOrder",
  ]);
  const target = memberTarget(body);
  await assertTargetExists(env, target);
  await assertTargetUnassigned(env, target);
  if (Number(category.active) !== 1 && await targetHasLiveUsage(env, target)) {
    throw new HttpError(409, "inactive_map_filter", "A live target must belong to an active map filter");
  }
  const id = makeId("mapfiltermember");
  const sortOrder = integer(body.sortOrder, "sortOrder", 100);
  const createdAt = isoNow();
  await env.DB.prepare(
    `insert into map_filter_members(id,category_id,place_kind_id,facility_type_id,includes_merchants,sort_order,created_at)
     values(?,?,?,?,?,?,?)`,
  ).bind(id, categoryId, target.placeKindId, target.facilityTypeId, target.includesMerchants, sortOrder, createdAt).run();
  const after = { id, categoryId, ...target, sortOrder };
  await audit(env, principal, "map_filter_member.create", "map_filter_member", id, requestId, null, after);
  return json(after, { status: 201 });
}

export async function updateMapFilterMember(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  id: string,
  requestId: string,
): Promise<Response> {
  const before = await first<Record<string, unknown>>(env.DB, "select * from map_filter_members where id=?", [id]);
  if (!before) throw new HttpError(404, "not_found", "Map filter member does not exist");
  const body = writeBody(await readJson<unknown>(request), "mapFilterMemberUpdate", [
    "categoryId", "sortOrder",
  ], [], true);
  const categoryId = body.categoryId === undefined
    ? String(before.category_id)
    : requiredString(body.categoryId, "categoryId", 100);
  if (body.categoryId !== undefined) {
    const category = await first<{ id: string; active: number }>(env.DB, "select id,active from map_filter_categories where id=?", [categoryId]);
    if (!category) throw new HttpError(400, "validation_error", "Map filter does not exist");
    if (Number(category.active) !== 1 && await memberHasLiveUsage(env, id)) {
      throw new HttpError(409, "inactive_map_filter", "A live member cannot move to an inactive map filter");
    }
  }
  const sortOrder = body.sortOrder === undefined ? Number(before.sort_order) : integer(body.sortOrder, "sortOrder");
  await env.DB.prepare("update map_filter_members set category_id=?,sort_order=? where id=?")
    .bind(categoryId, sortOrder, id).run();
  const after = { id, categoryId, sortOrder };
  await audit(env, principal, "map_filter_member.update", "map_filter_member", id, requestId, before, after);
  return json(after);
}

export async function deleteMapFilterMember(
  env: Env,
  principal: SessionPrincipal,
  id: string,
  requestId: string,
): Promise<Response> {
  const before = await first<{
    id: string;
    place_kind_id: string | null;
    facility_type_id: string | null;
    includes_merchants: number;
  }>(env.DB, "select id,place_kind_id,facility_type_id,includes_merchants from map_filter_members where id=?", [id]);
  if (!before) throw new HttpError(404, "not_found", "Map filter member does not exist");
  const inUse = await memberHasLiveUsage(env, id);
  if (inUse) throw new HttpError(409, "map_filter_member_in_use", "This target is in use and must remain assigned to a map filter");
  await env.DB.prepare("delete from map_filter_members where id=?").bind(id).run();
  await audit(env, principal, "map_filter_member.delete", "map_filter_member", id, requestId, before, null);
  return new Response(null, { status: 204 });
}
