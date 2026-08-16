#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSvgFeatures } from "../shared/svg-geometry.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const campusPlaces = JSON.parse(fs.readFileSync(path.join(root, "data/campus-buildings.picked.json"), "utf8"));
const campusMapAssets = JSON.parse(fs.readFileSync(path.join(root, "data/campus-map-assets.json"), "utf8"));
const shuttle = JSON.parse(fs.readFileSync(path.join(root, "data/shuttle-schedule.json"), "utf8"));
const calendar = JSON.parse(fs.readFileSync(path.join(root, "data/academic-calendar.json"), "utf8"));

const CAMPUS_IDS = new Map([
  ["宝山校区", { id: "campus_baoshan", key: "baoshan" }],
  ["嘉定校区", { id: "campus_jiading", key: "jiading" }],
  ["延长校区", { id: "campus_yanchang", key: "yanchang" }],
]);
const PLACE_KIND_IDS = new Map([
  ["building", "building"],
  ["canteen", "canteen"],
  ["library", "library"],
  ["dorm", "residence"],
  ["other", "other"],
]);
const CALENDAR_NAMES = new Map([
  ["weekday", "工作日"],
  ["weekend", "周末"],
  ["holiday", "节假日"],
  ["winterBreak", "寒假"],
  ["summerBreak", "暑假"],
]);
const SHUTTLE_BUCKETS = ["weekday", "weekend", "holiday", "winterBreak", "summerBreak"];

const campusOf = (name) => {
  const campus = CAMPUS_IDS.get(name);
  if (!campus) throw new Error(`Unknown campus: ${name}`);
  return campus;
};
const kindOf = (category) => {
  const kindId = PLACE_KIND_IDS.get(category);
  if (!kindId) throw new Error(`Unknown place category: ${category}`);
  return kindId;
};
const slug = (value) => value.normalize("NFKC").toLowerCase()
  .replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const q = (value) => value === null || value === undefined ? "null" : `'${String(value).replaceAll("'", "''")}'`;
const j = (value) => q(JSON.stringify(value));
const now = "datetime('now')";
const stopId = (name) => `stop_${slug(name) || hash(name).slice(0, 12)}`;

if (!Array.isArray(campusPlaces) || campusPlaces.length !== 121) {
  throw new Error("Campus place source must contain exactly 121 records");
}
if (!Array.isArray(calendar.academicYears) || calendar.academicYears.length !== 1
  || typeof calendar.academicYears[0]?.id !== "string" || !calendar.academicYears[0].id.trim()) {
  throw new Error("Academic calendar must declare exactly one identified academic year");
}
if (!Array.isArray(shuttle.routes) || shuttle.routes.length === 0) {
  throw new Error("Shuttle source must declare at least one route");
}
const routeIds = new Set();
for (const [routeIndex, route] of shuttle.routes.entries()) {
  if (!route || typeof route !== "object" || Array.isArray(route)) {
    throw new Error(`Shuttle route ${routeIndex + 1} must be an object`);
  }
  if (typeof route.id !== "string" || !route.id.trim() || routeIds.has(route.id)) {
    throw new Error(`Shuttle route ${routeIndex + 1} must have a unique non-empty id`);
  }
  routeIds.add(route.id);
  for (const field of ["from", "to"]) {
    if (typeof route[field] !== "string" || !route[field].trim()) {
      throw new Error(`Shuttle route ${route.id} ${field} must be a non-empty string`);
    }
  }
  if (!route.schedules || typeof route.schedules !== "object" || Array.isArray(route.schedules)) {
    throw new Error(`Shuttle route ${route.id} schedules must be an object`);
  }
  const scheduleKeys = Object.keys(route.schedules).sort();
  const expectedKeys = [...SHUTTLE_BUCKETS].sort();
  if (scheduleKeys.length !== expectedKeys.length || scheduleKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`Shuttle route ${route.id} must declare exactly ${SHUTTLE_BUCKETS.join(", ")}`);
  }
  for (const bucket of SHUTTLE_BUCKETS) {
    const departures = route.schedules[bucket];
    if (!Array.isArray(departures)) throw new Error(`Shuttle route ${route.id} ${bucket} must be an array`);
    for (const [departureIndex, departure] of departures.entries()) {
      if (!departure || typeof departure !== "object" || Array.isArray(departure)) {
        throw new Error(`Shuttle route ${route.id} ${bucket}[${departureIndex}] must be an object`);
      }
      const keys = Object.keys(departure);
      if (keys.some((key) => !["departureTime", "isReservation", "viaCampus"].includes(key))) {
        throw new Error(`Shuttle route ${route.id} ${bucket}[${departureIndex}] has unsupported fields`);
      }
      if (typeof departure.departureTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(departure.departureTime)) {
        throw new Error(`Shuttle route ${route.id} ${bucket}[${departureIndex}] has an invalid departureTime`);
      }
      if (typeof departure.isReservation !== "boolean") {
        throw new Error(`Shuttle route ${route.id} ${bucket}[${departureIndex}] isReservation must be boolean`);
      }
      if (departure.viaCampus !== undefined && !CAMPUS_IDS.has(departure.viaCampus)) {
        throw new Error(`Shuttle route ${route.id} ${bucket}[${departureIndex}] has an unknown viaCampus`);
      }
    }
  }
}

const featureGeometryTypes = new Map();
for (const asset of campusMapAssets) {
  const bytes = fs.readFileSync(path.join(root, asset.sourcePath));
  if (bytes.byteLength !== asset.byteSize || hash(bytes) !== asset.sha256) {
    throw new Error(`Canonical map asset does not match its manifest: ${asset.sourcePath}`);
  }
  for (const feature of parseSvgFeatures(bytes.toString("utf8"))) {
    if (!feature.geometry || !["Polygon", "MultiPolygon"].includes(feature.geometry.type)) continue;
    const key = `${asset.campusId}:${feature.sourceElementId}`;
    if (featureGeometryTypes.has(key)) throw new Error(`Duplicate canonical map feature: ${key}`);
    featureGeometryTypes.set(key, feature.geometry.type);
  }
}

const lines = [
  "-- Generated SHUMap v2 canonical seed. Apply after every v2 migration.",
  "pragma foreign_keys = on;",
  `insert or ignore into data_sources(id,source_type,title,url,reliability,metadata_json,created_at) values('source_campus_maps','import','校园地图地点与导航坐标',null,'reviewed',${j({ source: "data/campus-buildings.picked.json" })},${now});`,
  `insert or ignore into data_sources(id,source_type,title,url,reliability,metadata_json,created_at) values('source_shuttle_pdf','official','校车时刻表 ${shuttle.version}',${q(shuttle.sourceFile)},'authoritative',${j({ version: shuttle.version, notes: shuttle.normalizationNotes })},${now});`,
  `insert or ignore into data_sources(id,source_type,title,url,reliability,metadata_json,created_at) values('source_academic_calendar','official','校历数据',null,'authoritative',${j({ source: "data/academic-calendar.json" })},${now});`,
];

const seenPlaceCodes = new Map();
const seenSvgElements = new Set();
for (const [index, item] of campusPlaces.entries()) {
  const campus = campusOf(item.campus);
  const kindId = kindOf(item.category);
  if (typeof item.svgElementId !== "string" || !item.svgElementId) {
    throw new Error(`Place ${index + 1} has no SVG element id`);
  }
  const svgKey = `${campus.id}:${item.svgElementId}`;
  if (seenSvgElements.has(svgKey)) throw new Error(`Duplicate campus SVG element: ${svgKey}`);
  seenSvgElements.add(svgKey);
  const footprintGeometryType = featureGeometryTypes.get(svgKey);
  if (!footprintGeometryType) throw new Error(`Campus place has no polygonal map feature: ${svgKey}`);

  const baseCode = slug(item.svgElementId) || `place-${index + 1}`;
  const duplicateKey = `${campus.id}:${baseCode}`;
  const count = (seenPlaceCodes.get(duplicateKey) ?? 0) + 1;
  seenPlaceCodes.set(duplicateKey, count);
  const code = count === 1 ? baseCode : `${baseCode}-${count}`;
  const placeId = `place_${campus.key}_${code}`;
  const revisionId = `prev_${hash(placeId).slice(0, 24)}`;
  const nameId = `pname_${hash(`${placeId}:${item.name}`).slice(0, 24)}`;
  const footprintAnchorId = `anchor_footprint_${campus.key}_${item.svgElementId}`;
  const footprintBindingId = `entity_location_footprint_${campus.key}_${item.svgElementId}`;
  const mapVersionId = `map_version_campus_${campus.key}`;
  const mapFeatureId = `map_feature_${campus.key}_${item.svgElementId}`;
  const building = {
    buildingCode: code,
    managingOrganizationId: null,
    publicAccessLevel: "unknown",
  };
  // 这里刻意不产出 navigation_target。
  //
  // picked.json 里的 navigation 经纬度是早期随手标的（多在楼角/围墙上，不是入口），
  // 已由 scripts/generate_navigation_purge.mjs 从库里清除。种子若继续产出，
  // 下次 db:seed:v2 会把 121 个锚点原样插回来（锚点 id 是 placeId 的确定性哈希、
  // insert or ignore），而 structure_json 因 revision 已存在被跳过，
  // 两处就此长期不一致 —— 关系表有导航点、编辑器里没有。
  //
  // 新的导航终点改由管理端在校区图上标（LocationEditor 逆变换回填 GCJ-02），
  // 前提是先用「开发工具 → 坐标校准器」重建仿射参数。
  // navigation.address 仍然使用：地址是文字资料，与坐标准确性无关。
  const locations = [];
  locations.push({
    campusId: campus.id,
    buildingPlaceId: placeId,
    role: "footprint",
    geometryType: footprintGeometryType,
    mapVersionId,
    mapFeatureId,
    precisionLevel: "exact",
    sourceId: "source_campus_maps",
    isPrimary: false,
  });
  if (typeof item.navigation?.address !== "string" || !item.navigation.address.trim()) {
    throw new Error(`Place ${placeId} has no canonical address`);
  }
  const content = { detail: { facts: [], media: [] }, address: item.navigation.address };
  const structure = {
    kindId,
    campusId: campus.id,
    parentPlaceId: null,
    stableCode: code,
    aliases: [],
    building,
    locations,
  };
  const contentJson = JSON.stringify(content);
  const structureJson = JSON.stringify(structure);
  const contentHash = hash(`${item.name}\n\n\n${contentJson}\n${structureJson}`);

  lines.push(
    `insert or ignore into places(id,kind_id,campus_id,stable_code,lifecycle_status,approval_pending,created_at,updated_at) values(${q(placeId)},${q(kindId)},${q(campus.id)},${q(code)},'active',0,${now},${now});`,
    `insert or ignore into buildings(place_id,building_code,public_access_level) values(${q(placeId)},${q(code)},'unknown');`,
    `insert or ignore into place_revisions(id,place_id,revision_no,editorial_status,display_name,content_json,structure_json,source_id,content_hash,created_at) values(${q(revisionId)},${q(placeId)},1,'approved',${q(item.name)},${q(contentJson)},${q(structureJson)},'source_campus_maps',${q(contentHash)},${now});`,
    `update places set current_revision_id=${q(revisionId)} where id=${q(placeId)} and current_revision_id is null;`,
    `insert or ignore into place_names(id,place_id,language,name,normalized_name,name_type,is_searchable) values(${q(nameId)},${q(placeId)},'zh-CN',${q(item.name)},${q(item.name.normalize("NFKC").toLowerCase())},'primary',1);`,
    `insert or ignore into location_anchors(id,campus_id,building_place_id,role,geometry_type,map_version_id,map_feature_id,precision_level,source_id,verification_status,verified_at,created_at,updated_at) values(${q(footprintAnchorId)},${q(campus.id)},${q(placeId)},'footprint',${q(footprintGeometryType)},${q(mapVersionId)},${q(mapFeatureId)},'exact','source_campus_maps','verified',${now},${now},${now});`,
    `insert or ignore into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,created_at) values(${q(footprintBindingId)},'place',${q(placeId)},${q(footprintAnchorId)},'footprint',0,${now});`,
  );
}

const stops = new Set(shuttle.routes.flatMap((route) => [
  route.from,
  route.to,
  ...route.schedules.weekday.flatMap((trip) => trip.viaCampus ? [trip.viaCampus] : []),
]));
for (const name of stops) {
  const campus = CAMPUS_IDS.get(name)?.id ?? null;
  lines.push(`insert or ignore into transit_stops(id,campus_id,code,name,status,created_at,updated_at) values(${q(stopId(name))},${q(campus)},${q(slug(name))},${q(name)},'active',${now},${now});`);
}

const academicYear = calendar.academicYears[0].id.trim();
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
    const calendarName = CALENDAR_NAMES.get(bucket);
    if (!calendarName) throw new Error(`Unknown shuttle calendar bucket: ${bucket}`);
    const weekday = bucket === "weekday";
    const weekend = bucket === "weekend";
    lines.push(`insert or ignore into service_calendars(id,name,timezone,valid_from,valid_to,monday,tuesday,wednesday,thursday,friday,saturday,sunday,source_id) values(${q(calendarId)},${q(`${academicYear} ${calendarName}`)},'Asia/Shanghai','2025-01-01','2026-12-31',${weekday ? 1 : 0},${weekday ? 1 : 0},${weekday ? 1 : 0},${weekday ? 1 : 0},${weekday ? 1 : 0},${weekend ? 1 : 0},${weekend ? 1 : 0},'source_academic_calendar');`);
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
