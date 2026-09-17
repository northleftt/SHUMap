import type { EntityLocationType, SessionPrincipal } from "../domain/types";
import type {
  FacilityRevisionWrite,
  MerchantRevisionWrite,
  PlaceRevisionWrite,
  RevisionLocationInput,
} from "../../shared/revision-contract";
import type { CollectedFloor, SubmissionFieldDecision } from "../../shared/submission-contract";
import type { D1PreparedStatement, Env } from "../types/cloudflare";
import { all, first } from "../lib/db";
import { HttpError, json, readJson } from "../lib/http";
import { isoNow, jsonString, makeId, optionalString, parseJsonObject, requiredString, sha256 } from "../lib/values";
import {
  assertBuildingCanBeRemoved,
  normalizeStoredRevision,
  validateFacilityRevision,
  validateMerchantRevision,
  validatePlaceRevision,
} from "../lib/revision-contracts";
import { normalizeStoredSubmissionPayload } from "../lib/submission-contracts";
import { audit } from "./audit";
import { publicMediaPath } from "./media";
import { planLocation } from "./locations";

const REVISION_CONFIG = {
  place: { table: "place_revisions", parentTable: "places", parentColumn: "place_id" },
  facility: { table: "facility_revisions", parentTable: "facility_instances", parentColumn: "facility_id" },
  merchant: { table: "merchant_revisions", parentTable: "merchant_outlets", parentColumn: "outlet_id" },
} as const;

type RevisionType = keyof typeof REVISION_CONFIG;

type ValidatedRevision =
  | { type: "place"; revision: PlaceRevisionWrite }
  | { type: "facility"; revision: FacilityRevisionWrite }
  | { type: "merchant"; revision: MerchantRevisionWrite };

async function validateStoredRevision(
  env: Env,
  type: RevisionType,
  row: Record<string, unknown>,
  entityId: string,
): Promise<ValidatedRevision> {
  if (type === "place") {
    const revision = normalizeStoredRevision("place", row);
    await validatePlaceRevision(env, revision, entityId);
    return { type, revision };
  }
  if (type === "facility") {
    const revision = normalizeStoredRevision("facility", row);
    await validateFacilityRevision(env, revision);
    return { type, revision };
  }
  const revision = normalizeStoredRevision("merchant", row);
  await validateMerchantRevision(env, revision);
  return { type, revision };
}

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
    `select * from ${config.table} where id=?`,
    [revisionId],
  );
  if (!row) throw new HttpError(404, "not_found", "Revision does not exist");
  if (row.editorial_status !== "draft") throw new HttpError(409, "invalid_state", "Only draft revisions can be submitted");
  await validateStoredRevision(env, type, row, row[config.parentColumn] as string);
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
    `select * from ${config.table} where id=?`,
    [revisionId],
  );
  if (!row) throw new HttpError(404, "not_found", "Revision does not exist");
  if (row.editorial_status !== "in_review") throw new HttpError(409, "invalid_state", "Only revisions in review can be decided");
  const entityId = row[config.parentColumn] as string;
  const revision = await validateStoredRevision(env, type, row, entityId);
  const nextStatus = decision === "approve" ? "approved" : "rejected";
  const now = isoNow();
  const statements = [
    env.DB.prepare(`update ${config.table} set editorial_status=?,reviewed_by=?,reviewed_at=?,review_note=? where id=?`)
      .bind(nextStatus, principal.userId, now, note, revisionId),
  ];
  if (decision === "approve") {
    statements.push(
      env.DB.prepare(`update ${config.table} set editorial_status='superseded' where ${config.parentColumn}=? and editorial_status='draft' and id<>?`)
        .bind(entityId, revisionId),
    );
    statements.push(
      env.DB.prepare(`update ${config.table} set editorial_status='superseded' where ${config.parentColumn}=? and editorial_status='approved' and id<>?`)
        .bind(entityId, revisionId),
    );
    statements.push(
      env.DB.prepare(`update ${config.parentTable} set current_revision_id=?,updated_at=? where id=?`)
        .bind(revisionId, now, entityId),
    );
    statements.push(
      env.DB.prepare(`update ${config.parentTable} set lifecycle_status='active',approval_pending=0 where id=? and approval_pending=1`)
        .bind(entityId),
    );
    statements.push(...await applyApprovedStructure(
      env,
      principal,
      entityId,
      revision,
      revisionId,
      now,
    ));
    if (type === "place") {
      statements.push(...await materializeCollectedFloors(env, revisionId, entityId, principal.userId, now));
    }
  } else {
    // 驳回首条修订时把骨架行退休。approval_pending=1 表示这个实体从未通过审核，
    // 骨架只是为了先分配外键；不退休它就会永远停在 planned/pending 状态堆积。
    // 注意不能改清 approval_pending：发布查询按 lifecycle_status<>'retired' and
    // approval_pending=0 取数，清标志会把被驳回的内容送进发布产物。
    // 已经上线过的实体（approval_pending=0）新修订被驳回，现网状态保持不变。
    statements.push(
      env.DB.prepare(`update ${config.parentTable} set lifecycle_status='retired',updated_at=? where id=? and approval_pending=1`)
        .bind(now, entityId),
    );
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

async function applyApprovedStructure(
  env: Env,
  principal: SessionPrincipal,
  entityId: string,
  validated: ValidatedRevision,
  revisionId: string,
  now: string,
): Promise<D1PreparedStatement[]> {
  if (validated.type === "place") return applyPlaceStructure(env, principal, entityId, validated.revision, revisionId, now);
  if (validated.type === "facility") return applyFacilityStructure(env, principal, entityId, validated.revision, now);
  return applyMerchantStructure(env, principal, entityId, validated.revision, now);
}

async function replaceLocationStatements(
  env: Env,
  principal: SessionPrincipal,
  entityType: EntityLocationType,
  entityId: string,
  inputs: RevisionLocationInput[],
  now: string,
): Promise<D1PreparedStatement[]> {
  // replace-all 的范围必须与编辑器读到的范围一致：getPlace 等只取 valid_to is null 的
  // 绑定，所以这里也只能删当前有效的那些，否则会连带毁掉历史（已失效）位置记录。
  const previous = await all<{ anchorId: string }>(
    env.DB,
    "select anchor_id as anchorId from entity_locations where entity_type=? and entity_id=? and valid_to is null",
    [entityType, entityId],
  );
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("delete from entity_locations where entity_type=? and entity_id=? and valid_to is null").bind(entityType, entityId),
  ];
  if (previous.length) {
    // 锚点只在彻底没人引用时才删：同一 anchor 可能还挂着本次刻意保留的历史绑定
    // （或别的实体 / 别的 role），batch 内此语句在上面的 delete 之后执行，
    // 因此 not exists 看到的已是删除后的状态。
    statements.push(
      env.DB.prepare(
        `delete from location_anchors
          where id in (${previous.map(() => "?").join(",")})
            and not exists (select 1 from entity_locations el where el.anchor_id=location_anchors.id)`,
      ).bind(...previous.map((row) => row.anchorId)),
    );
  }
  for (const input of inputs) {
    const plan = await planLocation(env, entityType, entityId, input, principal, now);
    statements.push(...plan.statements);
  }
  return statements;
}

async function applyPlaceStructure(
  env: Env,
  principal: SessionPrincipal,
  placeId: string,
  revision: PlaceRevisionWrite,
  revisionId: string,
  now: string,
): Promise<D1PreparedStatement[]> {
  const { kindId, campusId, parentPlaceId, stableCode, aliases, building, locations } = revision.structure;
  const primaryName = await first<{ displayName: string }>(env.DB, "select display_name as displayName from place_revisions where id=?", [revisionId]);
  if (!primaryName) throw new Error(`Place revision ${revisionId} does not exist`);
  const hasPrimaryName = await first<{ id: string }>(env.DB, "select id from place_names where place_id=? and name_type='primary'", [placeId]);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("update places set kind_id=?,campus_id=?,parent_place_id=?,stable_code=?,updated_at=? where id=?")
      .bind(kindId, campusId, parentPlaceId, stableCode, now, placeId),
    env.DB.prepare("update place_names set name=?,normalized_name=? where place_id=? and name_type='primary'")
      .bind(primaryName.displayName, primaryName.displayName.normalize("NFKC").trim().toLowerCase(), placeId),
    env.DB.prepare("delete from place_names where place_id=? and name_type='alias'").bind(placeId),
  ];
  if (!hasPrimaryName) statements.push(
    env.DB.prepare("insert into place_names(id,place_id,language,name,normalized_name,name_type,is_searchable) values(?,?,'zh-CN',?,?,'primary',1)")
      .bind(makeId("pname"), placeId, primaryName.displayName, primaryName.displayName.normalize("NFKC").trim().toLowerCase()),
  );
  for (const alias of aliases) {
    statements.push(env.DB.prepare("insert into place_names(id,place_id,language,name,normalized_name,name_type,is_searchable) values(?,?,'zh-CN',?,?,'alias',1)")
      .bind(makeId("pname"), placeId, alias, alias.normalize("NFKC").trim().toLowerCase()));
  }
  if (building) {
    statements.push(
      env.DB.prepare("insert or ignore into buildings(place_id,building_code,managing_organization_id,public_access_level) values(?,?,?,?)")
        .bind(placeId, building.buildingCode, building.managingOrganizationId, building.publicAccessLevel),
      env.DB.prepare("update buildings set building_code=?,managing_organization_id=?,public_access_level=? where place_id=?")
        .bind(building.buildingCode, building.managingOrganizationId, building.publicAccessLevel, placeId),
    );
    const footprint = locations.find((location) => location.role === "footprint");
    if (!footprint?.mapFeatureId || !footprint.mapVersionId) {
      throw new Error(`Validated building ${placeId} has no canonical footprint feature`);
    }
    statements.push(
      env.DB.prepare(
        `update map_features set feature_kind='building_footprint',stable_feature_key=?
          where id=? and map_version_id=?`,
      ).bind(`place:${placeId}`, footprint.mapFeatureId, footprint.mapVersionId),
    );
  } else {
    await assertBuildingCanBeRemoved(env, placeId);
    statements.push(env.DB.prepare("delete from buildings where place_id=?").bind(placeId));
  }
  statements.push(...await replaceLocationStatements(env, principal, "place", placeId, locations, now));
  return statements;
}

async function applyFacilityStructure(
  env: Env,
  principal: SessionPrincipal,
  facilityId: string,
  revision: FacilityRevisionWrite,
  now: string,
): Promise<D1PreparedStatement[]> {
  const { facilityTypeId, hostPlaceId, floorId, quantity, operationalStatus, locations } = revision.structure;
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("update facility_instances set facility_type_id=?,host_place_id=?,floor_id=?,quantity=?,operational_status=?,updated_at=? where id=?")
      .bind(facilityTypeId, hostPlaceId, floorId, quantity, operationalStatus, now, facilityId),
  ];
  statements.push(...await replaceLocationStatements(env, principal, "facility", facilityId, locations, now));
  return statements;
}

async function applyMerchantStructure(
  env: Env,
  principal: SessionPrincipal,
  outletId: string,
  revision: MerchantRevisionWrite,
  now: string,
): Promise<D1PreparedStatement[]> {
  const { organizationId, hostPlaceId, floorId, locations } = revision.structure;
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("update merchant_outlets set organization_id=?,host_place_id=?,floor_id=?,updated_at=? where id=?")
      .bind(organizationId, hostPlaceId, floorId, now, outletId),
  ];
  statements.push(...await replaceLocationStatements(env, principal, "merchant_outlet", outletId, locations, now));
  return statements;
}

/**
 * 采集得到的规范楼层编号（"F3" / "B1"）格式化成给人看的名字。采集端填的是编号，
 * 直接拿它当显示名会让用户端楼层页出现「B1」这种半成品。
 */
export function formatFloorDisplayName(levelCode: string): string {
  const code = levelCode.trim().toUpperCase();
  const above = code.match(/^F(\d{1,3})$/);
  if (above) return `${Number(above[1])} 层`;
  const below = code.match(/^B(\d{1,2})$/);
  if (below) return `地下 ${Number(below[1])} 层`;
  throw new HttpError(400, "validation_error", `Unsupported floor level code: ${levelCode}`);
}

/** 同上的排序值：地下取负、地上取正。 */
function floorOrderOf(levelCode: string): number {
  const code = levelCode.trim().toUpperCase();
  const above = code.match(/^F(\d{1,3})$/);
  if (above) return Number(above[1]);
  const below = code.match(/^B(\d{1,2})$/);
  if (below) return -Number(below[1]);
  throw new HttpError(400, "validation_error", `Unsupported floor level code: ${levelCode}`);
}

/**
 * 把楼层照片作为带 floorLevelCode 的 canonical detail.media 条目并进本条修订。
 *
 * 这条修订此刻正被批准（同一个 batch 里 editorial_status 改成 approved），所以
 * content_hash 要跟着重算，否则发布出去的 manifest 里 hash 与内容不符。
 */
async function appendFloorMediaStatement(
  env: Env,
  revisionId: string,
  content: Record<string, unknown>,
  floorMedia: Record<string, string[]>,
) {
  const row = await first<{ displayName: string; summary: string | null; description: string | null; structureJson: string }>(
    env.DB,
    "select display_name as displayName,summary,description,structure_json as structureJson from place_revisions where id=?",
    [revisionId],
  );
  if (!row) throw new Error(`Place revision ${revisionId} does not exist`);
  if (!content.detail || typeof content.detail !== "object" || Array.isArray(content.detail)) {
    throw new Error(`Place revision ${revisionId} has no canonical detail object`);
  }
  const detail = content.detail as Record<string, unknown>;
  if (!Array.isArray(detail.media)) {
    throw new Error(`Place revision ${revisionId} detail.media must be an array`);
  }
  const media = detail.media.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Place revision ${revisionId} detail.media[${index}] must be an object`);
    }
    return item as Record<string, unknown>;
  });
  const known = new Set(media.map((item, index) => {
    if (typeof item.url !== "string" || !item.url) {
      throw new Error(`Place revision ${revisionId} detail.media[${index}].url must be a non-empty string`);
    }
    if (item.floorLevelCode !== undefined && typeof item.floorLevelCode !== "string") {
      throw new Error(`Place revision ${revisionId} detail.media[${index}].floorLevelCode must be a string`);
    }
    return `${item.floorLevelCode ?? ""}\u0000${item.url}`;
  }));
  for (const [levelCode, urls] of Object.entries(floorMedia)) {
    for (const url of urls) {
      const key = `${levelCode}\u0000${url}`;
      if (known.has(key)) continue;
      known.add(key);
      media.push({ role: "gallery", url, alt: "", caption: `${levelCode} 楼层照片`, floorLevelCode: levelCode });
    }
  }
  const nextContent = { ...content, detail: { ...detail, media } };
  const contentJson = jsonString(nextContent);
  const contentHash = await sha256(
    `${row.displayName}\n${row.summary ?? ""}\n${row.description ?? ""}\n${contentJson}\n${row.structureJson}`,
  );
  return env.DB.prepare("update place_revisions set content_json=?,content_hash=? where id=?")
    .bind(contentJson, contentHash, revisionId);
}

function storedFieldDecisions(value: unknown): Record<string, SubmissionFieldDecision> {
  const record = parseJsonObject(value, "submission_reviews.field_decisions_json");
  const result: Record<string, SubmissionFieldDecision> = {};
  for (const [key, decision] of Object.entries(record)) {
    if (decision !== "adopt" && decision !== "skip") {
      throw new Error(`submission_reviews.field_decisions_json.${key} must be adopt or skip`);
    }
    result[key] = decision;
  }
  return result;
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
  const content = parseJsonObject(revision?.contentJson, "place_revisions.content_json");
  const source = await first<{ payloadJson: string; decision: string; fieldDecisionsJson: string }>(
    env.DB,
    `select cs.payload_json as payloadJson,sr.decision,sr.field_decisions_json as fieldDecisionsJson
       from submission_reviews sr join content_submissions cs on cs.id=sr.submission_id
      where sr.produced_revision_type='place' and sr.produced_revision_id=?`,
    [revisionId],
  );
  if (!source) return [];
  const submissionPayload = normalizeStoredSubmissionPayload(source.payloadJson, "content_submissions.payload_json");
  if (submissionPayload.submissionKind !== "collection") return [];
  const fieldDecisions = storedFieldDecisions(source.fieldDecisionsJson);
  const floorsAdopted = fieldDecisions["collection.floors"] === "adopt";
  if (!floorsAdopted) return [];
  const floors: CollectedFloor[] = submissionPayload.collection.floors;

  const typeRows = await all<{ id: string; code: string; name: string }>(
    env.DB,
    `select t.id,t.code,t.name
       from facility_types t
       join map_filter_members m on m.facility_type_id=t.id
       join map_filter_categories c on c.id=m.category_id and c.active=1
      where t.status='active'`,
  );
  const facilityTypes = new Map(typeRows.map((type) => [type.code, type]));
  const statements = [];
  // 楼层照片：采集时按楼层分组上传，采纳时已被 promoteSubmissionPhotos 提升为公共可读。
  // floors 表没有照片列，楼层编号直接写进 canonical detail.media 的 floorLevelCode。
  const floorMedia: Record<string, string[]> = {};
  for (const floor of floors) {
    const urls: string[] = [];
    for (const rawId of floor.photoMediaIds) {
      const published = await first<{ id: string }>(
        env.DB,
        "select id from media_assets where id=? and bucket_scope='public' and status='published'",
        [rawId],
      );
      if (!published) throw new Error(`Collection photo ${rawId} was not published before floor materialization`);
      urls.push(publicMediaPath(rawId));
    }
    if (urls.length) floorMedia[floor.levelCode.trim()] = urls;
  }
  if (Object.keys(floorMedia).length) {
    statements.push(await appendFloorMediaStatement(env, revisionId, content, floorMedia));
  }

  for (const floor of floors) {
    const levelCode = floor.levelCode.trim();
    const existing = await first<{ id: string }>(env.DB, "select id from floors where building_place_id=? and level_code=?", [placeId, levelCode]);
    const floorId = existing?.id ?? makeId("floor");
    if (!existing) {
      statements.push(
        env.DB.prepare(
          `insert into floors(id,building_place_id,level_code,level_order,display_name,is_public,lifecycle_status,created_at,updated_at)
           values(?,?,?,?,?,1,'active',?,?)`,
        ).bind(floorId, placeId, levelCode, floorOrderOf(levelCode), formatFloorDisplayName(levelCode), now, now),
      );
    }
    for (const facility of floor.facilities) {
      const facilityType = facilityTypes.get(facility.typeCode);
      if (!facilityType) throw new Error(`Collection references unknown facility type ${facility.typeCode}`);
      const facilityId = makeId("facility");
      const facilityRevisionId = makeId("frev");
      const displayName = facility.name || facilityType.name;
      const locationDescription = facility.locationText.trim();
      const facilityContent = { locationDescription };
      const contentJson = jsonString(facilityContent);
      const structureJson = jsonString({
        facilityTypeId: facilityType.id,
        hostPlaceId: placeId,
        floorId,
        quantity: 1,
        operationalStatus: "unknown",
        locations: [],
      });
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
      const contentHash = await sha256(`${displayName}\n\n${contentJson}\n${structureJson}`);
      statements.push(
        env.DB.prepare(
          `insert into facility_instances(id,facility_type_id,host_place_id,floor_id,lifecycle_status,operational_status,quantity,current_revision_id,created_at,updated_at)
           values(?,?,?,?,'active','unknown',1,?,?,?)`,
        ).bind(facilityId, facilityType.id, placeId, floorId, facilityRevisionId, now, now),
        env.DB.prepare(
          `insert into facility_revisions(id,facility_id,revision_no,editorial_status,display_name,content_json,structure_json,content_hash,created_by,created_at,submitted_at,reviewed_by,reviewed_at)
           values(?,?,1,'approved',?,?,?,?,?,?,?,?,?)`,
        ).bind(facilityRevisionId, facilityId, displayName, contentJson, structureJson, contentHash, reviewerId, now, now, reviewerId, now),
      );
    }
  }
  return statements;
}
