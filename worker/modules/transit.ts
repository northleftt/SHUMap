import type { SessionPrincipal } from "../domain/types";
import type { Env } from "../types/cloudflare";
import { all, assertExists, first } from "../lib/db";
import { HttpError, json, readJson } from "../lib/http";
import { isoNow, makeId, objectValue, optionalString, requiredString } from "../lib/values";
import { audit } from "./audit";
import { createLocation } from "./locations";

export async function listTransit(env: Env): Promise<Response> {
  const [stops, routes, patterns, calendars, trips] = await Promise.all([
    all(env.DB, "select id,place_id as placeId,campus_id as campusId,code,name,status from transit_stops order by name"),
    all(env.DB, "select id,code,name,operator_id as operatorId,status from transit_routes order by name"),
    all(env.DB, "select id,route_id as routeId,direction_id as directionId,name,route_anchor_id as routeAnchorId from transit_patterns order by route_id,direction_id"),
    all(env.DB, "select * from service_calendars order by valid_from desc"),
    all(env.DB, "select id,pattern_id as patternId,service_calendar_id as serviceCalendarId,public_label as publicLabel,booking_policy as bookingPolicy,booking_url as bookingUrl,status from transit_trips order by id"),
  ]);
  return json({ stops, routes, patterns, calendars, trips });
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
  const times = Array.isArray(body.stopTimes) ? body.stopTimes : [];
  if (times.length !== patternStops.length) throw new HttpError(400, "validation_error", "stopTimes must contain one item for every pattern stop");
  const id = makeId("trip");
  const policy = optionalString(body.bookingPolicy, "bookingPolicy", 30) ?? "not_required";
  const statements = [env.DB.prepare(
    `insert into transit_trips(id,pattern_id,service_calendar_id,public_label,booking_policy,booking_url,status,source_id)
     values(?,?,?,?,?,?,'active',?)`,
  ).bind(id, patternId, calendarId, optionalString(body.publicLabel, "publicLabel", 200), policy, optionalString(body.bookingUrl, "bookingUrl", 1000), optionalString(body.sourceId, "sourceId", 100))];
  for (const [index, raw] of times.entries()) {
    const time = objectValue(raw, "stopTime");
    statements.push(env.DB.prepare("insert into transit_stop_times(trip_id,stop_id,stop_sequence,arrival_time,departure_time) values(?,?,?,?,?)")
      .bind(id, patternStops[index].stop_id, index, optionalString(time.arrivalTime, "arrivalTime", 10), optionalString(time.departureTime, "departureTime", 10)));
  }
  await env.DB.batch(statements);
  await audit(env, principal, "transit.trip.create", "transit_trip", id, requestId, null, body);
  return json({ id }, { status: 201 });
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
