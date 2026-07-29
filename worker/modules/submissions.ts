import type { SessionPrincipal } from "../domain/types";
import type { Env } from "../types/cloudflare";
import { all, first } from "../lib/db";
import { HttpError, json, readJson, readJsonLimited } from "../lib/http";
import { enforcePublicRateLimit } from "../lib/public-rate-limit";
import { isoNow, jsonString, makeId, objectValue, optionalString, parseJson, requiredString, sha256 } from "../lib/values";
import {
  assertAttachablePhotos,
  dropQuarantineCopies,
  linkSubmissionPhotoStatements,
  listSubmissionPhotos,
  promoteSubmissionPhotos,
} from "./media";

export async function createSubmission(request: Request, env: Env): Promise<Response> {
  await enforcePublicRateLimit(request, env, "submission-create", 20);
  const body = await readJsonLimited<Record<string, unknown>>(request, 64 * 1024);
  const targetType = requiredString(body.targetType, "targetType", 50);
  if (!["place", "facility", "merchant_outlet", "transit_stop", "new_place"].includes(targetType)) {
    throw new HttpError(400, "validation_error", "Invalid targetType");
  }
  const targetId = optionalString(body.targetId, "targetId", 100);
  if (targetType !== "new_place" && !targetId) throw new HttpError(400, "validation_error", "targetId is required");
  const payload = objectValue(body.payload, "payload");
  // photoMediaIds 走独立通道（POST /api/public/media），payload 里只留 id 引用，
  // 因此 64KiB 的 JSON 上限不受影响。
  const photoMediaIds = await assertAttachablePhotos(env, payload.photoMediaIds ?? body.photoMediaIds);
  delete payload.photoMediaIds;
  validateSubmissionPayload(payload);
  if (targetId && targetType !== "new_place") {
    const targetTables: Record<string, string> = {
      place: "places",
      facility: "facility_instances",
      merchant_outlet: "merchant_outlets",
      transit_stop: "transit_stops",
    };
    const target = await first<{ id: string }>(env.DB, `select id from ${targetTables[targetType]} where id=?`, [targetId]);
    if (!target) throw new HttpError(404, "target_not_found", "Submission target does not exist");
  }
  const id = makeId("submission");
  await env.DB.batch([
    env.DB.prepare(
      `insert into content_submissions(id,target_type,target_id,base_revision_id,payload_json,submitter_name,submitter_contact,status,created_at)
       values(?,?,?,?,?,?,?,'pending',?)`,
    ).bind(
      id, targetType, targetId, optionalString(body.baseRevisionId, "baseRevisionId", 100), jsonString(payload),
      optionalString(body.submitterName, "submitterName", 100), optionalString(body.submitterContact, "submitterContact", 200), isoNow(),
    ),
    ...linkSubmissionPhotoStatements(env, id, photoMediaIds),
  ]);
  return json({ id, status: "pending", photoCount: photoMediaIds.length }, { status: 201 });
}

export async function listSubmissions(env: Env): Promise<Response> {
  const items = await all<Record<string, unknown>>(
    env.DB,
    `select id,target_type as targetType,target_id as targetId,base_revision_id as baseRevisionId,payload_json as payloadJson,
            submitter_name as submitterName,submitter_contact as submitterContact,status,created_at as createdAt,reviewed_at as reviewedAt
       from content_submissions order by created_at desc limit 200`,
  );
  // 审核端需要缩略图，所以把关联照片一次查出来按提交分组，避免 N+1。
  const links = await all<{ submissionId: string; mediaAssetId: string; bucketScope: string; status: string }>(
    env.DB,
    `select sm.submission_id as submissionId,sm.media_asset_id as mediaAssetId,ma.bucket_scope as bucketScope,ma.status
       from submission_media sm join media_assets ma on ma.id=sm.media_asset_id
      order by sm.submission_id, sm.sort_order`,
  );
  const grouped = new Map<string, Array<{ mediaId: string; bucketScope: string; status: string }>>();
  for (const link of links) {
    const list = grouped.get(link.submissionId) ?? [];
    list.push({ mediaId: link.mediaAssetId, bucketScope: link.bucketScope, status: link.status });
    grouped.set(link.submissionId, list);
  }
  return json({
    items: items.map((item) => ({ ...item, photos: grouped.get(String(item.id)) ?? [] })),
  });
}

export async function reviewSubmission(request: Request, env: Env, reviewer: SessionPrincipal, submissionId: string): Promise<Response> {
  const submission = await first<Record<string, unknown>>(env.DB, "select * from content_submissions where id=?", [submissionId]);
  if (!submission) throw new HttpError(404, "not_found", "Submission does not exist");
  if (!["pending", "in_review"].includes(String(submission.status))) throw new HttpError(409, "invalid_state", "Submission has already been decided");
  const body = await readJson<Record<string, unknown>>(request);
  const decision = requiredString(body.decision, "decision", 20);
  if (!["accept", "partial", "reject"].includes(decision)) throw new HttpError(400, "validation_error", "Invalid decision");
  const reviewId = makeId("sreview");
  const status = decision === "accept" ? "accepted" : decision === "partial" ? "partially_accepted" : "rejected";
  const now = isoNow();
  const fieldDecisions = objectValue(body.fieldDecisions, "fieldDecisions");
  const payload = parseJson<Record<string, unknown>>(String(submission.payload_json ?? "{}"), {});

  // 照片随「采纳」一起发布：accept 全量放行，partial 只在勾选了 photos 时放行。
  // 驳回（以及 partial 未勾选）保持 quarantined，公共读端因此仍然读不到。
  const attached = await listSubmissionPhotos(env, submissionId);
  const publishPhotos = attached.length > 0 && (decision === "accept" || fieldDecisions.photos === "adopt");
  const promotion = publishPhotos ? await promoteSubmissionPhotos(env, submissionId) : { urls: [], statements: [] };

  const produced = decision !== "reject"
    ? await buildProducedRevision(env, reviewer, submission, payload, fieldDecisions, decision, promotion.urls)
    : null;
  const statements = [
    env.DB.prepare(
      `insert into submission_reviews(id,submission_id,reviewer_id,decision,field_decisions_json,note,produced_revision_type,produced_revision_id,created_at)
       values(?,?,?,?,?,?,?,?,?)`,
    ).bind(
      reviewId, submissionId, reviewer.userId, decision, jsonString(fieldDecisions), optionalString(body.note, "note", 2_000),
      produced?.type ?? null, produced?.id ?? null, now,
    ),
    env.DB.prepare("update content_submissions set status=?,reviewed_at=? where id=?").bind(status, now, submissionId),
  ];
  if (produced) statements.push(produced.statement);
  statements.push(...promotion.statements);
  statements.push(
    env.DB.prepare(
      `update collection_tasks set status=?,reviewed_at=?,updated_at=? where submission_id=?`,
    ).bind(decision === "accept" && produced ? "submitted" : "needs_recollection", now, now, submissionId),
  );
  await env.DB.batch(statements);
  // 行已经指向 public/media/ 之后隔离区副本再无引用，删除失败不影响结果。
  if (promotion.statements.length) await dropQuarantineCopies(env, attached);
  return json({
    id: reviewId,
    submissionId,
    status,
    producedRevisionType: produced?.type ?? null,
    producedRevisionId: produced?.id ?? null,
    publishedPhotoCount: promotion.urls.length,
  });
}

interface ProducedRevision {
  type: "place";
  id: string;
  statement: ReturnType<Env["DB"]["prepare"]>;
}

async function buildProducedRevision(
  env: Env,
  reviewer: SessionPrincipal,
  submission: Record<string, unknown>,
  payload: Record<string, unknown>,
  fieldDecisions: Record<string, unknown>,
  decision: string,
  /** 已提升为公共可读的照片路径（/api/public/media/:id），会并入 detail.media。 */
  photoUrls: string[] = [],
): Promise<ProducedRevision | null> {
  if (submission.target_type !== "place" || typeof submission.target_id !== "string") return null;
  const collection = payload.collection;
  const detailPatch = payload.detail;
  const changes = payload.changes;
  if (!isObject(collection) && !isObject(detailPatch) && !isObject(changes) && photoUrls.length === 0) return null;
  if (decision === "partial" && !Object.values(fieldDecisions).includes("adopt") && photoUrls.length === 0) return null;

  const pending = await first<{ id: string }>(
    env.DB,
    "select id from place_revisions where place_id=? and editorial_status in ('draft','in_review') limit 1",
    [submission.target_id],
  );
  if (pending) throw new HttpError(409, "pending_revision_exists", "Resolve the existing place revision before accepting this submission");

  const current = await first<Record<string, unknown>>(
    env.DB,
    `select p.current_revision_id,r.* from places p join place_revisions r on r.id=p.current_revision_id where p.id=?`,
    [submission.target_id],
  );
  if (!current) throw new HttpError(409, "missing_current_revision", "The target place has no current revision");
  const next = await first<{ nextNo: number }>(
    env.DB,
    "select coalesce(max(revision_no),0)+1 as nextNo from place_revisions where place_id=?",
    [submission.target_id],
  );

  const content = parseJson<Record<string, unknown>>(String(current.content_json ?? "{}"), {});
  const detail = isObject(content.detail) ? { ...content.detail } : {};
  const adopted = (key: string) => decision === "accept" || fieldDecisions[key] === "adopt";
  if (isObject(detailPatch)) {
    for (const [key, value] of Object.entries(detailPatch)) {
      if (adopted(key)) detail[key] = value;
    }
  }
  if (isObject(collection)) {
    const facts = new Map<string, { label: string; value: string }>();
    if (Array.isArray(detail.facts)) {
      for (const raw of detail.facts) {
        if (!isObject(raw) || typeof raw.label !== "string" || typeof raw.value !== "string") continue;
        facts.set(raw.label, { label: raw.label, value: raw.value });
      }
    }
    for (const [label, key] of [["开放时间", "openHours"], ["联系电话", "phone"], ["所属单位", "organization"]] as const) {
      const value = collection[key];
      if (adopted(`collection.${key}`) && typeof value === "string" && value.trim()) {
        facts.set(label, { label, value: value.trim() });
      }
    }
    detail.facts = Array.from(facts.values());
    if (adopted("collection.floors") && Array.isArray(collection.floors)) {
      content.collectionFloors = collection.floors;
      content.collectionSubmissionId = submission.id;
      const notes = collection.floors
        .filter(isObject)
        .map((floor) => {
          const level = typeof floor.levelCode === "string" ? floor.levelCode.trim() : "";
          const note = typeof floor.note === "string" ? floor.note.trim() : "";
          return level && note ? `${level}：${note}` : "";
        })
        .filter(Boolean);
      if (notes.length) content.floorNotes = notes.join("\n");
    }
  }
  // 已发布的用户照片并入 detail.media，随这条修订走正常审核/发布流程后出现在 M2 照片区。
  if (photoUrls.length) {
    const media = Array.isArray(detail.media)
      ? detail.media.filter((item): item is Record<string, unknown> => isObject(item))
      : [];
    const known = new Set(media.map((item) => String(item.url ?? "")));
    for (const url of photoUrls) {
      if (known.has(url)) continue;
      known.add(url);
      media.push({ role: media.length === 0 ? "cover" : "gallery", url, alt: "", caption: "用户提供" });
    }
    detail.media = media;
  }
  content.detail = detail;

  const changeSet = isObject(changes) ? changes : {};
  const displayName = adopted("displayName") && typeof changeSet.displayName === "string" ? changeSet.displayName : String(current.display_name);
  const summary = adopted("summary") && typeof changeSet.summary === "string" ? changeSet.summary : (current.summary as string | null);
  const description = adopted("description") && typeof changeSet.description === "string" ? changeSet.description : (current.description as string | null);
  const contentJson = jsonString(content);
  const contentHash = await sha256(`${displayName}\n${summary ?? ""}\n${description ?? ""}\n${contentJson}`);
  const revisionId = makeId("prev");
  const createdAt = isoNow();
  return {
    type: "place",
    id: revisionId,
    // 采纳提交直接以 in_review 入库并带上 submitted_at，这样修订会立刻出现在审核队列
    // （reviews.ts 的 listPendingRevisions 只收 in_review），不需要额外的「提交这条修订」动作。
    statement: env.DB.prepare(
      `insert into place_revisions(id,place_id,revision_no,editorial_status,display_name,summary,description,content_json,source_id,based_on_revision_id,content_hash,created_by,created_at,submitted_at)
       values(?,?,?,'in_review',?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      revisionId, submission.target_id as string, next?.nextNo ?? 1, displayName, summary ?? null, description ?? null,
      contentJson, (current.source_id as string | null) ?? null, current.current_revision_id as string, contentHash, reviewer.userId, createdAt, createdAt,
    ),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validateSubmissionPayload(value: unknown, depth = 0): void {
  if (depth > 6) throw new HttpError(400, "validation_error", "Submission payload is too deeply nested");
  if (typeof value === "string") {
    if (value.length > 10_000) throw new HttpError(400, "validation_error", "Submission text is too long");
    return;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    if (value.length > 100) throw new HttpError(400, "validation_error", "Submission array is too large");
    for (const item of value) validateSubmissionPayload(item, depth + 1);
    return;
  }
  if (!isObject(value)) throw new HttpError(400, "validation_error", "Submission payload contains an unsupported value");
  const entries = Object.entries(value);
  if (entries.length > 100) throw new HttpError(400, "validation_error", "Submission object has too many fields");
  for (const [key, item] of entries) {
    if (key.length > 100) throw new HttpError(400, "validation_error", "Submission field name is too long");
    validateSubmissionPayload(item, depth + 1);
  }
}
