import type { PlaceFact, PlaceRevisionWrite, RevisionMediaItem } from "../../shared/revision-contract";
import {
  adoptedSubmissionPhotoMediaIds,
  submissionReviewFieldKeys,
  type FeedbackSubmissionPayload,
  type SubmissionDecision,
  type SubmissionFieldDecision,
  type SubmissionFieldDecisions,
  type SubmissionFieldKey,
  type SubmissionPayload,
  type SubmissionTargetType,
} from "../../shared/submission-contract";
import type { SessionPrincipal } from "../domain/types";
import type { D1PreparedStatement, Env } from "../types/cloudflare";
import { all, first } from "../lib/db";
import { HttpError, json, readJson, readJsonLimited } from "../lib/http";
import { enforcePublicRateLimit } from "../lib/public-rate-limit";
import {
  normalizePlaceRevision,
  normalizeStoredRevision,
  validatePlaceRevision,
} from "../lib/revision-contracts";
import { normalizeFeedbackSubmissionPayload, normalizeStoredSubmissionPayload } from "../lib/submission-contracts";
import {
  exactObject,
  isoNow,
  jsonString,
  makeId,
  objectValue,
  oneOf,
  requiredString,
  sha256,
} from "../lib/values";
import {
  assertAttachablePhotos,
  dropQuarantineCopies,
  linkSubmissionPhotoStatements,
  listSubmissionPhotos,
  promoteSubmissionPhotos,
  publicMediaPath,
} from "./media";

const TARGET_TYPES = ["place", "facility", "merchant_outlet", "transit_stop", "new_place"] as const;
const SUBMISSION_DECISIONS = ["accept", "partial", "reject"] as const;
const FIELD_DECISIONS = ["adopt", "skip"] as const;

interface SubmissionRow {
  id: string;
  targetType: SubmissionTargetType;
  targetId: string | null;
  baseRevisionId: string | null;
  payloadJson: string;
  submitterName: string | null;
  submitterContact: string | null;
  status: "pending" | "in_review" | "accepted" | "partially_accepted" | "rejected" | "withdrawn";
  createdAt: string;
  reviewedAt: string | null;
}

/** 列表行额外带出提交账号，审核端据此显示「谁传的」而不是一个自由文本昵称。 */
interface SubmissionListRow extends SubmissionRow {
  submitterUserId: string | null;
  submitterEmail: string | null;
  submitterAccountName: string | null;
}

interface ProducedRevision {
  type: "place";
  id: string;
  statement: D1PreparedStatement;
}

interface ReviewContract {
  decision: SubmissionDecision;
  note: string | null;
  fieldDecisions: SubmissionFieldDecisions;
  adoptedFields: ReadonlySet<SubmissionFieldKey>;
}

function nullableText(value: unknown, field: string, maximum: number): string | null {
  if (value === null) return null;
  return requiredString(value, field, maximum);
}

function assertFeedbackTarget(payload: FeedbackSubmissionPayload, targetType: SubmissionTargetType): void {
  const expected: SubmissionTargetType = payload.feedbackType === "new_place"
    ? "new_place"
    : payload.feedbackType === "shuttle"
      ? "transit_stop"
      : "place";
  if (targetType !== expected) {
    throw new HttpError(400, "validation_error", `feedbackType ${payload.feedbackType} requires targetType ${expected}`);
  }
}

async function validateFeedbackTarget(
  env: Env,
  targetType: SubmissionTargetType,
  targetId: string | null,
  baseRevisionId: string | null,
): Promise<void> {
  if (targetType === "new_place") {
    if (targetId !== null) throw new HttpError(400, "validation_error", "targetId must be null for a new place");
    if (baseRevisionId !== null) throw new HttpError(400, "validation_error", "baseRevisionId must be null for a new place");
    return;
  }
  if (targetId === null) throw new HttpError(400, "validation_error", "targetId is required");
  if (targetType === "place") {
    if (baseRevisionId === null) {
      throw new HttpError(400, "validation_error", "baseRevisionId is required for a place submission");
    }
    const place = await first<{ currentRevisionId: string | null }>(
      env.DB,
      "select current_revision_id as currentRevisionId from places where id=? and lifecycle_status<>'retired'",
      [targetId],
    );
    if (!place) throw new HttpError(404, "target_not_found", "Submission target does not exist");
    if (place.currentRevisionId !== baseRevisionId) {
      throw new HttpError(409, "stale_base_revision", "The place changed before this submission was created");
    }
    return;
  }
  if (targetType !== "transit_stop") {
    throw new HttpError(400, "validation_error", "This feedback form does not accept facility or merchant targets");
  }
  if (baseRevisionId !== null) {
    throw new HttpError(400, "validation_error", "baseRevisionId must be null for a transit stop submission");
  }
  const stop = await first<{ id: string }>(env.DB, "select id from transit_stops where id=?", [targetId]);
  if (!stop) throw new HttpError(404, "target_not_found", "Submission target does not exist");
}

/**
 * POST /api/public/submissions — 用户反馈提交，可匿名也可署名。
 *
 * 反馈的门槛故意保持在零：路过的人发现信息有误就该能直接说，不必先注册。所以
 * `principal` 允许为 null。
 *
 * 但「匿名」不等于「无从判断来源」：如果提交者恰好登录了，服务端把账号写进
 * `submitter_user_id`（指向管理端同一张 users 表），审核时就能溯源。这一列由服务端
 * 从会话取，请求体改不动；`submitterName` 仅是展示用的自称，登录时缺省回落到账号名。
 *
 * 与之相对，志愿者采集（/api/public/collection-tasks/*）必须登录——那是有组织的
 * 数据录入，要能追责，见 collections.ts。
 */
export async function createSubmission(
  request: Request,
  env: Env,
  principal: SessionPrincipal | null,
): Promise<Response> {
  await enforcePublicRateLimit(request, env, "submission-create", 20);
  const body = exactObject(
    await readJsonLimited<unknown>(request, 64 * 1024),
    "submission",
    ["targetType", "targetId", "baseRevisionId", "payload", "submitterName", "submitterContact", "photoMediaIds"],
  );
  const targetType = oneOf(body.targetType, "targetType", TARGET_TYPES);
  const targetId = nullableText(body.targetId, "targetId", 100);
  const baseRevisionId = nullableText(body.baseRevisionId, "baseRevisionId", 100);
  const payload = normalizeFeedbackSubmissionPayload(body.payload);
  assertFeedbackTarget(payload, targetType);
  await validateFeedbackTarget(env, targetType, targetId, baseRevisionId);
  const photoMediaIds = await assertAttachablePhotos(env, body.photoMediaIds);
  // 昵称是展示用的自称，登录时缺省回落到账号名；账号归属由 submitter_user_id 单独承载。
  const submitterName = nullableText(body.submitterName, "submitterName", 100) ?? principal?.displayName ?? null;
  const submitterContact = nullableText(body.submitterContact, "submitterContact", 200);
  const id = makeId("submission");
  await env.DB.batch([
    env.DB.prepare(
      `insert into content_submissions(id,target_type,target_id,base_revision_id,payload_json,submitter_name,submitter_contact,submitter_user_id,status,created_at)
       values(?,?,?,?,?,?,?,?,'pending',?)`,
    ).bind(
      id,
      targetType,
      targetId,
      baseRevisionId,
      jsonString(payload),
      submitterName,
      submitterContact,
      principal?.userId ?? null,
      isoNow(),
    ),
    ...linkSubmissionPhotoStatements(env, id, photoMediaIds),
  ]);
  return json(
    { id, status: "pending", photoCount: photoMediaIds.length, attributed: principal !== null },
    { status: 201 },
  );
}

export async function listSubmissions(env: Env): Promise<Response> {
  const items = await all<SubmissionListRow>(
    env.DB,
    `select s.id,s.target_type as targetType,s.target_id as targetId,s.base_revision_id as baseRevisionId,s.payload_json as payloadJson,
            s.submitter_name as submitterName,s.submitter_contact as submitterContact,s.status,s.created_at as createdAt,
            s.reviewed_at as reviewedAt,s.submitter_user_id as submitterUserId,
            u.email as submitterEmail,u.display_name as submitterAccountName
       from content_submissions s left join users u on u.id=s.submitter_user_id
      order by s.created_at desc limit 200`,
  );
  const links = await all<{ submissionId: string; mediaAssetId: string; bucketScope: string; status: string }>(
    env.DB,
    `select sm.submission_id as submissionId,sm.media_asset_id as mediaAssetId,ma.bucket_scope as bucketScope,ma.status
       from submission_media sm join media_assets ma on ma.id=sm.media_asset_id
      order by sm.submission_id,sm.sort_order`,
  );
  const grouped = new Map<string, Array<{ mediaId: string; bucketScope: string; status: string }>>();
  for (const link of links) {
    const existing = grouped.get(link.submissionId);
    const photo = { mediaId: link.mediaAssetId, bucketScope: link.bucketScope, status: link.status };
    if (existing) existing.push(photo);
    else grouped.set(link.submissionId, [photo]);
  }
  return json({
    items: items.map(({ payloadJson, ...item }) => ({
      ...item,
      payload: normalizeStoredSubmissionPayload(payloadJson, `content_submissions.${item.id}.payload_json`),
      photos: grouped.get(item.id) ?? [],
    })),
  });
}

function normalizeReviewContract(
  value: unknown,
  payload: SubmissionPayload,
  targetType: SubmissionTargetType,
  attachedPhotoCount: number,
): ReviewContract {
  const body = exactObject(value, "review", ["decision", "note", "fieldDecisions"]);
  const decision = oneOf(body.decision, "decision", SUBMISSION_DECISIONS);
  const note = nullableText(body.note, "note", 2_000);
  if (decision === "reject" && note === null) {
    throw new HttpError(400, "validation_error", "note is required when rejecting a submission");
  }
  const expectedKeys = submissionReviewFieldKeys(payload, targetType, attachedPhotoCount);
  const expected = new Set(expectedKeys);
  const rawFieldDecisions = objectValue(body.fieldDecisions, "fieldDecisions");
  for (const key of Object.keys(rawFieldDecisions)) {
    if (!expected.has(key as SubmissionFieldKey)) {
      throw new HttpError(400, "validation_error", `fieldDecisions.${key} does not correspond to this submission`);
    }
  }
  const fieldDecisions: SubmissionFieldDecisions = {};
  const adoptedFields = new Set<SubmissionFieldKey>();
  for (const key of expectedKeys) {
    if (!Object.hasOwn(rawFieldDecisions, key)) {
      throw new HttpError(400, "validation_error", `fieldDecisions.${key} is required`);
    }
    const fieldDecision = oneOf(
      rawFieldDecisions[key],
      `fieldDecisions.${key}`,
      FIELD_DECISIONS,
    ) as SubmissionFieldDecision;
    fieldDecisions[key] = fieldDecision;
    if (fieldDecision === "adopt") adoptedFields.add(key);
  }
  if (decision === "accept" && adoptedFields.size !== expectedKeys.length) {
    throw new HttpError(400, "validation_error", "accept requires every field to be adopted");
  }
  if (decision === "partial" && (adoptedFields.size === 0 || adoptedFields.size === expectedKeys.length)) {
    throw new HttpError(400, "validation_error", "partial requires both adopted and skipped fields");
  }
  if (decision === "reject" && adoptedFields.size !== 0) {
    throw new HttpError(400, "validation_error", "reject requires every field to be skipped");
  }
  return { decision, note, fieldDecisions, adoptedFields };
}

export async function reviewSubmission(
  request: Request,
  env: Env,
  reviewer: SessionPrincipal,
  submissionId: string,
): Promise<Response> {
  const submission = await first<SubmissionRow>(
    env.DB,
    `select id,target_type as targetType,target_id as targetId,base_revision_id as baseRevisionId,payload_json as payloadJson,
            submitter_name as submitterName,submitter_contact as submitterContact,status,created_at as createdAt,reviewed_at as reviewedAt
       from content_submissions where id=?`,
    [submissionId],
  );
  if (!submission) throw new HttpError(404, "not_found", "Submission does not exist");
  if (submission.status !== "pending" && submission.status !== "in_review") {
    throw new HttpError(409, "invalid_state", "Submission has already been decided");
  }
  const payload = normalizeStoredSubmissionPayload(
    submission.payloadJson,
    `content_submissions.${submissionId}.payload_json`,
  );
  const attached = await listSubmissionPhotos(env, submissionId);
  const review = normalizeReviewContract(
    await readJson<unknown>(request),
    payload,
    submission.targetType,
    attached.length,
  );
  const attachedIds = attached.map((photo) => photo.mediaAssetId);
  const adoptedPhotoIds = adoptedSubmissionPhotoMediaIds(payload, attachedIds, review.adoptedFields);
  const adoptedPhotoSet = new Set(adoptedPhotoIds);
  const directPhotoIds = payload.submissionKind === "collection"
    ? payload.collection.photoMediaIds.filter((id) => adoptedPhotoSet.has(id))
    : adoptedPhotoIds;
  const produced = review.decision === "reject"
    ? null
    : await buildProducedRevision(env, reviewer, submission, payload, review.adoptedFields, directPhotoIds);
  const promotion = await promoteSubmissionPhotos(env, submissionId, adoptedPhotoIds);
  const reviewId = makeId("sreview");
  const status = review.decision === "accept"
    ? "accepted"
    : review.decision === "partial"
      ? "partially_accepted"
      : "rejected";
  const now = isoNow();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `insert into submission_reviews(id,submission_id,reviewer_id,decision,field_decisions_json,note,produced_revision_type,produced_revision_id,created_at)
       values(?,?,?,?,?,?,?,?,?)`,
    ).bind(
      reviewId,
      submissionId,
      reviewer.userId,
      review.decision,
      jsonString(review.fieldDecisions),
      review.note,
      produced?.type ?? null,
      produced?.id ?? null,
      now,
    ),
    env.DB.prepare("update content_submissions set status=?,reviewed_at=? where id=?")
      .bind(status, now, submissionId),
  ];
  if (produced) statements.push(produced.statement);
  statements.push(...promotion.statements);
  statements.push(
    env.DB.prepare(
      "update collection_tasks set status=?,reviewed_at=?,updated_at=? where submission_id=?",
    ).bind(produced ? "submitted" : "needs_recollection", now, now, submissionId),
  );
  await env.DB.batch(statements);
  await dropQuarantineCopies(env, attached.filter((photo) => adoptedPhotoSet.has(photo.mediaAssetId)));
  return json({
    id: reviewId,
    submissionId,
    status,
    producedRevisionType: produced?.type ?? null,
    producedRevisionId: produced?.id ?? null,
    publishedPhotoCount: adoptedPhotoIds.length,
  });
}

function replaceFact(facts: Map<string, PlaceFact>, label: string, value: string): void {
  if (value.length === 0) facts.delete(label);
  else facts.set(label, { label, value });
}

async function buildProducedRevision(
  env: Env,
  reviewer: SessionPrincipal,
  submission: SubmissionRow,
  payload: SubmissionPayload,
  adoptedFields: ReadonlySet<SubmissionFieldKey>,
  directPhotoIds: readonly string[],
): Promise<ProducedRevision | null> {
  if (submission.targetType !== "place" || submission.targetId === null) return null;
  if (adoptedFields.size === 0) return null;
  if (submission.baseRevisionId === null) {
    throw new Error(`Place submission ${submission.id} has no base revision`);
  }
  const pending = await first<{ id: string }>(
    env.DB,
    "select id from place_revisions where place_id=? and editorial_status in ('draft','in_review') limit 1",
    [submission.targetId],
  );
  if (pending) {
    throw new HttpError(409, "pending_revision_exists", "Resolve the existing place revision before accepting this submission");
  }
  const current = await first<Record<string, unknown>>(
    env.DB,
    `select r.* from places p join place_revisions r on r.id=p.current_revision_id
      where p.id=? and p.current_revision_id=?`,
    [submission.targetId, submission.baseRevisionId],
  );
  if (!current) {
    throw new HttpError(409, "stale_base_revision", "The target place changed after this submission was created");
  }
  const next = await first<{ nextNo: number }>(
    env.DB,
    "select max(revision_no)+1 as nextNo from place_revisions where place_id=?",
    [submission.targetId],
  );
  if (!next || !Number.isInteger(next.nextNo) || next.nextNo <= 1) {
    throw new Error(`Could not allocate a revision number for place ${submission.targetId}`);
  }
  const stored = normalizeStoredRevision("place", current);
  const existingFacts = stored.content.detail.facts;
  const facts = new Map<string, PlaceFact>();
  for (const fact of existingFacts) facts.set(fact.label, { ...fact });
  let description = stored.description;
  if (payload.submissionKind === "feedback" && adoptedFields.has("description")) {
    description = payload.description;
  }
  if (payload.submissionKind === "collection") {
    if (adoptedFields.has("collection.openHours")) {
      replaceFact(facts, "开放时间", payload.collection.openHours);
    }
    if (adoptedFields.has("collection.phone")) {
      replaceFact(facts, "联系电话", payload.collection.phone);
    }
    if (adoptedFields.has("collection.organization")) {
      replaceFact(facts, "所属单位", payload.collection.organization);
    }
    if (adoptedFields.has("collection.floors")) {
      const notes = payload.collection.floors
        .filter((floor) => floor.note.length > 0)
        .map((floor) => `${floor.levelCode}：${floor.note}`);
      replaceFact(facts, "楼层说明", notes.join("\n"));
    }
  }
  const media: RevisionMediaItem[] = [];
  const existingMedia = stored.content.detail.media;
  for (const item of existingMedia) media.push({ ...item });
  const knownUrls = new Set(media.map((item) => item.url));
  for (const mediaId of directPhotoIds) {
    const url = publicMediaPath(mediaId);
    if (knownUrls.has(url)) throw new Error(`Place revision already contains submission media ${mediaId}`);
    knownUrls.add(url);
    media.push({
      role: media.length === 0 ? "cover" : "gallery",
      url,
      alt: "",
      caption: "用户提供",
    });
  }
  const detail = {
    ...stored.content.detail,
    facts: Array.from(facts.values()),
    media,
  };
  const revision: PlaceRevisionWrite = normalizePlaceRevision({
    displayName: stored.displayName,
    summary: stored.summary,
    description,
    content: { ...stored.content, detail },
    sourceId: stored.sourceId,
    structure: stored.structure,
  });
  await validatePlaceRevision(env, revision, submission.targetId);
  const contentJson = jsonString(revision.content);
  const structureJson = jsonString(revision.structure);
  const contentHash = await sha256(
    `${revision.displayName}\n${revision.summary ?? ""}\n${revision.description ?? ""}\n${contentJson}\n${structureJson}`,
  );
  const revisionId = makeId("prev");
  const createdAt = isoNow();
  return {
    type: "place",
    id: revisionId,
    statement: env.DB.prepare(
      `insert into place_revisions(id,place_id,revision_no,editorial_status,display_name,summary,description,content_json,structure_json,source_id,based_on_revision_id,content_hash,created_by,created_at,submitted_at)
       values(?,?,?,'in_review',?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      revisionId,
      submission.targetId,
      next.nextNo,
      revision.displayName,
      revision.summary,
      revision.description,
      contentJson,
      structureJson,
      revision.sourceId,
      submission.baseRevisionId,
      contentHash,
      reviewer.userId,
      createdAt,
      createdAt,
    ),
  };
}
