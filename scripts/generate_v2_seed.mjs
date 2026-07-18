#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildings = JSON.parse(fs.readFileSync(path.join(root, "data/campus-buildings.picked.json"), "utf8"));
const shuttle = JSON.parse(fs.readFileSync(path.join(root, "data/shuttle-schedule.json"), "utf8"));
const calendar = JSON.parse(fs.readFileSync(path.join(root, "data/academic-calendar.json"), "utf8"));

const campusId = (name) => name.includes("宝山") ? "campus_baoshan" : name.includes("嘉定") ? "campus_jiading" : name.includes("延长") ? "campus_yanchang" : null;
const stopId = (name) => `stop_${slug(name) || hash(name).slice(0, 12)}`;
const slug = (value) => value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const q = (value) => value === null || value === undefined ? "null" : `'${String(value).replaceAll("'", "''")}'`;
const j = (value) => q(JSON.stringify(value));
const now = "datetime('now')";

const lines = [
  "-- Generated SHUMap v2 import seed. Safe for a fresh v2 database.",
  "pragma foreign_keys = on;",
  `insert or ignore into data_sources(id,source_type,title,url,reliability,metadata_json,created_at) values('source_legacy_buildings','import','现有校园建筑与导航坐标',null,'reviewed',${j({ source: "data/campus-buildings.picked.json" })},${now});`,
  `insert or ignore into data_sources(id,source_type,title,url,reliability,metadata_json,created_at) values('source_shuttle_pdf','official','校车时刻表 ${shuttle.version}',${q(shuttle.sourceFile)},'authoritative',${j({ version: shuttle.version, notes: shuttle.normalizationNotes })},${now});`,
  `insert or ignore into data_sources(id,source_type,title,url,reliability,metadata_json,created_at) values('source_academic_calendar','official','校历数据',null,'authoritative',${j({ source: "data/academic-calendar.json" })},${now});`,
];

const seenPlaceCodes = new Map();
for (const [index, item] of buildings.entries()) {
  const campus = campusId(item.campus);
  const baseCode = slug(item.svgElementId || item.name) || `place-${index + 1}`;
  const duplicateKey = `${campus}:${baseCode}`;
  const count = (seenPlaceCodes.get(duplicateKey) ?? 0) + 1;
  seenPlaceCodes.set(duplicateKey, count);
  const code = count === 1 ? baseCode : `${baseCode}-${count}`;
  const placeId = `place_${campus.replace("campus_", "")}_${code}`;
  const revisionId = `prev_${hash(placeId).slice(0, 24)}`;
  const nameId = `pname_${hash(`${placeId}:${item.name}`).slice(0, 24)}`;
  const anchorId = `anchor_${hash(`${placeId}:navigation`).slice(0, 24)}`;
  const bindingId = `eloc_${hash(`${placeId}:navigation`).slice(0, 24)}`;
  const category = item.category === "dorm" ? "residence" : item.category === "building" || item.category === "canteen" || item.category === "library" ? "building" : "other";
  const content = {
    legacyCategory: item.category,
    legacySvgElementId: item.svgElementId,
    detail: item.detail ?? {},
    address: item.navigation?.address ?? null,
  };
  const contentHash = hash(`${item.name}\n${JSON.stringify(content)}`);
  lines.push(
    `insert or ignore into places(id,kind_id,campus_id,stable_code,lifecycle_status,created_at,updated_at) values(${q(placeId)},${q(category)},${q(campus)},${q(code)},'active',${now},${now});`,
    `insert or ignore into place_revisions(id,place_id,revision_no,editorial_status,display_name,content_json,source_id,content_hash,created_at) values(${q(revisionId)},${q(placeId)},1,'approved',${q(item.name)},${j(content)},'source_legacy_buildings',${q(contentHash)},${now});`,
    `update places set current_revision_id=${q(revisionId)} where id=${q(placeId)};`,
    `insert or ignore into place_names(id,place_id,language,name,normalized_name,name_type,is_searchable) values(${q(nameId)},${q(placeId)},'zh-CN',${q(item.name)},${q(item.name.normalize("NFKC").toLowerCase())},'primary',1);`,
  );
  if (category === "building") {
    lines.push(`insert or ignore into buildings(place_id,building_code,public_access_level) values(${q(placeId)},${q(code)},'unknown');`);
  }
  if (Number.isFinite(item.navigation?.longitude) && Number.isFinite(item.navigation?.latitude)) {
    lines.push(
      `insert or ignore into location_anchors(id,campus_id,building_place_id,role,geometry_type,geometry_json,crs,location_hint,precision_level,source_id,verification_status,verified_at,created_at,updated_at) values(${q(anchorId)},${q(campus)},${category === "building" ? q(placeId) : "null"},'navigation_target','Point',${j({ type: "Point", coordinates: [item.navigation.longitude, item.navigation.latitude] })},${q((item.navigation.coordSystem ?? "gcj02").toUpperCase())},${q(item.navigation.address ?? null)},'exact','source_legacy_buildings','verified',${q(item.navigation.pickedAt ?? null)},${now},${now});`,
      `insert or ignore into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,created_at) values(${q(bindingId)},'place',${q(placeId)},${q(anchorId)},'navigation_target',1,${now});`,
    );
  }
}

const stops = new Set(shuttle.routes.flatMap((route) => [route.from, route.to, ...(route.schedules.weekday ?? []).flatMap((trip) => trip.viaCampus ? [trip.viaCampus] : [])]));
for (const name of stops) {
  const id = stopId(name);
  const campus = campusId(name);
  lines.push(`insert or ignore into transit_stops(id,campus_id,code,name,status,created_at,updated_at) values(${q(id)},${q(campus)},${q(slug(name))},${q(name)},'active',${now},${now});`);
}

const academicYear = calendar.academicYear ?? "legacy";
for (const [routeIndex, route] of shuttle.routes.entries()) {
  const routeId = `route_${slug(route.id)}`;
  const patternId = `pattern_${slug(route.id)}`;
  const fromStop = stopId(route.from);
  const toStop = stopId(route.to);
  lines.push(
    `insert or ignore into transit_routes(id,code,name,status,created_at,updated_at) values(${q(routeId)},${q(route.id)},${q(`${route.from} → ${route.to}`)},'active',${now},${now});`,
    `insert or ignore into transit_patterns(id,route_id,direction_id,name) values(${q(patternId)},${q(routeId)},${routeIndex % 2},${q(`${route.from} → ${route.to}`)});`,
    `insert or ignore into transit_pattern_stops(pattern_id,stop_id,stop_sequence,pickup_type,dropoff_type) values(${q(patternId)},${q(fromStop)},0,'regular','none');`,
    `insert or ignore into transit_pattern_stops(pattern_id,stop_id,stop_sequence,pickup_type,dropoff_type) values(${q(patternId)},${q(toStop)},1,'none','regular');`,
  );
  for (const [bucket, departures] of Object.entries(route.schedules)) {
    const calendarId = `calendar_${slug(academicYear)}_${bucket}`;
    const weekday = bucket === "weekday";
    const weekend = bucket === "weekend";
    lines.push(`insert or ignore into service_calendars(id,name,timezone,valid_from,valid_to,monday,tuesday,wednesday,thursday,friday,saturday,sunday,source_id) values(${q(calendarId)},${q(`${academicYear} ${bucket}`)},'Asia/Shanghai','2025-01-01','2026-12-31',${weekday ? 1 : 0},${weekday ? 1 : 0},${weekday ? 1 : 0},${weekday ? 1 : 0},${weekday ? 1 : 0},${weekend ? 1 : 0},${weekend ? 1 : 0},'source_academic_calendar');`);
    for (const [tripIndex, departure] of departures.entries()) {
      const tripId = `trip_${slug(route.id)}_${bucket}_${tripIndex + 1}`;
      lines.push(
        `insert or ignore into transit_trips(id,pattern_id,service_calendar_id,public_label,booking_policy,status,source_id) values(${q(tripId)},${q(patternId)},${q(calendarId)},${q(departure.departureTime)},${q(departure.isReservation ? "required" : "not_required")},'active','source_shuttle_pdf');`,
        `insert or ignore into transit_stop_times(trip_id,stop_id,stop_sequence,departure_time) values(${q(tripId)},${q(fromStop)},0,${q(departure.departureTime)});`,
        `insert or ignore into transit_stop_times(trip_id,stop_id,stop_sequence) values(${q(tripId)},${q(toStop)},1);`,
      );
    }
  }
}

process.stdout.write(`${lines.join("\n")}\n`);
