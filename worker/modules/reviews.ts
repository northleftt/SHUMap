import type { SessionPrincipal } from "../domain/types";
import type { Env } from "../types/cloudflare";
import { all, first } from "../lib/db";
import { HttpError, json, readJson } from "../lib/http";
import { isoNow, jsonString, makeId, optionalString, parseJson, requiredString, sha256 } from "../lib/values";
import { audit } from "./audit";
import { publicMediaPath } from "./media";

const REVISION_CONFIG = {
  place: { table: "place_revisions", parentTable: "places", parentColumn: "place_id" },
  facility: { table: "facility_revisions", parentTable: "facility_instances", parentColumn: "facility_id" },
  merchant: { table: "merchant_revisions", parentTable: "merchant_outlets", parentColumn: "outlet_id" },
} as const;

type RevisionType = keyof typeof REVISION_CONFIG;

export async function listPendingRevisions(env: Env): Promise<Response> {
  const items = await all(
    env.DB,
    `select 'place' as type,r.id as revisionId,r.place_id as entityId,r.display_name as title,r.revision_no as revisionNo,r.submitted_at as submittedAt
       from place_revisions r where r.editorial_status='in_review'
     union all
     select 'facility',r.id,r.facility_id,r.display_name,r.revision_no,r.submitted_at
       from facility_revisions r where r.editorial_status='in_review'
     union all
     select 'merchant',r.id,r.outlet_id,r.display_name,r.revision_no,r.submitted_at
       from merchant_revisions r where r.editorial_status='in_review'
     order by submittedAt desc`,
  );
  return json({ items });
}

export async function submitRevision(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  type: RevisionType,
  revisionId: string,
  requestId: string,
): Promise<Response> {
  const config = REVISION_CONFIG[type];
  const row = await first<Record<string, unknown>>(
    env.DB,
    `select id,${config.parentColumn} as parent_id,editorial_status from ${config.table} where id=?`,
    [revisionId],
  );
  if (!row) throw new HttpError(404, "not_found", "Revision does not exist");
  if (row.editorial_status !== "draft") throw new HttpError(409, "invalid_state", "Only draft revisions can be submitted");
  const now = isoNow();
  await env.DB.batch([
    env.DB.prepare(`update ${config.table} set editorial_status='in_review',submitted_at=? where id=?`).bind(now, revisionId),
  ]);
  await audit(env, principal, `${type}.revision.submit`, `${type}_revision`, revisionId, requestId, row, { ...row, editorial_status: "in_review" });
  return json({ id: revisionId, editorialStatus: "in_review" });
}

export async function reviewRevision(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  type: RevisionType,
  revisionId: string,
  requestId: string,
): Promise<Response> {
  const config = REVISION_CONFIG[type];
  const body = await readJson<Record<string, unknown>>(request);
  const decision = requiredString(body.decision, "decision", 20);
  if (decision !== "approve" && decision !== "reject") throw new HttpError(400, "validation_error", "decision must be approve or reject");
  const note = optionalString(body.note, "note", 2_000);
  const row = await first<Record<string, unknown>>(
    env.DB,
    `select id,${config.parentColumn} as parent_id,editorial_status from ${config.table} where id=?`,
    [revisionId],
  );
  if (!row) throw new HttpError(404, "not_found", "Revision does not exist");
  if (row.editorial_status !== "in_review") throw new HttpError(409, "invalid_state", "Only revisions in review can be decided");
  const nextStatus = decision === "approve" ? "approved" : "rejected";
  const now = isoNow();
  const statements = [
    env.DB.prepare(`update ${config.table} set editorial_status=?,reviewed_by=?,reviewed_at=?,review_note=? where id=?`)
      .bind(nextStatus, principal.userId, now, note, revisionId),
  ];
  if (decision === "approve") {
    statements.push(
      env.DB.prepare(`update ${config.table} set editorial_status='superseded' where ${config.parentColumn}=? and editorial_status='draft' and id<>?`)
        .bind(row.parent_id as string, revisionId),
    );
    statements.push(
      env.DB.prepare(`update ${config.table} set editorial_status='superseded' where ${config.parentColumn}=? and editorial_status='approved' and id<>?`)
        .bind(row.parent_id as string, revisionId),
    );
    statements.push(
      env.DB.prepare(`update ${config.parentTable} set current_revision_id=?,updated_at=? where id=?`)
        .bind(revisionId, now, row.parent_id as string),
    );
    if (type === "place") {
      statements.push(...await materializeCollectedFloors(env, revisionId, row.parent_id as string, principal.userId, now));
    }
  }
  if (type === "place") {
    const taskStatus = decision === "approve" ? "accepted" : "needs_recollection";
    statements.push(
      env.DB.prepare(
        `update collection_tasks set status=?,reviewed_at=?,updated_at=?
          where submission_id in (
            select sr.submission_id from submission_reviews sr
              join content_submissions cs on cs.id=sr.submission_id
             where sr.produced_revision_type='place' and sr.produced_revision_id=?
               and (?='needs_recollection' or cs.status='accepted')
          )`,
      ).bind(taskStatus, now, now, revisionId, taskStatus),
    );
  }
  await env.DB.batch(statements);
  await audit(env, principal, `${type}.revision.${decision}`, `${type}_revision`, revisionId, requestId, row, { ...row, editorial_status: nextStatus }, note);
  return json({ id: revisionId, editorialStatus: nextStatus });
}

interface CollectedFacility {
  typeCode?: unknown;
  name?: unknown;
  locationText?: unknown;
}

interface CollectedFloor {
  levelCode?: unknown;
  note?: unknown;
  facilities?: unknown;
  photoMediaIds?: unknown;
}

/**
 * 采集得到的楼层编号（"3" / "F3" / "B1"）格式化成给人看的名字。采集端填的是编号，
 * 直接拿它当显示名会让用户端楼层页出现「B1」这种半成品。
 */
export function formatFloorDisplayName(levelCode: string): string {
  const code = levelCode.trim().toUpperCase();
  const above = code.match(/^F?(\d{1,3})$/);
  if (above) return `${Number(above[1])} 层`;
  const below = code.match(/^B(\d{1,2})$/);
  if (below) return `地下 ${Number(below[1])} 层`;
  return levelCode.trim();
}

/** 同上的排序值：地下取负、地上取正，非数字编号退回采集顺序。 */
function floorOrderOf(levelCode: string, fallback: number): number {
  const code = levelCode.trim().toUpperCase();
  const above = code.match(/^F?(\d{1,3})$/);
  if (above) return Number(above[1]);
  const below = code.match(/^B(\d{1,2})$/);
  if (below) return -Number(below[1]);
  return fallback;
}

/**
 * 把 floorMedia 映射并进本条修订的 content_json。
 *
 * 这条修订此刻正被批准（同一个 batch 里 editorial_status 改成 approved），所以
 * content_hash 要跟着重算，否则发布出去的 manifest 里 hash 与内容不符。
 */
async function floorMediaStatement(
  env: Env,
  revisionId: string,
  content: Record<string, unknown>,
  floorMedia: Record<string, string[]>,
) {
  const row = await first<{ displayName: string; summary: string | null; description: string | null }>(
    env.DB,
    "select display_name as displayName,summary,description from place_revisions where id=?",
    [revisionId],
  );
  const nextContent = { ...content, floorMedia };
  const contentJson = jsonString(nextContent);
  const contentHash = await sha256(
    `${row?.displayName ?? ""}\n${row?.summary ?? ""}\n${row?.description ?? ""}\n${contentJson}`,
  );
  return env.DB.prepare("update place_revisions set content_json=?,content_hash=? where id=?")
    .bind(contentJson, contentHash, revisionId);
}

async function materializeCollectedFloors(
  env: Env,
  revisionId: string,
  placeId: string,
  reviewerId: string,
  now: string,
) {
  const revision = await first<{ contentJson: string }>(
    env.DB,
    "select content_json as contentJson from place_revisions where id=?",
    [revisionId],
  );
  const content = parseJson<Record<string, unknown>>(revision?.contentJson, {});
  if (!Array.isArray(content.collectionFloors)) return [];
  if (typeof content.collectionSubmissionId !== "string") return [];
  const source = await first<{ id: string }>(
    env.DB,
    `select id from submission_reviews
      where submission_id=? and produced_revision_type='place' and produced_revision_id=?`,
    [content.collectionSubmissionId, revisionId],
  );
  if (!source) return [];

  const typeRows = await all<{ id: string; code: string; name: string }>(env.DB, "select id,code,name from facility_types");
  const facilityTypes = new Map(typeRows.map((type) => [type.code, type]));
  const statements = [];
  // 楼层照片：采集时按楼层分组上传，采纳时已被 promoteSubmissionPhotos 提升为公共可读。
  // floors 表没有照片列（也不该为此加列），因此把「楼层编号 → 已发布照片地址」这张
  // 映射写回本条修订的 content.floorMedia，客户端楼层页按 levelCode 取用。
  const floorMedia: Record<string, string[]> = {};
  for (const rawFloor of content.collectionFloors) {
    if (!rawFloor || typeof rawFloor !== "object" || Array.isArray(rawFloor)) continue;
    const floor = rawFloor as CollectedFloor;
    if (typeof floor.levelCode !== "string" || !floor.levelCode.trim()) continue;
    if (!Array.isArray(floor.photoMediaIds)) continue;
    const urls: string[] = [];
    for (const rawId of floor.photoMediaIds) {
      if (typeof rawId !== "string") continue;
      const published = await first<{ id: string }>(
        env.DB,
        "select id from media_assets where id=? and bucket_scope='public' and status='published'",
        [rawId],
      );
      if (published) urls.push(publicMediaPath(rawId));
    }
    if (urls.length) floorMedia[floor.levelCode.trim()] = urls;
  }
  if (Object.keys(floorMedia).length) {
    statements.push(await floorMediaStatement(env, revisionId, content, floorMedia));
  }

  for (const [floorIndex, rawFloor] of content.collectionFloors.entries()) {
    if (!rawFloor || typeof rawFloor !== "object" || Array.isArray(rawFloor)) continue;
    const floor = rawFloor as CollectedFloor;
    if (typeof floor.levelCode !== "string" || !floor.levelCode.trim()) continue;
    const levelCode = floor.levelCode.trim();
    const existing = await first<{ id: string }>(env.DB, "select id from floors where building_place_id=? and level_code=?", [placeId, levelCode]);
    const floorId = existing?.id ?? makeId("floor");
    if (!existing) {
      statements.push(
        env.DB.prepare(
          `insert into floors(id,building_place_id,level_code,level_order,display_name,is_public,lifecycle_status,created_at,updated_at)
           values(?,?,?,?,?,1,'active',?,?)`,
        ).bind(floorId, placeId, levelCode, floorOrderOf(levelCode, floorIndex), formatFloorDisplayName(levelCode), now, now),
      );
    }
    if (!Array.isArray(floor.facilities)) continue;
    for (const rawFacility of floor.facilities) {
      if (!rawFacility || typeof rawFacility !== "object" || Array.isArray(rawFacility)) continue;
      const facility = rawFacility as CollectedFacility;
      if (typeof facility.typeCode !== "string") continue;
      const facilityType = facilityTypes.get(facility.typeCode);
      if (!facilityType) continue;
      const facilityId = makeId("facility");
      const facilityRevisionId = makeId("frev");
      const displayName = typeof facility.name === "string" && facility.name.trim() ? facility.name.trim() : facilityType.name;
      const locationDescription = typeof facility.locationText === "string" ? facility.locationText.trim() : "";
      const facilityContent = locationDescription ? { locationDescription } : {};
      const contentJson = jsonString(facilityContent);
      const duplicate = await first<{ id: string }>(
        env.DB,
        `select f.id from facility_instances f
          join facility_revisions r on r.id=f.current_revision_id
         where f.host_place_id=? and f.floor_id=? and f.facility_type_id=?
           and r.display_name=? and coalesce(json_extract(r.content_json,'$.locationDescription'),'')=?
         limit 1`,
        [placeId, floorId, facilityType.id, displayName, locationDescription],
      );
      if (duplicate) continue;
      const contentHash = await sha256(`${displayName}\n\n${contentJson}`);
      statements.push(
        env.DB.prepare(
          `insert into facility_instances(id,facility_type_id,host_place_id,floor_id,lifecycle_status,operational_status,quantity,current_revision_id,created_at,updated_at)
           values(?,?,?,?,'active','unknown',1,?,?,?)`,
        ).bind(facilityId, facilityType.id, placeId, floorId, facilityRevisionId, now, now),
        env.DB.prepare(
          `insert into facility_revisions(id,facility_id,revision_no,editorial_status,display_name,content_json,content_hash,created_by,created_at,submitted_at,reviewed_by,reviewed_at)
           values(?,?,1,'approved',?,?,?,?,?,?,?,?)`,
        ).bind(facilityRevisionId, facilityId, displayName, contentJson, contentHash, reviewerId, now, now, reviewerId, now),
      );
    }
  }
  return statements;
}
