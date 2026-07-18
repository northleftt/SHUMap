import type { SessionPrincipal } from "../domain/types";
import type { Env } from "../types/cloudflare";
import { first } from "../lib/db";
import { HttpError, json, readJson } from "../lib/http";
import { isoNow, optionalString, requiredString } from "../lib/values";
import { audit } from "./audit";

const REVISION_CONFIG = {
  place: { table: "place_revisions", parentTable: "places", parentColumn: "place_id" },
  facility: { table: "facility_revisions", parentTable: "facility_instances", parentColumn: "facility_id" },
  merchant: { table: "merchant_revisions", parentTable: "merchant_outlets", parentColumn: "outlet_id" },
} as const;

type RevisionType = keyof typeof REVISION_CONFIG;

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
      env.DB.prepare(`update ${config.table} set editorial_status='superseded' where ${config.parentColumn}=? and editorial_status='approved' and id<>?`)
        .bind(row.parent_id as string, revisionId),
    );
    statements.push(
      env.DB.prepare(`update ${config.parentTable} set current_revision_id=?,updated_at=? where id=?`)
        .bind(revisionId, now, row.parent_id as string),
    );
  }
  await env.DB.batch(statements);
  await audit(env, principal, `${type}.revision.${decision}`, `${type}_revision`, revisionId, requestId, row, { ...row, editorial_status: nextStatus }, note);
  return json({ id: revisionId, editorialStatus: nextStatus });
}
