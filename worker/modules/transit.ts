import type { SessionPrincipal } from "../domain/types";
import type { D1PreparedStatement, Env } from "../types/cloudflare";
import { all, assertExists, first } from "../lib/db";
import { HttpError, json, readJson } from "../lib/http";
import { isoNow, makeId, objectValue, oneOf, optionalString, requiredString } from "../lib/values";
import { audit } from "./audit";
import { createLocation } from "./locations";

const PICKUP_TYPES = ["regular", "reservation_only", "none"] as const;
const DROPOFF_TYPES = ["regular", "none"] as const;
const BOOKING_POLICIES = ["required", "optional", "not_required"] as const;
const MAX_PATTERN_STOPS = 40;

/**
 * Calendars imported from the shuttle timetable were seeded with the importer's
 * bucket key as their name ("legacy weekday"), which is not presentable. Resolve
 * a Chinese label from that key and fall back to the stored name for calendars
 * that an editor named, so renaming a row wins over this mapping.
 */
const CALENDAR_LABELS: Record<string, string> = {
  weekday: "工作日",
  workday: "工作日",
  weekend: "周末",
  holiday: "节假日",
  winterbreak: "寒假",
  summerbreak: "暑假",
};

export function calendarDisplayName(row: { id: string; name: string }): string {
  for (const candidate of [row.name.split(/[\s_-]+/).pop() ?? "", row.id.split(/[_-]/).pop() ?? ""]) {
    const label = CALENDAR_LABELS[candidate.toLowerCase()];
    if (label) return label;
  }
  return row.name;
}

/**
 * Stop times are rendered verbatim by the client shuttle grid and the imported
 * rows are `HH:MM`, so normalize to that shape instead of `HH:MM:SS`.
 */
function timeValue(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new HttpError(400, "validation_error", `${field} must be a string`);
  const parsed = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(value.trim());
  if (!parsed) throw new HttpError(400, "validation_error", `${field} must be a time of day such as 07:30`);
  return `${parsed[1]}:${parsed[2]}`;
}

interface CalendarRow extends Record<string, unknown> {
  id: string;
  name: string;
}

export async function listTransit(env: Env): Promise<Response> {
  const [stops, routes, patterns, patternStops, calendars, exceptions, trips, stopTimes] = await Promise.all([
    all(env.DB, "select id,place_id as placeId,campus_id as campusId,code,name,status from transit_stops where status='active' order by name"),
    all(env.DB, "select id,code,name,operator_id as operatorId,status from transit_routes order by name"),
    all(env.DB, "select id,route_id as routeId,direction_id as directionId,name,route_anchor_id as routeAnchorId from transit_patterns order by route_id,direction_id"),
    all(env.DB, "select pattern_id as patternId,stop_id as stopId,stop_sequence as stopSequence,pickup_type as pickupType,dropoff_type as dropoffType from transit_pattern_stops order by pattern_id,stop_sequence"),
    all<CalendarRow>(env.DB, "select id,name,timezone,valid_from as validFrom,valid_to as validTo,monday,tuesday,wednesday,thursday,friday,saturday,sunday from service_calendars order by valid_from desc,id"),
    all(env.DB, "select calendar_id as calendarId,service_date as serviceDate,exception_type as exceptionType,label from service_calendar_exceptions order by service_date"),
    all(env.DB, "select id,pattern_id as patternId,service_calendar_id as serviceCalendarId,public_label as publicLabel,booking_policy as bookingPolicy,booking_url as bookingUrl,status from transit_trips where status='active' order by id"),
    all(env.DB, "select trip_id as tripId,stop_id as stopId,stop_sequence as stopSequence,arrival_time as arrivalTime,departure_time as departureTime from transit_stop_times order by trip_id,stop_sequence"),
  ]);
  return json({
    stops,
    routes,
    patterns,
    patternStops,
    calendars: calendars.map((row) => ({ ...row, displayName: calendarDisplayName(row) })),
    exceptions,
    trips,
    stopTimes,
  });
}

export async function createStop(request: Request, env: Env, principal: SessionPrincipal, requestId: string): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request);
  const name = requiredString(body.name, "name", 200);
  const placeId = optionalString(body.placeId, "placeId", 100);
  const campusId = optionalString(body.campusId, "campusId", 100);
  await Promise.all([
    assertExists(env.DB, "places", placeId, "Place"),
    assertExists(env.DB, "campuses", campusId, "Campus"),
  ]);
  const id = makeId("stop");
  const now = isoNow();
  await env.DB.prepare("insert into transit_stops(id,place_id,campus_id,code,name,status,created_at,updated_at) values(?,?,?,?,?,'active',?,?)")
    .bind(id, placeId, campusId, optionalString(body.code, "code", 100), name, now, now).run();
  const locations = Array.isArray(body.locations) ? body.locations : [];
  for (const [index, raw] of locations.entries()) await createLocation(env, "transit_stop", id, raw as never, principal, index === 0);
  await audit(env, principal, "transit.stop.create", "transit_stop", id, requestId, null, body);
  return json({ id }, { status: 201 });
}

export async function createRoute(request: Request, env: Env, principal: SessionPrincipal, requestId: string): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request);
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
  const body = await readJson<Record<string, unknown>>(request);
  const routeId = requiredString(body.routeId, "routeId", 100);
  await assertExists(env.DB, "transit_routes", routeId, "Route");
  const directionId = body.directionId;
  if (directionId !== 0 && directionId !== 1) throw new HttpError(400, "validation_error", "directionId must be 0 or 1");
  const stops = Array.isArray(body.stops) ? body.stops : [];
  if (stops.length < 2) throw new HttpError(400, "validation_error", "A route pattern requires at least two stops");
  const id = makeId("pattern");
  const statements = [env.DB.prepare("insert into transit_patterns(id,route_id,direction_id,name) values(?,?,?,?)")
    .bind(id, routeId, directionId, requiredString(body.name, "name", 200))];
  for (const [index, raw] of stops.entries()) {
    const stop = objectValue(raw, "stop");
    const stopId = requiredString(stop.stopId, "stop.stopId", 100);
    await assertExists(env.DB, "transit_stops", stopId, "Stop");
    const pickupType = optionalString(stop.pickupType, "stop.pickupType", 30) ?? "regular";
    const dropoffType = optionalString(stop.dropoffType, "stop.dropoffType", 30) ?? "regular";
    statements.push(env.DB.prepare("insert into transit_pattern_stops(pattern_id,stop_id,stop_sequence,pickup_type,dropoff_type) values(?,?,?,?,?)")
      .bind(id, stopId, index, pickupType, dropoffType));
  }
  await env.DB.batch(statements);
  await audit(env, principal, "transit.pattern.create", "transit_pattern", id, requestId, null, body);
  return json({ id }, { status: 201 });
}

export async function createCalendar(request: Request, env: Env, principal: SessionPrincipal, requestId: string): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request);
  const id = makeId("calendar");
  const sourceId = optionalString(body.sourceId, "sourceId", 100);
  await assertExists(env.DB, "data_sources", sourceId, "Data source");
  const weekdays = objectValue(body.weekdays, "weekdays");
  const flags = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((day) => weekdays[day] === true ? 1 : 0);
  await env.DB.prepare(
    `insert into service_calendars(id,name,timezone,valid_from,valid_to,monday,tuesday,wednesday,thursday,friday,saturday,sunday,source_id)
     values(?,?,'Asia/Shanghai',?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, requiredString(body.name, "name", 200), requiredString(body.validFrom, "validFrom", 20), requiredString(body.validTo, "validTo", 20), ...flags, sourceId).run();
  const exceptions = Array.isArray(body.exceptions) ? body.exceptions : [];
  for (const raw of exceptions) {
    const exception = objectValue(raw, "exception");
    await env.DB.prepare("insert into service_calendar_exceptions(calendar_id,service_date,exception_type,label) values(?,?,?,?)")
      .bind(id, requiredString(exception.date, "exception.date", 20), requiredString(exception.type, "exception.type", 20), optionalString(exception.label, "exception.label", 200)).run();
  }
  await audit(env, principal, "transit.calendar.create", "service_calendar", id, requestId, null, body);
  return json({ id }, { status: 201 });
}

export async function createTrip(request: Request, env: Env, principal: SessionPrincipal, requestId: string): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request);
  const patternId = requiredString(body.patternId, "patternId", 100);
  const calendarId = requiredString(body.serviceCalendarId, "serviceCalendarId", 100);
  await Promise.all([
    assertExists(env.DB, "transit_patterns", patternId, "Pattern"),
    assertExists(env.DB, "service_calendars", calendarId, "Calendar"),
  ]);
  const patternStops = await all<{ stop_id: string; stop_sequence: number }>(env.DB, "select stop_id,stop_sequence from transit_pattern_stops where pattern_id=? order by stop_sequence", [patternId]);
  if (patternStops.length === 0) throw new HttpError(400, "validation_error", "The pattern has no stop sequence yet");
  const times = Array.isArray(body.stopTimes) ? body.stopTimes : [];
  if (times.length !== patternStops.length) throw new HttpError(400, "validation_error", "stopTimes must contain one item for every pattern stop");
  const id = makeId("trip");
  const policy = body.bookingPolicy === undefined || body.bookingPolicy === null
    ? "not_required"
    : oneOf(body.bookingPolicy, "bookingPolicy", BOOKING_POLICIES);
  const statements = [env.DB.prepare(
    `insert into transit_trips(id,pattern_id,service_calendar_id,public_label,booking_policy,booking_url,status,source_id)
     values(?,?,?,?,?,?,'active',?)`,
  ).bind(id, patternId, calendarId, optionalString(body.publicLabel, "publicLabel", 200), policy, optionalString(body.bookingUrl, "bookingUrl", 1000), optionalString(body.sourceId, "sourceId", 100))];
  for (const [index, raw] of times.entries()) {
    const time = objectValue(raw, "stopTime");
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

  const body = await readJson<Record<string, unknown>>(request);
  if (!Array.isArray(body.stops)) throw new HttpError(400, "validation_error", "stops must be an array");
  if (body.stops.length < 2) throw new HttpError(400, "validation_error", "A route pattern requires at least two stops");
  if (body.stops.length > MAX_PATTERN_STOPS) {
    throw new HttpError(400, "validation_error", `A route pattern supports at most ${MAX_PATTERN_STOPS} stops`);
  }

  // Validate the whole payload before touching the database: a rejected request
  // must never leave the pattern without its stop sequence.
  const activeStopIds = new Set((await all<{ id: string }>(env.DB, "select id from transit_stops where status='active'")).map((row) => row.id));
  const planned: Array<{ stopId: string; pickupType: string; dropoffType: string }> = [];
  const seen = new Set<string>();
  for (const [index, raw] of body.stops.entries()) {
    const stop = objectValue(raw, `stops[${index}]`);
    const stopId = requiredString(stop.stopId, `stops[${index}].stopId`, 100);
    if (!activeStopIds.has(stopId)) throw new HttpError(400, "validation_error", `stops[${index}].stopId does not exist`);
    if (seen.has(stopId)) throw new HttpError(400, "validation_error", "A stop can appear only once in a pattern");
    seen.add(stopId);
    planned.push({
      stopId,
      pickupType: stop.pickupType === undefined || stop.pickupType === null ? "regular" : oneOf(stop.pickupType, `stops[${index}].pickupType`, PICKUP_TYPES),
      dropoffType: stop.dropoffType === undefined || stop.dropoffType === null ? "regular" : oneOf(stop.dropoffType, `stops[${index}].dropoffType`, DROPOFF_TYPES),
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
  const timeByTripStop = new Map(previousTimes.map((row) => [`${row.trip_id} ${row.stop_id}`, row]));

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
      const carried = timeByTripStop.get(`${trip.id} ${stop.stopId}`);
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

  const body = await readJson<Record<string, unknown>>(request);
  const calendarId = optionalString(body.serviceCalendarId, "serviceCalendarId", 100) ?? trip.service_calendar_id;
  if (calendarId !== trip.service_calendar_id) {
    const calendar = await first<{ id: string }>(env.DB, "select id from service_calendars where id=?", [calendarId]);
    if (!calendar) throw new HttpError(400, "validation_error", "serviceCalendarId does not exist");
  }
  const policy = body.bookingPolicy === undefined || body.bookingPolicy === null
    ? trip.booking_policy
    : oneOf(body.bookingPolicy, "bookingPolicy", BOOKING_POLICIES);

  const statements: D1PreparedStatement[] = [
    env.DB.prepare("update transit_trips set service_calendar_id=?,booking_policy=?,booking_url=? where id=?")
      .bind(calendarId, policy, optionalString(body.bookingUrl, "bookingUrl", 1000) ?? trip.booking_url, tripId),
  ];

  if (body.stopTimes !== undefined) {
    if (!Array.isArray(body.stopTimes)) throw new HttpError(400, "validation_error", "stopTimes must be an array");
    const patternStops = await all<{ stop_id: string; stop_sequence: number }>(
      env.DB,
      "select stop_id,stop_sequence from transit_pattern_stops where pattern_id=? order by stop_sequence",
      [trip.pattern_id],
    );
    if (body.stopTimes.length !== patternStops.length) {
      throw new HttpError(400, "validation_error", "stopTimes must contain one item for every pattern stop");
    }
    statements.push(env.DB.prepare("delete from transit_stop_times where trip_id=?").bind(tripId));
    for (const [index, raw] of body.stopTimes.entries()) {
      const time = objectValue(raw, `stopTimes[${index}]`);
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
      where t.status='active' and fs.stop_sequence<ts.stop_sequence and c.valid_from<=? and c.valid_to>=?
        and c.${weekday}=1
        and not exists(select 1 from service_calendar_exceptions e where e.calendar_id=c.id and e.service_date=? and e.exception_type='removed')
      order by fs.departure_time`,
    [fromStopId, toStopId, date, date, date],
  );
  return json({ date, timezone: "Asia/Shanghai", journeys }, { headers: { "cache-control": "public, max-age=60" } });
}
