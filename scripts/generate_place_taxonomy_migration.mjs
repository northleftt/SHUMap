#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseSvgFeatures, parseSvgViewBox } from "../shared/svg-geometry.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(fs.readFileSync(path.join(root, "data/campus-buildings.picked.json"), "utf8"));
const campusMapAssets = JSON.parse(fs.readFileSync(path.join(root, "data/campus-map-assets.json"), "utf8"));
const destination = path.join(root, "migrations-v2/0011_unified_place_taxonomy.sql");
const sourceDatabase = process.argv[2];
if (!sourceDatabase) {
  throw new Error("Usage: node scripts/generate_place_taxonomy_migration.mjs <source-d1.sqlite>");
}
if (!fs.existsSync(sourceDatabase)) throw new Error(`Source D1 database does not exist: ${sourceDatabase}`);

const CAMPUS_BY_NAME = new Map([
  ["宝山校区", { id: "campus_baoshan", key: "baoshan" }],
  ["嘉定校区", { id: "campus_jiading", key: "jiading" }],
  ["延长校区", { id: "campus_yanchang", key: "yanchang" }],
]);
const KIND_BY_CATEGORY = new Map([
  ["building", "building"],
  ["canteen", "canteen"],
  ["library", "library"],
  ["dorm", "residence"],
  ["other", "other"],
]);
const campus = (name) => {
  const value = CAMPUS_BY_NAME.get(name);
  if (!value) throw new Error(`Unsupported campus: ${name}`);
  return value;
};
const kind = (category) => {
  const value = KIND_BY_CATEGORY.get(category);
  if (!value) throw new Error(`Unsupported place category: ${category}`);
  return value;
};
const slug = (value) => value.normalize("NFKC").toLowerCase()
  .replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const q = (value) => value === null || value === undefined
  ? "null"
  : `'${String(value).replaceAll("'", "''")}'`;

const json = (value) => JSON.stringify(value);

// D1 enforces SQLITE_MAX_SQL_LENGTH per statement: 100000 bytes applies, 102400
// fails with SQLITE_TOOBIG. Wrangler splits this file into statements before
// sending them, so a single multi-row insert must stay under that limit. The
// budget below leaves room for the trigger bodies that wrangler's splitter may
// glue onto a neighbouring statement.
const MAX_INSERT_BYTES = 80_000;

// Emit one multi-row insert as consecutive statements batched by accumulated
// byte size, so adding rows or widening a column cannot silently reintroduce an
// unappliable statement. `header` ends with `values`, `trailer` carries any
// on-conflict clause; the semicolon belongs to this function.
function batchedInsert(header, tuples, trailer = "") {
  if (tuples.length === 0) throw new Error(`No rows to insert for: ${header}`);
  const overhead = Buffer.byteLength(`${header}\n${trailer};`, "utf8");
  const batches = [[]];
  let bytes = overhead;
  for (const tuple of tuples) {
    const size = Buffer.byteLength(`${tuple},\n`, "utf8");
    if (overhead + size > MAX_INSERT_BYTES) {
      throw new Error(`Single row exceeds the D1 statement budget: ${tuple.slice(0, 80)}`);
    }
    if (batches.at(-1).length > 0 && bytes + size > MAX_INSERT_BYTES) {
      batches.push([]);
      bytes = overhead;
    }
    batches.at(-1).push(tuple);
    bytes += size;
  }
  return batches.map((batch) => `${header}\n${batch.join(",\n")}${trailer};`).join("\n");
}

// A value tuple this large or larger is carried out of its insert and assembled
// from chunks instead, so one wide row cannot push a batch past the limit.
const MAX_ROW_BYTES = MAX_INSERT_BYTES / 2;

const fitsInOneStatement = (tuple) => Buffer.byteLength(tuple, "utf8") <= MAX_ROW_BYTES;

// Chunk width for assembled text. Each chunk becomes one statement of roughly
// this size plus a short prefix, so it stays well inside MAX_INSERT_BYTES.
// Splitting by code point keeps a surrogate pair from landing across a boundary.
const CHUNK_CHARS = 30_000;

function chunkText(value) {
  const characters = [...value];
  const chunks = [];
  for (let index = 0; index < characters.length; index += CHUNK_CHARS) {
    chunks.push(characters.slice(index, index + CHUNK_CHARS).join(""));
  }
  if (chunks.join("") !== value) throw new Error("Chunking did not preserve the source text");
  return chunks;
}

function canonicalPlaceContent(value, revisionId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Revision ${revisionId} content must be an object`);
  }
  const detail = value.detail;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    throw new Error(`Revision ${revisionId} detail must be an object`);
  }
  const canonicalDetail = { facts: [], media: [] };
  if (Object.hasOwn(detail, "facts")) {
    if (!Array.isArray(detail.facts)) throw new Error(`Revision ${revisionId} facts must be an array`);
    canonicalDetail.facts = detail.facts;
  }
  if (Object.hasOwn(detail, "media")) {
    if (!Array.isArray(detail.media)) throw new Error(`Revision ${revisionId} media must be an array`);
    canonicalDetail.media = detail.media;
  }
  if (typeof value.address !== "string" || !value.address.trim()) {
    throw new Error(`Revision ${revisionId} address must be a non-empty string`);
  }
  return { detail: canonicalDetail, address: value.address };
}

const mapFiles = campusMapAssets.map((entry) => {
  const bytes = fs.readFileSync(path.join(root, entry.sourcePath));
  if (bytes.byteLength !== entry.byteSize) {
    throw new Error(`${entry.sourcePath} byte size does not match data/campus-map-assets.json`);
  }
  if (hash(bytes) !== entry.sha256) {
    throw new Error(`${entry.sourcePath} checksum does not match data/campus-map-assets.json`);
  }
  const svg = bytes.toString("utf8");
  const features = parseSvgFeatures(svg);
  if (!features.length) throw new Error(`No SVG features found in ${entry.sourcePath}`);
  const viewBox = parseSvgViewBox(svg);
  return { ...entry, viewBox: [viewBox.x, viewBox.y, viewBox.width, viewBox.height], checksum: entry.sha256, features };
});

const recordByFeature = new Map();

const seenCodes = new Map();
const records = data.map((item, index) => {
  const targetCampus = campus(item.campus);
  const baseCode = slug(item.svgElementId || item.name) || `place-${index + 1}`;
  const duplicateKey = `${targetCampus.id}:${baseCode}`;
  const occurrence = (seenCodes.get(duplicateKey) ?? 0) + 1;
  seenCodes.set(duplicateKey, occurrence);
  const code = occurrence === 1 ? baseCode : `${baseCode}-${occurrence}`;
  return {
    placeId: `place_${targetCampus.key}_${code}`,
    stableCode: code,
    kindId: kind(item.category),
    campusId: targetCampus.id,
    campusKey: targetCampus.key,
    sourceElementId: item.svgElementId,
    displayName: item.name,
    navigation: item.navigation,
  };
});

if (records.length !== 121 || new Set(records.map((record) => record.placeId)).size !== 121) {
  throw new Error("Campus place mapping must contain 121 unique place ids");
}
if (new Set(records.map((record) => `${record.campusId}/${record.sourceElementId}`)).size !== 121) {
  throw new Error("Campus place mapping must contain 121 unique campus SVG ids");
}
for (const record of records) recordByFeature.set(`${record.campusKey}/${record.sourceElementId}`, record);

for (const mapFile of mapFiles) {
  const featureIds = new Set(mapFile.features.map((feature) => feature.sourceElementId));
  for (const record of records.filter((item) => item.campusKey === mapFile.key)) {
    if (!featureIds.has(record.sourceElementId)) {
      throw new Error(`${mapFile.sourcePath} has no feature ${record.sourceElementId}`);
    }
  }
}

const mappingValues = records.map((record) =>
  `  (${q(record.placeId)},${q(record.kindId)},${q(record.campusId)},${q(record.campusKey)},${q(record.sourceElementId)},${q(record.displayName)})`,
);

const assetRows = mapFiles.map((entry) => [
  `  ('media_campus_${entry.key}_svg','private',${q(entry.objectKey)},${q(path.basename(entry.sourcePath))},'image/svg+xml',${entry.byteSize},${q(entry.checksum)},'approved','source_campus_maps',datetime('now'),datetime('now'))`,
  `  ('map_asset_campus_${entry.key}','campus_svg','media_campus_${entry.key}_svg',${q(entry.checksum)},${q(JSON.stringify({ sourcePath: entry.sourcePath }))},datetime('now'))`,
  `  ('map_version_campus_${entry.key}','${entry.campusId}','map_asset_campus_${entry.key}','campus-source-v1','svg_viewbox',${q(JSON.stringify({ viewBox: entry.viewBox }))},'campus-svg-id-v1','published',datetime('now'))`,
]);

const featureRecords = mapFiles.flatMap((entry) => entry.features.map((feature, index) => {
  const place = recordByFeature.get(`${entry.key}/${feature.sourceElementId}`);
  const geometryJson = feature.geometry ? json(feature.geometry) : null;
  const bboxJson = feature.bbox ? json(feature.bbox) : null;
  const stableKey = place ? `place:${place.placeId}` : `svg:${entry.key}:${feature.sourceElementId}`;
  const featureKind = place ? "building_footprint" : "other";
  const label = place?.displayName ?? feature.label;
  const metadata = {
    sourceOrder: index,
    ...(place ? { placeId: place.placeId } : {}),
    ...(feature.approximated ? { geometryApproximation: "curve_endpoints" } : {}),
  };
  return {
    id: `map_feature_${entry.key}_${feature.sourceElementId}`,
    mapVersionId: `map_version_campus_${entry.key}`,
    stableFeatureKey: stableKey,
    sourceElementId: feature.sourceElementId,
    featureKind,
    geometryJson,
    bboxJson,
    shapeHash: geometryJson ? hash(geometryJson) : null,
    label,
    metadataJson: json(metadata),
  };
}));

const featureTuple = (record) =>
  `  (${q(record.id)},${q(record.mapVersionId)},${q(record.stableFeatureKey)},${q(record.sourceElementId)},${q(record.featureKind)},${q(record.geometryJson)},${q(record.bboxJson)},${q(record.shapeHash)},${q(record.label)},${q(record.metadataJson)})`;

if (new Set(featureRecords.map(featureTuple)).size !== featureRecords.length) {
  throw new Error("Generated campus map features must be unique");
}

const FEATURE_COLUMNS = `insert into map_features(
  id,map_version_id,stable_feature_key,source_element_id,feature_kind,
  geometry_json,bbox_json,shape_hash,label,metadata_json
)`;
const FEATURE_CONFLICT = `
on conflict(id) do update set
  map_version_id=excluded.map_version_id,
  stable_feature_key=excluded.stable_feature_key,
  source_element_id=excluded.source_element_id,
  feature_kind=excluded.feature_kind,geometry_json=excluded.geometry_json,
  bbox_json=excluded.bbox_json,shape_hash=excluded.shape_hash,label=excluded.label,
  metadata_json=excluded.metadata_json`;

// The Baoshan campus outline holds more geometry text than one D1 statement can
// carry, so no batch size can ship it as a value tuple. Those rows travel as
// ordered chunks appended in a staging table instead.
const featureRows = featureRecords.filter((record) => fitsInOneStatement(featureTuple(record))).map(featureTuple);
const stagedFeatures = featureRecords.filter((record) => !fitsInOneStatement(featureTuple(record)));
for (const record of stagedFeatures) {
  if (!record.geometryJson) throw new Error(`Oversized feature ${record.id} has no geometry to chunk`);
  if (!fitsInOneStatement(featureTuple({ ...record, geometryJson: "" }))) {
    throw new Error(`Feature ${record.id} is too large even without its geometry`);
  }
}

// map_features.geometry_json is guarded by check(json_valid(...)), so a partial
// value cannot be appended in place. Chunks accumulate in a staging table and
// only the assembled value is inserted, where that existing check hard-fails the
// migration if any chunk went missing rather than storing broken geometry.
const stagedFeatureSql = stagedFeatures.length === 0 ? "" : `
-- The campus outline feature holds more geometry text than one D1 statement can
-- carry, so it is appended chunk by chunk before it is stored.
create table map_feature_geometry_assembly (
  feature_id text primary key,
  geometry_json text not null
);
${stagedFeatures.map((record) => {
  const [head, ...rest] = chunkText(record.geometryJson);
  return [
    `insert into map_feature_geometry_assembly(feature_id,geometry_json) values\n  (${q(record.id)},${q(head)});`,
    ...rest.map((chunk) =>
      `update map_feature_geometry_assembly set geometry_json=geometry_json||${q(chunk)}\n where feature_id=${q(record.id)};`),
    `${FEATURE_COLUMNS}
select ${q(record.id)},${q(record.mapVersionId)},${q(record.stableFeatureKey)},${q(record.sourceElementId)},${q(record.featureKind)},
       a.geometry_json,${q(record.bboxJson)},${q(record.shapeHash)},${q(record.label)},${q(record.metadataJson)}
  from map_feature_geometry_assembly a
 where a.feature_id=${q(record.id)}${FEATURE_CONFLICT};`,
  ].join("\n");
}).join("\n")}
drop table map_feature_geometry_assembly;
`;

const revisionUpdates = [];
const db = new DatabaseSync(sourceDatabase, { readOnly: true });
try {
  const aliasRows = db.prepare("select place_id as placeId,name from place_names where name_type='alias' order by place_id,name").all();
  const aliasesByPlace = new Map();
  for (const row of aliasRows) aliasesByPlace.set(row.placeId, [...(aliasesByPlace.get(row.placeId) ?? []), row.name]);
  const rows = db.prepare(
    `select r.id,r.place_id as placeId,r.display_name as displayName,r.summary,r.description,r.content_json as contentJson,
            p.parent_place_id as parentPlaceId,
            b.building_code as buildingCode,b.managing_organization_id as managingOrganizationId,
            b.public_access_level as publicAccessLevel
       from place_revisions r join places p on p.id=r.place_id
       left join buildings b on b.place_id=p.id order by r.place_id,r.revision_no`,
  ).all();
  if (rows.length !== 122) throw new Error(`Source D1 must contain 122 place revisions; found ${rows.length}`);
  for (const row of rows) {
    const record = records.find((item) => item.placeId === row.placeId);
    if (!record) throw new Error(`Revision ${row.id} belongs to an unmapped place ${row.placeId}`);
    const contentJson = json(canonicalPlaceContent(JSON.parse(row.contentJson), row.id));
    const navigation = record.navigation;
    if (!Number.isFinite(navigation?.longitude) || !Number.isFinite(navigation?.latitude) || typeof navigation.coordSystem !== "string") {
      throw new Error(`Place ${record.placeId} has no canonical navigation point`);
    }
    const structureJson = json({
      kindId: record.kindId,
      campusId: record.campusId,
      parentPlaceId: row.parentPlaceId ?? null,
      stableCode: record.stableCode,
      aliases: aliasesByPlace.get(row.placeId) ?? [],
      building: {
        buildingCode: row.buildingCode ?? record.stableCode,
        managingOrganizationId: row.managingOrganizationId ?? null,
        publicAccessLevel: row.publicAccessLevel ?? "unknown",
      },
      locations: [
        {
          campusId: record.campusId,
          buildingPlaceId: record.placeId,
          role: "navigation_target",
          geometryType: "Point",
          geometry: { type: "Point", coordinates: [navigation.longitude, navigation.latitude] },
          crs: navigation.coordSystem.toUpperCase(),
          locationHint: navigation.address ?? null,
          precisionLevel: "exact",
          sourceId: "source_campus_maps",
          isPrimary: true,
        },
        {
          campusId: record.campusId,
          buildingPlaceId: record.placeId,
          role: "footprint",
          geometryType: mapFiles
            .find((mapFile) => mapFile.key === record.campusKey)
            .features.find((feature) => feature.sourceElementId === record.sourceElementId).geometry.type,
          mapVersionId: `map_version_campus_${record.campusKey}`,
          mapFeatureId: `map_feature_${record.campusKey}_${record.sourceElementId}`,
          precisionLevel: "exact",
          sourceId: "source_campus_maps",
          isPrimary: false,
        },
      ],
    });
    const contentHash = hash(`${row.displayName}\n${row.summary ?? ""}\n${row.description ?? ""}\n${contentJson}\n${structureJson}`);
    revisionUpdates.push(`  (${q(row.id)},${q(contentJson)},${q(structureJson)},${q(contentHash)})`);
  }
} finally {
  db.close();
}

const sql = `-- Generated by scripts/generate_place_taxonomy_migration.mjs.
pragma foreign_keys = on;

-- The input mapping is explicit so an applied database does not infer a
-- classification or SVG relationship from mutable names or JSON content.
create table place_import_map (
  place_id text primary key,
  kind_id text not null,
  campus_id text not null,
  campus_key text not null,
  source_element_id text not null,
  display_name text not null,
  unique(campus_id, source_element_id)
);
${batchedInsert(
  "insert into place_import_map(place_id,kind_id,campus_id,campus_key,source_element_id,display_name) values",
  mappingValues,
)}

insert into place_kinds(id,name,sort_order,is_searchable) values
  ('canteen','食堂',25,1),
  ('library','图书馆',35,1);

-- Normalize the canonical source id by its stable title, then move every
-- foreign-key reference before removing the superseded row.
insert or ignore into data_sources(
  id,source_type,title,url,license,obtained_at,reliability,metadata_json,created_at
)
select 'source_campus_maps',source_type,'校园地图地点与导航坐标',url,license,obtained_at,
       reliability,'{"source":"data/campus-buildings.picked.json"}',created_at
  from data_sources
 where title='现有校园建筑与导航坐标';
insert or ignore into data_sources(
  id,source_type,title,url,reliability,metadata_json,created_at
) values (
  'source_campus_maps','import','校园地图地点与导航坐标',null,'reviewed',
  '{"source":"data/campus-buildings.picked.json"}',datetime('now')
);
update media_assets set source_id='source_campus_maps'
 where source_id in (select id from data_sources where title='现有校园建筑与导航坐标');
update place_revisions set source_id='source_campus_maps'
 where source_id in (select id from data_sources where title='现有校园建筑与导航坐标');
update location_anchors set source_id='source_campus_maps'
 where source_id in (select id from data_sources where title='现有校园建筑与导航坐标');
update facility_revisions set source_id='source_campus_maps'
 where source_id in (select id from data_sources where title='现有校园建筑与导航坐标');
update merchant_revisions set source_id='source_campus_maps'
 where source_id in (select id from data_sources where title='现有校园建筑与导航坐标');
update operational_events set source_id='source_campus_maps'
 where source_id in (select id from data_sources where title='现有校园建筑与导航坐标');
update service_calendars set source_id='source_academic_calendar'
 where source_id in (select id from data_sources where title='现有校园建筑与导航坐标');
update transit_trips set source_id='source_shuttle_pdf'
 where source_id in (select id from data_sources where title='现有校园建筑与导航坐标');
update transit_alerts set source_id='source_campus_maps'
 where source_id in (select id from data_sources where title='现有校园建筑与导航坐标');
delete from data_sources
 where title='现有校园建筑与导航坐标' and id<>'source_campus_maps';

update places
   set kind_id=(select m.kind_id from place_import_map m where m.place_id=places.id)
 where id in (select place_id from place_import_map);

-- Every imported campus place has a building row because every one has a
-- footprint and can host floors, facilities, merchants, and services.
insert into buildings(place_id,building_code,public_access_level)
select m.place_id,p.stable_code,'unknown'
  from place_import_map m join places p on p.id=m.place_id
 where true
on conflict(place_id) do update set building_code=excluded.building_code;

create table place_revision_migration (
  revision_id text primary key,
  content_json text not null check (json_valid(content_json)),
  structure_json text not null check (json_valid(structure_json)),
  content_hash text not null
);
${batchedInsert(
  "insert into place_revision_migration(revision_id,content_json,structure_json,content_hash) values",
  revisionUpdates,
)}
update place_revisions
   set content_json=(select m.content_json from place_revision_migration m where m.revision_id=place_revisions.id),
       structure_json=(select m.structure_json from place_revision_migration m where m.revision_id=place_revisions.id),
       content_hash=(select m.content_hash from place_revision_migration m where m.revision_id=place_revisions.id)
 where id in (select revision_id from place_revision_migration);
drop table place_revision_migration;

-- Rebuild the chip system in both database histories: fresh 0009 and the
-- previously applied transition definition converge here.
drop index if exists idx_map_filter_categories_active;
drop table if exists map_filter_categories;
create table map_filter_categories (
  id text primary key,
  key text not null unique,
  label text not null,
  active integer not null default 1 check (active in (0,1)),
  sort_order integer not null default 100,
  created_at text not null,
  updated_at text not null
);
create index idx_map_filter_categories_active
  on map_filter_categories(active,sort_order,label);

create table map_filter_members (
  id text primary key,
  category_id text not null references map_filter_categories(id) on delete restrict,
  place_kind_id text references place_kinds(id) on delete restrict,
  facility_type_id text references facility_types(id) on delete restrict,
  includes_merchants integer not null default 0 check (includes_merchants in (0,1)),
  sort_order integer not null default 100,
  created_at text not null,
  check (
    (place_kind_id is not null) +
    (facility_type_id is not null) +
    includes_merchants = 1
  )
);
create index idx_map_filter_members_category
  on map_filter_members(category_id,sort_order,id);
create unique index idx_map_filter_members_place_kind
  on map_filter_members(place_kind_id) where place_kind_id is not null;
create unique index idx_map_filter_members_facility_type
  on map_filter_members(facility_type_id) where facility_type_id is not null;
create unique index idx_map_filter_members_merchants
  on map_filter_members(includes_merchants) where includes_merchants=1;

insert into map_filter_categories(id,key,label,active,sort_order,created_at,updated_at) values
  ('map_filter_teaching','teaching','教学楼',1,10,datetime('now'),datetime('now')),
  ('map_filter_library','library','图书馆',1,20,datetime('now'),datetime('now')),
  ('map_filter_dorm','dorm','宿舍楼',1,30,datetime('now'),datetime('now')),
  ('map_filter_canteen','canteen','食堂',1,40,datetime('now'),datetime('now')),
  ('map_filter_commercial','commercial','商业',1,50,datetime('now'),datetime('now')),
  ('map_filter_printing','printing','打印机',1,60,datetime('now'),datetime('now')),
  ('map_filter_charging','charging','充电桩',1,70,datetime('now'),datetime('now')),
  ('map_filter_power_bank','powerBank','充电宝',1,80,datetime('now'),datetime('now')),
  ('map_filter_outdoor','outdoorArea','室外区域',0,110,datetime('now'),datetime('now')),
  ('map_filter_service_place','servicePlace','服务地点',0,120,datetime('now'),datetime('now')),
  ('map_filter_transit','transitStop','交通站点',0,130,datetime('now'),datetime('now')),
  ('map_filter_sports','sportsVenue','运动场馆',0,140,datetime('now'),datetime('now')),
  ('map_filter_other','other','其他',1,150,datetime('now'),datetime('now')),
  ('map_filter_study_area','studyArea','自习区域',1,210,datetime('now'),datetime('now')),
  ('map_filter_restroom','restroom','卫生间',1,220,datetime('now'),datetime('now')),
  ('map_filter_drinking_water','drinkingWater','饮水点',1,230,datetime('now'),datetime('now')),
  ('map_filter_elevator','elevator','电梯',1,240,datetime('now'),datetime('now')),
  ('map_filter_vending','vendingMachine','自动售货机',1,250,datetime('now'),datetime('now')),
  ('map_filter_service_center','serviceCenter','一站式服务中心',1,260,datetime('now'),datetime('now'));

insert into map_filter_members(
  id,category_id,place_kind_id,facility_type_id,includes_merchants,sort_order,created_at
) values
  ('map_filter_member_teaching','map_filter_teaching','building',null,0,10,datetime('now')),
  ('map_filter_member_library','map_filter_library','library',null,0,10,datetime('now')),
  ('map_filter_member_dorm','map_filter_dorm','residence',null,0,10,datetime('now')),
  ('map_filter_member_canteen','map_filter_canteen','canteen',null,0,10,datetime('now')),
  ('map_filter_member_commercial','map_filter_commercial',null,null,1,10,datetime('now')),
  ('map_filter_member_printing','map_filter_printing',null,'facility_type_printer',0,10,datetime('now')),
  ('map_filter_member_charging','map_filter_charging',null,'facility_type_charging',0,10,datetime('now')),
  ('map_filter_member_power_bank','map_filter_power_bank',null,'facility_type_power_bank',0,10,datetime('now')),
  ('map_filter_member_outdoor','map_filter_outdoor','outdoor_area',null,0,10,datetime('now')),
  ('map_filter_member_service_place','map_filter_service_place','service_place',null,0,10,datetime('now')),
  ('map_filter_member_transit','map_filter_transit','transit_stop',null,0,10,datetime('now')),
  ('map_filter_member_sports','map_filter_sports','sports_venue',null,0,10,datetime('now')),
  ('map_filter_member_other','map_filter_other','other',null,0,10,datetime('now')),
  ('map_filter_member_study_area','map_filter_study_area',null,'facility_type_study_area',0,10,datetime('now')),
  ('map_filter_member_restroom','map_filter_restroom',null,'facility_type_restroom',0,10,datetime('now')),
  ('map_filter_member_drinking_water','map_filter_drinking_water',null,'facility_type_drinking_water',0,10,datetime('now')),
  ('map_filter_member_elevator','map_filter_elevator',null,'facility_type_elevator',0,10,datetime('now')),
  ('map_filter_member_vending','map_filter_vending',null,'facility_type_vending',0,10,datetime('now')),
  ('map_filter_member_service_center','map_filter_service_center',null,'facility_type_service_center',0,10,datetime('now'));

-- Expand the location geometry contract before importing SVG footprints.
-- Direct dependents are emptied and restored so no ON DELETE action can alter
-- their rows while SQLite replaces the constrained column.
create table location_anchor_geometry_migration as
select * from location_anchors;
create table entity_location_geometry_migration as
select * from entity_locations;
create table transit_pattern_anchor_geometry_migration as
select id,route_anchor_id from transit_patterns where route_anchor_id is not null;

delete from entity_locations;
update transit_patterns set route_anchor_id=null where route_anchor_id is not null;
delete from location_anchors;

alter table location_anchors add column geometry_type_v2 text not null
  check (geometry_type_v2 in ('Point','LineString','Polygon','MultiPolygon'));
alter table location_anchors drop column geometry_type;
alter table location_anchors rename column geometry_type_v2 to geometry_type;

insert into location_anchors(
  id,campus_id,building_place_id,floor_id,indoor_space_id,role,geometry_type,
  geometry_json,crs,map_version_id,map_feature_id,location_hint,precision_level,
  accuracy_meters,source_id,verification_status,verified_by,verified_at,valid_from,
  valid_to,created_at,updated_at
)
select id,campus_id,building_place_id,floor_id,indoor_space_id,role,geometry_type,
       geometry_json,crs,map_version_id,map_feature_id,location_hint,precision_level,
       accuracy_meters,source_id,verification_status,verified_by,verified_at,valid_from,
       valid_to,created_at,updated_at
  from location_anchor_geometry_migration;
insert into entity_locations(
  id,entity_type,entity_id,anchor_id,role,is_primary,valid_from,valid_to,created_at
)
select id,entity_type,entity_id,anchor_id,role,is_primary,valid_from,valid_to,created_at
  from entity_location_geometry_migration;
update transit_patterns
   set route_anchor_id=(
     select saved.route_anchor_id
       from transit_pattern_anchor_geometry_migration saved
      where saved.id=transit_patterns.id
   )
 where id in (select id from transit_pattern_anchor_geometry_migration);

drop table transit_pattern_anchor_geometry_migration;
drop table entity_location_geometry_migration;
drop table location_anchor_geometry_migration;

-- A referenced feature and version must belong to the same imported map.
-- BEGIN/END are uppercase because wrangler's statement splitter opens a compound
-- statement case-insensitively but closes it only on uppercase END. The guard is
-- a WHERE clause rather than a CASE because D1's server-side splitter tracks
-- BEGIN/END but not CASE: a CASE's own END; closes the trigger body early and the
-- remote apply fails with "incomplete input".
create trigger validate_anchor_map_feature_insert
before insert on location_anchors
when new.map_feature_id is not null
BEGIN
  select raise(abort,'anchor map feature must belong to its map version')
    WHERE not exists (
    select 1 from map_features f
     where f.id=new.map_feature_id and f.map_version_id=new.map_version_id
  );
END;
create trigger validate_anchor_map_feature_update
before update of map_feature_id,map_version_id on location_anchors
when new.map_feature_id is not null
BEGIN
  select raise(abort,'anchor map feature must belong to its map version')
    WHERE not exists (
    select 1 from map_features f
     where f.id=new.map_feature_id and f.map_version_id=new.map_version_id
  );
END;

insert into media_assets(
  id,bucket_scope,object_key,original_name,content_type,byte_size,sha256,status,
  source_id,created_at,approved_at
) values
${assetRows.map((entry) => entry[0]).join(",\n")}
on conflict(id) do update set
  object_key=excluded.object_key,original_name=excluded.original_name,
  content_type=excluded.content_type,byte_size=excluded.byte_size,
  sha256=excluded.sha256,status=excluded.status,source_id=excluded.source_id,
  approved_at=excluded.approved_at;

insert into map_assets(id,asset_type,media_asset_id,checksum,metadata_json,created_at) values
${assetRows.map((entry) => entry[1]).join(",\n")}
on conflict(id) do update set
  media_asset_id=excluded.media_asset_id,checksum=excluded.checksum,
  metadata_json=excluded.metadata_json;

insert into map_versions(
  id,campus_id,map_asset_id,version_label,coordinate_space_type,
  coordinate_space_json,parser_version,lifecycle_status,created_at
) values
${assetRows.map((entry) => entry[2]).join(",\n")}
on conflict(id) do update set
  campus_id=excluded.campus_id,map_asset_id=excluded.map_asset_id,
  version_label=excluded.version_label,
  coordinate_space_type=excluded.coordinate_space_type,
  coordinate_space_json=excluded.coordinate_space_json,
  parser_version=excluded.parser_version,lifecycle_status=excluded.lifecycle_status;

${batchedInsert(`${FEATURE_COLUMNS} values`, featureRows, FEATURE_CONFLICT)}
${stagedFeatureSql}

-- Existing navigation anchors predate the buildings rows for several kinds.
-- Their owning place now supplies the structural building relationship.
update location_anchors
   set building_place_id=(
     select el.entity_id from entity_locations el
      where el.anchor_id=location_anchors.id and el.entity_type='place'
      order by el.created_at,el.id limit 1
   )
 where building_place_id is null
   and exists (
     select 1 from entity_locations el join buildings b on b.place_id=el.entity_id
      where el.anchor_id=location_anchors.id and el.entity_type='place'
   );

insert into location_anchors(
  id,campus_id,building_place_id,role,geometry_type,map_version_id,map_feature_id,
  precision_level,source_id,verification_status,verified_at,created_at,updated_at
)
select 'anchor_footprint_'||m.campus_key||'_'||m.source_element_id,
       m.campus_id,m.place_id,'footprint',(
         select json_extract(f.geometry_json,'$.type') from map_features f
          where f.id='map_feature_'||m.campus_key||'_'||m.source_element_id
       ),
       'map_version_campus_'||m.campus_key,
       'map_feature_'||m.campus_key||'_'||m.source_element_id,
       'exact','source_campus_maps','verified',datetime('now'),datetime('now'),datetime('now')
  from place_import_map m
  join buildings b on b.place_id=m.place_id
 where true
on conflict(id) do update set
  campus_id=excluded.campus_id,building_place_id=excluded.building_place_id,
  role=excluded.role,geometry_type=excluded.geometry_type,
  map_version_id=excluded.map_version_id,map_feature_id=excluded.map_feature_id,
  precision_level=excluded.precision_level,source_id=excluded.source_id,
  verification_status=excluded.verification_status,verified_at=excluded.verified_at,
  updated_at=excluded.updated_at;

insert into entity_locations(
  id,entity_type,entity_id,anchor_id,role,is_primary,created_at
)
select 'entity_location_footprint_'||m.campus_key||'_'||m.source_element_id,
       'place',m.place_id,
       'anchor_footprint_'||m.campus_key||'_'||m.source_element_id,
       'footprint',0,datetime('now')
  from place_import_map m
  join buildings b on b.place_id=m.place_id
 where true
on conflict(id) do update set
  entity_type=excluded.entity_type,entity_id=excluded.entity_id,
  anchor_id=excluded.anchor_id,role=excluded.role,is_primary=excluded.is_primary;

drop table place_import_map;
`;

fs.writeFileSync(destination, sql, "utf8");
console.log(`Wrote ${path.relative(root, destination)} with ${records.length} explicit place mappings`);
