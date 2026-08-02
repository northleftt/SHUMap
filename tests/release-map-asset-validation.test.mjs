import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await build({
  absWorkingDir: root,
  entryPoints: ["worker/modules/releases.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`;
const { ReleaseCoordinator } = await import(moduleUrl);

class Statement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new Statement(this.database, this.sql, values);
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.values) ?? null;
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.values) };
  }

  async run() {
    this.database.prepare(this.sql).run(...this.values);
    return { success: true };
  }
}

class D1Database {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new Statement(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("begin");
    try {
      for (const statement of statements) this.database.prepare(statement.sql).run(...statement.values);
      this.database.exec("commit");
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
    return statements.map(() => ({ success: true }));
  }
}

class StoredObject {
  constructor(bytes) {
    this.bytes = Uint8Array.from(bytes);
    this.size = this.bytes.byteLength;
    this.body = new ReadableStream({
      start: (controller) => {
        controller.enqueue(this.bytes);
        controller.close();
      },
    });
  }

  async arrayBuffer() {
    return this.bytes.buffer.slice(this.bytes.byteOffset, this.bytes.byteOffset + this.bytes.byteLength);
  }
}

class R2Bucket {
  constructor(objects = new Map()) {
    this.objects = objects;
    this.puts = [];
  }

  async get(key) {
    const bytes = this.objects.get(key);
    return bytes ? new StoredObject(bytes) : null;
  }

  async put(key, value) {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
    this.objects.set(key, bytes);
    this.puts.push(key);
  }
}

function databaseWithMap(bytes, declaredSize = bytes.byteLength, declaredHash = sha256(bytes)) {
  const migrationsDir = path.join(root, "migrations-v2");
  const database = new DatabaseSync(":memory:");
  for (const name of fs.readdirSync(migrationsDir).filter((value) => value.endsWith(".sql")).sort()) {
    database.exec(fs.readFileSync(path.join(migrationsDir, name), "utf8"));
  }
  const now = "2026-08-01T00:00:00.000Z";
  database.prepare(
    `insert into users(id,email,display_name,password_hash,status,token_version,created_at,updated_at)
     values('user_test','release@example.test','发布员','hash','active',1,?,?)`,
  ).run(now, now);
  database.prepare(
    "insert into campuses(id,code,name,timezone,status,created_at,updated_at) values('campus_test','test','测试校区','Asia/Shanghai','active',?,?)",
  ).run(now, now);
  database.prepare(
    `insert into media_assets(id,bucket_scope,object_key,original_name,content_type,byte_size,sha256,status,created_at,approved_at)
     values('media_test','private','maps/test.svg','test.svg','image/svg+xml',?,?,'approved',?,?)`,
  ).run(declaredSize, declaredHash, now, now);
  database.prepare(
    "insert into map_assets(id,asset_type,media_asset_id,checksum,metadata_json,created_at) values('asset_test','campus_svg','media_test',?,'{}',?)",
  ).run(declaredHash, now);
  database.prepare(
    `insert into map_versions(id,campus_id,map_asset_id,version_label,coordinate_space_type,coordinate_space_json,lifecycle_status,created_at)
     values('map_test','campus_test','asset_test','test-v1','svg_viewbox','{}','ready',?)`,
  ).run(now);
  return database;
}

function coordinator(database, bucket) {
  return new ReleaseCoordinator(
    { blockConcurrencyWhile: (callback) => callback() },
    { DB: new D1Database(database), SHUMAP_BUCKET: bucket },
  );
}

function publishRequest(version, mapVersionIds = ["map_test"]) {
  return new Request("https://release.internal/release", {
    method: "POST",
    headers: { "content-type": "application/json", "x-shumap-user-id": "user_test" },
    body: JSON.stringify({ version, summary: null, reason: null, mapVersionIds }),
  });
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function seedPublishedPlace(database, id = "place_release_test") {
  const now = "2026-08-01T00:00:00.000Z";
  database.prepare(
    `insert into places(id,kind_id,campus_id,stable_code,lifecycle_status,approval_pending,created_at,updated_at)
     values(?,'building','campus_test',?,'active',0,?,?)`,
  ).run(id, id, now, now);
  database.prepare(
    `insert into buildings(place_id,building_code,public_access_level)
     values(?,?,'unknown')`,
  ).run(id, id);
  const contentJson = '{"detail":{"facts":[],"media":[]}}';
  const structureJson = JSON.stringify({
    kindId: "building",
    campusId: "campus_test",
    parentPlaceId: null,
    stableCode: id,
    aliases: [],
    building: { buildingCode: id, managingOrganizationId: null, publicAccessLevel: "unknown" },
    locations: [],
  });
  const contentHash = crypto.createHash("sha256")
    .update(`测试地点\n\n\n${contentJson}\n${structureJson}`)
    .digest("hex");
  database.prepare(
    `insert into place_revisions(
       id,place_id,revision_no,editorial_status,display_name,content_json,structure_json,
       content_hash,created_at
     ) values(?, ?,1,'approved','测试地点',?,?,?,?)`,
  ).run(`revision_${id}`, id, contentJson, structureJson, contentHash, now);
  database.prepare("update places set current_revision_id=? where id=?").run(`revision_${id}`, id);
  return id;
}

function seedFeature(database, id, mapVersionId, sourceElementId, featureKind = "building_footprint") {
  database.prepare(
    `insert into map_features(
       id,map_version_id,stable_feature_key,source_element_id,feature_kind,geometry_json,metadata_json
     ) values(?,?,?,?,?,'{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}','{}')`,
  ).run(id, mapVersionId, `place:${sourceElementId}`, sourceElementId, featureKind);
}

function seedLocation(database, {
  id,
  placeId,
  role,
  geometryType,
  geometryJson = null,
  crs = null,
  mapVersionId = null,
  mapFeatureId = null,
  isPrimary = 0,
}) {
  const now = "2026-08-01T00:00:00.000Z";
  database.prepare(
    `insert into location_anchors(
       id,campus_id,building_place_id,role,geometry_type,geometry_json,crs,map_version_id,
       map_feature_id,precision_level,verification_status,created_at,updated_at
     ) values(?,'campus_test',?,?,?,?,?,?,?,'exact','verified',?,?)`,
  ).run(id, placeId, role, geometryType, geometryJson, crs, mapVersionId, mapFeatureId, now, now);
  database.prepare(
    `insert into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,created_at)
     values(?,'place',?,?,?, ?,?)`,
  ).run(`binding_${id}`, placeId, id, role, isPrimary, now);
}

test("release validation reports a missing selected map object and does not activate", async () => {
  const bytes = new TextEncoder().encode("<svg/>");
  const database = databaseWithMap(bytes);
  const bucket = new R2Bucket();
  const response = await coordinator(database, bucket).fetch(publishRequest("missing-map-object"));
  const body = await response.json();

  assert.equal(response.status, 422);
  assert.equal(body.status, "validation_failed");
  assert.deepEqual(body.validation.mapAssets, [{
    mapVersionId: "map_test",
    objectKey: "maps/test.svg",
    valid: false,
    error: "Map map_test object maps/test.svg is missing",
  }]);
  assert.equal(database.prepare("select status from releases where id=?").get(body.id).status, "validation_failed");
  assert.equal(database.prepare("select count(*) as count from release_activations").get().count, 0);
  assert.deepEqual(bucket.puts, []);
});

test("release validation reports every explicitly requested map version that was not selected", async () => {
  const bytes = new TextEncoder().encode("<svg/>");
  const database = databaseWithMap(bytes);
  const bucket = new R2Bucket(new Map([["maps/test.svg", bytes]]));
  const response = await coordinator(database, bucket).fetch(publishRequest(
    "missing-requested-map-version",
    ["map_test", "map_missing"],
  ));
  const body = await response.json();

  assert.equal(response.status, 422);
  assert.deepEqual(body.validation.mapSelection, {
    requestedMapVersionIds: ["map_test", "map_missing"],
    selectedMapVersionIds: ["map_test"],
    missingMapVersionIds: ["map_missing"],
  });
  assert.ok(body.validation.errors.includes("Requested map version map_missing does not exist or is not ready for release"));
  assert.deepEqual(bucket.puts, []);
});

test("release validation distinguishes map object size and checksum mismatches", async () => {
  const declared = new TextEncoder().encode("<svg id='declared'/>");
  const sameSizeWrongContent = Uint8Array.from(declared);
  sameSizeWrongContent[sameSizeWrongContent.byteLength - 2] ^= 1;

  {
    const database = databaseWithMap(declared);
    const bucket = new R2Bucket(new Map([["maps/test.svg", new Uint8Array(declared.byteLength + 1)]]));
    const response = await coordinator(database, bucket).fetch(publishRequest("map-size-mismatch"));
    const body = await response.json();
    assert.equal(response.status, 422);
    assert.equal(body.validation.mapAssets[0].error, `Map map_test object size ${declared.byteLength + 1} does not match stored byte size ${declared.byteLength}`);
  }

  {
    const database = databaseWithMap(declared);
    const bucket = new R2Bucket(new Map([["maps/test.svg", sameSizeWrongContent]]));
    const response = await coordinator(database, bucket).fetch(publishRequest("map-checksum-mismatch"));
    const body = await response.json();
    assert.equal(response.status, 422);
    assert.equal(body.validation.mapAssets[0].error, "Map map_test object checksum does not match stored SHA-256");
  }
});

test("a verified selected map object can pass asset validation and reach ordinary release validation", async () => {
  const bytes = new TextEncoder().encode("<svg id='verified'/>");
  const database = databaseWithMap(bytes);
  const bucket = new R2Bucket(new Map([["maps/test.svg", bytes]]));
  const response = await coordinator(database, bucket).fetch(publishRequest("verified-map-object"));
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.status, "active");
  assert.deepEqual(body.validation.mapAssets, [{
    mapVersionId: "map_test",
    objectKey: "maps/test.svg",
    valid: true,
    error: null,
  }]);
  assert.equal(database.prepare("select status from releases where id=?").get(body.id).status, "active");
  assert.equal(database.prepare("select lifecycle_status from map_versions where id='map_test'").get().lifecycle_status, "published");
  assert.equal(database.prepare("select count(*) as count from release_activations").get().count, 1);
  assert.equal(bucket.puts.length, 1);
  const manifest = JSON.parse(new TextDecoder().decode(bucket.objects.get(bucket.puts[0])));
  assert.equal(manifest.maps.length, 1);
  assert.deepEqual(Object.keys(manifest.maps[0]).sort(), [
    "assetKey", "campusCode", "campusName", "campus_id", "checksum", "coordinate_space_json",
    "coordinate_space_type", "created_at", "created_by", "floor_id", "id", "lifecycle_status",
    "map_asset_id", "parent_version_id", "parser_version", "version_label",
  ].sort());
});

test("release rejects a location bound to a map version outside the selection", async () => {
  const bytes = new TextEncoder().encode("<svg id='selected'/>");
  const database = databaseWithMap(bytes);
  const placeId = seedPublishedPlace(database);
  const now = "2026-08-01T00:00:00.000Z";
  database.prepare(
    `insert into media_assets(id,bucket_scope,object_key,original_name,content_type,byte_size,sha256,status,created_at,approved_at)
     values('media_outside','private','maps/outside.svg','outside.svg','image/svg+xml',?,?,'approved',?,?)`,
  ).run(bytes.byteLength, sha256(bytes), now, now);
  database.prepare(
    "insert into map_assets(id,asset_type,media_asset_id,checksum,metadata_json,created_at) values('asset_outside','campus_svg','media_outside',?,'{}',?)",
  ).run(sha256(bytes), now);
  database.prepare(
    `insert into map_versions(id,campus_id,map_asset_id,version_label,coordinate_space_type,coordinate_space_json,lifecycle_status,created_at)
     values('map_outside','campus_test','asset_outside','outside-v1','svg_viewbox','{}','ready',?)`,
  ).run(now);
  seedFeature(database, "feature_selected", "map_test", "selected");
  seedFeature(database, "feature_outside", "map_outside", "outside", "other");
  seedLocation(database, {
    id: "anchor_selected_footprint",
    placeId,
    role: "footprint",
    geometryType: "Polygon",
    mapVersionId: "map_test",
    mapFeatureId: "feature_selected",
  });
  seedLocation(database, {
    id: "anchor_outside_service",
    placeId,
    role: "other",
    geometryType: "Polygon",
    mapVersionId: "map_outside",
    mapFeatureId: "feature_outside",
  });
  const bucket = new R2Bucket(new Map([["maps/test.svg", bytes], ["maps/outside.svg", bytes]]));
  const response = await coordinator(database, bucket).fetch(publishRequest("outside-location-map"));
  const body = await response.json();

  assert.equal(response.status, 422);
  assert.ok(body.validation.errors.includes("Location anchor_outside_service uses a map version outside this release"));
  assert.deepEqual(bucket.puts, []);
});

test("release rejects a building without exactly one canonical footprint", async () => {
  const bytes = new TextEncoder().encode("<svg id='selected'/>");
  const database = databaseWithMap(bytes);
  seedPublishedPlace(database);
  const bucket = new R2Bucket(new Map([["maps/test.svg", bytes]]));
  const response = await coordinator(database, bucket).fetch(publishRequest("missing-building-footprint"));
  const body = await response.json();

  assert.equal(response.status, 422);
  assert.ok(body.validation.errors.includes("Building place_release_test must have exactly one footprint location"));
  assert.deepEqual(bucket.puts, []);
});

test("release rejects malformed navigation coordinates before writing an artifact", async () => {
  const bytes = new TextEncoder().encode("<svg id='selected'/>");
  const database = databaseWithMap(bytes);
  const placeId = seedPublishedPlace(database);
  seedFeature(database, "feature_selected", "map_test", "selected");
  seedLocation(database, {
    id: "anchor_selected_footprint",
    placeId,
    role: "footprint",
    geometryType: "Polygon",
    mapVersionId: "map_test",
    mapFeatureId: "feature_selected",
  });
  database.exec("drop trigger require_navigation_anchor_contract_insert");
  seedLocation(database, {
    id: "anchor_invalid_navigation",
    placeId,
    role: "navigation_target",
    geometryType: "Point",
    geometryJson: '{"type":"Point","coordinates":[121.4,31.3]}',
    crs: "EPSG:4326",
    isPrimary: 1,
  });
  const bucket = new R2Bucket(new Map([["maps/test.svg", bytes]]));
  const response = await coordinator(database, bucket).fetch(publishRequest("invalid-navigation-crs"));
  const body = await response.json();

  assert.equal(response.status, 422);
  assert.ok(body.validation.errors.includes("Navigation location anchor_invalid_navigation must use GCJ02"));
  assert.deepEqual(bucket.puts, []);
});

test("release rejects multiple campus maps for the same campus", async () => {
  const firstBytes = new TextEncoder().encode("<svg id='first'/>");
  const secondBytes = new TextEncoder().encode("<svg id='second'/>");
  const database = databaseWithMap(firstBytes);
  const now = "2026-08-01T00:00:00.000Z";
  database.prepare(
    `insert into media_assets(id,bucket_scope,object_key,original_name,content_type,byte_size,sha256,status,created_at,approved_at)
     values('media_second','private','maps/second.svg','second.svg','image/svg+xml',?,?,'approved',?,?)`,
  ).run(secondBytes.byteLength, sha256(secondBytes), now, now);
  database.prepare(
    "insert into map_assets(id,asset_type,media_asset_id,checksum,metadata_json,created_at) values('asset_second','campus_svg','media_second',?,'{}',?)",
  ).run(sha256(secondBytes), now);
  database.prepare(
    `insert into map_versions(id,campus_id,map_asset_id,version_label,coordinate_space_type,coordinate_space_json,lifecycle_status,created_at)
     values('map_second','campus_test','asset_second','test-v2','svg_viewbox','{}','ready',?)`,
  ).run(now);
  const bucket = new R2Bucket(new Map([
    ["maps/test.svg", firstBytes],
    ["maps/second.svg", secondBytes],
  ]));
  const response = await coordinator(database, bucket).fetch(publishRequest(
    "duplicate-campus-maps",
    ["map_test", "map_second"],
  ));
  const body = await response.json();

  assert.equal(response.status, 422);
  assert.ok(body.validation.errors.includes("Campus campus_test must have exactly one map version in this release"));
  assert.deepEqual(bucket.puts, []);
});
