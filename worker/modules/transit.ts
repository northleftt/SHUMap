import type { RevisionLocationInput } from "../../shared/revision-contract";
import type { SessionPrincipal } from "../domain/types";
import type { D1PreparedStatement, Env } from "../types/cloudflare";
import { all, assertExists, first } from "../lib/db";
import { HttpError, json, noContent, readJson } from "../lib/http";
import {
  arrayValue,
  booleanValue,
  exactObject,
  isoNow,
  makeId,
  oneOf,
  optionalString,
  partialObject,
  requiredString,
} from "../lib/values";
import { normalizeLocationInputs } from "../lib/revision-contracts";
import { audit } from "./audit";
import { listEntityLocationsByType, planLocation } from "./locations";
import { estimateStopArrivals, loadSegmentMedians, scopeSegmentMedians } from "./travel-time";

// reservation_only 是旧模型的残留（0024 起停用）：预约与否是线路级属性
// （transit_routes.booking_policy），不再允许写在停靠行上。读侧（journeys 查询）
// 仍兼容旧值，迁移前的存量数据不至于匹配不到。
const PICKUP_WRITE_TYPES = ["regular", "none"] as const;
const DROPOFF_TYPES = ["regular", "none"] as const;
const BOOKING_POLICIES = ["required", "optional", "not_required"] as const;
const STOP_STATUSES = ["active", "temporarily_closed", "retired"] as const;
const ROUTE_STATUSES = ["active", "suspended", "retired"] as const;
/**
 * A stop keeps at most two anchors of its own: the waiting point (`boarding_point`,
 * an svg_viewbox canvas pin) and optionally a navigation destination
 * (`navigation_target`, a GCJ-02 point filled from canvas picking) for the
 * "navigate here" link. Whether a direction boards or alights here belongs to
 * the pattern (pickup/dropoff type), not to the stop. The waiting-point role
 * value stays `boarding_point` because the role enum is a CHECK constraint on
 * location_anchors (0001) and renaming it would mean rebuilding that table in
 * production; legacy `alighting_point` rows remain readable but new writes only
 * accept `boarding_point`.
 */
const STOP_LOCATION_ROLES = ["boarding_point", "navigation_target"] as const;
const MAX_PATTERN_STOPS = 40;
const MAX_CALENDAR_EXCEPTIONS = 366;
const MAX_STOP_LOCATIONS = 2;
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

/**
 * `transit_stops.code` and `transit_routes.code` are UNIQUE. Checked up front so
 * a duplicate answers 409 with the offending code instead of surfacing the raw
 * D1 constraint failure as a 500.
 */
async function assertCodeAvailable(
  env: Env,
  table: "transit_stops" | "transit_routes",
  code: string | null,
  excludeId: string | null,
): Promise<void> {
  if (code === null) return;
  const row = await first<{ id: string }>(env.DB, `select id from ${table} where code=?`, [code]);
  if (row && row.id !== excludeId) {
    throw new HttpError(409, "transit_code_taken", `Code ${code} is already used by another record`);
  }
}

/** Validate the `locations` field of a stop create / update payload. */
function stopLocations(value: unknown) {
  const locations = normalizeLocationInputs(value, "locations", MAX_STOP_LOCATIONS);
  const seenRoles = new Set<string>();
  for (const [index, location] of locations.entries()) {
    if (!STOP_LOCATION_ROLES.includes(location.role as (typeof STOP_LOCATION_ROLES)[number])) {
      throw new HttpError(400, "validation_error", `locations[${index}].role is not supported for transit stops`);
    }
    // 候车点与导航终点各最多一个：两个 navigation_target 会让发布端的
    // buildMapPointPois 直接抛「multiple navigation locations」，整张地图打不开。
    if (seenRoles.has(location.role)) {
      throw new HttpError(400, "validation_error", `locations[${index}].role can appear at most once for a transit stop`);
    }
    seenRoles.add(location.role);
  }
  return locations;
}

function dateValue(value: unknown, field: string): string {
  const date = requiredString(value, field, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new HttpError(400, "validation_error", `${field} must be a date such as 2026-08-01`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (daysInMonth === undefined || day < 1 || day > daysInMonth) {
    throw new HttpError(400, "validation_error", `${field} is not a valid calendar date`);
  }
  return date;
}

/**
 * Stop times are rendered verbatim by the client shuttle grid and the imported
 * rows are `HH:MM`, so normalize to that shape instead of `HH:MM:SS`.
 */
function timeValue(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, "validation_error", `${field} must be a string`);
  const parsed = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(value.trim());
  if (!parsed) throw new HttpError(400, "validation_error", `${field} must be a time of day such as 07:30`);
  return `${parsed[1]}:${parsed[2]}`;
}

export async function listTransit(env: Env): Promise<Response> {
  const [stops, routes, patterns, patternStops, calendars, exceptions, trips, stopTimes, stopLocations] = await Promise.all([
    // Retired stops stay in the payload: a pattern may still reference one, and
    // the editor needs to show (and be able to restore) it rather than fail to
    // resolve the name.
    all(env.DB, "select id,place_id as placeId,campus_id as campusId,code,name,status from transit_stops order by status='retired',name"),
    all(env.DB, "select id,code,name,operator_id as operatorId,status,booking_policy as bookingPolicy,booking_url as bookingUrl from transit_routes order by status='retired',name"),
    all(env.DB, "select id,route_id as routeId,direction_id as directionId,name,route_anchor_id as routeAnchorId from transit_patterns order by route_id,direction_id"),
    all(env.DB, "select pattern_id as patternId,stop_id as stopId,stop_sequence as stopSequence,pickup_type as pickupType,dropoff_type as dropoffType from transit_pattern_stops order by pattern_id,stop_sequence"),
    all(env.DB, "select id,name,timezone,valid_from as validFrom,valid_to as validTo,monday,tuesday,wednesday,thursday,friday,saturday,sunday,source_id as sourceId from service_calendars order by valid_from desc,id"),
    all(env.DB, "select calendar_id as calendarId,service_date as serviceDate,exception_type as exceptionType,label from service_calendar_exceptions order by service_date"),
    all(env.DB, "select id,pattern_id as patternId,service_calendar_id as serviceCalendarId,public_label as publicLabel,booking_policy as bookingPolicy,booking_url as bookingUrl,status from transit_trips where status='active' order by id"),
    all(env.DB, "select trip_id as tripId,stop_id as stopId,stop_sequence as stopSequence,arrival_time as arrivalTime,departure_time as departureTime from transit_stop_times order by trip_id,stop_sequence"),
    listEntityLocationsByType(env, "transit_stop"),
  ]);
  // Names of the places a stop can borrow its photos / contact rows from, so the
  // editor can label the binding without a second round trip.
  //
  // `isBuilding` travels with each row because it decides whether the binding
  // does anything on the client: `buildMapBuildings` only emits places with a
  // building footprint, and the shuttle sheet resolves a stop's navigation link
  // through that list. Binding a stop to a place without building structure is
  // accepted by the schema but produces no photo, no contact row and no
  // "navigate here" — the editor has to say so rather than let it look wired up.
  const places = await all<Record<string, unknown>>(
    env.DB,
    `select p.id,r.display_name as displayName,p.kind_id as kindId,p.campus_id as campusId,
            case when b.place_id is null then 0 else 1 end as isBuilding
       from places p left join place_revisions r on r.id=p.current_revision_id
       left join buildings b on b.place_id=p.id
      where p.lifecycle_status<>'retired' order by coalesce(r.display_name,p.id)`,
  );
  return json({
    stops,
    stopLocations,
    routes,
    patterns,
    patternStops,
    calendars,
    exceptions,
    trips,
    stopTimes,
    // Same normalization as GET /api/admin/places, so the flag is a boolean on
    // both admin payloads rather than 0/1 in one and true/false in the other.
    places: places.map((row) => ({ ...row, isBuilding: Number(row.isBuilding) === 1 })),
  });
}

export async function createStop(request: Request, env: Env, principal: SessionPrincipal, requestId: string): Promise<Response> {
  const body = exactObject(await readJson<unknown>(request), "transitStop", ["name", "code", "placeId", "campusId", "locations"]);
  const name = requiredString(body.name, "name", 200);
  const placeId = optionalString(body.placeId, "placeId", 100);
  const campusId = optionalString(body.campusId, "campusId", 100);
  const code = optionalString(body.code, "code", 100);
  const locations = stopLocations(body.locations);
  await Promise.all([
    assertExists(env.DB, "places", placeId, "Place"),
    assertExists(env.DB, "campuses", campusId, "Campus"),
    assertCodeAvailable(env, "transit_stops", code, null),
  ]);
  const id = makeId("stop");
  const now = isoNow();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("insert into transit_stops(id,place_id,campus_id,code,name,status,created_at,updated_at) values(?,?,?,?,?,'active',?,?)")
      .bind(id, placeId, campusId, code, name, now, now),
  ];
  for (const location of locations) {
    const plan = await planLocation(env, "transit_stop", id, location, principal, now);
    statements.push(...plan.statements);
  }
  await env.DB.batch(statements);
  await audit(env, principal, "transit.stop.create", "transit_stop", id, requestId, null, body);
  return json({ id }, { status: 201 });
}

/**
 * Edit one stop. `locations` is replace-all when present (omit the field to keep
 * the current anchors); everything is validated before the first statement runs,
 * so a rejected payload cannot leave the stop without its boarding point.
 */
export async function updateStop(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  stopId: string,
  requestId: string,
): Promise<Response> {
  const before = await first<{ id: string; place_id: string | null; campus_id: string | null; code: string | null; name: string; status: string }>(
    env.DB,
    "select id,place_id,campus_id,code,name,status from transit_stops where id=?",
    [stopId],
  );
  if (!before) throw new HttpError(404, "not_found", "Stop does not exist");

  const body = partialObject(await readJson<unknown>(request), "transitStopUpdate", [
    "name", "code", "placeId", "campusId", "status", "locations",
  ]);
  const name = Object.hasOwn(body, "name") ? requiredString(body.name, "name", 200) : before.name;
  const code = Object.hasOwn(body, "code") ? optionalString(body.code, "code", 100) : before.code;
  const placeId = Object.hasOwn(body, "placeId") ? optionalString(body.placeId, "placeId", 100) : before.place_id;
  const campusId = Object.hasOwn(body, "campusId") ? optionalString(body.campusId, "campusId", 100) : before.campus_id;
  const status = Object.hasOwn(body, "status") ? oneOf(body.status, "status", STOP_STATUSES) : before.status;
  await Promise.all([
    assertExists(env.DB, "places", placeId, "Place"),
    assertExists(env.DB, "campuses", campusId, "Campus"),
    assertCodeAvailable(env, "transit_stops", code, stopId),
  ]);

  // Retiring a stop that a pattern still calls at would silently drop those
  // journeys from the public results, so require the pattern to be edited first.
  if (status === "retired" && before.status !== "retired") {
    const inUse = await first<{ total: number }>(
      env.DB,
      "select count(*) as total from transit_pattern_stops where stop_id=?",
      [stopId],
    );
    if ((inUse?.total ?? 0) > 0) {
      throw new HttpError(409, "transit_stop_in_use", "Remove this stop from every route direction before retiring it");
    }
  }

  const now = isoNow();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("update transit_stops set place_id=?,campus_id=?,code=?,name=?,status=?,updated_at=? where id=?")
      .bind(placeId, campusId, code, name, status, now, stopId),
  ];
  let replacedLocations: RevisionLocationInput[] | null = null;
  if (Object.hasOwn(body, "locations")) {
    replacedLocations = stopLocations(body.locations);
    const previous = await all<{ anchorId: string }>(
      env.DB,
      "select anchor_id as anchorId from entity_locations where entity_type='transit_stop' and entity_id=?",
      [stopId],
    );
    const planned = [];
    for (const location of replacedLocations) {
      planned.push(await planLocation(env, "transit_stop", stopId, location, principal, now));
    }
    statements.push(
      env.DB.prepare("delete from entity_locations where entity_type='transit_stop' and entity_id=?").bind(stopId),
    );
    if (previous.length > 0) {
      const anchorIds = previous.map((row) => row.anchorId);
      statements.push(
        env.DB.prepare(`delete from location_anchors where id in (${anchorIds.map(() => "?").join(",")})`).bind(...anchorIds),
      );
    }
    for (const plan of planned) statements.push(...plan.statements);
  }
  await env.DB.batch(statements);
  await audit(env, principal, "transit.stop.update", "transit_stop", stopId, requestId, before, {
    name, code, placeId, campusId, status,
    ...(replacedLocations === null ? {} : { locations: replacedLocations.map((location) => ({ role: location.role, isPrimary: location.isPrimary })) }),
  });
  return json({ id: stopId });
}

/**
 * Remove a stop outright. Only allowed while nothing references it — a stop that
 * a pattern or a recorded time still points at must be retired instead, which is
 * what {@link updateStop} is for.
 */
export async function deleteStop(
  env: Env,
  principal: SessionPrincipal,
  stopId: string,
  requestId: string,
): Promise<Response> {
  const before = await first<Record<string, unknown>>(
    env.DB,
    "select id,place_id,campus_id,code,name,status from transit_stops where id=?",
    [stopId],
  );
  if (!before) throw new HttpError(404, "not_found", "Stop does not exist");
  const usage = await first<{ patterns: number; times: number }>(
    env.DB,
    `select (select count(*) from transit_pattern_stops where stop_id=?) as patterns,
            (select count(*) from transit_stop_times where stop_id=?) as times`,
    [stopId, stopId],
  );
  const referenced = (usage?.patterns ?? 0) + (usage?.times ?? 0);
  if (referenced > 0) {
    throw new HttpError(409, "transit_stop_in_use", `This stop is still used by ${referenced} route or schedule records; retire it instead`);
  }
  const anchors = await all<{ anchorId: string }>(
    env.DB,
    "select anchor_id as anchorId from entity_locations where entity_type='transit_stop' and entity_id=?",
    [stopId],
  );
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("delete from entity_locations where entity_type='transit_stop' and entity_id=?").bind(stopId),
  ];
  if (anchors.length > 0) {
    const anchorIds = anchors.map((row) => row.anchorId);
    statements.push(
      env.DB.prepare(`delete from location_anchors where id in (${anchorIds.map(() => "?").join(",")})`).bind(...anchorIds),
    );
  }
  statements.push(env.DB.prepare("delete from transit_stops where id=?").bind(stopId));
  await env.DB.batch(statements);
  await audit(env, principal, "transit.stop.delete", "transit_stop", stopId, requestId, before, null);
  return noContent();
}

export async function createRoute(request: Request, env: Env, principal: SessionPrincipal, requestId: string): Promise<Response> {
  const body = exactObject(await readJson<unknown>(request), "transitRoute", ["name", "code", "operatorId", "bookingPolicy", "bookingUrl"]);
  const id = makeId("route");
  const now = isoNow();
  const operatorId = optionalString(body.operatorId, "operatorId", 100);
  const code = optionalString(body.code, "code", 100);
  const bookingUrl = optionalString(body.bookingUrl, "bookingUrl", 1000);
  const bookingPolicy = body.bookingPolicy === undefined || body.bookingPolicy === null
    ? "not_required"
    : oneOf(body.bookingPolicy, "bookingPolicy", BOOKING_POLICIES);
  await Promise.all([
    assertExists(env.DB, "organizations", operatorId, "Operator"),
    assertCodeAvailable(env, "transit_routes", code, null),
  ]);
  await env.DB.prepare("insert into transit_routes(id,code,name,operator_id,status,booking_policy,booking_url,created_at,updated_at) values(?,?,?,?,'active',?,?,?,?)")
    .bind(id, code, requiredString(body.name, "name", 200), operatorId, bookingPolicy, bookingUrl, now, now).run();
  await audit(env, principal, "transit.route.create", "transit_route", id, requestId, null, body);
  return json({ id }, { status: 201 });
}

export async function updateRoute(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  routeId: string,
  requestId: string,
): Promise<Response> {
  const before = await first<{ id: string; code: string | null; name: string; operator_id: string | null; status: string; booking_policy: string; booking_url: string | null }>(
    env.DB,
    "select id,code,name,operator_id,status,booking_policy,booking_url from transit_routes where id=?",
    [routeId],
  );
  if (!before) throw new HttpError(404, "not_found", "Route does not exist");
  const body = partialObject(await readJson<unknown>(request), "transitRouteUpdate", ["name", "code", "operatorId", "status", "bookingPolicy", "bookingUrl"]);
  const name = Object.hasOwn(body, "name") ? requiredString(body.name, "name", 200) : before.name;
  const code = Object.hasOwn(body, "code") ? optionalString(body.code, "code", 100) : before.code;
  const operatorId = Object.hasOwn(body, "operatorId") ? optionalString(body.operatorId, "operatorId", 100) : before.operator_id;
  const status = Object.hasOwn(body, "status") ? oneOf(body.status, "status", ROUTE_STATUSES) : before.status;
  const bookingPolicy = Object.hasOwn(body, "bookingPolicy")
    ? oneOf(body.bookingPolicy, "bookingPolicy", BOOKING_POLICIES)
    : before.booking_policy;
  const bookingUrl = Object.hasOwn(body, "bookingUrl")
    ? optionalString(body.bookingUrl, "bookingUrl", 1000)
    : before.booking_url;
  await Promise.all([
    assertExists(env.DB, "organizations", operatorId, "Operator"),
    assertCodeAvailable(env, "transit_routes", code, routeId),
  ]);
  const now = isoNow();
  await env.DB.batch([
    env.DB.prepare("update transit_routes set code=?,name=?,operator_id=?,status=?,booking_policy=?,booking_url=?,updated_at=? where id=?")
      .bind(code, name, operatorId, status, bookingPolicy, bookingUrl, now, routeId),
    // 班次的 booking_policy 是线路级的冗余副本（列保留是因为 CHECK 约束重建代价大），
    // 线路改预约属性时必须同步覆盖，否则公共查询两边读到不同答案。
    env.DB.prepare(
      `update transit_trips set booking_policy=?
        where status='active' and booking_policy<>?
          and pattern_id in (select id from transit_patterns where route_id=?)`,
    ).bind(bookingPolicy, bookingPolicy, routeId),
  ]);
  await audit(env, principal, "transit.route.update", "transit_route", routeId, requestId, before, { name, code, operatorId, status, bookingPolicy, bookingUrl });
  return json({ id: routeId });
}

/**
 * Remove a route. `transit_patterns` cascades from here and `transit_trips`
 * cascades from those, so a route that still has directions is refused rather
 * than allowed to take a season of timetables down with it.
 */
export async function deleteRoute(
  env: Env,
  principal: SessionPrincipal,
  routeId: string,
  requestId: string,
): Promise<Response> {
  const before = await first<Record<string, unknown>>(
    env.DB,
    "select id,code,name,operator_id,status from transit_routes where id=?",
    [routeId],
  );
  if (!before) throw new HttpError(404, "not_found", "Route does not exist");
  const usage = await first<{ patterns: number }>(
    env.DB,
    "select count(*) as patterns from transit_patterns where route_id=?",
    [routeId],
  );
  if ((usage?.patterns ?? 0) > 0) {
    throw new HttpError(409, "transit_route_in_use", `This route still has ${usage?.patterns} direction(s); delete them first or suspend the route instead`);
  }
  await env.DB.prepare("delete from transit_routes where id=?").bind(routeId).run();
  await audit(env, principal, "transit.route.delete", "transit_route", routeId, requestId, before, null);
  return noContent();
}

export async function createPattern(request: Request, env: Env, principal: SessionPrincipal, requestId: string): Promise<Response> {
  const body = exactObject(await readJson<unknown>(request), "transitPattern", ["routeId", "directionId", "name", "stops"]);
  const routeId = requiredString(body.routeId, "routeId", 100);
  await assertExists(env.DB, "transit_routes", routeId, "Route");
  const directionId = body.directionId;
  if (directionId !== 0 && directionId !== 1) throw new HttpError(400, "validation_error", "directionId must be 0 or 1");
  const stops = arrayValue(body.stops, "stops", MAX_PATTERN_STOPS);
  if (stops.length < 2) throw new HttpError(400, "validation_error", "A route pattern requires at least two stops");
  const id = makeId("pattern");
  const patternName = requiredString(body.name, "name", 200);
  const plannedStops: Array<{ stopId: string; pickupType: string; dropoffType: string }> = [];
  const seen = new Set<string>();
  for (const [index, raw] of stops.entries()) {
    const stop = exactObject(raw, `stops[${index}]`, ["stopId", "pickupType", "dropoffType"]);
    const stopId = requiredString(stop.stopId, `stops[${index}].stopId`, 100);
    await assertExists(env.DB, "transit_stops", stopId, "Stop");
    if (seen.has(stopId)) throw new HttpError(400, "validation_error", "A stop can appear only once in a pattern");
    seen.add(stopId);
    const pickupType = oneOf(stop.pickupType, `stops[${index}].pickupType`, PICKUP_WRITE_TYPES);
    const dropoffType = oneOf(stop.dropoffType, `stops[${index}].dropoffType`, DROPOFF_TYPES);
    plannedStops.push({ stopId, pickupType, dropoffType });
  }
  const statements = [env.DB.prepare("insert into transit_patterns(id,route_id,direction_id,name) values(?,?,?,?)")
    .bind(id, routeId, directionId, patternName)];
  for (const [index, stop] of plannedStops.entries()) {
    statements.push(env.DB.prepare("insert into transit_pattern_stops(pattern_id,stop_id,stop_sequence,pickup_type,dropoff_type) values(?,?,?,?,?)")
      .bind(id, stop.stopId, index, stop.pickupType, stop.dropoffType));
  }
  await env.DB.batch(statements);
  await audit(env, principal, "transit.pattern.create", "transit_pattern", id, requestId, null, body);
  return json({ id }, { status: 201 });
}

/**
 * Rename a direction or flip which way round it runs. The stop sequence is edited
 * separately by {@link replacePatternStops}, which has to remap existing trip
 * times and therefore cannot be folded in here.
 */
export async function updatePattern(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  patternId: string,
  requestId: string,
): Promise<Response> {
  const before = await first<{ id: string; route_id: string; direction_id: number; name: string }>(
    env.DB,
    "select id,route_id,direction_id,name from transit_patterns where id=?",
    [patternId],
  );
  if (!before) throw new HttpError(404, "not_found", "Pattern does not exist");
  const body = partialObject(await readJson<unknown>(request), "transitPatternUpdate", ["name", "directionId"]);
  const name = Object.hasOwn(body, "name") ? requiredString(body.name, "name", 200) : before.name;
  let directionId = before.direction_id;
  if (Object.hasOwn(body, "directionId")) {
    if (body.directionId !== 0 && body.directionId !== 1) {
      throw new HttpError(400, "validation_error", "directionId must be 0 or 1");
    }
    directionId = body.directionId;
  }
  // `unique(route_id, direction_id, name)` — report the clash instead of letting
  // the constraint surface as a 500.
  const clash = await first<{ id: string }>(
    env.DB,
    "select id from transit_patterns where route_id=? and direction_id=? and name=? and id<>?",
    [before.route_id, directionId, name, patternId],
  );
  if (clash) throw new HttpError(409, "transit_pattern_duplicate", "This route already has a direction with that name and travel direction");
  await env.DB.prepare("update transit_patterns set name=?,direction_id=? where id=?").bind(name, directionId, patternId).run();
  await audit(env, principal, "transit.pattern.update", "transit_pattern", patternId, requestId, before, { name, directionId });
  return json({ id: patternId });
}

/**
 * Delete a direction along with its stop sequence. Trips cascade from
 * `transit_patterns`, so an existing timetable blocks the delete: retiring those
 * trips first is an explicit decision, not a side effect of removing a direction.
 */
export async function deletePattern(
  env: Env,
  principal: SessionPrincipal,
  patternId: string,
  requestId: string,
): Promise<Response> {
  const before = await first<Record<string, unknown>>(
    env.DB,
    "select id,route_id,direction_id,name from transit_patterns where id=?",
    [patternId],
  );
  if (!before) throw new HttpError(404, "not_found", "Pattern does not exist");
  const usage = await first<{ trips: number }>(
    env.DB,
    "select count(*) as trips from transit_trips where pattern_id=? and status='active'",
    [patternId],
  );
  if ((usage?.trips ?? 0) > 0) {
    throw new HttpError(409, "transit_pattern_in_use", `This direction still has ${usage?.trips} active trip(s); delete them first`);
  }
  await env.DB.batch([
    env.DB.prepare("delete from transit_pattern_stops where pattern_id=?").bind(patternId),
    env.DB.prepare("delete from transit_patterns where id=?").bind(patternId),
  ]);
  await audit(env, principal, "transit.pattern.delete", "transit_pattern", patternId, requestId, before, null);
  return noContent();
}

/**
 * Validate a calendar's exception list against its date range and return the
 * insert statements. Shared by create and update so both reject the same inputs.
 */
function planCalendarExceptions(
  env: Env,
  calendarId: string,
  value: unknown,
  validFrom: string,
  validTo: string,
): { statements: D1PreparedStatement[]; exceptions: Array<{ date: string; type: string; label: string | null }> } {
  const rows = arrayValue(value, "exceptions", MAX_CALENDAR_EXCEPTIONS);
  const statements: D1PreparedStatement[] = [];
  const exceptions: Array<{ date: string; type: string; label: string | null }> = [];
  const seen = new Set<string>();
  for (const [index, raw] of rows.entries()) {
    const exception = exactObject(raw, `exceptions[${index}]`, ["date", "type", "label"]);
    const type = oneOf(exception.type, `exceptions[${index}].type`, ["added", "removed"] as const);
    const date = dateValue(exception.date, `exceptions[${index}].date`);
    if (date < validFrom || date > validTo) {
      throw new HttpError(400, "validation_error", `exceptions[${index}].date must be within the calendar date range`);
    }
    if (seen.has(date)) throw new HttpError(400, "validation_error", "Each exception date can appear only once");
    seen.add(date);
    const label = optionalString(exception.label, `exceptions[${index}].label`, 200);
    exceptions.push({ date, type, label });
    statements.push(env.DB.prepare("insert into service_calendar_exceptions(calendar_id,service_date,exception_type,label) values(?,?,?,?)")
      .bind(calendarId, date, type, label));
  }
  return { statements, exceptions };
}

export async function createCalendar(request: Request, env: Env, principal: SessionPrincipal, requestId: string): Promise<Response> {
  const body = exactObject(await readJson<unknown>(request), "serviceCalendar", [
    "name",
    "validFrom",
    "validTo",
    "weekdays",
    "exceptions",
    "sourceId",
  ]);
  const id = makeId("calendar");
  const sourceId = optionalString(body.sourceId, "sourceId", 100);
  await assertExists(env.DB, "data_sources", sourceId, "Data source");
  const weekdays = exactObject(body.weekdays, "weekdays", WEEKDAYS);
  const flags = WEEKDAYS.map((day) => booleanValue(weekdays[day], `weekdays.${day}`) ? 1 : 0);
  const name = requiredString(body.name, "name", 200);
  const validFrom = dateValue(body.validFrom, "validFrom");
  const validTo = dateValue(body.validTo, "validTo");
  if (validFrom > validTo) {
    throw new HttpError(400, "validation_error", "Calendar date range is invalid");
  }
  const planned = planCalendarExceptions(env, id, body.exceptions, validFrom, validTo);
  await env.DB.batch([
    env.DB.prepare(
      `insert into service_calendars(id,name,timezone,valid_from,valid_to,monday,tuesday,wednesday,thursday,friday,saturday,sunday,source_id)
       values(?,?,'Asia/Shanghai',?,?,?,?,?,?,?,?,?,?)`,
    ).bind(id, name, validFrom, validTo, ...flags, sourceId),
    ...planned.statements,
  ]);
  await audit(env, principal, "transit.calendar.create", "service_calendar", id, requestId, null, body);
  return json({ id }, { status: 201 });
}

/**
 * Edit a calendar. `exceptions` is replace-all when present; omit it to keep the
 * stored list. Narrowing the date range is refused while an exception sits
 * outside the new range, so an edit can never silently discard a recorded
 * holiday.
 */
export async function updateCalendar(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  calendarId: string,
  requestId: string,
): Promise<Response> {
  const before = await first<Record<string, unknown>>(
    env.DB,
    `select id,name,valid_from,valid_to,monday,tuesday,wednesday,thursday,friday,saturday,sunday,source_id
       from service_calendars where id=?`,
    [calendarId],
  );
  if (!before) throw new HttpError(404, "not_found", "Calendar does not exist");

  const body = partialObject(await readJson<unknown>(request), "serviceCalendarUpdate", [
    "name", "validFrom", "validTo", "weekdays", "exceptions", "sourceId",
  ]);
  const name = Object.hasOwn(body, "name") ? requiredString(body.name, "name", 200) : String(before.name);
  const validFrom = Object.hasOwn(body, "validFrom") ? dateValue(body.validFrom, "validFrom") : String(before.valid_from);
  const validTo = Object.hasOwn(body, "validTo") ? dateValue(body.validTo, "validTo") : String(before.valid_to);
  if (validFrom > validTo) throw new HttpError(400, "validation_error", "Calendar date range is invalid");
  const sourceId = Object.hasOwn(body, "sourceId")
    ? optionalString(body.sourceId, "sourceId", 100)
    : (before.source_id === null ? null : String(before.source_id));
  await assertExists(env.DB, "data_sources", sourceId, "Data source");
  const flags = Object.hasOwn(body, "weekdays")
    ? WEEKDAYS.map((day) => booleanValue(exactObject(body.weekdays, "weekdays", WEEKDAYS)[day], `weekdays.${day}`) ? 1 : 0)
    : WEEKDAYS.map((day) => (before[day] === 1 ? 1 : 0));

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `update service_calendars set name=?,valid_from=?,valid_to=?,
        monday=?,tuesday=?,wednesday=?,thursday=?,friday=?,saturday=?,sunday=?,source_id=? where id=?`,
    ).bind(name, validFrom, validTo, ...flags, sourceId, calendarId),
  ];
  let replacedExceptions: Array<{ date: string; type: string; label: string | null }> | null = null;
  if (Object.hasOwn(body, "exceptions")) {
    const planned = planCalendarExceptions(env, calendarId, body.exceptions, validFrom, validTo);
    replacedExceptions = planned.exceptions;
    statements.push(env.DB.prepare("delete from service_calendar_exceptions where calendar_id=?").bind(calendarId));
    statements.push(...planned.statements);
  } else {
    const orphaned = await first<{ total: number }>(
      env.DB,
      "select count(*) as total from service_calendar_exceptions where calendar_id=? and (service_date<? or service_date>?)",
      [calendarId, validFrom, validTo],
    );
    if ((orphaned?.total ?? 0) > 0) {
      throw new HttpError(409, "calendar_range_excludes_exceptions", `${orphaned?.total} recorded exception date(s) fall outside the new date range; edit them together with the range`);
    }
  }
  await env.DB.batch(statements);
  await audit(env, principal, "transit.calendar.update", "service_calendar", calendarId, requestId, before, {
    name, validFrom, validTo, sourceId,
    weekdays: Object.fromEntries(WEEKDAYS.map((day, index) => [day, flags[index] === 1])),
    ...(replacedExceptions === null ? {} : { exceptions: replacedExceptions }),
  });
  return json({ id: calendarId });
}

/**
 * Delete a calendar. `transit_trips.service_calendar_id` is `on delete restrict`,
 * so this is refused while any trip — active or retired — still runs on it; the
 * check is explicit here to answer 409 instead of a raw constraint failure.
 */
export async function deleteCalendar(
  env: Env,
  principal: SessionPrincipal,
  calendarId: string,
  requestId: string,
): Promise<Response> {
  const before = await first<Record<string, unknown>>(
    env.DB,
    `select id,name,valid_from,valid_to,monday,tuesday,wednesday,thursday,friday,saturday,sunday,source_id
       from service_calendars where id=?`,
    [calendarId],
  );
  if (!before) throw new HttpError(404, "not_found", "Calendar does not exist");
  const usage = await first<{ trips: number }>(
    env.DB,
    "select count(*) as trips from transit_trips where service_calendar_id=?",
    [calendarId],
  );
  if ((usage?.trips ?? 0) > 0) {
    throw new HttpError(409, "service_calendar_in_use", `This calendar still has ${usage?.trips} trip(s) on it; move or delete them first`);
  }
  await env.DB.batch([
    env.DB.prepare("delete from service_calendar_exceptions where calendar_id=?").bind(calendarId),
    env.DB.prepare("delete from service_calendars where id=?").bind(calendarId),
  ]);
  await audit(env, principal, "transit.calendar.delete", "service_calendar", calendarId, requestId, before, null);
  return noContent();
}

export async function createTrip(request: Request, env: Env, principal: SessionPrincipal, requestId: string): Promise<Response> {
  const body = exactObject(await readJson<unknown>(request), "transitTrip", [
    "patternId",
    "serviceCalendarId",
    "publicLabel",
    "bookingPolicy",
    "bookingUrl",
    "sourceId",
    "stopTimes",
  ]);
  const patternId = requiredString(body.patternId, "patternId", 100);
  const calendarId = requiredString(body.serviceCalendarId, "serviceCalendarId", 100);
  const sourceId = optionalString(body.sourceId, "sourceId", 100);
  await Promise.all([
    assertExists(env.DB, "transit_patterns", patternId, "Pattern"),
    assertExists(env.DB, "service_calendars", calendarId, "Calendar"),
    assertExists(env.DB, "data_sources", sourceId, "Data source"),
  ]);
  const patternStops = await all<{ stop_id: string; stop_sequence: number }>(env.DB, "select stop_id,stop_sequence from transit_pattern_stops where pattern_id=? order by stop_sequence", [patternId]);
  if (patternStops.length === 0) throw new HttpError(400, "validation_error", "The pattern has no stop sequence yet");
  const times = arrayValue(body.stopTimes, "stopTimes", MAX_PATTERN_STOPS);
  if (times.length !== patternStops.length) throw new HttpError(400, "validation_error", "stopTimes must contain one item for every pattern stop");
  const id = makeId("trip");
  // 预约与否是线路级属性（0024）：请求里的 bookingPolicy 仅作向后兼容收下，
  // 落库一律以所属线路为准。
  const route = await first<{ booking_policy: string }>(
    env.DB,
    "select r.booking_policy from transit_patterns p join transit_routes r on r.id=p.route_id where p.id=?",
    [patternId],
  );
  const policy = route?.booking_policy ?? "not_required";
  const statements = [env.DB.prepare(
    `insert into transit_trips(id,pattern_id,service_calendar_id,public_label,booking_policy,booking_url,status,source_id)
     values(?,?,?,?,?,?,'active',?)`,
  ).bind(id, patternId, calendarId, optionalString(body.publicLabel, "publicLabel", 200), policy, optionalString(body.bookingUrl, "bookingUrl", 1000), sourceId)];
  for (const [index, raw] of times.entries()) {
    const time = exactObject(raw, `stopTimes[${index}]`, ["arrivalTime", "departureTime"]);
    // Bind the pattern's own stop_sequence: the public journeys query compares
    // stop_times.stop_sequence across the trip, so it has to line up with the
    // pattern rather than with this array's index.
    statements.push(env.DB.prepare("insert into transit_stop_times(trip_id,stop_id,stop_sequence,arrival_time,departure_time) values(?,?,?,?,?)")
      .bind(id, patternStops[index].stop_id, patternStops[index].stop_sequence,
        timeValue(time.arrivalTime, `stopTimes[${index}].arrivalTime`), timeValue(time.departureTime, `stopTimes[${index}].departureTime`)));
  }
  await env.DB.batch(statements);
  await audit(env, principal, "transit.trip.create", "transit_trip", id, requestId, null, body);
  return json({ id }, { status: 201 });
}

/**
 * Replace a pattern's whole stop sequence (add / remove / reorder in one call).
 *
 * Existing trips are re-pointed at the new sequence: times already recorded for a
 * stop follow that stop to its new position, stops that were dropped lose their
 * times, and newly inserted stops start empty. Without this remap the public
 * journeys query — which pairs two stop_times rows of the same trip and compares
 * their stop_sequence — would silently stop matching after a reorder.
 */
export async function replacePatternStops(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  patternId: string,
  requestId: string,
): Promise<Response> {
  const pattern = await first<{ id: string }>(env.DB, "select id from transit_patterns where id=?", [patternId]);
  if (!pattern) throw new HttpError(404, "not_found", "Pattern does not exist");

  const body = exactObject(await readJson<unknown>(request), "patternStops", ["stops"]);
  const stops = arrayValue(body.stops, "stops", MAX_PATTERN_STOPS);
  if (stops.length < 2) throw new HttpError(400, "validation_error", "A route pattern requires at least two stops");

  // Validate the whole payload before touching the database: a rejected request
  // must never leave the pattern without its stop sequence.
  const activeStopIds = new Set((await all<{ id: string }>(env.DB, "select id from transit_stops where status='active'")).map((row) => row.id));
  const planned: Array<{ stopId: string; pickupType: string; dropoffType: string }> = [];
  const seen = new Set<string>();
  for (const [index, raw] of stops.entries()) {
    const stop = exactObject(raw, `stops[${index}]`, ["stopId", "pickupType", "dropoffType"]);
    const stopId = requiredString(stop.stopId, `stops[${index}].stopId`, 100);
    if (!activeStopIds.has(stopId)) throw new HttpError(400, "validation_error", `stops[${index}].stopId does not exist`);
    if (seen.has(stopId)) throw new HttpError(400, "validation_error", "A stop can appear only once in a pattern");
    seen.add(stopId);
    planned.push({
      stopId,
      pickupType: oneOf(stop.pickupType, `stops[${index}].pickupType`, PICKUP_WRITE_TYPES),
      dropoffType: oneOf(stop.dropoffType, `stops[${index}].dropoffType`, DROPOFF_TYPES),
    });
  }

  const previous = await all<Record<string, unknown>>(
    env.DB,
    "select stop_id,stop_sequence,pickup_type,dropoff_type from transit_pattern_stops where pattern_id=? order by stop_sequence",
    [patternId],
  );
  const trips = await all<{ id: string }>(env.DB, "select id from transit_trips where pattern_id=?", [patternId]);
  const previousTimes = await all<{ trip_id: string; stop_id: string; arrival_time: string | null; departure_time: string | null }>(
    env.DB,
    "select trip_id,stop_id,arrival_time,departure_time from transit_stop_times where trip_id in (select id from transit_trips where pattern_id=?)",
    [patternId],
  );
  if (trips.length * planned.length > 4000) {
    throw new HttpError(409, "conflict", "This pattern has too many trips to resequence in one request");
  }
  const timeByTripStop = new Map(previousTimes.map((row) => [JSON.stringify([row.trip_id, row.stop_id]), row]));

  const statements: D1PreparedStatement[] = [
    env.DB.prepare("delete from transit_stop_times where trip_id in (select id from transit_trips where pattern_id=?)").bind(patternId),
    env.DB.prepare("delete from transit_pattern_stops where pattern_id=?").bind(patternId),
  ];
  for (const [index, stop] of planned.entries()) {
    statements.push(env.DB.prepare("insert into transit_pattern_stops(pattern_id,stop_id,stop_sequence,pickup_type,dropoff_type) values(?,?,?,?,?)")
      .bind(patternId, stop.stopId, index, stop.pickupType, stop.dropoffType));
  }
  for (const trip of trips) {
    for (const [index, stop] of planned.entries()) {
      const carried = timeByTripStop.get(JSON.stringify([trip.id, stop.stopId]));
      statements.push(env.DB.prepare("insert into transit_stop_times(trip_id,stop_id,stop_sequence,arrival_time,departure_time) values(?,?,?,?,?)")
        .bind(trip.id, stop.stopId, index, carried?.arrival_time ?? null, carried?.departure_time ?? null));
    }
  }
  await env.DB.batch(statements);

  await audit(env, principal, "transit.pattern.stops.replace", "transit_pattern", patternId, requestId, { stops: previous }, body);
  return json({ patternId, stops: planned.map((stop, index) => ({ ...stop, stopSequence: index })) });
}

/** Update one trip's calendar, booking policy and/or times. Times replace all stops at once. */
export async function updateTrip(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  tripId: string,
  requestId: string,
): Promise<Response> {
  const trip = await first<{ id: string; pattern_id: string; service_calendar_id: string; booking_policy: string; booking_url: string | null }>(
    env.DB,
    "select id,pattern_id,service_calendar_id,booking_policy,booking_url from transit_trips where id=? and status='active'",
    [tripId],
  );
  if (!trip) throw new HttpError(404, "not_found", "Trip does not exist");

  const body = partialObject(await readJson<unknown>(request), "transitTripUpdate", [
    "serviceCalendarId",
    "bookingPolicy",
    "bookingUrl",
    "stopTimes",
  ]);
  const calendarId = Object.hasOwn(body, "serviceCalendarId")
    ? requiredString(body.serviceCalendarId, "serviceCalendarId", 100)
    : trip.service_calendar_id;
  if (calendarId !== trip.service_calendar_id) {
    const calendar = await first<{ id: string }>(env.DB, "select id from service_calendars where id=?", [calendarId]);
    if (!calendar) throw new HttpError(400, "validation_error", "serviceCalendarId does not exist");
  }
  // 同 createTrip：bookingPolicy 以所属线路为准，请求里的值不再生效。
  const route = await first<{ booking_policy: string }>(
    env.DB,
    "select r.booking_policy from transit_patterns p join transit_routes r on r.id=p.route_id where p.id=?",
    [trip.pattern_id],
  );
  const policy = route?.booking_policy ?? trip.booking_policy;
  const bookingUrl = Object.hasOwn(body, "bookingUrl")
    ? optionalString(body.bookingUrl, "bookingUrl", 1000)
    : trip.booking_url;

  const statements: D1PreparedStatement[] = [
    env.DB.prepare("update transit_trips set service_calendar_id=?,booking_policy=?,booking_url=? where id=?")
      .bind(calendarId, policy, bookingUrl, tripId),
  ];

  if (Object.hasOwn(body, "stopTimes")) {
    const stopTimes = arrayValue(body.stopTimes, "stopTimes", MAX_PATTERN_STOPS);
    const patternStops = await all<{ stop_id: string; stop_sequence: number }>(
      env.DB,
      "select stop_id,stop_sequence from transit_pattern_stops where pattern_id=? order by stop_sequence",
      [trip.pattern_id],
    );
    if (stopTimes.length !== patternStops.length) {
      throw new HttpError(400, "validation_error", "stopTimes must contain one item for every pattern stop");
    }
    statements.push(env.DB.prepare("delete from transit_stop_times where trip_id=?").bind(tripId));
    for (const [index, raw] of stopTimes.entries()) {
      const time = exactObject(raw, `stopTimes[${index}]`, ["arrivalTime", "departureTime"]);
      statements.push(env.DB.prepare("insert into transit_stop_times(trip_id,stop_id,stop_sequence,arrival_time,departure_time) values(?,?,?,?,?)")
        .bind(tripId, patternStops[index].stop_id, patternStops[index].stop_sequence,
          timeValue(time.arrivalTime, `stopTimes[${index}].arrivalTime`), timeValue(time.departureTime, `stopTimes[${index}].departureTime`)));
    }
  }

  await env.DB.batch(statements);
  await audit(env, principal, "transit.trip.update", "transit_trip", tripId, requestId, trip, body);
  return json({ id: tripId });
}

/**
 * Retire a trip. Kept as a status change rather than a row delete so the change
 * stays reversible and the audit trail still resolves the entity; every read path
 * (admin list, release snapshot, public journeys) filters on status='active'.
 */
export async function deleteTrip(
  env: Env,
  principal: SessionPrincipal,
  tripId: string,
  requestId: string,
): Promise<Response> {
  const trip = await first<Record<string, unknown>>(env.DB, "select id,pattern_id,service_calendar_id,booking_policy,status from transit_trips where id=?", [tripId]);
  if (!trip) throw new HttpError(404, "not_found", "Trip does not exist");
  if (trip.status !== "active") return json({ id: tripId, status: trip.status });
  await env.DB.prepare("update transit_trips set status='retired' where id=?").bind(tripId).run();
  await audit(env, principal, "transit.trip.retire", "transit_trip", tripId, requestId, trip, { status: "retired" });
  return json({ id: tripId, status: "retired" });
}

export async function publicJourneys(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const date = url.searchParams.get("date") ?? new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
  const fromStopId = url.searchParams.get("fromStopId");
  const toStopId = url.searchParams.get("toStopId");
  if (!fromStopId || !toStopId) throw new HttpError(400, "validation_error", "fromStopId and toStopId are required");
  const fromStop = await first<{ id: string }>(env.DB, "select id from transit_stops where id=? and status='active'", [fromStopId]);
  const toStop = await first<{ id: string }>(env.DB, "select id from transit_stops where id=? and status='active'", [toStopId]);
  if (!fromStop || !toStop) throw new HttpError(404, "not_found", "One or both transit stops do not exist");
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", weekday: "long" }).format(new Date(`${date}T12:00:00+08:00`)).toLowerCase();
  if (!["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].includes(weekday)) throw new HttpError(400, "validation_error", "Invalid date");
  const journeys = await all(
    env.DB,
    `select t.id as tripId,r.id as routeId,r.name as routeName,p.id as patternId,t.booking_policy as bookingPolicy,t.booking_url as bookingUrl,
            fs.departure_time as departureTime,ts.arrival_time as arrivalTime,fs.stop_sequence as fromSequence,ts.stop_sequence as toSequence
       from transit_trips t join transit_patterns p on p.id=t.pattern_id join transit_routes r on r.id=p.route_id
       join transit_stop_times fs on fs.trip_id=t.id and fs.stop_id=?
       join transit_stop_times ts on ts.trip_id=t.id and ts.stop_id=?
       join service_calendars c on c.id=t.service_calendar_id
       join transit_pattern_stops fps on fps.pattern_id=p.id and fps.stop_id=fs.stop_id and fps.stop_sequence=fs.stop_sequence
       join transit_pattern_stops tps on tps.pattern_id=p.id and tps.stop_id=ts.stop_id and tps.stop_sequence=ts.stop_sequence
      where t.status='active' and fs.stop_sequence<ts.stop_sequence and c.valid_from<=? and c.valid_to>=?
        and fps.pickup_type<>'none' and tps.dropoff_type<>'none'
        and (fps.pickup_type<>'reservation_only' or t.booking_policy in ('required','optional'))
        and (c.${weekday}=1 or exists(
          select 1 from service_calendar_exceptions a
           where a.calendar_id=c.id and a.service_date=? and a.exception_type='added'
        ))
        and not exists(select 1 from service_calendar_exceptions e where e.calendar_id=c.id and e.service_date=? and e.exception_type='removed')
      order by fs.departure_time`,
    [fromStopId, toStopId, date, date, date, date],
  );
  return json({ date, timezone: "Asia/Shanghai", journeys }, { headers: { "cache-control": "public, max-age=60" } });
}

/**
 * GET /api/public/transit/trips/:tripId/stops — 单个班次的完整停靠序列。
 *
 * M7 班次路线预览此前读 release manifest 里冻结的 patternStops / stopTimes。班次时刻
 * 改了要立刻生效，所以这份数据和 journeys 一样走实时读，不再进快照；站点名也在这里
 * 一并给出，免得调用方再去 manifest 里对一次。
 */
export async function publicTripStops(env: Env, tripId: string): Promise<Response> {
  const trip = await first<{ id: string; patternId: string }>(
    env.DB,
    "select id,pattern_id as patternId from transit_trips where id=? and status='active'",
    [tripId],
  );
  if (!trip) throw new HttpError(404, "not_found", "Trip does not exist");
  // 以 pattern 的停靠序列为骨架：某一站还没录时刻时也要出现在预览里（时间留空）。
  const stops = await all(
    env.DB,
    `select ps.stop_id as stopId,s.name as stopName,ps.stop_sequence as stopSequence,
            ps.pickup_type as pickupType,ps.dropoff_type as dropoffType,
            st.arrival_time as arrivalTime,st.departure_time as departureTime
       from transit_pattern_stops ps
       join transit_stops s on s.id=ps.stop_id
       left join transit_stop_times st on st.trip_id=? and st.stop_sequence=ps.stop_sequence
      where ps.pattern_id=? order by ps.stop_sequence`,
    [tripId, trip.patternId],
  );
  return json({ tripId, patternId: trip.patternId, stops }, { headers: { "cache-control": "public, max-age=60" } });
}

// ---------------------------------------------------------------------------
// 校区对校区模型（0024 改版）
//
// 校车线路的真实结构是「校区 A → 校区 B」，每条线路挂多个上/下车点（pattern 的
// 停靠序列），预约与否是线路属性。客户端按校区选 OD，不再按乘车点选。
//
// 端点 id：校区的 campus_id 直接用；campus_id 为 null 的乘车点（如陈太公寓）
// 自成一组，用 `stop:<stopId>` 作伪端点 id，免得为它造一条 campuses 行污染
// 校区列表。
// ---------------------------------------------------------------------------

interface TransitEndpoint {
  id: string;
  name: string;
  stopIds: string[];
}

async function resolveTransitEndpoint(env: Env, endpointId: string): Promise<TransitEndpoint | null> {
  if (endpointId.startsWith("stop:")) {
    const stopId = endpointId.slice("stop:".length);
    const stop = await first<{ id: string; name: string }>(
      env.DB,
      "select id,name from transit_stops where id=? and status='active'",
      [stopId],
    );
    return stop ? { id: endpointId, name: stop.name, stopIds: [stop.id] } : null;
  }
  const campus = await first<{ id: string; name: string }>(
    env.DB,
    "select id,name from campuses where id=? and status='active'",
    [endpointId],
  );
  if (!campus) return null;
  const stops = await all<{ id: string }>(
    env.DB,
    "select id from transit_stops where campus_id=? and status='active'",
    [campus.id],
  );
  return { id: campus.id, name: campus.name, stopIds: stops.map((stop) => stop.id) };
}

function shanghaiWeekday(date: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", weekday: "long" })
    .format(new Date(`${date}T12:00:00+08:00`))
    .toLowerCase();
}

/**
 * GET /api/public/transit/campus-lines?from=<endpointId>&to=<endpointId>&date=YYYY-MM-DD
 *
 * 返回该校区对下的全部线路（预约线/非预约线分开），每条线路带完整停靠序列和
 * 当日班次（含逐站时刻，班次预览不必再回源 trips/:id/stops）。日历过滤规则与
 * publicJourneys 完全一致。
 */
export async function publicCampusLines(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const date = url.searchParams.get("date") ?? new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
  const fromId = url.searchParams.get("from");
  const toId = url.searchParams.get("to");
  if (!fromId || !toId) throw new HttpError(400, "validation_error", "from and to are required");
  if (fromId === toId) throw new HttpError(400, "validation_error", "from and to must differ");
  const [from, to] = await Promise.all([resolveTransitEndpoint(env, fromId), resolveTransitEndpoint(env, toId)]);
  if (!from || !to) throw new HttpError(404, "not_found", "One or both endpoints do not exist");
  const weekday = shanghaiWeekday(date);
  if (!(WEEKDAYS as readonly string[]).includes(weekday)) throw new HttpError(400, "validation_error", "Invalid date");
  const headers = { "cache-control": "public, max-age=60" };
  const payload = { date, timezone: "Asia/Shanghai", from: { id: from.id, name: from.name }, to: { id: to.id, name: to.name } };
  if (from.stopIds.length === 0 || to.stopIds.length === 0) return json({ ...payload, lines: [] }, { headers });

  const fromMarks = from.stopIds.map(() => "?").join(",");
  const toMarks = to.stopIds.map(() => "?").join(",");
  const patterns = await all<{
    patternId: string; patternName: string; routeId: string; routeName: string;
    bookingPolicy: string; bookingUrl: string | null;
  }>(
    env.DB,
    `select p.id as patternId,p.name as patternName,r.id as routeId,r.name as routeName,
            r.booking_policy as bookingPolicy,r.booking_url as bookingUrl
       from transit_patterns p
       join transit_routes r on r.id=p.route_id and r.status='active'
      where (select ps.stop_id from transit_pattern_stops ps where ps.pattern_id=p.id order by ps.stop_sequence limit 1) in (${fromMarks})
        and (select ps.stop_id from transit_pattern_stops ps where ps.pattern_id=p.id order by ps.stop_sequence desc limit 1) in (${toMarks})
      order by r.name,p.id`,
    [...from.stopIds, ...to.stopIds],
  );
  if (patterns.length === 0) return json({ ...payload, lines: [] }, { headers });

  const patternIds = patterns.map((pattern) => pattern.patternId);
  const patternMarks = patternIds.map(() => "?").join(",");
  const [patternStops, trips] = await Promise.all([
    all<{
      patternId: string; stopId: string; stopName: string; stopSequence: number;
      pickupType: string; dropoffType: string;
    }>(
      env.DB,
      `select ps.pattern_id as patternId,ps.stop_id as stopId,s.name as stopName,ps.stop_sequence as stopSequence,
              ps.pickup_type as pickupType,ps.dropoff_type as dropoffType
         from transit_pattern_stops ps join transit_stops s on s.id=ps.stop_id
        where ps.pattern_id in (${patternMarks})
        order by ps.pattern_id,ps.stop_sequence`,
      patternIds,
    ),
    all<{ tripId: string; patternId: string; publicLabel: string | null; bookingUrl: string | null }>(
      env.DB,
      `select t.id as tripId,t.pattern_id as patternId,t.public_label as publicLabel,t.booking_url as bookingUrl
         from transit_trips t join service_calendars c on c.id=t.service_calendar_id
        where t.status='active' and t.pattern_id in (${patternMarks})
          and c.valid_from<=? and c.valid_to>=?
          and (c.${weekday}=1 or exists(
            select 1 from service_calendar_exceptions a
             where a.calendar_id=c.id and a.service_date=? and a.exception_type='added'
          ))
          and not exists(select 1 from service_calendar_exceptions e where e.calendar_id=c.id and e.service_date=? and e.exception_type='removed')`,
      [...patternIds, date, date, date, date],
    ),
  ]);

  const tripIds = trips.map((trip) => trip.tripId);
  const stopTimes = tripIds.length === 0 ? [] : await all<{
    tripId: string; stopSequence: number; arrivalTime: string | null; departureTime: string | null;
  }>(
    env.DB,
    `select trip_id as tripId,stop_sequence as stopSequence,arrival_time as arrivalTime,departure_time as departureTime
       from transit_stop_times where trip_id in (${tripIds.map(() => "?").join(",")})
       order by trip_id,stop_sequence`,
    tripIds,
  );
  const timesByTrip = new Map<string, typeof stopTimes>();
  for (const time of stopTimes) {
    const list = timesByTrip.get(time.tripId) ?? [];
    list.push(time);
    timesByTrip.set(time.tripId, list);
  }

  // 区间用时中位数：给每个下车站补一个**估算**到达时间。
  //
  // 为什么要估：源数据（返校指南 PDF / 管理端录入）只有首站发车时刻，
  // transit_stop_times 的到达列基本全空（实测线上 157 个班次里 seq>=2 全空），
  // 所以「几点能到」在页面上一直是空的。校车按表发车，唯一的未知量是行驶耗时，
  // 由 worker/modules/travel-time.ts 的定时采样攒下来（见那边的文件头）。
  //
  // 没有样本时这里返回的 estimated* 全是 null，页面按「暂无」渲染 —— 采样还没跑
  // 或某段缺样本都不影响这个接口的其余内容。
  const segmentMedians = await loadSegmentMedians(env, patternIds);
  const sequencesByPattern = new Map<string, number[]>();
  for (const stop of patternStops) {
    const list = sequencesByPattern.get(stop.patternId) ?? [];
    list.push(stop.stopSequence);
    sequencesByPattern.set(stop.patternId, list);
  }

  const lines = new Map<string, {
    routeId: string; routeName: string; bookingPolicy: string; bookingUrl: string | null;
    patterns: Array<{ patternId: string; name: string; stops: unknown[] }>;
    journeys: Array<Record<string, unknown>>;
  }>();
  for (const pattern of patterns) {
    const line = lines.get(pattern.routeId) ?? {
      routeId: pattern.routeId,
      routeName: pattern.routeName,
      bookingPolicy: pattern.bookingPolicy,
      bookingUrl: pattern.bookingUrl,
      patterns: [],
      journeys: [],
    };
    line.patterns.push({
      patternId: pattern.patternId,
      name: pattern.patternName,
      stops: patternStops
        .filter((stop) => stop.patternId === pattern.patternId)
        .map(({ patternId: _patternId, ...stop }) => stop),
    });
    lines.set(pattern.routeId, line);
  }
  for (const trip of trips) {
    const pattern = patterns.find((candidate) => candidate.patternId === trip.patternId);
    if (!pattern) continue;
    const line = lines.get(pattern.routeId);
    if (!line) continue;
    if (line.bookingUrl === null && trip.bookingUrl !== null) line.bookingUrl = trip.bookingUrl;
    const times = timesByTrip.get(trip.tripId) ?? [];
    // 发车时刻取该班次第一个有值的 departure_time：线上只有首站录了时刻。
    const departureTime = times.find((time) => time.departureTime !== null)?.departureTime ?? null;
    const sequences = (sequencesByPattern.get(trip.patternId) ?? []).slice().sort((a, b) => a - b);
    const arrivals = departureTime === null
      ? new Map<number, { time: string; dayOffset: number; durationSeconds: number }>()
      : estimateStopArrivals(
        sequences,
        scopeSegmentMedians(segmentMedians, trip.patternId, departureTime),
        departureTime.slice(0, 5),
      );
    const lastSequence = sequences.length ? sequences[sequences.length - 1] : null;
    const finalArrival = lastSequence === null ? undefined : arrivals.get(lastSequence);
    line.journeys.push({
      tripId: trip.tripId,
      patternId: trip.patternId,
      publicLabel: trip.publicLabel,
      departureTime: times[0]?.departureTime ?? null,
      arrivalTime: times.length ? times[times.length - 1].arrivalTime : null,
      // 末站的估算到达时间与全程估算用时（分钟）。录了真实到达时刻时客户端优先用
      // arrivalTime，这两个字段只在它为 null 时兜底。
      estimatedArrivalTime: finalArrival?.time ?? null,
      estimatedArrivalDayOffset: finalArrival?.dayOffset ?? null,
      estimatedDurationMinutes: finalArrival ? Math.round(finalArrival.durationSeconds / 60) : null,
      stopTimes: times.map(({ tripId: _tripId, ...time }) => ({
        ...time,
        // 逐站估算：断链之后的站为 null（见 estimateStopArrivals 的注释）。
        estimatedArrivalTime: arrivals.get(time.stopSequence)?.time ?? null,
        estimatedArrivalDayOffset: arrivals.get(time.stopSequence)?.dayOffset ?? null,
      })),
    });
  }
  for (const line of lines.values()) {
    line.journeys.sort((a, b) => String(a.departureTime ?? "99:99").localeCompare(String(b.departureTime ?? "99:99")));
  }
  return json({ ...payload, lines: [...lines.values()] }, { headers });
}
