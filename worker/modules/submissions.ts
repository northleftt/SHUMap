import type { Env } from "../types/cloudflare";
import { all, first } from "../lib/db";
import { HttpError, json, readJson } from "../lib/http";
import { isoNow, jsonString, makeId, objectValue, optionalString, requiredString } from "../lib/values";

export async function createSubmission(request: Request, env: Env): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 64 * 1024) throw new HttpError(413, "payload_too_large", "Submission must be at most 64 KiB");
  const body = await readJson<Record<string, unknown>>(request);
  const targetType = requiredString(body.targetType, "targetType", 50);
  if (!["place", "facility", "merchant_outlet", "transit_stop", "new_place"].includes(targetType)) {
    throw new HttpError(400, "validation_error", "Invalid targetType");
  }
  const targetId = optionalString(body.targetId, "targetId", 100);
  if (targetType !== "new_place" && !targetId) throw new HttpError(400, "validation_error", "targetId is required");
  const payload = objectValue(body.payload, "payload");
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

export async function reviewSubmission(request: Request, env: Env, reviewerId: string, submissionId: string): Promise<Response> {
  const submission = await first<Record<string, unknown>>(env.DB, "select * from content_submissions where id=?", [submissionId]);
  if (!submission) throw new HttpError(404, "not_found", "Submission does not exist");
  if (!["pending", "in_review"].includes(String(submission.status))) throw new HttpError(409, "invalid_state", "Submission has already been decided");
  const body = await readJson<Record<string, unknown>>(request);
  const decision = requiredString(body.decision, "decision", 20);
  if (!["accept", "partial", "reject"].includes(decision)) throw new HttpError(400, "validation_error", "Invalid decision");
  const reviewId = makeId("sreview");
  const status = decision === "accept" ? "accepted" : decision === "partial" ? "partially_accepted" : "rejected";
  const now = isoNow();
  await env.DB.batch([
    env.DB.prepare(
      `insert into submission_reviews(id,submission_id,reviewer_id,decision,field_decisions_json,note,produced_revision_type,produced_revision_id,created_at)
       values(?,?,?,?,?,?,?,?,?)`,
    ).bind(
      reviewId, submissionId, reviewerId, decision, jsonString(body.fieldDecisions ?? {}), optionalString(body.note, "note", 2_000),
      optionalString(body.producedRevisionType, "producedRevisionType", 50), optionalString(body.producedRevisionId, "producedRevisionId", 100), now,
    ),
    env.DB.prepare("update content_submissions set status=?,reviewed_at=? where id=?").bind(status, now, submissionId),
  ]);
  return json({ id: reviewId, submissionId, status });
}
