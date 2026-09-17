import type { SessionPrincipal } from "../domain/types";
import type { D1PreparedStatement, Env } from "../types/cloudflare";
import { all, first } from "../lib/db";
import { HttpError, json, noContent, readJson } from "../lib/http";
import { exactObject, isoNow, jsonString, makeId, oneOf, sha256 } from "../lib/values";
import { normalizeFacilityRevision, validateFacilityRevision } from "../lib/revision-contracts";
import { audit } from "./audit";
import { listEntityLocations, restoreEntityLocations, retireEntityLocations } from "./locations";

/** facility_instances 只有三档，没有 temporarily_closed —— 设施「暂时不能用」是
 *  operational_status 的事（实时接口即时生效），与生命周期分开。 */
const FACILITY_LIFECYCLES = ["planned", "active", "retired"] as const;

export async function listFacilities(env: Env): Promise<Response> {
  const items = await all(
    env.DB,
    `select f.id,f.facility_type_id as facilityTypeId,t.name as facilityTypeName,f.host_place_id as hostPlaceId,
            f.floor_id as floorId,f.lifecycle_status as lifecycleStatus,
            f.operational_status as operationalStatus,f.quantity,r.id as currentRevisionId,r.display_name as displayName,r.editorial_status as editorialStatus,
            f.last_verified_at as lastVerifiedAt,f.next_verification_due_at as nextVerificationDueAt,
            f.updated_at as updatedAt
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
  const { facilityTypeId, hostPlaceId, floorId, quantity, operationalStatus, locations } = revision.structure;

  const facilityId = makeId("facility");
  const revisionId = makeId("frev");
  const now = isoNow();
  const contentJson = jsonString(revision.content);
  const structureJson = jsonString({ facilityTypeId, hostPlaceId, floorId, quantity, operationalStatus, locations });
  const serviceHoursJson = revision.serviceHours === null ? null : jsonString(revision.serviceHours);
  const contentHash = await sha256(`${revision.displayName}\n${serviceHoursJson ?? ""}\n${contentJson}\n${structureJson}`);
  await env.DB.batch([
    env.DB.prepare(
      `insert into facility_instances(id,facility_type_id,host_place_id,floor_id,lifecycle_status,approval_pending,operational_status,quantity,created_at,updated_at)
       values(?,?,?,?,'planned',1,?,?,?,?)`,
    ).bind(facilityId, facilityTypeId, hostPlaceId, floorId, operationalStatus, quantity, now, now),
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

/**
 * PATCH /api/admin/facilities/:id/lifecycle —— 筹建 / 启用 / 停用。
 *
 * 与商户的生命周期同理，不进修订流：设施撤掉了要能当场标出来。「今天坏了」不走
 * 这里，那是 operational_status（GET /api/public/facility-status 实时下发）。
 * retired 之外的取值会触发 0012 的 require_facility_active_map_filter_update
 * （设施类型必须启用且归属一个启用的筛选组）。
 */
export async function updateFacilityLifecycle(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  facilityId: string,
  requestId: string,
): Promise<Response> {
  const before = await first<{ id: string; lifecycle_status: string }>(
    env.DB,
    "select id,lifecycle_status from facility_instances where id=?",
    [facilityId],
  );
  if (!before) throw new HttpError(404, "not_found", "Facility does not exist");
  const body = exactObject(await readJson<unknown>(request), "facilityLifecycle", ["lifecycleStatus"]);
  const lifecycleStatus = oneOf(body.lifecycleStatus, "lifecycleStatus", FACILITY_LIFECYCLES);
  // 从 retired 恢复前先确认设施类型仍然可用：protect_used_map_filter_deactivation
  // 只挡「未停用」设施的筛选组，停用期间类型可以被禁用、筛选组可以被下线；
  // 不查的话 0012 的 require_facility_active_map_filter_update 会把恢复打成
  // 没有说明的 500（raise(abort) 到全局处理就是 internal_error）。
  if (before.lifecycle_status === "retired" && lifecycleStatus !== "retired") {
    const typeInactive = await first<{ id: string }>(
      env.DB,
      `select f.id from facility_instances f
        where f.id=? and not exists (
          select 1 from facility_types t
            join map_filter_members m on m.facility_type_id=t.id
            join map_filter_categories c on c.id=m.category_id and c.active=1
           where t.id=f.facility_type_id and t.status='active'
        )`,
      [facilityId],
    );
    if (typeInactive) {
      throw new HttpError(
        409,
        "facility_type_inactive",
        "This facility's type was disabled or lost its active map filter while retired; re-activate the type first",
      );
    }
  }
  await env.DB.prepare("update facility_instances set lifecycle_status=?,updated_at=? where id=?")
    .bind(lifecycleStatus, isoNow(), facilityId)
    .run();
  // 停用后位置绑定一并失效：发布查询按 lifecycle 过滤，但 entity_locations 是独立
  // 时间轴，留着会让「已停用的设施还占着一个主位置」在下次编辑时才炸出来。
  // 重新启用时把最近一次停用关掉的绑定打开，否则设施上不了地图。
  if (lifecycleStatus === "retired") await retireEntityLocations(env, "facility", facilityId);
  else if (before.lifecycle_status === "retired") await restoreEntityLocations(env, "facility", facilityId);
  await audit(env, principal, "facility.lifecycle.update", "facility", facilityId, requestId, before, { lifecycleStatus });
  return json({ id: facilityId, lifecycleStatus });
}

/**
 * DELETE /api/admin/facilities/:id —— 只用来清掉建错的设施。
 *
 * 设施没有子实体，唯一的外键是自己的修订（on delete cascade），所以能删的判断只有
 * 两条：有没有进过发布，有没有被供稿或运营事件指着。进过发布的只能停用，否则历史
 * release 的 release_items 会指向不存在的实体，而那是回滚的依据。
 */
export async function deleteFacility(
  env: Env,
  principal: SessionPrincipal,
  facilityId: string,
  requestId: string,
): Promise<Response> {
  const before = await first<Record<string, unknown>>(
    env.DB,
    `select f.id,f.facility_type_id as facilityTypeId,f.host_place_id as hostPlaceId,f.floor_id as floorId,
            f.lifecycle_status as lifecycleStatus,r.display_name as displayName
       from facility_instances f left join facility_revisions r on r.id=f.current_revision_id where f.id=?`,
    [facilityId],
  );
  if (!before) throw new HttpError(404, "not_found", "Facility does not exist");
  const usage = await first<{ submissions: number; eventTargets: number }>(
    env.DB,
    `select (select count(*) from content_submissions where target_type='facility' and target_id=?) as submissions,
            (select count(*) from operational_event_targets where target_type='facility' and target_id=?) as eventTargets`,
    [facilityId, facilityId],
  );
  const referenced = (usage?.submissions ?? 0) + (usage?.eventTargets ?? 0);
  if (referenced > 0) {
    throw new HttpError(409, "facility_in_use", "This facility is referenced by submissions or operational events; retire it instead", usage);
  }
  const released = await first<{ count: number }>(
    env.DB,
    "select count(*) as count from release_items where entity_type='facility' and entity_id=?",
    [facilityId],
  );
  if ((released?.count ?? 0) > 0) {
    throw new HttpError(409, "facility_released", "This facility appears in a published release; retire it instead");
  }
  const anchors = await all<{ anchorId: string }>(
    env.DB,
    "select anchor_id as anchorId from entity_locations where entity_type='facility' and entity_id=?",
    [facilityId],
  );
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("delete from entity_locations where entity_type='facility' and entity_id=?").bind(facilityId),
  ];
  if (anchors.length > 0) {
    const anchorIds = anchors.map((row) => row.anchorId);
    statements.push(
      env.DB.prepare(`delete from location_anchors where id in (${anchorIds.map(() => "?").join(",")})`).bind(...anchorIds),
    );
  }
  // facility_revisions 是 on delete cascade，跟着实例一起走。
  statements.push(env.DB.prepare("delete from facility_instances where id=?").bind(facilityId));
  await env.DB.batch(statements);
  await audit(env, principal, "facility.delete", "facility", facilityId, requestId, before, null);
  return noContent();
}
