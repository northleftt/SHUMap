import type { RevisionLocationInput } from "../../shared/revision-contract";
import type { SessionPrincipal } from "../domain/types";
import type { D1PreparedStatement, Env } from "../types/cloudflare";
import { all, assertExists, first } from "../lib/db";
import { HttpError, json, readJson } from "../lib/http";
import {
  arrayValue,
  exactObject,
  isoNow,
  jsonString,
  makeId,
  objectValue,
  oneOf,
  optionalString,
  requiredString,
} from "../lib/values";
import { normalizeLocationInputs } from "../lib/revision-contracts";
import { audit } from "./audit";
import { planLocation } from "./locations";

const EVENT_TYPES = ["maintenance", "activity", "closure", "notice"] as const;
const EVENT_SEVERITIES = ["info", "warning", "critical"] as const;
const EVENT_TARGET_TYPES = [
  "place", "floor", "space", "facility", "merchant_outlet", "transit_stop", "transit_route", "transit_trip", "map_feature",
] as const;
const EVENT_LOCATION_ROLES = ["event_location", "impact_area", "route_shape"] as const;
const EVENT_TARGET_TABLES: Record<(typeof EVENT_TARGET_TYPES)[number], string> = {
  place: "places",
  floor: "floors",
  space: "indoor_spaces",
  facility: "facility_instances",
  merchant_outlet: "merchant_outlets",
  transit_stop: "transit_stops",
  transit_route: "transit_routes",
  transit_trip: "transit_trips",
  map_feature: "map_features",
};
const CAMPAIGN_ITEM_TYPES = ["rich_text", "place", "facility", "transit_route", "route", "external_link", "action"] as const;
const MAX_EVENT_LOCATIONS = 10;

interface EventTargetInput {
  type: (typeof EVENT_TARGET_TYPES)[number];
  id: string;
  impactType: string;
}

function isoTimestamp(value: unknown, field: string): string {
  const text = requiredString(value, field, 50);
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== text) {
    throw new HttpError(400, "validation_error", `${field} must be a canonical ISO timestamp`);
  }
  return text;
}

function nullableIsoTimestamp(value: unknown, field: string): string | null {
  if (value === null) return null;
  return isoTimestamp(value, field);
}

/** 地图标注颜色：#rrggbb 或 null（null = 双端按 severity 默认色渲染）。 */
function eventColor(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  const text = requiredString(value, field, 20);
  if (!/^#[0-9a-fA-F]{6}$/.test(text)) {
    throw new HttpError(400, "validation_error", `${field} must be a #rrggbb hex color`);
  }
  return text.toLowerCase();
}

function eventTargets(value: unknown): EventTargetInput[] {
  const targets = arrayValue(value, "targets", 100).map((raw, index) => {
    const field = `targets[${index}]`;
    const target = exactObject(raw, field, ["type", "id", "impactType"]);
    return {
      type: oneOf(target.type, `${field}.type`, EVENT_TARGET_TYPES),
      id: requiredString(target.id, `${field}.id`, 100),
      impactType: requiredString(target.impactType, `${field}.impactType`, 100),
    };
  });
  const keys = targets.map((target) => `${target.type}\u0000${target.id}`);
  if (new Set(keys).size !== keys.length) throw new HttpError(400, "validation_error", "targets must not contain duplicates");
  return targets;
}

function eventLocations(value: unknown): RevisionLocationInput[] {
  const locations = normalizeLocationInputs(value, "locations", MAX_EVENT_LOCATIONS);
  for (const [index, location] of locations.entries()) {
    if (!EVENT_LOCATION_ROLES.includes(location.role as (typeof EVENT_LOCATION_ROLES)[number])) {
      throw new HttpError(400, "validation_error", `locations[${index}].role is not supported for operational events`);
    }
    const expectedGeometry = location.role === "event_location"
      ? "Point"
      : location.role === "impact_area"
        ? "Polygon"
        : "LineString";
    if (location.geometryType !== expectedGeometry || location.geometry === null) {
      throw new HttpError(400, "validation_error", `locations[${index}] must contain ${expectedGeometry} geometry`);
    }
    if (location.crs !== "svg_viewbox") {
      throw new HttpError(400, "validation_error", `locations[${index}].crs must be svg_viewbox`);
    }
  }
  return locations;
}

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
    `select id,event_type as eventType,severity,color,editorial_status as editorialStatus,operational_status as operationalStatus,
            title,description,starts_at as startsAt,expected_ends_at as expectedEndsAt,auto_expire_at as autoExpireAt,
            resolved_at as resolvedAt,last_verified_at as lastVerifiedAt,${publicOnly ? "" : "review_note as reviewNote,"}created_at as createdAt,updated_at as updatedAt
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
  const body = exactObject(await readJson<unknown>(request), "operation", [
    "eventType", "severity", "title", "description", "startsAt", "expectedEndsAt", "autoExpireAt", "sourceId",
    "responsibleOrganizationId", "targets", "locations", "color",
  ]);
  const eventType = oneOf(body.eventType, "eventType", EVENT_TYPES);
  const severity = oneOf(body.severity, "severity", EVENT_SEVERITIES);
  const color = eventColor(body.color, "color");
  const title = requiredString(body.title, "title", 200);
  const description = optionalString(body.description, "description", 10_000);
  const startsAt = isoTimestamp(body.startsAt, "startsAt");
  const expectedEndsAt = nullableIsoTimestamp(body.expectedEndsAt, "expectedEndsAt");
  const autoExpireAt = nullableIsoTimestamp(body.autoExpireAt, "autoExpireAt");
  if (expectedEndsAt !== null && expectedEndsAt <= startsAt) {
    throw new HttpError(400, "validation_error", "expectedEndsAt must be after startsAt");
  }
  if (autoExpireAt !== null && autoExpireAt <= startsAt) {
    throw new HttpError(400, "validation_error", "autoExpireAt must be after startsAt");
  }
  const sourceId = optionalString(body.sourceId, "sourceId", 100);
  const organizationId = optionalString(body.responsibleOrganizationId, "responsibleOrganizationId", 100);
  const targets = eventTargets(body.targets);
  const locations = eventLocations(body.locations);
  await Promise.all([
    assertExists(env.DB, "data_sources", sourceId, "Data source"),
    assertExists(env.DB, "organizations", organizationId, "Responsible organization"),
    ...targets.map((target) => assertExists(env.DB, EVENT_TARGET_TABLES[target.type], target.id, "Event target")),
  ]);
  const id = makeId("event");
  const now = isoNow();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `insert into operational_events(id,event_type,severity,color,editorial_status,operational_status,title,description,starts_at,expected_ends_at,auto_expire_at,source_id,responsible_organization_id,created_by,created_at,updated_at)
       values(?,?,?,?,'draft','scheduled',?,?,?,?,?,?,?,?,?,?)`,
    ).bind(id, eventType, severity, color, title, description, startsAt, expectedEndsAt, autoExpireAt, sourceId, organizationId, principal.userId, now, now),
    ...targets.map((target) => env.DB.prepare(
      "insert into operational_event_targets(event_id,target_type,target_id,impact_type) values(?,?,?,?)",
    ).bind(id, target.type, target.id, target.impactType)),
  ];
  for (const location of locations) {
    const plan = await planLocation(env, "operational_event", id, location, principal, now);
    statements.push(...plan.statements);
  }
  await env.DB.batch(statements);
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
  // 驳回必须留下理由，与 submissions.ts 的 reviewSubmission 对齐：被驳回的运营事件
  // 对供稿人是唯一的通知渠道就是这条 note，空着驳回等于无声否决。
  if (decision === "reject" && (note === null || note.trim() === "")) {
    throw new HttpError(400, "validation_error", "Rejection requires a non-empty note");
  }
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

/**
 * PUT /api/admin/operations/:id — 编辑事件主体（不含几何，几何走 PUT :id/locations）。
 *
 * 草稿/被驳回/已通过的事件都能改：被驳回的改完回到 draft 重新排队审核（并清掉
 * 上一轮的 reviewed_by/at，review_note 保留供审核人参考）；已通过的保持 approved，
 * 改动即时生效——与 locations replace 的「live 数据无需发版」同一口径。
 * 已结束（resolved/expired/cancelled）的事件只读，只能删除。
 */
export async function updateOperationalEvent(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  eventId: string,
  requestId: string,
): Promise<Response> {
  const event = await first<Record<string, unknown>>(env.DB, "select * from operational_events where id=?", [eventId]);
  if (!event) throw new HttpError(404, "not_found", "Event does not exist");
  const editorialStatus = String(event.editorial_status);
  if (!["draft", "in_review", "rejected", "approved"].includes(editorialStatus)) {
    throw new HttpError(409, "invalid_state", "Event cannot be edited in its current state");
  }
  if (["resolved", "expired", "cancelled"].includes(String(event.operational_status))) {
    throw new HttpError(409, "invalid_state", "Ended events cannot be edited");
  }

  const body = exactObject(await readJson<unknown>(request), "operation", [
    "eventType", "severity", "title", "description", "startsAt", "expectedEndsAt", "autoExpireAt", "sourceId",
    "responsibleOrganizationId", "targets", "color",
  ]);
  const eventType = oneOf(body.eventType, "eventType", EVENT_TYPES);
  const severity = oneOf(body.severity, "severity", EVENT_SEVERITIES);
  const color = eventColor(body.color, "color");
  const title = requiredString(body.title, "title", 200);
  const description = optionalString(body.description, "description", 10_000);
  const startsAt = isoTimestamp(body.startsAt, "startsAt");
  const expectedEndsAt = nullableIsoTimestamp(body.expectedEndsAt, "expectedEndsAt");
  const autoExpireAt = nullableIsoTimestamp(body.autoExpireAt, "autoExpireAt");
  if (expectedEndsAt !== null && expectedEndsAt <= startsAt) {
    throw new HttpError(400, "validation_error", "expectedEndsAt must be after startsAt");
  }
  if (autoExpireAt !== null && autoExpireAt <= startsAt) {
    throw new HttpError(400, "validation_error", "autoExpireAt must be after startsAt");
  }
  const sourceId = optionalString(body.sourceId, "sourceId", 100);
  const organizationId = optionalString(body.responsibleOrganizationId, "responsibleOrganizationId", 100);
  const targets = eventTargets(body.targets);
  await Promise.all([
    assertExists(env.DB, "data_sources", sourceId, "Data source"),
    assertExists(env.DB, "organizations", organizationId, "Responsible organization"),
    ...targets.map((target) => assertExists(env.DB, EVENT_TARGET_TABLES[target.type], target.id, "Event target")),
  ]);

  const now = isoNow();
  // 被驳回 → 改完回草稿重新排队；其余状态原样保留。
  const nextEditorialStatus = editorialStatus === "rejected" ? "draft" : editorialStatus;
  await env.DB.batch([
    env.DB.prepare(
      `update operational_events
          set event_type=?,severity=?,color=?,title=?,description=?,starts_at=?,expected_ends_at=?,auto_expire_at=?,
              source_id=?,responsible_organization_id=?,editorial_status=?,
              reviewed_by=case when editorial_status='rejected' then null else reviewed_by end,
              reviewed_at=case when editorial_status='rejected' then null else reviewed_at end,
              updated_at=?
        where id=?`,
    ).bind(eventType, severity, color, title, description, startsAt, expectedEndsAt, autoExpireAt,
      sourceId, organizationId, nextEditorialStatus, now, eventId),
    env.DB.prepare("delete from operational_event_targets where event_id=?").bind(eventId),
    ...targets.map((target) => env.DB.prepare(
      "insert into operational_event_targets(event_id,target_type,target_id,impact_type) values(?,?,?,?)",
    ).bind(eventId, target.type, target.id, target.impactType)),
  ]);
  await audit(env, principal, "operational_event.update", "operational_event", eventId, requestId, event, body);
  return json({ id: eventId, editorialStatus: nextEditorialStatus });
}

/**
 * DELETE /api/admin/operations/:id — 删除事件。
 * targets/updates 靠外键 cascade；entity_locations 的 entity_id 是多态弱引用，
 * 与其锚点一起显式删除（同 replace 端点的清理顺序）。任何状态都可删，一律审计。
 */
export async function deleteOperationalEvent(
  env: Env,
  principal: SessionPrincipal,
  eventId: string,
  requestId: string,
): Promise<Response> {
  const event = await first<Record<string, unknown>>(env.DB, "select * from operational_events where id=?", [eventId]);
  if (!event) throw new HttpError(404, "not_found", "Event does not exist");
  const previous = await all<{ anchorId: string }>(
    env.DB,
    "select anchor_id as anchorId from entity_locations where entity_type='operational_event' and entity_id=?",
    [eventId],
  );
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("delete from entity_locations where entity_type='operational_event' and entity_id=?").bind(eventId),
  ];
  if (previous.length > 0) {
    statements.push(
      env.DB.prepare(`delete from location_anchors where id in (${previous.map(() => "?").join(",")})`)
        .bind(...previous.map((row) => row.anchorId)),
    );
  }
  statements.push(env.DB.prepare("delete from operational_events where id=?").bind(eventId));
  await env.DB.batch(statements);
  await audit(env, principal, "operational_event.delete", "operational_event", eventId, requestId, event, null);
  return json({ id: eventId, deleted: true });
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
  const body = exactObject(await readJson<unknown>(request), "campaign", [
    "title", "summary", "startsAt", "endsAt", "audience", "placements", "items",
  ]);
  const title = requiredString(body.title, "title", 200);
  const summary = optionalString(body.summary, "summary", 500);
  const startsAt = isoTimestamp(body.startsAt, "startsAt");
  const endsAt = isoTimestamp(body.endsAt, "endsAt");
  if (endsAt <= startsAt) throw new HttpError(400, "validation_error", "endsAt must be after startsAt");
  const audience = objectValue(body.audience, "audience");
  const placements = arrayValue(body.placements, "placements", 100);
  const items = arrayValue(body.items, "items", 100).map((raw, index) => {
    const field = `items[${index}]`;
    const item = exactObject(raw, field, ["type", "targetId", "content"]);
    return {
      type: oneOf(item.type, `${field}.type`, CAMPAIGN_ITEM_TYPES),
      targetId: optionalString(item.targetId, `${field}.targetId`, 100),
      content: objectValue(item.content, `${field}.content`),
    };
  });
  const id = makeId("campaign");
  const now = isoNow();
  await env.DB.batch([
    env.DB.prepare(
      `insert into campaigns(id,title,summary,editorial_status,lifecycle_status,starts_at,ends_at,audience_json,placements_json,created_by,created_at,updated_at)
       values(?,?,?,'draft','scheduled',?,?,?,?,?,?,?)`,
    ).bind(id, title, summary, startsAt, endsAt, jsonString(audience), jsonString(placements), principal.userId, now, now),
    ...items.map((item, index) => env.DB.prepare(
      "insert into campaign_items(id,campaign_id,item_type,target_id,content_json,sort_order) values(?,?,?,?,?,?)",
    ).bind(makeId("citem"), id, item.type, item.targetId, jsonString(item.content), index * 10)),
  ]);
  await audit(env, principal, "campaign.create", "campaign", id, requestId, null, body);
  return json({ id, editorialStatus: "draft" }, { status: 201 });
}

// ---------------------------------------------------------------------------
// Geometry re-editing: PUT /api/admin/operations/:id/locations
// ---------------------------------------------------------------------------

/**
 * Replace-all update of an event's locations. Old bindings and their anchors are
 * dropped and the submitted set is inserted in one `DB.batch` transaction, so a
 * rejected input can never leave the event half-edited. The first entry becomes
 * the primary binding (same rule as create), which keeps the partial unique
 * index `idx_entity_locations_one_primary` satisfiable.
 */
export async function replaceOperationalEventLocations(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  eventId: string,
  requestId: string,
): Promise<Response> {
  const event = await first<Record<string, unknown>>(env.DB, "select id from operational_events where id=?", [eventId]);
  if (!event) throw new HttpError(404, "not_found", "Event does not exist");

  const body = exactObject(await readJson<unknown>(request), "operationLocations", ["locations"]);
  const inputs = eventLocations(body.locations);

  const previous = await all<{ bindingId: string; anchorId: string; role: string }>(
    env.DB,
    `select el.id as bindingId,el.anchor_id as anchorId,el.role
       from entity_locations el where el.entity_type='operational_event' and el.entity_id=?`,
    [eventId],
  );

  // Validate every input (roles, crs/map version, spatial hierarchy) before any
  // statement runs, so validation failures never delete the existing geometry.
  const now = isoNow();
  const planned = [];
  for (const input of inputs) {
    planned.push(await planLocation(env, "operational_event", eventId, input, principal, now));
  }

  const statements: D1PreparedStatement[] = [
    env.DB.prepare("delete from entity_locations where entity_type='operational_event' and entity_id=?").bind(eventId),
  ];
  if (previous.length > 0) {
    const anchorIds = previous.map((row) => row.anchorId);
    statements.push(
      env.DB.prepare(`delete from location_anchors where id in (${anchorIds.map(() => "?").join(",")})`).bind(...anchorIds),
    );
  }
  for (const plan of planned) statements.push(...plan.statements);
  statements.push(env.DB.prepare("update operational_events set updated_at=? where id=?").bind(now, eventId));
  await env.DB.batch(statements);

  await audit(
    env,
    principal,
    "operational_event.locations.replace",
    "operational_event",
    eventId,
    requestId,
    { locations: previous },
    { locations: inputs.map((input) => ({ role: input.role, geometryType: input.geometryType, crs: input.crs, campusId: input.campusId, mapVersionId: input.mapVersionId })) },
  );
  return json({
    id: eventId,
    removed: previous.length,
    locations: planned.map((plan, index) => ({ id: plan.anchorId, role: inputs[index].role, isPrimary: inputs[index].isPrimary })),
  });
}
