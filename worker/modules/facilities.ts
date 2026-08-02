import type { SessionPrincipal } from "../domain/types";
import type { Env } from "../types/cloudflare";
import { all, first } from "../lib/db";
import { HttpError, json, readJson } from "../lib/http";
import { isoNow, jsonString, makeId, sha256 } from "../lib/values";
import { normalizeFacilityRevision, validateFacilityRevision } from "../lib/revision-contracts";
import { audit } from "./audit";
import { listEntityLocations } from "./locations";

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

/**
 * GET /api/public/facility-status — 设施运营状态的实时读端。
 *
 * 「充电桩坏了」必须立刻对用户生效，而 manifest 里的 operationalStatus 是发布快照，
 * 所以状态单独走这条实时通道，客户端拿它盖在快照上。行过滤与 release 查询一致：
 * 只出 lifecycle active、approval_pending=0 的设施，未审的改动不会从这里漏出去。
 */
export async function publicFacilityStatus(env: Env): Promise<Response> {
  const rows = await all<{ id: string; operationalStatus: string }>(
    env.DB,
    `select id,operational_status as operationalStatus from facility_instances
      where lifecycle_status='active' and approval_pending=0`,
  );
  const statuses: Record<string, string> = {};
  for (const row of rows) statuses[row.id] = row.operationalStatus;
  return json({ statuses }, { headers: { "cache-control": "public, max-age=30" } });
}

export async function getFacility(env: Env, id: string): Promise<Response> {
  const facility = await first<Record<string, unknown>>(
    env.DB,
    `select f.*,r.display_name,r.service_hours_json,r.content_json,r.structure_json,r.source_id,r.editorial_status
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
    listEntityLocations(env, "facility", id),
  ]);
  return json({ facility, revisions, locations });
}

export async function createFacilityHandler(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  requestId: string,
): Promise<Response> {
  const revision = normalizeFacilityRevision(await readJson<unknown>(request));
  await validateFacilityRevision(env, revision);
  const { facilityTypeId, hostPlaceId, floorId, indoorSpaceId, quantity, operationalStatus, locations } = revision.structure;

  const facilityId = makeId("facility");
  const revisionId = makeId("frev");
  const now = isoNow();
  const contentJson = jsonString(revision.content);
  const structureJson = jsonString({ facilityTypeId, hostPlaceId, floorId, indoorSpaceId, quantity, operationalStatus, locations });
  const serviceHoursJson = revision.serviceHours === null ? null : jsonString(revision.serviceHours);
  const contentHash = await sha256(`${revision.displayName}\n${serviceHoursJson ?? ""}\n${contentJson}\n${structureJson}`);
  await env.DB.batch([
    env.DB.prepare(
      `insert into facility_instances(id,facility_type_id,host_place_id,floor_id,indoor_space_id,lifecycle_status,approval_pending,operational_status,quantity,created_at,updated_at)
       values(?,?,?,?,?,'planned',1,?,?,?,?)`,
    ).bind(facilityId, facilityTypeId, hostPlaceId, floorId, indoorSpaceId, operationalStatus, quantity, now, now),
    env.DB.prepare(
      `insert into facility_revisions(id,facility_id,revision_no,editorial_status,display_name,service_hours_json,content_json,structure_json,source_id,content_hash,created_by,created_at)
       values(?,?,1,'draft',?,?,?,?,?,?,?,?)`,
    ).bind(revisionId, facilityId, revision.displayName, serviceHoursJson, contentJson, structureJson, revision.sourceId, contentHash, principal.userId, now),
  ]);
  await audit(env, principal, "facility.create", "facility", facilityId, requestId, null, { ...revision, revisionId });
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
  const revision = normalizeFacilityRevision(await readJson<unknown>(request));
  await validateFacilityRevision(env, revision);
  const next = await first<{ next_no: number }>(env.DB, "select coalesce(max(revision_no),0)+1 as next_no from facility_revisions where facility_id=?", [facilityId]);
  if (!next) throw new Error("Could not allocate a facility revision number");
  const revisionId = pending?.id ?? makeId("frev");
  const now = isoNow();
  const contentJson = jsonString(revision.content);
  const structureJson = jsonString(revision.structure);
  const serviceHoursJson = revision.serviceHours === null ? null : jsonString(revision.serviceHours);
  const hash = await sha256(`${revision.displayName}\n${serviceHoursJson ?? ""}\n${contentJson}\n${structureJson}`);
  await env.DB.batch([
    pending
      ? env.DB.prepare(
        `update facility_revisions set display_name=?,service_hours_json=?,content_json=?,structure_json=?,source_id=?,content_hash=?,created_by=?,created_at=?
          where id=? and editorial_status='draft'`,
      ).bind(revision.displayName, serviceHoursJson, contentJson, structureJson, revision.sourceId ?? null, hash, principal.userId, now, revisionId)
      : env.DB.prepare(
        `insert into facility_revisions(id,facility_id,revision_no,editorial_status,display_name,service_hours_json,content_json,structure_json,source_id,based_on_revision_id,content_hash,created_by,created_at)
         values(?,?,?,'draft',?,?,?,?,?,?,?,?,?)`,
      ).bind(revisionId, facilityId, next.next_no, revision.displayName, serviceHoursJson, contentJson, structureJson, revision.sourceId, facility.current_revision_id, hash, principal.userId, now),
    env.DB.prepare("update facility_instances set updated_at=? where id=?").bind(now, facilityId),
  ]);
  await audit(env, principal, "facility.revision.create", "facility_revision", revisionId, requestId, null, revision);
  return json({ id: revisionId, facilityId, revisionNo: pending?.revision_no ?? next.next_no, editorialStatus: "draft" }, { status: pending ? 200 : 201 });
}
