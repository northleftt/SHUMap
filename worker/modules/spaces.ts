import type { SessionPrincipal } from "../domain/types";
import type { Env } from "../types/cloudflare";
import { all, assertExists, first } from "../lib/db";
import { HttpError, json, readJson } from "../lib/http";
import {
  booleanValue,
  exactObject,
  isoNow,
  jsonString,
  makeId,
  numberValue,
  objectValue,
  oneOf,
  optionalString,
  partialObject,
  requiredString,
} from "../lib/values";
import { audit } from "./audit";

const SPACE_TYPES = ["room", "zone", "corridor", "entrance", "stair", "elevator", "service_area", "other"] as const;
const SOURCE_TYPES = ["official", "survey", "import", "community", "derived"] as const;
const SOURCE_RELIABILITIES = ["authoritative", "reviewed", "unverified", "unknown"] as const;

export async function listCampusesAndSpaces(env: Env): Promise<Response> {
  const [campuses, buildings, floors, spaces] = await Promise.all([
    all(env.DB, "select id,code,name,timezone,status from campuses order by name"),
    all(env.DB, `select b.place_id as placeId,b.building_code as buildingCode,b.managing_organization_id as managingOrganizationId,
      b.public_access_level as publicAccessLevel,r.display_name as displayName,p.campus_id as campusId
      from buildings b join places p on p.id=b.place_id left join place_revisions r on r.id=p.current_revision_id order by r.display_name`),
    all(env.DB, "select id,building_place_id as buildingPlaceId,level_code as levelCode,level_order as levelOrder,display_name as displayName,is_public as isPublic,lifecycle_status as lifecycleStatus from floors order by building_place_id,level_order"),
    all(env.DB, "select id,floor_id as floorId,parent_space_id as parentSpaceId,space_type as spaceType,stable_code as stableCode,display_name as displayName,lifecycle_status as lifecycleStatus from indoor_spaces order by floor_id,display_name"),
  ]);
  return json({ campuses, buildings, floors, spaces });
}

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
  const levelOrder = numberValue(body.levelOrder, "levelOrder");
  const isPublic = booleanValue(body.isPublic, "isPublic");
  const id = makeId("floor");
  const now = isoNow();
  await env.DB.prepare(
    `insert into floors(id,building_place_id,level_code,level_order,display_name,is_public,lifecycle_status,created_at,updated_at)
     values(?,?,?,?,?,?,'active',?,?)`,
  ).bind(
    id,
    buildingPlaceId,
    requiredString(body.levelCode, "levelCode", 30),
    levelOrder,
    requiredString(body.displayName, "displayName", 100),
    isPublic ? 1 : 0,
    now,
    now,
  ).run();
  await audit(env, principal, "floor.create", "floor", id, requestId, null, body);
  return json({ id }, { status: 201 });
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

export async function createSpace(request: Request, env: Env, principal: SessionPrincipal, requestId: string): Promise<Response> {
  const body = exactObject(await readJson<unknown>(request), "indoorSpace", [
    "floorId",
    "parentSpaceId",
    "spaceType",
    "stableCode",
    "displayName",
  ]);
  const floorId = requiredString(body.floorId, "floorId", 100);
  const parentSpaceId = optionalString(body.parentSpaceId, "parentSpaceId", 100);
  await Promise.all([assertExists(env.DB, "floors", floorId, "Floor"), assertExists(env.DB, "indoor_spaces", parentSpaceId, "Parent space")]);
  if (parentSpaceId) {
    const parent = await first<{ floor_id: string }>(env.DB, "select floor_id from indoor_spaces where id=?", [parentSpaceId]);
    if (parent?.floor_id !== floorId) throw new HttpError(400, "invalid_spatial_hierarchy", "Parent space belongs to another floor");
  }
  const spaceType = oneOf(body.spaceType, "spaceType", SPACE_TYPES);
  const id = makeId("space");
  const now = isoNow();
  await env.DB.prepare(
    `insert into indoor_spaces(id,floor_id,parent_space_id,space_type,stable_code,display_name,lifecycle_status,created_at,updated_at)
     values(?,?,?,?,?,?,'active',?,?)`,
  ).bind(id, floorId, parentSpaceId, spaceType, optionalString(body.stableCode, "stableCode", 100), requiredString(body.displayName, "displayName", 200), now, now).run();
  await audit(env, principal, "space.create", "indoor_space", id, requestId, null, body);
  return json({ id }, { status: 201 });
}

export async function createDataSource(request: Request, env: Env, principal: SessionPrincipal, requestId: string): Promise<Response> {
  const body = exactObject(await readJson<unknown>(request), "dataSource", [
    "sourceType",
    "title",
    "organizationId",
    "url",
    "license",
    "obtainedAt",
    "reliability",
    "metadata",
  ]);
  const sourceType = oneOf(body.sourceType, "sourceType", SOURCE_TYPES);
  const organizationId = optionalString(body.organizationId, "organizationId", 100);
  await assertExists(env.DB, "organizations", organizationId, "Organization");
  const reliability = oneOf(body.reliability, "reliability", SOURCE_RELIABILITIES);
  const metadataJson = jsonString(objectValue(body.metadata, "metadata"));
  const id = makeId("source");
  await env.DB.prepare(
    `insert into data_sources(id,source_type,title,organization_id,url,license,obtained_at,reliability,metadata_json,created_at)
     values(?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    id,
    sourceType,
    requiredString(body.title, "title", 300),
    organizationId,
    optionalString(body.url, "url", 1000),
    optionalString(body.license, "license", 200),
    optionalString(body.obtainedAt, "obtainedAt", 50),
    reliability,
    metadataJson,
    isoNow(),
  ).run();
  await audit(env, principal, "data_source.create", "data_source", id, requestId, null, body);
  return json({ id }, { status: 201 });
}

export async function listReferenceData(env: Env): Promise<Response> {
  const [organizations, sources, facilityTypes, placeKinds] = await Promise.all([
    all(env.DB, "select * from organizations where status='active' order by name"),
    all(env.DB, "select * from data_sources order by created_at desc"),
    all(env.DB, "select * from facility_types where status='active' order by category,name"),
    all(env.DB, "select * from place_kinds order by sort_order"),
  ]);
  return json({ organizations, sources, facilityTypes, placeKinds });
}
