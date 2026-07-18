import type { SessionPrincipal } from "../domain/types";
import type { Env } from "../types/cloudflare";
import { all, assertExists, first } from "../lib/db";
import { HttpError, json, readJson } from "../lib/http";
import { isoNow, makeId, optionalNumber, optionalString, requiredString } from "../lib/values";
import { audit } from "./audit";

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
  const body = await readJson<Record<string, unknown>>(request);
  const buildingPlaceId = requiredString(body.buildingPlaceId, "buildingPlaceId", 100);
  await assertExists(env.DB, "buildings", buildingPlaceId, "Building");
  const levelOrder = optionalNumber(body.levelOrder, "levelOrder");
  if (levelOrder === null) throw new HttpError(400, "validation_error", "levelOrder is required");
  const id = makeId("floor");
  const now = isoNow();
  await env.DB.prepare(
    `insert into floors(id,building_place_id,level_code,level_order,display_name,is_public,lifecycle_status,created_at,updated_at)
     values(?,?,?,?,?,?,'active',?,?)`,
  ).bind(id, buildingPlaceId, requiredString(body.levelCode, "levelCode", 30), levelOrder, requiredString(body.displayName, "displayName", 100), body.isPublic === false ? 0 : 1, now, now).run();
  await audit(env, principal, "floor.create", "floor", id, requestId, null, body);
  return json({ id }, { status: 201 });
}

export async function createSpace(request: Request, env: Env, principal: SessionPrincipal, requestId: string): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request);
  const floorId = requiredString(body.floorId, "floorId", 100);
  const parentSpaceId = optionalString(body.parentSpaceId, "parentSpaceId", 100);
  await Promise.all([assertExists(env.DB, "floors", floorId, "Floor"), assertExists(env.DB, "indoor_spaces", parentSpaceId, "Parent space")]);
  if (parentSpaceId) {
    const parent = await first<{ floor_id: string }>(env.DB, "select floor_id from indoor_spaces where id=?", [parentSpaceId]);
    if (parent?.floor_id !== floorId) throw new HttpError(400, "invalid_spatial_hierarchy", "Parent space belongs to another floor");
  }
  const spaceType = requiredString(body.spaceType, "spaceType", 50);
  if (!["room", "zone", "corridor", "entrance", "stair", "elevator", "service_area", "other"].includes(spaceType)) {
    throw new HttpError(400, "validation_error", "Invalid spaceType");
  }
  const id = makeId("space");
  const now = isoNow();
  await env.DB.prepare(
    `insert into indoor_spaces(id,floor_id,parent_space_id,space_type,stable_code,display_name,lifecycle_status,created_at,updated_at)
     values(?,?,?,?,?,?,'active',?,?)`,
  ).bind(id, floorId, parentSpaceId, spaceType, optionalString(body.stableCode, "stableCode", 100), requiredString(body.displayName, "displayName", 200), now, now).run();
  await audit(env, principal, "space.create", "indoor_space", id, requestId, null, body);
  return json({ id }, { status: 201 });
}

export async function createOrganization(request: Request, env: Env, principal: SessionPrincipal, requestId: string): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request);
  const id = makeId("org");
  const now = isoNow();
  await env.DB.prepare("insert into organizations(id,name,kind,status,created_at,updated_at) values(?,?,?,'active',?,?)")
    .bind(id, requiredString(body.name, "name", 200), optionalString(body.kind, "kind", 50) ?? "department", now, now).run();
  await audit(env, principal, "organization.create", "organization", id, requestId, null, body);
  return json({ id }, { status: 201 });
}

export async function createDataSource(request: Request, env: Env, principal: SessionPrincipal, requestId: string): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request);
  const sourceType = requiredString(body.sourceType, "sourceType", 30);
  if (!["official", "survey", "import", "community", "derived"].includes(sourceType)) throw new HttpError(400, "validation_error", "Invalid sourceType");
  const organizationId = optionalString(body.organizationId, "organizationId", 100);
  await assertExists(env.DB, "organizations", organizationId, "Organization");
  const id = makeId("source");
  await env.DB.prepare(
    `insert into data_sources(id,source_type,title,organization_id,url,license,obtained_at,reliability,metadata_json,created_at)
     values(?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, sourceType, requiredString(body.title, "title", 300), organizationId, optionalString(body.url, "url", 1000), optionalString(body.license, "license", 200), optionalString(body.obtainedAt, "obtainedAt", 50), optionalString(body.reliability, "reliability", 30) ?? "unknown", JSON.stringify(body.metadata ?? {}), isoNow()).run();
  await audit(env, principal, "data_source.create", "data_source", id, requestId, null, body);
  return json({ id }, { status: 201 });
}

export async function listReferenceData(env: Env): Promise<Response> {
  const [organizations, sources, facilityTypes, placeKinds] = await Promise.all([
    all(env.DB, "select * from organizations where status='active' order by name"),
    all(env.DB, "select * from data_sources order by created_at desc"),
    all(env.DB, "select * from facility_types order by category,name"),
    all(env.DB, "select * from place_kinds order by sort_order"),
  ]);
  return json({ organizations, sources, facilityTypes, placeKinds });
}
