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

const PICKUP_TYPES = ["regular", "reservation_only", "none"] as const;
const DROPOFF_TYPES = ["regular", "none"] as const;
const BOOKING_POLICIES = ["required", "optional", "not_required"] as const;
const STOP_STATUSES = ["active", "temporarily_closed", "retired"] as const;
const ROUTE_STATUSES = ["active", "suspended", "retired"] as const;
/** A stop's own anchors only describe where you board or alight. */
const STOP_LOCATION_ROLES = ["boarding_point", "alighting_point"] as const;
const MAX_PATTERN_STOPS = 40;
const MAX_CALENDAR_EXCEPTIONS = 366;
const MAX_STOP_LOCATIONS = 20;
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
    throw new HttpError(409, "conflict", `Code ${code} is already used by another record`);
  }
}

/** Validate the `locations` field of a stop create / update payload. */
function stopLocations(value: unknown) {
  const locations = normalizeLocationInputs(value, "locations", MAX_STOP_LOCATIONS);
  for (const [index, location] of locations.entries()) {
    if (!STOP_LOCATION_ROLES.includes(location.role as (typeof STOP_LOCATION_ROLES)[number])) {
      throw new HttpError(400, "validation_error", `locations[${index}].role is not supported for transit stops`);
    }
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
    all(env.DB, "select id,code,name,operator_id as operatorId,status from transit_routes order by status='retired',name"),
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
  const places = await all(
    env.DB,
    `select p.id,r.display_name as displayName,p.kind_id as kindId,p.campus_id as campusId
       from places p left join place_revisions r on r.id=p.current_revision_id
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
    places,
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
      throw new HttpError(409, "conflict", "Remove this stop from every route direction before retiring it");
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
  const body = exactObject(await readJson<unknown>(request), "transitRoute", ["name", "code", "operatorId"]);
  const id = makeId("route");
  const now = isoNow();
  const operatorId = optionalString(body.operatorId, "operatorId", 100);
  const code = optionalString(body.code, "code", 100);
  await Promise.all([
    assertExists(env.DB, "organizations", operatorId, "Operator"),
    assertCodeAvailable(env, "transit_routes", code, null),
  ]);
  await env.DB.prepare("insert into transit_routes(id,code,name,operator_id,status,created_at,updated_at) values(?,?,?,?,'active',?,?)")
    .bind(id, code, requiredString(body.name, "name", 200), operatorId, now, now).run();
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
  const before = await first<{ id: string; code: string | null; name: string; operator_id: string | null; status: string }>(
    env.DB,
    "select id,code,name,operator_id,status from transit_routes where id=?",
    [routeId],
  );
  if (!before) throw new HttpError(404, "not_found", "Route does not exist");
  const body = partialObject(await readJson<unknown>(request), "transitRouteUpdate", ["name", "code", "operatorId", "status"]);
  const name = Object.hasOwn(body, "name") ? requiredString(body.name, "name", 200) : before.name;
  const code = Object.hasOwn(body, "code") ? optionalString(body.code, "code", 100) : before.code;
  const operatorId = Object.hasOwn(body, "operatorId") ? optionalString(body.operatorId, "operatorId", 100) : before.operator_id;
  const status = Object.hasOwn(body, "status") ? oneOf(body.status, "status", ROUTE_STATUSES) : before.status;
  await Promise.all([
    assertExists(env.DB, "organizations", operatorId, "Operator"),
    assertCodeAvailable(env, "transit_routes", code, routeId),
  ]);
  const now = isoNow();
  await env.DB.prepare("update transit_routes set code=?,name=?,operator_id=?,status=?,updated_at=? where id=?")
    .bind(code, name, operatorId, status, now, routeId).run();
  await audit(env, principal, "transit.route.update", "transit_route", routeId, requestId, before, { name, code, operatorId, status });
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
    const pickupType = oneOf(stop.pickupType, `stops[${index}].pickupType`, PICKUP_TYPES);
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
  if (clash) throw new HttpError(409, "conflict", "This route already has a direction with that name and travel direction");
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
      throw new HttpError(409, "conflict", `${orphaned?.total} recorded exception date(s) fall outside the new date range; edit them together with the range`);
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
  const policy = oneOf(body.bookingPolicy, "bookingPolicy", BOOKING_POLICIES);
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
      pickupType: oneOf(stop.pickupType, `stops[${index}].pickupType`, PICKUP_TYPES),
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
  const policy = Object.hasOwn(body, "bookingPolicy")
    ? oneOf(body.bookingPolicy, "bookingPolicy", BOOKING_POLICIES)
    : trip.booking_policy;
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
