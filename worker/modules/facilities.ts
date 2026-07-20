import type { FacilityRevisionInput, LocationInput, SessionPrincipal } from "../domain/types";
import type { Env } from "../types/cloudflare";
import { all, assertExists, first } from "../lib/db";
import { HttpError, json, readJson } from "../lib/http";
import { isoNow, jsonString, makeId, objectValue, optionalNumber, optionalString, requiredString, sha256 } from "../lib/values";
import { audit } from "./audit";
import { createLocation } from "./locations";

interface CreateFacilityBody extends FacilityRevisionInput {
  facilityTypeId: string;
  hostPlaceId?: string | null;
  floorId?: string | null;
  indoorSpaceId?: string | null;
  quantity?: number | null;
  operationalStatus?: string;
  locations?: Array<LocationInput & { isPrimary?: boolean }>;
}

export async function listFacilities(env: Env): Promise<Response> {
  const items = await all(
    env.DB,
    `select f.id,f.facility_type_id as facilityTypeId,t.name as facilityTypeName,f.host_place_id as hostPlaceId,
            f.floor_id as floorId,f.indoor_space_id as indoorSpaceId,f.lifecycle_status as lifecycleStatus,
            f.operational_status as operationalStatus,f.quantity,r.id as currentRevisionId,r.display_name as displayName,r.editorial_status as editorialStatus,
            f.last_verified_at as lastVerifiedAt,f.next_verification_due_at as nextVerificationDueAt
       from facility_instances f join facility_types t on t.id=f.facility_type_id
       left join facility_revisions r on r.id=coalesce(
         (select pending.id from facility_revisions pending
           where pending.facility_id=f.id and pending.editorial_status in ('draft','in_review')
           order by case pending.editorial_status when 'in_review' then 0 else 1 end,pending.revision_no desc limit 1),
         f.current_revision_id
       ) order by coalesce(r.display_name,t.name)`,
  );
  return json({ items });
}

export async function getFacility(env: Env, id: string): Promise<Response> {
  const facility = await first<Record<string, unknown>>(
    env.DB,
    `select f.*,r.display_name,r.service_hours_json,r.content_json,r.source_id,r.editorial_status
       from facility_instances f left join facility_revisions r on r.id=coalesce(
         (select pending.id from facility_revisions pending
           where pending.facility_id=f.id and pending.editorial_status in ('draft','in_review')
           order by case pending.editorial_status when 'in_review' then 0 else 1 end,pending.revision_no desc limit 1),
         f.current_revision_id
       ) where f.id=?`,
    [id],
  );
  if (!facility) throw new HttpError(404, "not_found", "Facility does not exist");
  const [revisions, locations] = await Promise.all([
    all(env.DB, "select * from facility_revisions where facility_id=? order by revision_no desc", [id]),
    all(
      env.DB,
      `select el.id as bindingId,el.role,el.is_primary as isPrimary,la.* from entity_locations el
       join location_anchors la on la.id=el.anchor_id where el.entity_type='facility' and el.entity_id=? and el.valid_to is null`,
      [id],
    ),
  ]);
  return json({ facility, revisions, locations });
}

export async function createFacilityHandler(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  requestId: string,
): Promise<Response> {
  const body = await readJson<CreateFacilityBody>(request);
  const facilityTypeId = requiredString(body.facilityTypeId, "facilityTypeId", 100);
  const hostPlaceId = optionalString(body.hostPlaceId, "hostPlaceId", 100);
  const floorId = optionalString(body.floorId, "floorId", 100);
  const indoorSpaceId = optionalString(body.indoorSpaceId, "indoorSpaceId", 100);
  const quantity = optionalNumber(body.quantity, "quantity");
  if (quantity !== null && (!Number.isInteger(quantity) || quantity <= 0)) {
    throw new HttpError(400, "validation_error", "quantity must be a positive integer");
  }
  const operationalStatus = body.operationalStatus ?? "unknown";
  if (!["available", "partially_available", "unavailable", "unknown"].includes(operationalStatus)) {
    throw new HttpError(400, "validation_error", "Invalid operationalStatus");
  }
  const revision = normalizeRevision(body);
  await Promise.all([
    assertExists(env.DB, "facility_types", facilityTypeId, "Facility type"),
    assertExists(env.DB, "places", hostPlaceId, "Host place"),
    assertExists(env.DB, "floors", floorId, "Floor"),
    assertExists(env.DB, "indoor_spaces", indoorSpaceId, "Indoor space"),
    assertExists(env.DB, "data_sources", revision.sourceId, "Data source"),
  ]);
  await validateHierarchy(env, hostPlaceId, floorId, indoorSpaceId);

  const facilityId = makeId("facility");
  const revisionId = makeId("frev");
  const now = isoNow();
  const contentJson = jsonString(revision.content);
  const serviceHoursJson = revision.serviceHours === undefined ? null : jsonString(revision.serviceHours);
  const contentHash = await sha256(`${revision.displayName}\n${serviceHoursJson ?? ""}\n${contentJson}`);
  await env.DB.batch([
    env.DB.prepare(
      `insert into facility_instances(id,facility_type_id,host_place_id,floor_id,indoor_space_id,lifecycle_status,operational_status,quantity,created_at,updated_at)
       values(?,?,?,?,?,'active',?,?,?,?)`,
    ).bind(facilityId, facilityTypeId, hostPlaceId, floorId, indoorSpaceId, operationalStatus, quantity, now, now),
    env.DB.prepare(
      `insert into facility_revisions(id,facility_id,revision_no,editorial_status,display_name,service_hours_json,content_json,source_id,content_hash,created_by,created_at)
       values(?,?,1,'draft',?,?,?,?,?,?,?)`,
    ).bind(revisionId, facilityId, revision.displayName, serviceHoursJson, contentJson, revision.sourceId ?? null, contentHash, principal.userId, now),
  ]);
  for (const [index, location] of (body.locations ?? []).entries()) {
    await createLocation(env, "facility", facilityId, location, principal, location.isPrimary ?? index === 0);
  }
  await audit(env, principal, "facility.create", "facility", facilityId, requestId, null, { ...body, revisionId });
  return json({ id: facilityId, revisionId, editorialStatus: "draft" }, { status: 201 });
}

export async function createFacilityRevisionHandler(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  facilityId: string,
  requestId: string,
): Promise<Response> {
  const facility = await first<{ id: string; current_revision_id: string | null }>(env.DB, "select id,current_revision_id from facility_instances where id=?", [facilityId]);
  if (!facility) throw new HttpError(404, "not_found", "Facility does not exist");
  const pending = await first<{ id: string; editorial_status: string; revision_no: number }>(
    env.DB,
    `select id,editorial_status,revision_no from facility_revisions
      where facility_id=? and editorial_status in ('draft','in_review')
      order by case editorial_status when 'in_review' then 0 else 1 end,revision_no desc limit 1`,
    [facilityId],
  );
  if (pending?.editorial_status === "in_review") {
    throw new HttpError(409, "revision_in_review", "This facility already has a revision in review");
  }
  const body = await readJson<FacilityRevisionInput>(request);
  const revision = normalizeRevision(body);
  await assertExists(env.DB, "data_sources", revision.sourceId, "Data source");
  const next = await first<{ next_no: number }>(env.DB, "select coalesce(max(revision_no),0)+1 as next_no from facility_revisions where facility_id=?", [facilityId]);
  const revisionId = pending?.id ?? makeId("frev");
  const now = isoNow();
  const contentJson = jsonString(revision.content);
  const serviceHoursJson = revision.serviceHours === undefined ? null : jsonString(revision.serviceHours);
  const hash = await sha256(`${revision.displayName}\n${serviceHoursJson ?? ""}\n${contentJson}`);
  await env.DB.batch([
    pending
      ? env.DB.prepare(
        `update facility_revisions set display_name=?,service_hours_json=?,content_json=?,source_id=?,content_hash=?,created_by=?,created_at=?
          where id=? and editorial_status='draft'`,
      ).bind(revision.displayName, serviceHoursJson, contentJson, revision.sourceId ?? null, hash, principal.userId, now, revisionId)
      : env.DB.prepare(
        `insert into facility_revisions(id,facility_id,revision_no,editorial_status,display_name,service_hours_json,content_json,source_id,based_on_revision_id,content_hash,created_by,created_at)
         values(?,?,?,'draft',?,?,?,?,?,?,?,?)`,
      ).bind(revisionId, facilityId, next?.next_no ?? 1, revision.displayName, serviceHoursJson, contentJson, revision.sourceId ?? null, facility.current_revision_id, hash, principal.userId, now),
    env.DB.prepare("update facility_instances set updated_at=? where id=?").bind(now, facilityId),
  ]);
  await audit(env, principal, "facility.revision.create", "facility_revision", revisionId, requestId, null, revision);
  return json({ id: revisionId, facilityId, revisionNo: pending?.revision_no ?? next?.next_no ?? 1, editorialStatus: "draft" }, { status: pending ? 200 : 201 });
}

function normalizeRevision(input: FacilityRevisionInput) {
  return {
    displayName: requiredString(input.displayName, "displayName", 200),
    serviceHours: input.serviceHours,
    content: objectValue(input.content, "content"),
    sourceId: optionalString(input.sourceId, "sourceId", 100),
  };
}

async function validateHierarchy(env: Env, placeId: string | null, floorId: string | null, spaceId: string | null) {
  if (floorId && placeId) {
    const floor = await first<{ building_place_id: string }>(env.DB, "select building_place_id from floors where id=?", [floorId]);
    if (floor?.building_place_id !== placeId) throw new HttpError(400, "invalid_spatial_hierarchy", "Floor does not belong to host place");
  }
  if (spaceId && floorId) {
    const space = await first<{ floor_id: string }>(env.DB, "select floor_id from indoor_spaces where id=?", [spaceId]);
    if (space?.floor_id !== floorId) throw new HttpError(400, "invalid_spatial_hierarchy", "Space does not belong to floor");
  }
}
