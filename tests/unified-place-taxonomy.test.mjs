import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(root, "migrations-v2");

function migrationNames() {
  return fs.readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql")).sort();
}

function applyMigrations(db, predicate = () => true) {
  for (const name of migrationNames().filter(predicate)) {
    db.exec(fs.readFileSync(path.join(migrationDirectory, name), "utf8"));
  }
}

function databaseThrough(lastMigration) {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys = on;");
  applyMigrations(db, (name) => name <= lastMigration);
  return db;
}

function scalar(db, sql, ...params) {
  return db.prepare(sql).get(...params).value;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function seedSql() {
  return execFileSync(process.execPath, ["scripts/generate_v2_seed.mjs"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
}

function tableCounts(db) {
  const names = db.prepare(
    "select name from sqlite_schema where type='table' and name not like 'sqlite_%' order by name",
  ).all().map((row) => row.name);
  return Object.fromEntries(names.map((name) => {
    const quoted = `"${name.replaceAll('"', '""')}"`;
    return [name, scalar(db, `select count(*) as value from ${quoted}`)];
  }));
}

test("fresh v2 data forms one canonical place, chip, and SVG feature system", () => {
  const db = databaseThrough("0011_unified_place_taxonomy.sql");
  const sql = seedSql();
  db.exec(sql);

  assert.equal(scalar(db, "select count(*) as value from places"), 121);
  assert.equal(scalar(db, "select count(*) as value from buildings"), 121);
  assert.equal(scalar(db, "select count(*) as value from map_features"), 125);
  assert.equal(scalar(
    db,
    `select count(*) as value
       from places p join place_revisions r on r.id=p.current_revision_id
      where r.place_id=p.id and r.editorial_status='approved'`,
  ), 121);

  const kindCounts = Object.fromEntries(db.prepare(
    "select kind_id as kindId,count(*) as count from places group by kind_id order by kind_id",
  ).all().map((row) => [row.kindId, row.count]));
  assert.deepEqual(kindCounts, {
    building: 66,
    canteen: 7,
    library: 4,
    other: 7,
    residence: 37,
  });

  assert.equal(scalar(
    db,
    `select count(*) as value
       from entity_locations el
       join location_anchors la on la.id=el.anchor_id
       join map_features mf on mf.id=la.map_feature_id and mf.map_version_id=la.map_version_id
       join buildings b on b.place_id=el.entity_id and b.place_id=la.building_place_id
      where el.entity_type='place' and el.role='footprint' and el.valid_to is null
        and la.role='footprint' and la.valid_to is null and mf.feature_kind='building_footprint'`,
  ), 121);

  const revisions = db.prepare(
    `select r.id,r.display_name as displayName,r.summary,r.description,
            r.content_json as contentJson,r.structure_json as structureJson,
            r.content_hash as contentHash,p.kind_id as kindId,p.campus_id as campusId
       from places p join place_revisions r on r.id=p.current_revision_id
      order by p.id`,
  ).all();
  assert.equal(revisions.length, 121);
  for (const row of revisions) {
    const content = JSON.parse(row.contentJson);
    assert.deepEqual(Object.keys(content).sort(), ["address", "detail"], `${row.id} content keys`);
    assert.equal(typeof content.address, "string", `${row.id} address type`);
    assert.ok(content.address.trim(), `${row.id} address value`);
    assert.equal(Array.isArray(content.detail), false, `${row.id} detail object`);
    assert.equal(typeof content.detail, "object", `${row.id} detail object`);
    for (const [key, value] of Object.entries(content.detail)) {
      assert.ok(["facts", "media"].includes(key), `${row.id} unsupported detail field ${key}`);
      assert.ok(Array.isArray(value), `${row.id} detail.${key}`);
    }

    const structure = JSON.parse(row.structureJson);
    assert.deepEqual(
      Object.keys(structure).sort(),
      ["aliases", "building", "campusId", "kindId", "locations", "parentPlaceId", "stableCode"],
      `${row.id} structure keys`,
    );
    assert.equal(structure.kindId, row.kindId, `${row.id} structure kind`);
    assert.equal(structure.campusId, row.campusId, `${row.id} structure campus`);
    assert.ok(structure.locations.some((location) => location.role === "footprint" && location.mapFeatureId), `${row.id} footprint`);

    const expectedHash = sha256(
      `${row.displayName}\n${row.summary ?? ""}\n${row.description ?? ""}\n${row.contentJson}\n${row.structureJson}`,
    );
    assert.equal(row.contentHash, expectedHash, `${row.id} content hash`);
  }

  const usedKindMembership = db.prepare(
    `select p.kind_id as kindId,
            count(distinct m.category_id) as memberCount,
            count(distinct case when c.active=1 then c.id end) as activeCategoryCount
       from places p
       left join map_filter_members m on m.place_kind_id=p.kind_id
       left join map_filter_categories c on c.id=m.category_id
      group by p.kind_id order by p.kind_id`,
  ).all();
  for (const row of usedKindMembership) {
    assert.equal(row.memberCount, 1, `${row.kindId} chip membership`);
    assert.equal(row.activeCategoryCount, 1, `${row.kindId} active chip membership`);
  }

  assert.equal(scalar(
    db,
    `select count(*) as value from facility_types ft
      where ft.status='active' and not exists (
        select 1 from map_filter_members m where m.facility_type_id=ft.id
      )`,
  ), 0);
  assert.equal(scalar(
    db,
    `select count(*) as value from map_filter_members m
       join map_filter_categories c on c.id=m.category_id
      where m.includes_merchants=1 and c.active=1`,
  ), 1);

  const specialFeatures = db.prepare(
    `select source_element_id as sourceElementId,feature_kind as featureKind
       from map_features
      where map_version_id='map_version_campus_baoshan'
        and source_element_id in ('_4th_canteen','_6th_canteen','_6th_canteen-2')
      order by source_element_id`,
  ).all().map((row) => ({ ...row }));
  assert.deepEqual(specialFeatures, [
    { sourceElementId: "_4th_canteen", featureKind: "building_footprint" },
    { sourceElementId: "_6th_canteen", featureKind: "other" },
    { sourceElementId: "_6th_canteen-2", featureKind: "building_footprint" },
  ]);
  for (const sourceElementId of ["art_college", "chemistry_building_"]) {
    assert.equal(scalar(
      db,
      "select json_extract(geometry_json,'$.type') as value from map_features where source_element_id=?",
      sourceElementId,
    ), "Polygon");
  }

  const multiPolygonPlace = db.prepare(
    `select r.display_name as displayName,r.content_hash as contentHash,
            r.summary,r.description,r.content_json as contentJson,r.structure_json as structureJson,
            json_extract(r.structure_json,'$.locations[1].geometryType') as revisionGeometryType,
            la.geometry_type as anchorGeometryType,
            json_extract(mf.geometry_json,'$.type') as featureGeometryType
       from places p
       join place_revisions r on r.id=p.current_revision_id
       join entity_locations el on el.entity_type='place' and el.entity_id=p.id
         and el.role='footprint' and el.valid_to is null
       join location_anchors la on la.id=el.anchor_id and la.valid_to is null
       join map_features mf on mf.id=la.map_feature_id
      where p.id='place_yanchang_shanghai-art-college'`,
  ).get();
  assert.equal(multiPolygonPlace.revisionGeometryType, "MultiPolygon");
  assert.equal(multiPolygonPlace.anchorGeometryType, "MultiPolygon");
  assert.equal(multiPolygonPlace.featureGeometryType, "MultiPolygon");
  assert.equal(
    multiPolygonPlace.contentHash,
    sha256(
      `${multiPolygonPlace.displayName}\n${multiPolygonPlace.summary ?? ""}\n${multiPolygonPlace.description ?? ""}\n${multiPolygonPlace.contentJson}\n${multiPolygonPlace.structureJson}`,
    ),
  );

  assert.deepEqual(db.prepare("pragma foreign_key_check").all(), []);

  const countsAfterFirstSeed = tableCounts(db);
  db.exec(sql);
  assert.deepEqual(tableCounts(db), countsAfterFirstSeed, "the canonical seed must be idempotent");
  assert.deepEqual(db.prepare("pragma foreign_key_check").all(), []);
  db.close();
});

test("taxonomy migration preserves revision review history while canonicalizing payloads", () => {
  const db = databaseThrough("0010_collection_assignee_backfill.sql");
  const createdAt = "2026-05-01T10:00:00.000Z";
  const submittedAt = "2026-05-02T10:00:00.000Z";
  const reviewedAt = "2026-05-03T10:00:00.000Z";

  db.exec(`
    insert into users(id,email,display_name,password_hash,status,created_at,updated_at)
      values('user_fixture','fixture@example.com','Fixture','hash','active','${createdAt}','${createdAt}');
    insert into data_sources(id,source_type,title,reliability,metadata_json,created_at)
      values('source_fixture','import','现有校园建筑与导航坐标','reviewed','{}','${createdAt}');
    insert into places(id,kind_id,campus_id,stable_code,lifecycle_status,created_at,updated_at)
      values('place_baoshan_dorm-1','residence','campus_baoshan','dorm-1','active','${createdAt}','${createdAt}');
    insert into buildings(place_id,building_code,public_access_level)
      values('place_baoshan_dorm-1','dorm-1','unknown');
    insert into place_revisions(
      id,place_id,revision_no,editorial_status,display_name,summary,description,
      content_json,structure_json,source_id,content_hash,created_by,created_at,
      submitted_at,reviewed_by,reviewed_at,review_note
    ) values (
      'prev_a98fb2febdc2d8259e20ad10','place_baoshan_dorm-1',1,'approved','1号楼',null,null,
      '{"detail":{},"address":"上海市宝山区上大路99号 上海大学宝山校区 1号楼"}','{}','source_fixture','old-hash-1',
      'user_fixture','${createdAt}','${submittedAt}','user_fixture','${reviewedAt}','approved note'
    );
    insert into place_revisions(
      id,place_id,revision_no,editorial_status,display_name,summary,description,
      content_json,structure_json,source_id,based_on_revision_id,content_hash,
      created_by,created_at,submitted_at
    ) values (
      'prev_8b9f5355aebc4aad96bb208228b08fb9','place_baoshan_dorm-1',2,'in_review','1号楼',null,null,
      '{"detail":{"facts":[],"media":[{"role":"cover","url":"/api/public/media/media_962609da5ca4480d84d43ad2fcc259d9","alt":"","caption":"用户提供"}]},"address":"上海市宝山区上大路99号 上海大学宝山校区 1号楼"}',
      '{}','source_fixture','prev_a98fb2febdc2d8259e20ad10','old-hash-2','user_fixture','${createdAt}','${submittedAt}'
    );
    update places set current_revision_id='prev_a98fb2febdc2d8259e20ad10'
      where id='place_baoshan_dorm-1';
  `);

  const historyQuery = `select id,revision_no as revisionNo,editorial_status as editorialStatus,
      based_on_revision_id as basedOnRevisionId,display_name as displayName,summary,description,
      created_by as createdBy,created_at as createdAt,submitted_at as submittedAt,
      reviewed_by as reviewedBy,reviewed_at as reviewedAt,review_note as reviewNote
    from place_revisions where place_id='place_baoshan_dorm-1' order by revision_no`;
  const historyBefore = db.prepare(historyQuery).all();

  applyMigrations(db, (name) => name === "0011_unified_place_taxonomy.sql");

  assert.deepEqual(db.prepare(historyQuery).all(), historyBefore);
  assert.equal(scalar(
    db,
    "select current_revision_id as value from places where id='place_baoshan_dorm-1'",
  ), "prev_a98fb2febdc2d8259e20ad10");
  assert.equal(scalar(
    db,
    "select count(*) as value from place_revisions where place_id='place_baoshan_dorm-1' and editorial_status='in_review'",
  ), 1);

  for (const row of db.prepare(
    `select display_name as displayName,summary,description,content_json as contentJson,
            structure_json as structureJson,content_hash as contentHash,source_id as sourceId
       from place_revisions where place_id='place_baoshan_dorm-1' order by revision_no`,
  ).all()) {
    const content = JSON.parse(row.contentJson);
    assert.deepEqual(Object.keys(content).sort(), ["address", "detail"]);
    assert.deepEqual(Object.keys(content.detail).sort(), ["facts", "media"]);
    assert.ok(Array.isArray(content.detail.facts));
    assert.ok(Array.isArray(content.detail.media));
    assert.deepEqual(
      Object.keys(JSON.parse(row.structureJson)).sort(),
      ["aliases", "building", "campusId", "kindId", "locations", "parentPlaceId", "stableCode"],
    );
    assert.equal(
      row.contentHash,
      sha256(`${row.displayName}\n${row.summary ?? ""}\n${row.description ?? ""}\n${row.contentJson}\n${row.structureJson}`),
    );
    assert.equal(row.sourceId, "source_campus_maps");
  }
  assert.deepEqual(db.prepare("pragma foreign_key_check").all(), []);
  db.close();
});

test("taxonomy migration preserves direct anchor dependents while expanding geometry types", () => {
  const db = databaseThrough("0010_collection_assignee_backfill.sql");
  const createdAt = "2026-05-01T10:00:00.000Z";
  db.exec(`
    insert into location_anchors(
      id,campus_id,role,geometry_type,geometry_json,crs,precision_level,
      verification_status,created_at,updated_at
    ) values (
      'anchor_geometry_fixture','campus_baoshan','route_shape','LineString',
      '{"type":"LineString","coordinates":[[0,0],[1,1]]}','GCJ02','exact',
      'verified','${createdAt}','${createdAt}'
    );
    insert into entity_locations(
      id,entity_type,entity_id,anchor_id,role,is_primary,created_at
    ) values (
      'entity_location_geometry_fixture','transit_stop','stop_baoshan',
      'anchor_geometry_fixture','route_shape',0,'${createdAt}'
    );
    insert into transit_routes(id,code,name,status,created_at,updated_at)
      values('route_geometry_fixture','geometry-fixture','Geometry fixture','active','${createdAt}','${createdAt}');
    insert into transit_patterns(id,route_id,direction_id,name,route_anchor_id)
      values('pattern_geometry_fixture','route_geometry_fixture',0,'Geometry fixture','anchor_geometry_fixture');
  `);

  const anchorBefore = db.prepare(
    "select * from location_anchors where id='anchor_geometry_fixture'",
  ).get();
  const bindingBefore = db.prepare(
    "select * from entity_locations where id='entity_location_geometry_fixture'",
  ).get();
  const patternBefore = db.prepare(
    "select id,route_anchor_id as routeAnchorId from transit_patterns where route_anchor_id is not null",
  ).get();
  const anchorCountBefore = scalar(db, "select count(*) as value from location_anchors");
  const bindingCountBefore = scalar(db, "select count(*) as value from entity_locations");

  applyMigrations(db, (name) => name === "0011_unified_place_taxonomy.sql");

  assert.deepEqual(
    db.prepare("select * from location_anchors where id='anchor_geometry_fixture'").get(),
    anchorBefore,
  );
  assert.deepEqual(
    db.prepare("select * from entity_locations where id='entity_location_geometry_fixture'").get(),
    bindingBefore,
  );
  assert.deepEqual(
    db.prepare("select id,route_anchor_id as routeAnchorId from transit_patterns where id=?").get(patternBefore.id),
    patternBefore,
  );
  assert.equal(scalar(db, "select count(*) as value from location_anchors"), anchorCountBefore);
  assert.equal(scalar(db, "select count(*) as value from entity_locations"), bindingCountBefore);

  const locationSchema = scalar(
    db,
    "select sql as value from sqlite_schema where type='table' and name='location_anchors'",
  );
  assert.match(locationSchema, /'MultiPolygon'/);
  assert.deepEqual(
    db.prepare("pragma foreign_key_list(entity_locations)").all()
      .filter((row) => row.from === "anchor_id")
      .map((row) => ({ table: row.table, onDelete: row.on_delete })),
    [{ table: "location_anchors", onDelete: "CASCADE" }],
  );
  assert.deepEqual(
    db.prepare("pragma foreign_key_list(transit_patterns)").all()
      .filter((row) => row.from === "route_anchor_id")
      .map((row) => ({ table: row.table, onDelete: row.on_delete })),
    [{ table: "location_anchors", onDelete: "SET NULL" }],
  );
  assert.deepEqual(db.prepare("pragma foreign_key_check").all(), []);
  db.close();
});
