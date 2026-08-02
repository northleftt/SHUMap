import type { SessionPrincipal } from "../domain/types";
import type { D1PreparedStatement, Env } from "../types/cloudflare";
import { all, assertExists, first } from "../lib/db";
import { HttpError, json, readJson } from "../lib/http";
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
import { planLocation } from "./locations";

const PICKUP_TYPES = ["regular", "reservation_only", "none"] as const;
const DROPOFF_TYPES = ["regular", "none"] as const;
const BOOKING_POLICIES = ["required", "optional", "not_required"] as const;
const MAX_PATTERN_STOPS = 40;
const MAX_CALENDAR_EXCEPTIONS = 366;
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

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
  const [stops, routes, patterns, patternStops, calendars, exceptions, trips, stopTimes] = await Promise.all([
    all(env.DB, "select id,place_id as placeId,campus_id as campusId,code,name,status from transit_stops where status='active' order by name"),
    all(env.DB, "select id,code,name,operator_id as operatorId,status from transit_routes order by name"),
    all(env.DB, "select id,route_id as routeId,direction_id as directionId,name,route_anchor_id as routeAnchorId from transit_patterns order by route_id,direction_id"),
    all(env.DB, "select pattern_id as patternId,stop_id as stopId,stop_sequence as stopSequence,pickup_type as pickupType,dropoff_type as dropoffType from transit_pattern_stops order by pattern_id,stop_sequence"),
    all(env.DB, "select id,name,timezone,valid_from as validFrom,valid_to as validTo,monday,tuesday,wednesday,thursday,friday,saturday,sunday from service_calendars order by valid_from desc,id"),
    all(env.DB, "select calendar_id as calendarId,service_date as serviceDate,exception_type as exceptionType,label from service_calendar_exceptions order by service_date"),
    all(env.DB, "select id,pattern_id as patternId,service_calendar_id as serviceCalendarId,public_label as publicLabel,booking_policy as bookingPolicy,booking_url as bookingUrl,status from transit_trips where status='active' order by id"),
    all(env.DB, "select trip_id as tripId,stop_id as stopId,stop_sequence as stopSequence,arrival_time as arrivalTime,departure_time as departureTime from transit_stop_times order by trip_id,stop_sequence"),
  ]);
  return json({
    stops,
    routes,
    patterns,
    patternStops,
    calendars,
    exceptions,
    trips,
    stopTimes,
  });
}

export async function createStop(request: Request, env: Env, principal: SessionPrincipal, requestId: string): Promise<Response> {
  const body = exactObject(await readJson<unknown>(request), "transitStop", ["name", "code", "placeId", "campusId", "locations"]);
  const name = requiredString(body.name, "name", 200);
  const placeId = optionalString(body.placeId, "placeId", 100);
  const campusId = optionalString(body.campusId, "campusId", 100);
  const locations = normalizeLocationInputs(body.locations, "locations", 20);
  for (const [index, location] of locations.entries()) {
    if (location.role !== "boarding_point" && location.role !== "alighting_point") {
      throw new HttpError(400, "validation_error", `locations[${index}].role is not supported for transit stops`);
    }
  }
  await Promise.all([
    assertExists(env.DB, "places", placeId, "Place"),
    assertExists(env.DB, "campuses", campusId, "Campus"),
  ]);
  const id = makeId("stop");
  const now = isoNow();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("insert into transit_stops(id,place_id,campus_id,code,name,status,created_at,updated_at) values(?,?,?,?,?,'active',?,?)")
      .bind(id, placeId, campusId, optionalString(body.code, "code", 100), name, now, now),
  ];
  for (const location of locations) {
    const plan = await planLocation(env, "transit_stop", id, location, principal, now);
    statements.push(...plan.statements);
  }
  await env.DB.batch(statements);
  await audit(env, principal, "transit.stop.create", "transit_stop", id, requestId, null, body);
  return json({ id }, { status: 201 });
}

export async function createRoute(request: Request, env: Env, principal: SessionPrincipal, requestId: string): Promise<Response> {
  const body = exactObject(await readJson<unknown>(request), "transitRoute", ["name", "code", "operatorId"]);
  const id = makeId("route");
  const now = isoNow();
  const operatorId = optionalString(body.operatorId, "operatorId", 100);
  await assertExists(env.DB, "organizations", operatorId, "Operator");
  await env.DB.prepare("insert into transit_routes(id,code,name,operator_id,status,created_at,updated_at) values(?,?,?,?,'active',?,?)")
    .bind(id, optionalString(body.code, "code", 100), requiredString(body.name, "name", 200), operatorId, now, now).run();
  await audit(env, principal, "transit.route.create", "transit_route", id, requestId, null, body);
  return json({ id }, { status: 201 });
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
  const exceptions = arrayValue(body.exceptions, "exceptions", MAX_CALENDAR_EXCEPTIONS);
  const statements: D1PreparedStatement[] = [env.DB.prepare(
    `insert into service_calendars(id,name,timezone,valid_from,valid_to,monday,tuesday,wednesday,thursday,friday,saturday,sunday,source_id)
     values(?,?,'Asia/Shanghai',?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, name, validFrom, validTo, ...flags, sourceId)];
  const exceptionDates = new Set<string>();
  for (const [index, raw] of exceptions.entries()) {
    const exception = exactObject(raw, `exceptions[${index}]`, ["date", "type", "label"]);
    const type = oneOf(exception.type, `exceptions[${index}].type`, ["added", "removed"] as const);
    const date = dateValue(exception.date, `exceptions[${index}].date`);
    if (date < validFrom || date > validTo) {
      throw new HttpError(400, "validation_error", `exceptions[${index}].date must be within the calendar date range`);
    }
    if (exceptionDates.has(date)) throw new HttpError(400, "validation_error", "Each exception date can appear only once");
    exceptionDates.add(date);
    statements.push(env.DB.prepare("insert into service_calendar_exceptions(calendar_id,service_date,exception_type,label) values(?,?,?,?)")
      .bind(id, date, type, optionalString(exception.label, `exceptions[${index}].label`, 200)));
  }
  await env.DB.batch(statements);
  await audit(env, principal, "transit.calendar.create", "service_calendar", id, requestId, null, body);
  return json({ id }, { status: 201 });
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
