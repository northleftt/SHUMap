import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys = on;");
  for (const name of fs.readdirSync(path.join(root, "migrations-v2")).filter((value) => value.endsWith(".sql")).sort()) {
    db.exec(fs.readFileSync(path.join(root, "migrations-v2", name), "utf8"));
  }
  return db;
}

function navigationAnchor(db, overrides = {}) {
  const row = {
    id: "anchor_navigation_test",
    role: "navigation_target",
    geometryType: "Point",
    geometryJson: '{"type":"Point","coordinates":[121.4,31.3]}',
    crs: "GCJ02",
    ...overrides,
  };
  db.prepare(
    `insert into location_anchors(
       id,campus_id,role,geometry_type,geometry_json,crs,precision_level,
       verification_status,created_at,updated_at
     ) values(?,'campus_baoshan',?,?,?,?, 'exact','verified',datetime('now'),datetime('now'))`,
  ).run(row.id, row.role, row.geometryType, row.geometryJson, row.crs);
  return row.id;
}

function footprintAnchor(db, id, mapFeatureId = null, placeId = "place_test") {
  db.exec(`
    insert or ignore into places(
      id,kind_id,campus_id,lifecycle_status,created_at,updated_at
    ) values(
      '${placeId}','building','campus_baoshan','planned',datetime('now'),datetime('now')
    );
    insert or ignore into buildings(place_id,public_access_level)
    values('${placeId}','unknown');
  `);
  if (mapFeatureId) {
    db.prepare(
      `insert or ignore into map_features(
         id,map_version_id,source_element_id,feature_kind,geometry_json,metadata_json
       ) values(?,'map_version_campus_baoshan',?,'building_footprint',
         '{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}','{}')`,
    ).run(mapFeatureId, mapFeatureId);
  }
  db.prepare(
    `insert into location_anchors(
       id,campus_id,building_place_id,role,geometry_type,geometry_json,crs,map_version_id,map_feature_id,precision_level,
       verification_status,created_at,updated_at
     ) values(?,'campus_baoshan',?,'footprint','Polygon',null,null,?,?,
       'exact','verified',datetime('now'),datetime('now'))`,
  ).run(id, placeId, mapFeatureId ? "map_version_campus_baoshan" : null, mapFeatureId);
  return id;
}

test("navigation anchors require an in-range GCJ02 Point", () => {
  for (const overrides of [
    { geometryType: "LineString", geometryJson: '{"type":"LineString","coordinates":[[121.4,31.3],[121.5,31.4]]}' },
    { geometryJson: '{"type":"Point","coordinates":[181,31.3]}' },
    { geometryJson: '{"type":"Point","coordinates":[121.4,91]}' },
    { crs: "EPSG:4326" },
  ]) {
    const db = database();
    assert.throws(() => navigationAnchor(db, overrides), /navigation target must be a valid GCJ02 Point/);
    db.close();
  }

  const db = database();
  navigationAnchor(db);
  assert.equal(db.prepare("select crs from location_anchors where id='anchor_navigation_test'").get().crs, "GCJ02");
  db.close();
});

test("one entity has one active navigation target", () => {
  const db = database();
  const firstId = navigationAnchor(db, { id: "anchor_navigation_first" });
  const secondId = navigationAnchor(db, { id: "anchor_navigation_second" });
  db.prepare(
    `insert into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,created_at)
     values('binding_navigation_first','place','place_test',?,'navigation_target',1,datetime('now'))`,
  ).run(firstId);
  assert.throws(
    () => db.prepare(
      `insert into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,created_at)
       values('binding_navigation_second','place','place_test',?,'navigation_target',0,datetime('now'))`,
    ).run(secondId),
    /UNIQUE constraint failed/,
  );
  db.close();
});

test("retired primary locations do not block a new primary", () => {
  const db = database();
  const firstId = navigationAnchor(db, { id: "anchor_primary_retired" });
  const secondId = navigationAnchor(db, { id: "anchor_primary_active" });
  db.prepare(
    `insert into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,valid_to,created_at)
     values('binding_primary_retired','place','place_test',?,'navigation_target',1,datetime('now'),datetime('now'))`,
  ).run(firstId);
  db.prepare(
    `insert into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,created_at)
     values('binding_primary_active','place','place_test',?,'navigation_target',1,datetime('now'))`,
  ).run(secondId);
  assert.equal(
    db.prepare("select count(*) as count from entity_locations where entity_id='place_test' and is_primary=1").get().count,
    2,
  );
  db.close();
});

test("anchor role updates preserve binding agreement", () => {
  const db = database();
  const anchorId = navigationAnchor(db);
  db.prepare(
    `insert into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,created_at)
     values('binding_navigation_test','place','place_test',?,'navigation_target',1,datetime('now'))`,
  ).run(anchorId);
  assert.throws(
    () => db.prepare("update location_anchors set role='centroid' where id=?").run(anchorId),
    /anchor role must match every entity location binding/,
  );
  db.close();
});

test("one map feature belongs to one active building footprint", () => {
  const db = database();
  const featureId = "feature_shared_footprint";
  const firstAnchor = footprintAnchor(db, "anchor_feature_first", featureId, "place_first");
  const secondAnchor = footprintAnchor(db, "anchor_feature_second", featureId, "place_second");
  db.prepare(
    `insert into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,created_at)
     values('binding_feature_first','place','place_first',?,'footprint',0,datetime('now'))`,
  ).run(firstAnchor);
  assert.throws(
    () => db.prepare(
      `insert into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,created_at)
       values('binding_feature_second','place','place_second',?,'footprint',0,datetime('now'))`,
    ).run(secondAnchor),
    /map feature already has an active footprint binding/,
  );
  db.close();
});

test("footprint bindings must use their anchor building", () => {
  const db = database();
  db.prepare(
    `insert into places(id,kind_id,campus_id,lifecycle_status,created_at,updated_at)
     values('place_other','building','campus_baoshan','planned',datetime('now'),datetime('now'))`,
  ).run();
  db.prepare("insert into buildings(place_id,public_access_level) values('place_other','unknown')").run();
  const anchorId = footprintAnchor(db, "anchor_owned", "feature_owned");
  assert.throws(
    () => db.prepare(
      `insert into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,created_at)
       values('binding_wrong_owner','place','place_other',?,'footprint',0,datetime('now'))`,
    ).run(anchorId),
    /footprint binding must belong to its anchor building/,
  );
  db.close();
});

test("footprint anchors require canonical campus building features", () => {
  const db = database();
  db.prepare(
    `insert into map_features(
       id,map_version_id,source_element_id,feature_kind,geometry_json,metadata_json
     ) values('feature_other','map_version_campus_baoshan','other','other',
       '{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}','{}')`,
  ).run();
  assert.throws(
    () => db.prepare(
      `insert into location_anchors(
         id,campus_id,building_place_id,role,geometry_type,map_version_id,map_feature_id,
         precision_level,verification_status,created_at,updated_at
       ) values(
         'anchor_invalid_feature','campus_baoshan','place_test','footprint','Polygon',
         'map_version_campus_baoshan','feature_other','exact','verified',datetime('now'),datetime('now')
       )`,
    ).run(),
    /footprint anchor must reference a canonical campus building feature/,
  );

  const anchorId = footprintAnchor(db, "anchor_canonical", "feature_canonical");
  assert.equal(db.prepare("select map_feature_id from location_anchors where id=?").get(anchorId).map_feature_id, "feature_canonical");
  db.prepare(
    `insert into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,created_at)
     values('binding_canonical','place','place_test',?,'footprint',0,datetime('now'))`,
  ).run(anchorId);
  assert.throws(
    () => db.prepare("update map_features set feature_kind='other' where id='feature_canonical'").run(),
    /active footprint feature must preserve its canonical contract/,
  );
  db.close();
});

test("one entity has one active footprint and binding roles match anchors", () => {
  const db = database();
  const anchorId = navigationAnchor(db);
  db.prepare(
    `insert into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,created_at)
     values('binding_navigation_test','place','place_test',?,'navigation_target',1,datetime('now'))`,
  ).run(anchorId);

  const firstFootprintId = footprintAnchor(db, "anchor_footprint_first", "feature_footprint_first");
  const secondFootprintId = footprintAnchor(db, "anchor_footprint_second", "feature_footprint_second");
  db.prepare(
    `insert into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,created_at)
     values('binding_footprint_first','place','place_test',?,'footprint',0,datetime('now'))`,
  ).run(firstFootprintId);
  assert.throws(
    () => db.prepare(
      `insert into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,created_at)
       values('binding_footprint_second','place','place_test',?,'footprint',0,datetime('now'))`,
    ).run(secondFootprintId),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () => db.prepare(
      `insert into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,created_at)
       values('binding_role_mismatch','place','place_other',?,'footprint',0,datetime('now'))`,
    ).run(anchorId),
    /footprint binding must belong to its anchor building|entity location role must match anchor role/,
  );
  db.close();
});
