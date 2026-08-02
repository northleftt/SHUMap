import type { SessionPrincipal } from "../domain/types";
import type { Env } from "../types/cloudflare";
import { all, first } from "../lib/db";
import { HttpError, json, readJson } from "../lib/http";
import { assertActiveMapFilterCategory } from "../lib/taxonomy";
import { isoNow, makeId, objectValue, requiredString } from "../lib/values";
import { audit } from "./audit";

interface MapFilterCategoryRow {
  id: string;
  key: string;
  label: string;
  active: number;
  sortOrder: number;
}

interface MapFilterMemberRow {
  id: string;
  categoryId: string;
  placeKindId: string | null;
  facilityTypeId: string | null;
  includesMerchants: number;
  sortOrder: number;
  targetLabel: string;
  targetCode: string | null;
  usageCount: number;
}

type MapFilterMemberResponse = Omit<MapFilterMemberRow, "includesMerchants"> & { includesMerchants: boolean };

interface MapFilterMemberTarget {
  placeKindId: string | null;
  facilityTypeId: string | null;
  includesMerchants: number;
}

interface PlaceKindRow {
  id: string;
  name: string;
  sortOrder: number;
  isSearchable: number;
  placeCount: number;
  mapFilterMemberId: string | null;
  categoryId: string | null;
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

export async function listMapFilters(env: Env): Promise<Response> {
  const [categories, members, placeKinds, facilityTypes, merchantMember] = await Promise.all([
    all<MapFilterCategoryRow>(
      env.DB,
      "select id,key,label,active,sort_order as sortOrder from map_filter_categories order by sort_order,label,id",
    ),
    all<MapFilterMemberRow>(
      env.DB,
      `select m.id,m.category_id as categoryId,m.place_kind_id as placeKindId,
              m.facility_type_id as facilityTypeId,m.includes_merchants as includesMerchants,
              m.sort_order as sortOrder,
              case when m.place_kind_id is not null then pk.name
                   when m.facility_type_id is not null then ft.name
                   else '商户' end as targetLabel,
              case when m.place_kind_id is not null then m.place_kind_id
                   when m.facility_type_id is not null then ft.code
                   else null end as targetCode,
              case when m.place_kind_id is not null then
                     (select count(*) from places p where p.kind_id=m.place_kind_id)
                   when m.facility_type_id is not null then
                     (select count(*) from facility_instances fi where fi.facility_type_id=m.facility_type_id)
                   else (select count(*) from merchant_outlets) end as usageCount
         from map_filter_members m
         left join place_kinds pk on pk.id=m.place_kind_id
         left join facility_types ft on ft.id=m.facility_type_id
        order by m.category_id,m.sort_order,m.created_at,m.id`,
    ),
    all<PlaceKindRow>(
      env.DB,
      `select pk.id,pk.name,pk.sort_order as sortOrder,pk.is_searchable as isSearchable,
              (select count(*) from places p where p.kind_id=pk.id) as placeCount,
              m.id as mapFilterMemberId,m.category_id as categoryId
         from place_kinds pk left join map_filter_members m on m.place_kind_id=pk.id
        order by pk.sort_order,pk.name,pk.id`,
    ),
    all<{ id: string; code: string; name: string; category: string }>(
      env.DB,
      `select ft.id,ft.code,ft.name,ft.category from facility_types ft
        where not exists(select 1 from map_filter_members m where m.facility_type_id=ft.id)
        order by ft.category,ft.name,ft.id`,
    ),
    first<{ id: string }>(env.DB, "select id from map_filter_members where includes_merchants=1"),
  ]);
  const membersByCategory = new Map<string, MapFilterMemberResponse[]>();
  for (const member of members) {
    membersByCategory.set(member.categoryId, [...(membersByCategory.get(member.categoryId) ?? []), {
      ...member,
      includesMerchants: Number(member.includesMerchants) === 1,
    }]);
  }
  const normalizedPlaceKinds = placeKinds.map((kind) => ({
    ...kind,
    isSearchable: Number(kind.isSearchable) === 1,
  }));
  return json({
    items: categories.map((category) => ({
      ...category,
      active: Number(category.active) === 1,
      members: membersByCategory.get(category.id) ?? [],
    })),
    placeKinds: normalizedPlaceKinds,
    unassigned: {
      placeKinds: normalizedPlaceKinds.filter((kind) => kind.categoryId === null),
      facilityTypes,
      includesMerchants: !merchantMember,
    },
  });
}

async function getPlaceKindRow(env: Env, id: string): Promise<PlaceKindRow | null> {
  return first<PlaceKindRow>(
    env.DB,
    `select pk.id,pk.name,pk.sort_order as sortOrder,pk.is_searchable as isSearchable,
            (select count(*) from places p where p.kind_id=pk.id) as placeCount,
            m.id as mapFilterMemberId,m.category_id as categoryId
       from place_kinds pk left join map_filter_members m on m.place_kind_id=pk.id where pk.id=?`,
    [id],
  );
}

function placeKindResponse(row: PlaceKindRow) {
  return { ...row, isSearchable: Number(row.isSearchable) === 1 };
}

export async function listPlaceKinds(env: Env): Promise<Response> {
  const rows = await all<PlaceKindRow>(
    env.DB,
    `select pk.id,pk.name,pk.sort_order as sortOrder,pk.is_searchable as isSearchable,
            (select count(*) from places p where p.kind_id=pk.id) as placeCount,
            m.id as mapFilterMemberId,m.category_id as categoryId
       from place_kinds pk left join map_filter_members m on m.place_kind_id=pk.id
      order by pk.sort_order,pk.name,pk.id`,
  );
  return json({ items: rows.map(placeKindResponse) });
}

export async function createPlaceKind(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  requestId: string,
): Promise<Response> {
  const body = writeBody(await readJson<unknown>(request), "placeKind", [
    "id", "name", "sortOrder", "isSearchable", "categoryId",
  ], ["id", "name", "categoryId"]);
  const id = requiredString(body.id, "id", 80);
  if (!/^[a-z][a-z0-9_]*$/.test(id)) {
    throw new HttpError(400, "validation_error", "id must use lowercase letters, digits, and underscores");
  }
  const duplicate = await first<{ id: string }>(env.DB, "select id from place_kinds where id=?", [id]);
  if (duplicate) throw new HttpError(409, "duplicate_place_kind", "This place kind id already exists");
  const name = requiredString(body.name, "name", 100);
  const sortOrder = integer(body.sortOrder, "sortOrder", 100);
  const isSearchable = booleanValue(body.isSearchable, "isSearchable", true);
  const categoryId = requiredString(body.categoryId, "categoryId", 100);
  await assertActiveMapFilterCategory(env, categoryId);
  const now = isoNow();
  const memberId = makeId("mapfiltermember");
  const statements = [
    env.DB.prepare("insert into place_kinds(id,name,sort_order,is_searchable) values(?,?,?,?)")
      .bind(id, name, sortOrder, isSearchable ? 1 : 0),
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
    "name", "sortOrder", "isSearchable",
  ], [], true);
  const name = body.name === undefined ? before.name : requiredString(body.name, "name", 100);
  const sortOrder = body.sortOrder === undefined ? Number(before.sortOrder) : integer(body.sortOrder, "sortOrder");
  const isSearchable = body.isSearchable === undefined
    ? Number(before.isSearchable) === 1
    : booleanValue(body.isSearchable, "isSearchable");
  await env.DB.prepare("update place_kinds set name=?,sort_order=?,is_searchable=? where id=?")
    .bind(name, sortOrder, isSearchable ? 1 : 0, id).run();
  const after = await getPlaceKindRow(env, id);
  if (!after) throw new Error("Updated place kind is unavailable");
  await audit(env, principal, "place_kind.update", "place_kind", id, requestId, placeKindResponse(before), placeKindResponse(after));
  return json(placeKindResponse(after));
}

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
  await env.DB.batch([
    env.DB.prepare("delete from map_filter_members where place_kind_id=?").bind(id),
    env.DB.prepare("delete from place_kinds where id=?").bind(id),
  ]);
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
