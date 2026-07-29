import type { SessionPrincipal } from "../domain/types";
import type { Env } from "../types/cloudflare";
import { all, assertExists, first } from "../lib/db";
import { HttpError, json, readJson } from "../lib/http";
import { isoNow, jsonString, makeId, objectValue, optionalString, requiredString } from "../lib/values";
import { audit } from "./audit";
import { createLocation } from "./locations";

export async function listOperationalEvents(env: Env, publicOnly = false): Promise<Response> {
  const now = isoNow();
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const where = publicOnly
    ? `where editorial_status='approved' and (
        (operational_status in ('scheduled','active') and starts_at<=? and (auto_expire_at is null or auto_expire_at>?))
        or (operational_status in ('resolved','cancelled','expired') and coalesce(resolved_at,updated_at)>=?)
      )`
    : "";
  const items = await all<Record<string, unknown>>(
    env.DB,
    `select id,event_type as eventType,severity,editorial_status as editorialStatus,operational_status as operationalStatus,
            title,description,starts_at as startsAt,expected_ends_at as expectedEndsAt,auto_expire_at as autoExpireAt,
            resolved_at as resolvedAt,last_verified_at as lastVerifiedAt,created_at as createdAt,updated_at as updatedAt
       from operational_events ${where} order by starts_at desc`,
    publicOnly ? [now, now, weekAgo] : [],
  );
  if (items.length > 0) {
    const ids = items.map((item) => String(item.id));
    const placeholders = ids.map(() => "?").join(",");
    const [targets, updates, locations] = await Promise.all([
      all<Record<string, unknown>>(
        env.DB,
        `select event_id as eventId,target_type as targetType,target_id as targetId,impact_type as impactType
           from operational_event_targets where event_id in (${placeholders})`,
        ids,
      ),
      all<Record<string, unknown>>(
        env.DB,
        `select id,event_id as eventId,status,message,created_at as createdAt
           from operational_event_updates where event_id in (${placeholders}) order by created_at desc`,
        ids,
      ),
      // 事件位置走 live 表随接口下发（不进 release manifest），审核通过即可上图，无需发版
      all<Record<string, unknown>>(
        env.DB,
        `select el.entity_id as eventId,la.id,la.role,la.geometry_type as geometryType,
                la.geometry_json as geometryJson,la.crs,la.campus_id as campusId
           from entity_locations el join location_anchors la on la.id=el.anchor_id
          where el.entity_type='operational_event' and el.entity_id in (${placeholders})
            and el.valid_to is null and (la.valid_to is null or la.valid_to>?)`,
        [...ids, now],
      ),
    ]);
    for (const item of items) {
      item.targets = targets.filter((target) => target.eventId === item.id).map(({ eventId: _eventId, ...target }) => target);
      item.updates = updates.filter((update) => update.eventId === item.id).map(({ eventId: _eventId, ...update }) => update);
      item.locations = locations.filter((location) => location.eventId === item.id).map(({ eventId: _eventId, ...location }) => location);
    }
  }
  return json({ items }, publicOnly ? { headers: { "cache-control": "public, max-age=30" } } : {});
}

export async function createOperationalEvent(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  requestId: string,
): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request);
  const eventType = requiredString(body.eventType, "eventType", 100);
  const severity = requiredString(body.severity, "severity", 20);
  if (!["info", "warning", "critical"].includes(severity)) throw new HttpError(400, "validation_error", "Invalid severity");
  const title = requiredString(body.title, "title", 200);
  const description = optionalString(body.description, "description", 10_000);
  const startsAt = requiredString(body.startsAt, "startsAt", 50);
  const expectedEndsAt = optionalString(body.expectedEndsAt, "expectedEndsAt", 50);
  const autoExpireAt = optionalString(body.autoExpireAt, "autoExpireAt", 50);
  const sourceId = optionalString(body.sourceId, "sourceId", 100);
  const organizationId = optionalString(body.responsibleOrganizationId, "responsibleOrganizationId", 100);
  await Promise.all([
    assertExists(env.DB, "data_sources", sourceId, "Data source"),
    assertExists(env.DB, "organizations", organizationId, "Responsible organization"),
  ]);
  const id = makeId("event");
  const now = isoNow();
  await env.DB.prepare(
    `insert into operational_events(id,event_type,severity,editorial_status,operational_status,title,description,starts_at,expected_ends_at,auto_expire_at,source_id,responsible_organization_id,created_by,created_at,updated_at)
     values(?,?,?,'draft','scheduled',?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, eventType, severity, title, description, startsAt, expectedEndsAt, autoExpireAt, sourceId, organizationId, principal.userId, now, now).run();

  const targets = Array.isArray(body.targets) ? body.targets : [];
  for (const raw of targets) {
    const target = objectValue(raw, "target");
    const targetType = requiredString(target.type, "target.type", 50);
    const targetId = requiredString(target.id, "target.id", 100);
    const impactType = optionalString(target.impactType, "target.impactType", 100) ?? "affected";
    await env.DB.prepare("insert into operational_event_targets(event_id,target_type,target_id,impact_type) values(?,?,?,?)")
      .bind(id, targetType, targetId, impactType).run();
  }
  const locations = Array.isArray(body.locations) ? body.locations : [];
  for (const [index, raw] of locations.entries()) {
    await createLocation(env, "operational_event", id, raw as never, principal, index === 0);
  }
  await audit(env, principal, "operational_event.create", "operational_event", id, requestId, null, body);
  return json({ id, editorialStatus: "draft", operationalStatus: "scheduled" }, { status: 201 });
}

export async function decideOperationalEvent(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  eventId: string,
  requestId: string,
): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request);
  const decision = requiredString(body.decision, "decision", 20);
  if (!["approve", "reject"].includes(decision)) throw new HttpError(400, "validation_error", "Invalid decision");
  const note = optionalString(body.note, "note", 2_000);
  const event = await first<Record<string, unknown>>(env.DB, "select * from operational_events where id=?", [eventId]);
  if (!event) throw new HttpError(404, "not_found", "Event does not exist");
  if (!["draft", "in_review"].includes(String(event.editorial_status))) throw new HttpError(409, "invalid_state", "Event has already been decided");
  const next = decision === "approve" ? "approved" : "rejected";
  await env.DB.prepare("update operational_events set editorial_status=?,reviewed_by=?,reviewed_at=?,review_note=?,updated_at=? where id=?")
    .bind(next, principal.userId, isoNow(), note, isoNow(), eventId).run();
  await audit(
    env, principal, `operational_event.${decision}`, "operational_event", eventId, requestId,
    event, { ...event, editorial_status: next, review_note: note }, note,
  );
  return json({ id: eventId, editorialStatus: next, reviewNote: note });
}

export async function createOperationalEventUpdate(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  eventId: string,
  requestId: string,
): Promise<Response> {
  const event = await first<Record<string, unknown>>(env.DB, "select id from operational_events where id=?", [eventId]);
  if (!event) throw new HttpError(404, "not_found", "Event does not exist");
  const body = await readJson<Record<string, unknown>>(request);
  const status = requiredString(body.status, "status", 20);
  if (!["progress", "delayed", "resolved"].includes(status)) throw new HttpError(400, "validation_error", "Invalid update status");
  const message = requiredString(body.message, "message", 2000);
  const expectedEndsAt = optionalString(body.expectedEndsAt, "expectedEndsAt", 50);
  if (status === "delayed" && !expectedEndsAt) throw new HttpError(400, "validation_error", "expectedEndsAt is required for delayed updates");
  const now = isoNow();
  const id = makeId("upd");
  await env.DB.prepare("insert into operational_event_updates(id,event_id,status,message,created_by,created_at) values(?,?,?,?,?,?)")
    .bind(id, eventId, status, message, principal.userId, now).run();
  if (status === "delayed") {
    await env.DB.prepare("update operational_events set expected_ends_at=?,updated_at=? where id=?").bind(expectedEndsAt, now, eventId).run();
  } else if (status === "resolved") {
    await env.DB.prepare("update operational_events set operational_status='resolved',resolved_at=?,updated_at=? where id=?").bind(now, now, eventId).run();
  }
  await audit(env, principal, "operational_event.post_update", "operational_event", eventId, requestId, null, body);
  return json({ id, status }, { status: 201 });
}

export async function listCampaigns(env: Env, publicOnly = false): Promise<Response> {
  const now = isoNow();
  const items = await all(
    env.DB,
    `select id,title,summary,editorial_status as editorialStatus,lifecycle_status as lifecycleStatus,starts_at as startsAt,ends_at as endsAt,
            audience_json as audienceJson,placements_json as placementsJson
       from campaigns ${publicOnly ? "where editorial_status='approved' and lifecycle_status in ('scheduled','active') and starts_at<=? and ends_at>?" : ""}
       order by starts_at desc`,
    publicOnly ? [now, now] : [],
  );
  return json({ items }, publicOnly ? { headers: { "cache-control": "public, max-age=60" } } : {});
}

export async function createCampaign(request: Request, env: Env, principal: SessionPrincipal, requestId: string): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request);
  const title = requiredString(body.title, "title", 200);
  const summary = optionalString(body.summary, "summary", 500);
  const startsAt = requiredString(body.startsAt, "startsAt", 50);
  const endsAt = requiredString(body.endsAt, "endsAt", 50);
  if (endsAt <= startsAt) throw new HttpError(400, "validation_error", "endsAt must be after startsAt");
  const id = makeId("campaign");
  const now = isoNow();
  await env.DB.prepare(
    `insert into campaigns(id,title,summary,editorial_status,lifecycle_status,starts_at,ends_at,audience_json,placements_json,created_by,created_at,updated_at)
     values(?,?,?,'draft','scheduled',?,?,?,?,?,?,?)`,
  ).bind(id, title, summary, startsAt, endsAt, jsonString(body.audience ?? {}), jsonString(body.placements ?? []), principal.userId, now, now).run();
  const items = Array.isArray(body.items) ? body.items : [];
  for (const [index, raw] of items.entries()) {
    const item = objectValue(raw, "item");
    await env.DB.prepare("insert into campaign_items(id,campaign_id,item_type,target_id,content_json,sort_order) values(?,?,?,?,?,?)")
      .bind(makeId("citem"), id, requiredString(item.type, "item.type", 50), optionalString(item.targetId, "item.targetId", 100), jsonString(item.content ?? {}), index * 10).run();
  }
  await audit(env, principal, "campaign.create", "campaign", id, requestId, null, body);
  return json({ id, editorialStatus: "draft" }, { status: 201 });
}
