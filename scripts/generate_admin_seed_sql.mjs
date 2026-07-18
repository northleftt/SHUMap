#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const outFile = path.join(root, "output", "admin-seed.sql");
const now = new Date().toISOString();

const campusFiles = [
  { campus: "宝山校区", version: "draft-2026-05-28", file: "地图/宝山本部地图1.svg" },
  { campus: "嘉定校区", version: "draft-2026-05-28", file: "地图/嘉定校区地图1.svg" },
  { campus: "延长校区", version: "draft-2026-05-28", file: "地图/延长校区地图1.svg" },
];

function sql(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function decodeIllustratorId(id) {
  return id
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/_x([0-9A-Fa-f]{2})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/_x5C_/g, "_");
}

function getCampusKey(campus) {
  if (campus.includes("宝山")) return "baoshan";
  if (campus.includes("嘉定")) return "jiading";
  if (campus.includes("延长")) return "yanchang";
  return "other";
}

function statusForGeometry(geometry) {
  return geometry === "none" ? "issue" : "draft";
}

function normalizeGeometry(rawGeometry) {
  if (rawGeometry === "marker") return "marker";
  if (rawGeometry === "polygon") return "polygon";
  if (rawGeometry === "svg-object") return "svg-object";
  return "none";
}

function extractSvgObjects(svgText) {
  const objects = [];
  const groupPattern = /<g\b[^>]*\sid="([^"]+)"[^>]*>([\s\S]*?)<\/g>/g;
  let match;
  while ((match = groupPattern.exec(svgText))) {
    const rawId = match[1];
    if (rawId === "Layer_1") continue;
    const body = match[2] || "";
    const text = Array.from(body.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g))
      .map((textMatch) => textMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" ");
    objects.push({
      rawId,
      normalizedId: decodeIllustratorId(rawId),
      kind: "g",
      text,
    });
  }

  const circlePattern = /<circle\b[^>]*\sid="([^"]+)"[^>]*>/g;
  while ((match = circlePattern.exec(svgText))) {
    const rawId = match[1];
    objects.push({
      rawId,
      normalizedId: decodeIllustratorId(rawId),
      kind: "circle",
      text: "",
    });
  }

  return objects;
}

function makeId(prefix, value) {
  return `${prefix}_${value}`
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function routeBucketCount(route, bucket) {
  return Array.isArray(route.schedules?.[bucket]) ? route.schedules[bucket].length : 0;
}

const rawBuildings = JSON.parse(
  fs.readFileSync(path.join(root, "data", "campus-buildings.picked.json"), "utf8"),
);
const shuttleData = JSON.parse(
  fs.readFileSync(path.join(root, "data", "shuttle-schedule.json"), "utf8"),
);

const mapObjectsByCampus = new Map();
const lines = [
  "delete from validation_issues;",
  "delete from logs;",
  "delete from releases;",
  "delete from shuttle_routes;",
  "delete from route_overlays;",
  "delete from poi_bindings;",
  "delete from markers;",
  "delete from pois;",
  "delete from svg_diffs;",
  "delete from map_objects;",
  "delete from map_versions;",
];

for (const campusFile of campusFiles) {
  const svgText = fs.readFileSync(path.join(root, campusFile.file), "utf8");
  const objects = extractSvgObjects(svgText);
  const versionId = makeId("map", `${getCampusKey(campusFile.campus)}_${campusFile.version}`);
  mapObjectsByCampus.set(campusFile.campus, {
    versionId,
    objects,
    normalizedIds: new Set(objects.map((object) => object.normalizedId)),
  });

  lines.push(
    `insert into map_versions (id, campus, version, status, source_file_name, object_count, unresolved_diffs, created_at, updated_at) values (${sql(versionId)}, ${sql(campusFile.campus)}, ${sql(campusFile.version)}, 'draft', ${sql(path.basename(campusFile.file))}, ${objects.length}, 0, ${sql(now)}, ${sql(now)});`,
  );

  for (const object of objects) {
    const objectId = makeId("obj", `${versionId}_${object.normalizedId}`);
    lines.push(
      `insert into map_objects (id, map_version_id, campus, raw_id, normalized_id, object_kind, label_text, created_at) values (${sql(objectId)}, ${sql(versionId)}, ${sql(campusFile.campus)}, ${sql(object.rawId)}, ${sql(object.normalizedId)}, ${sql(object.kind)}, ${sql(object.text || null)}, ${sql(now)});`,
    );
  }
}

let unboundCount = 0;
for (const building of rawBuildings) {
  const campus = building.campus;
  const campusObjects = mapObjectsByCampus.get(campus);
  const poiId = makeId("poi", `${getCampusKey(campus)}_${building.svgElementId}`);
  const normalizedElementId = decodeIllustratorId(building.svgElementId);
  const hasSvgObject = campusObjects?.normalizedIds.has(normalizedElementId) ?? false;
  const geometry = normalizeGeometry(hasSvgObject ? "svg-object" : "none");
  if (!hasSvgObject) unboundCount += 1;

  lines.push(
    `insert into pois (id, name, campus, category, geometry, status, detail_json, navigation_json, created_at, updated_at) values (${sql(poiId)}, ${sql(building.name)}, ${sql(campus)}, ${sql(building.category)}, ${sql(geometry)}, ${sql(statusForGeometry(geometry))}, ${sql(JSON.stringify(building.detail ?? {}))}, ${sql(JSON.stringify(building.navigation ?? null))}, ${sql(now)}, ${sql(now)});`,
  );

  if (hasSvgObject && campusObjects) {
    const objectId = makeId("obj", `${campusObjects.versionId}_${normalizedElementId}`);
    lines.push(
      `insert into poi_bindings (id, poi_id, binding_type, map_object_id, geometry_json, created_at) values (${sql(makeId("bind", `${poiId}_${objectId}`))}, ${sql(poiId)}, 'svg-object', ${sql(objectId)}, null, ${sql(now)});`,
    );
  }
}

const markerSeeds = [
  {
    id: "marker_baoshan_jiading_reserve_onboard",
    poiId: "poi_baoshan_jiading_reserve_onboard",
    name: "嘉定方向预约车上车点",
    campus: "宝山校区",
    markerTypeId: "shuttle-stop",
    x: 763.5,
    y: 517.4,
    meta: { serviceType: "reservation", directionTarget: "jiading", role: "onboard" },
  },
  {
    id: "marker_baoshan_yanchang_reserve_onboard",
    poiId: "poi_baoshan_yanchang_reserve_onboard",
    name: "延长方向预约车上车点",
    campus: "宝山校区",
    markerTypeId: "shuttle-stop",
    x: 488.1,
    y: 709.2,
    meta: { serviceType: "reservation", directionTarget: "yanchang", role: "onboard" },
  },
  {
    id: "marker_jiading_campus_onboard",
    poiId: "poi_jiading_campus_onboard",
    name: "嘉定校区校车上车点",
    campus: "嘉定校区",
    markerTypeId: "shuttle-stop",
    x: 151.3,
    y: 61.2,
    meta: { role: "onboard" },
  },
  {
    id: "marker_yanchang_campus_onboard",
    poiId: "poi_yanchang_campus_onboard",
    name: "延长校区校车上车点",
    campus: "延长校区",
    markerTypeId: "shuttle-stop",
    x: 685.3,
    y: 284.6,
    meta: { role: "onboard" },
  },
];

for (const marker of markerSeeds) {
  lines.push(
    `insert into pois (id, name, campus, category, geometry, status, detail_json, navigation_json, created_at, updated_at) values (${sql(marker.poiId)}, ${sql(marker.name)}, ${sql(marker.campus)}, '校车点', 'marker', 'draft', ${sql(JSON.stringify({ typeLabel: "校车点", facilityNotes: "由校车页面上下文打开。" }))}, null, ${sql(now)}, ${sql(now)});`,
  );
  lines.push(
    `insert into markers (id, marker_type_id, campus, poi_id, x, y, status, meta_json, created_at, updated_at) values (${sql(marker.id)}, ${sql(marker.markerTypeId)}, ${sql(marker.campus)}, ${sql(marker.poiId)}, ${marker.x}, ${marker.y}, 'draft', ${sql(JSON.stringify(marker.meta))}, ${sql(now)}, ${sql(now)});`,
  );
  lines.push(
    `insert into poi_bindings (id, poi_id, binding_type, marker_id, geometry_json, created_at) values (${sql(makeId("bind", marker.id))}, ${sql(marker.poiId)}, 'marker', ${sql(marker.id)}, ${sql(JSON.stringify({ x: marker.x, y: marker.y }))}, ${sql(now)});`,
  );
}

const overlaySeeds = [
  ["baoshan-reserve-to-jiading", "嘉定方向预约车下车说明", "宝山校区", "shuttle_dropoff"],
  ["baoshan-reserve-to-yanchang", "延长方向预约车下车说明", "宝山校区", "shuttle_dropoff"],
  ["baoshan-nonreserve-to-jiading", "嘉定方向非预约车校内环线", "宝山校区", "shuttle_route"],
  ["baoshan-nonreserve-to-yanchang", "延长方向非预约车校内环线", "宝山校区", "shuttle_route"],
];

for (const [id, name, campus, kind] of overlaySeeds) {
  lines.push(
    `insert into route_overlays (id, name, campus, kind, status, geometry_json, style_json, created_at, updated_at) values (${sql(id)}, ${sql(name)}, ${sql(campus)}, ${sql(kind)}, 'draft', ${sql(JSON.stringify({ source: "pending-svg-overlay-extraction" }))}, ${sql(JSON.stringify({ stroke: "#1E80C1", strokeWidth: 8 }))}, ${sql(now)}, ${sql(now)});`,
  );
}

for (const route of shuttleData.routes) {
  lines.push(
    `insert into shuttle_routes (id, from_campus, to_campus, weekday_trips, weekend_trips, schedule_json, updated_at) values (${sql(route.id)}, ${sql(route.from)}, ${sql(route.to)}, ${routeBucketCount(route, "weekday")}, ${routeBucketCount(route, "weekend")}, ${sql(JSON.stringify(route.schedules))}, ${sql(now)});`,
  );
}

lines.push(
  `insert into releases (id, version, status, snapshot_key, summary, created_at) values ('release_current_legacy', 'legacy-json', 'published', null, '当前用户端仍读取仓库内旧 JSON 和 SVG。', ${sql(now)});`,
);
lines.push(
  `insert into releases (id, version, status, snapshot_key, summary, created_at) values ('release_draft_admin_seed', 'v2026-05-28-draft', 'draft', null, '后台初始化导入三校区 SVG、旧 POI、Marker、Overlay 和校车时刻。', ${sql(now)});`,
);

if (unboundCount > 0) {
  lines.push(
    `insert into validation_issues (id, severity, title, detail, target, created_at) values ('issue_unbound_seed_pois', 'warning', 'POI 绑定待确认', ${sql(`${unboundCount} 个旧 POI 暂未在新版 SVG 中自动匹配到对象，需要在地图版本 Diff 中确认。`)}, 'poi_bindings', ${sql(now)});`,
  );
}
lines.push(
  `insert into validation_issues (id, severity, title, detail, target, created_at) values ('issue_r2_not_enabled', 'warning', 'R2 尚未启用', '媒体资源、SVG 原文件、发布快照和备份需要启用 R2 bucket 后才能持久化。', 'cloudflare_r2', ${sql(now)});`,
);
lines.push(
  `insert into logs (id, level, message, actor, meta_json, created_at) values ('log_seed_admin_data', 'audit', 'Seeded admin console with project data', 'seed-script', ${sql(JSON.stringify({ pois: rawBuildings.length + markerSeeds.length, shuttleRoutes: shuttleData.routes.length, overlays: overlaySeeds.length }))}, ${sql(now)});`,
);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${lines.join("\n")}\n`, "utf8");

console.log(`Wrote ${outFile}`);
console.log(`Map versions: ${campusFiles.length}`);
console.log(`POIs: ${rawBuildings.length + markerSeeds.length}`);
console.log(`Unbound old POIs: ${unboundCount}`);
console.log(`Shuttle routes: ${shuttleData.routes.length}`);
