import type { SessionPrincipal } from "../domain/types";
import type { Env } from "../types/cloudflare";
import { all, first } from "../lib/db";
import { HttpError, json, readJson, readJsonLimited } from "../lib/http";
import { enforcePublicRateLimit } from "../lib/public-rate-limit";
import { isoNow, jsonString, makeId, objectValue, optionalString, parseJson, requiredString, sha256 } from "../lib/values";

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
  await env.DB.prepare(
    `insert into content_submissions(id,target_type,target_id,base_revision_id,payload_json,submitter_name,submitter_contact,status,created_at)
     values(?,?,?,?,?,?,?,'pending',?)`,
  ).bind(
    id, targetType, targetId, optionalString(body.baseRevisionId, "baseRevisionId", 100), jsonString(payload),
    optionalString(body.submitterName, "submitterName", 100), optionalString(body.submitterContact, "submitterContact", 200), isoNow(),
  ).run();
  return json({ id, status: "pending" }, { status: 201 });
}

export async function listSubmissions(env: Env): Promise<Response> {
  const items = await all(
    env.DB,
    `select id,target_type as targetType,target_id as targetId,base_revision_id as baseRevisionId,payload_json as payloadJson,
            submitter_name as submitterName,submitter_contact as submitterContact,status,created_at as createdAt,reviewed_at as reviewedAt
       from content_submissions order by created_at desc limit 200`,
  );
  return json({ items });
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
  const produced = decision !== "reject"
    ? await buildProducedRevision(env, reviewer, submission, payload, fieldDecisions, decision)
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
  statements.push(
    env.DB.prepare(
      `update collection_tasks set status=?,reviewed_at=?,updated_at=? where submission_id=?`,
    ).bind(decision === "accept" && produced ? "submitted" : "needs_recollection", now, now, submissionId),
  );
  await env.DB.batch(statements);
  return json({ id: reviewId, submissionId, status, producedRevisionType: produced?.type ?? null, producedRevisionId: produced?.id ?? null });
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
): Promise<ProducedRevision | null> {
  if (submission.target_type !== "place" || typeof submission.target_id !== "string") return null;
  const collection = payload.collection;
  const detailPatch = payload.detail;
  const changes = payload.changes;
  if (!isObject(collection) && !isObject(detailPatch) && !isObject(changes)) return null;
  if (decision === "partial" && !Object.values(fieldDecisions).includes("adopt")) return null;

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
    statement: env.DB.prepare(
      `insert into place_revisions(id,place_id,revision_no,editorial_status,display_name,summary,description,content_json,source_id,based_on_revision_id,content_hash,created_by,created_at)
       values(?,?,?,'draft',?,?,?,?,?,?,?,?,?)`,
    ).bind(
      revisionId, submission.target_id as string, next?.nextNo ?? 1, displayName, summary ?? null, description ?? null,
      contentJson, (current.source_id as string | null) ?? null, current.current_revision_id as string, contentHash, reviewer.userId, createdAt,
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
