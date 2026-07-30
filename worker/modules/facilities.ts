import type { FacilityRevisionInput, LocationInput, SessionPrincipal } from "../domain/types";
import type { D1PreparedStatement, Env } from "../types/cloudflare";
import { all, assertExists, first } from "../lib/db";
import { HttpError, json, readJson } from "../lib/http";
import { isoNow, jsonString, makeId, objectValue, optionalNumber, optionalString, requiredString, sha256 } from "../lib/values";
import { audit } from "./audit";
import { createLocation, planLocation } from "./locations";

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

/**
 * PATCH /api/admin/facilities/:id — 结构字段直接生效，不走修订流。
 *
 * 同 places：facility_revisions 只承载 displayName/serviceHours/content/sourceId，
 * 实例挂接关系（设施类型、所属楼宇、楼层、室内空间）在 facility_instances 上，
 * 修订表没有对应列，所以这些字段即时写库 + 记审计。
 */
export async function updateFacilityHandler(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  facilityId: string,
  requestId: string,
): Promise<Response> {
  const before = await first<Record<string, unknown>>(
    env.DB,
    "select id,facility_type_id,host_place_id,floor_id,indoor_space_id,operational_status,quantity from facility_instances where id=?",
    [facilityId],
  );
  if (!before) throw new HttpError(404, "not_found", "Facility does not exist");

  const body = await readJson<Record<string, unknown>>(request);
  const facilityTypeId = body.facilityTypeId === undefined
    ? String(before.facility_type_id)
    : requiredString(body.facilityTypeId, "facilityTypeId", 100);
  const hostPlaceId = body.hostPlaceId === undefined
    ? (before.host_place_id === null ? null : String(before.host_place_id))
    : optionalString(body.hostPlaceId, "hostPlaceId", 100);
  // 换楼宇时旧楼层必然失效：显式传了 floorId 用新值，否则楼宇变动就清空。
  const floorId = body.floorId !== undefined
    ? optionalString(body.floorId, "floorId", 100)
    : hostPlaceId === (before.host_place_id ?? null)
      ? (before.floor_id === null ? null : String(before.floor_id))
      : null;
  const indoorSpaceId = body.indoorSpaceId !== undefined
    ? optionalString(body.indoorSpaceId, "indoorSpaceId", 100)
    : floorId === (before.floor_id ?? null)
      ? (before.indoor_space_id === null ? null : String(before.indoor_space_id))
      : null;
  const operationalStatus = body.operationalStatus === undefined
    ? String(before.operational_status)
    : requiredString(body.operationalStatus, "operationalStatus", 30);
  if (!["available", "partially_available", "unavailable", "unknown"].includes(operationalStatus)) {
    throw new HttpError(400, "validation_error", "Invalid operationalStatus");
  }

  await Promise.all([
    assertExists(env.DB, "facility_types", facilityTypeId, "Facility type"),
    assertExists(env.DB, "places", hostPlaceId, "Host place"),
    assertExists(env.DB, "floors", floorId, "Floor"),
    assertExists(env.DB, "indoor_spaces", indoorSpaceId, "Indoor space"),
  ]);
  await validateHierarchy(env, hostPlaceId, floorId, indoorSpaceId);

  const now = isoNow();
  await env.DB.prepare(
    `update facility_instances set facility_type_id=?,host_place_id=?,floor_id=?,indoor_space_id=?,operational_status=?,updated_at=? where id=?`,
  ).bind(facilityTypeId, hostPlaceId, floorId, indoorSpaceId, operationalStatus, now, facilityId).run();
  await audit(env, principal, "facility.update", "facility", facilityId, requestId, before, {
    facilityTypeId, hostPlaceId, floorId, indoorSpaceId, operationalStatus,
  });
  return json({ id: facilityId, facilityTypeId, hostPlaceId, floorId, indoorSpaceId, operationalStatus });
}

/**
 * PUT /api/admin/facilities/:id/location — 服务位置锚点的 replace-all。
 *
 * 与 W-B 的运营事件 replaceOperationalEventLocations 同一模式：先整体校验，再在
 * 一个 DB.batch 里删旧 binding + anchor 并写新的，校验失败不会留下半截状态。
 * 设施只保留一个 role='service_position' 锚点（M5 楼层徽章一个设施一个点），
 * 传空 body（既无 geometry 也无 locationHint）即清空。
 */
export async function replaceFacilityLocation(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  facilityId: string,
  requestId: string,
): Promise<Response> {
  const facility = await first<{ id: string; host_place_id: string | null; floor_id: string | null; indoor_space_id: string | null }>(
    env.DB,
    "select id,host_place_id,floor_id,indoor_space_id from facility_instances where id=?",
    [facilityId],
  );
  if (!facility) throw new HttpError(404, "not_found", "Facility does not exist");

  const body = await readJson<Record<string, unknown>>(request);
  const locationHint = optionalString(body.locationHint, "locationHint", 500);
  const mapVersionId = optionalString(body.mapVersionId, "mapVersionId", 100);
  const point = body.point === undefined || body.point === null ? null : objectValue(body.point, "point");
  let geometry: { type: "Point"; coordinates: [number, number] } | null = null;
  if (point) {
    const x = optionalNumber(point.x, "point.x");
    const y = optionalNumber(point.y, "point.y");
    if (x === null || y === null) throw new HttpError(400, "validation_error", "point requires numeric x and y");
    geometry = { type: "Point", coordinates: [x, y] };
  }
  if (geometry && !mapVersionId) {
    throw new HttpError(400, "validation_error", "A map version is required for a plan coordinate");
  }

  const previous = await all<{ bindingId: string; anchorId: string }>(
    env.DB,
    `select el.id as bindingId,el.anchor_id as anchorId from entity_locations el
      where el.entity_type='facility' and el.entity_id=?`,
    [facilityId],
  );

  const now = isoNow();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("delete from entity_locations where entity_type='facility' and entity_id=?").bind(facilityId),
  ];
  if (previous.length > 0) {
    const anchorIds = previous.map((row) => row.anchorId);
    statements.push(
      env.DB.prepare(`delete from location_anchors where id in (${anchorIds.map(() => "?").join(",")})`).bind(...anchorIds),
    );
  }

  let anchorId: string | null = null;
  if (geometry || locationHint) {
    const plan = await planLocation(
      env,
      "facility",
      facilityId,
      {
        role: "service_position",
        floorId: facility.floor_id,
        buildingPlaceId: facility.host_place_id,
        indoorSpaceId: facility.indoor_space_id,
        geometryType: geometry ? "Point" : null,
        geometry: geometry ?? undefined,
        crs: geometry ? "svg_viewbox" : null,
        mapVersionId: geometry ? mapVersionId : null,
        locationHint,
        precisionLevel: geometry ? "exact" : facility.floor_id ? "floor" : "building",
      },
      principal,
      true,
      now,
    );
    anchorId = plan.anchorId;
    statements.push(...plan.statements);
  }
  statements.push(env.DB.prepare("update facility_instances set updated_at=? where id=?").bind(now, facilityId));
  await env.DB.batch(statements);

  await audit(env, principal, "facility.location.replace", "facility", facilityId, requestId,
    { locations: previous }, { anchorId, mapVersionId, point: geometry?.coordinates ?? null, locationHint });
  return json({ id: facilityId, removed: previous.length, anchorId });
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
