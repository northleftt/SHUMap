import type { SessionPrincipal } from "../domain/types";
import type { Env } from "../types/cloudflare";
import { run } from "../lib/db";
import { isoNow, jsonString, makeId } from "../lib/values";

export async function audit(
  env: Env,
  actor: SessionPrincipal | null,
  action: string,
  entityType: string,
  entityId: string | null,
  requestId: string,
  before: unknown,
  after: unknown,
  reason?: string | null,
): Promise<void> {
  await run(
    env.DB,
    `insert into audit_events(id,actor_user_id,action,entity_type,entity_id,request_id,reason,before_json,after_json,created_at)
     values(?,?,?,?,?,?,?,?,?,?)`,
    [
      makeId("audit"), actor?.userId ?? null, action, entityType, entityId, requestId, reason ?? null,
      before === undefined ? null : jsonString(before), after === undefined ? null : jsonString(after), isoNow(),
    ],
  );
}
