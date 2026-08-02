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
  entryPoints: ["worker/modules/jobs.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`;
const { processQueue } = await import(moduleUrl);

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
  constructor(bytes, declaredSize = bytes.byteLength) {
    this.bytes = Uint8Array.from(bytes);
    this.size = declaredSize;
  }

  async arrayBuffer() {
    return this.bytes.buffer.slice(this.bytes.byteOffset, this.bytes.byteOffset + this.bytes.byteLength);
  }
}

class R2Bucket {
  constructor(object) {
    this.object = object;
    this.gets = [];
  }

  async get(key) {
    this.gets.push(key);
    return this.object;
  }
}

function freshDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("pragma foreign_keys=on");
  const migrationsDir = path.join(root, "migrations-v2");
  for (const name of fs.readdirSync(migrationsDir).filter((value) => value.endsWith(".sql")).sort()) {
    database.exec(fs.readFileSync(path.join(migrationsDir, name), "utf8"));
  }
  return database;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function seedImport(database, bytes, { byteSize = bytes.byteLength, digest = sha256(bytes) } = {}) {
  const now = "2026-08-01T00:00:00.000Z";
  database.prepare(
    "insert into campuses(id,code,name,timezone,status,created_at,updated_at) values('campus_import','import','导入校区','Asia/Shanghai','active',?,?)",
  ).run(now, now);
  database.prepare(
    "insert into places(id,kind_id,campus_id,stable_code,lifecycle_status,created_at,updated_at) values('place_import','building','campus_import','import-building','active',?,?)",
  ).run(now, now);
  database.prepare(
    "insert into buildings(place_id,building_code,public_access_level) values('place_import','import-building','unknown')",
  ).run();

  database.prepare(
    `insert into media_assets(id,bucket_scope,object_key,original_name,content_type,byte_size,sha256,status,created_at,approved_at)
     values('media_previous','private','maps/previous.svg','previous.svg','image/svg+xml',1,?,'approved',?,?)`,
  ).run(sha256(new Uint8Array([0])), now, now);
  database.prepare(
    "insert into map_assets(id,asset_type,media_asset_id,checksum,metadata_json,created_at) values('asset_previous','campus_svg','media_previous',?,'{}',?)",
  ).run(sha256(new Uint8Array([0])), now);
  database.prepare(
    `insert into map_versions(
       id,campus_id,map_asset_id,version_label,coordinate_space_type,coordinate_space_json,
       parser_version,lifecycle_status,created_at
     ) values('version_previous','campus_import','asset_previous','previous','svg_viewbox','{"x":0,"y":0,"width":100,"height":100}','svg-geometry-v3','published',?)`,
  ).run(now);
  database.prepare(
    `insert into map_features(
       id,map_version_id,stable_feature_key,source_element_id,feature_kind,
       geometry_json,bbox_json,shape_hash,label,metadata_json
     ) values
       ('feature_previous_building','version_previous','place:place_import','building','building_footprint','{"type":"Polygon","coordinates":[[[0,0],[10,0],[10,10],[0,10],[0,0]]]}','[0,0,10,10]','old-building-hash','旧建筑','{}'),
       ('feature_previous_other','version_previous','campus:campus_import:svg:other','other','other','{"type":"Polygon","coordinates":[[[40,40],[45,40],[45,45],[40,45],[40,40]]]}','[40,40,45,45]','old-other-hash',null,'{}')`,
  ).run();
  database.prepare(
    `insert into location_anchors(
       id,campus_id,building_place_id,role,geometry_type,map_version_id,map_feature_id,
       precision_level,verification_status,valid_from,created_at,updated_at
     ) values('anchor_previous','campus_import','place_import','footprint','Polygon','version_previous',
       'feature_previous_building','exact','verified',?,?,?)`,
  ).run(now, now, now);
  database.prepare(
    `insert into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,valid_from,created_at)
     values('binding_previous','place','place_import','anchor_previous','footprint',0,?,?)`,
  ).run(now, now);

  database.prepare(
    `insert into media_assets(id,bucket_scope,object_key,original_name,content_type,byte_size,sha256,status,created_at,approved_at)
     values('media_import','private','maps/import.svg','import.svg','image/svg+xml',?,?,'approved',?,?)`,
  ).run(byteSize, digest, now, now);
  database.prepare(
    `insert into jobs(id,job_type,idempotency_key,status,payload_json,attempt_count,created_at)
     values('job_import','map_import','import-test','queued',?,0,?)`,
  ).run(JSON.stringify({
    mediaAssetId: "media_import",
    campusId: "campus_import",
    floorId: null,
    versionLabel: "imported",
  }), now);
}

function seedDetachedReadyVersion(database) {
  const now = "2026-08-02T00:00:00.000Z";
  const digest = sha256(new Uint8Array([1]));
  database.prepare(
    `insert into media_assets(id,bucket_scope,object_key,original_name,content_type,byte_size,sha256,status,created_at,approved_at)
     values('media_detached','private','maps/detached.svg','detached.svg','image/svg+xml',1,?,'approved',?,?)`,
  ).run(digest, now, now);
  database.prepare(
    "insert into map_assets(id,asset_type,media_asset_id,checksum,metadata_json,created_at) values('asset_detached','campus_svg','media_detached',?,'{}',?)",
  ).run(digest, now);
  database.prepare(
    `insert into map_versions(
       id,campus_id,map_asset_id,parent_version_id,version_label,coordinate_space_type,coordinate_space_json,
       parser_version,lifecycle_status,created_at
     ) values('version_detached','campus_import','asset_detached','version_previous','detached','svg_viewbox',
       '{"x":0,"y":0,"width":100,"height":100}','svg-geometry-v3','ready',?)`,
  ).run(now);
  database.prepare(
    `insert into map_features(
       id,map_version_id,stable_feature_key,source_element_id,feature_kind,
       geometry_json,bbox_json,shape_hash,label,metadata_json
     ) values
       ('feature_detached_building','version_detached','campus:campus_import:svg:building','building','other','{"type":"Polygon","coordinates":[[[0,0],[10,0],[10,10],[0,10],[0,0]]]}','[0,0,10,10]','detached-building-hash',null,'{}'),
       ('feature_detached_other','version_detached','campus:campus_import:svg:other','other','other','{"type":"Polygon","coordinates":[[[40,40],[45,40],[45,45],[40,45],[40,40]]]}','[40,40,45,45]','detached-other-hash',null,'{}')`,
  ).run();
}

function message() {
  return {
    id: "message_import",
    timestamp: new Date("2026-08-01T00:00:00.000Z"),
    body: { jobId: "job_import", jobType: "map_import" },
    acknowledged: false,
    retried: false,
    ack() { this.acknowledged = true; },
    retry() { this.retried = true; },
  };
}

async function runImport(database, bucket, { silenceExpectedFailure = false } = {}) {
  const item = message();
  const originalConsoleError = console.error;
  if (silenceExpectedFailure) console.error = () => {};
  try {
    await processQueue(
      { queue: "imports", messages: [item], ackAll() {}, retryAll() {} },
      { DB: new D1Database(database), SHUMAP_BUCKET: bucket },
    );
  } finally {
    console.error = originalConsoleError;
  }
  return item;
}

const importedSvg = new TextEncoder().encode(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <g id="building">
      <path d="M0 0 L10 0 L10 10 L0 10 Z M20 20 L30 20 L30 30 L20 30 Z"/>
    </g>
    <g id="other"><rect x="40" y="40" width="5" height="5"/></g>
  </svg>
`);

test("map import creates version and feature lineage while replacing active footprint bindings", async () => {
  const database = freshDatabase();
  seedImport(database, importedSvg);
  const item = await runImport(database, new R2Bucket(new StoredObject(importedSvg)));

  assert.equal(item.acknowledged, true);
  assert.equal(item.retried, false);
  const job = database.prepare("select status,result_json as resultJson from jobs where id='job_import'").get();
  assert.equal(job.status, "succeeded");
  const result = JSON.parse(job.resultJson);
  assert.equal(result.featureCount, 2);
  assert.equal(
    database.prepare("select parent_version_id as parentVersionId from map_versions where id=?").get(result.mapVersionId).parentVersionId,
    "version_previous",
  );

  const mappings = database.prepare(
    `select old.source_element_id as sourceElementId,m.mapping_status as mappingStatus,m.confidence
       from map_feature_mappings m join map_features old on old.id=m.from_feature_id
      join map_features next on next.id=m.to_feature_id
      where next.map_version_id=? order by old.source_element_id`,
  ).all(result.mapVersionId);
  assert.deepEqual(mappings.map((row) => ({ ...row })), [
    { sourceElementId: "building", mappingStatus: "automatic", confidence: 1 },
    { sourceElementId: "other", mappingStatus: "automatic", confidence: 1 },
  ]);

  assert.ok(database.prepare("select valid_to as validTo from location_anchors where id='anchor_previous'").get().validTo);
  assert.ok(database.prepare("select valid_to as validTo from entity_locations where id='binding_previous'").get().validTo);
  const active = database.prepare(
    `select la.geometry_type as geometryType,la.map_version_id as mapVersionId,
            mf.source_element_id as sourceElementId,mf.feature_kind as featureKind,
            mf.stable_feature_key as stableFeatureKey,el.is_primary as isPrimary
       from entity_locations el join location_anchors la on la.id=el.anchor_id
       join map_features mf on mf.id=la.map_feature_id
      where el.entity_type='place' and el.entity_id='place_import' and el.role='footprint'
        and el.valid_to is null and la.valid_to is null`,
  ).get();
  assert.deepEqual({ ...active }, {
    geometryType: "MultiPolygon",
    mapVersionId: result.mapVersionId,
    sourceElementId: "building",
    featureKind: "building_footprint",
    stableFeatureKey: "place:place_import",
    isPrimary: 0,
  });
  assert.deepEqual(database.prepare("pragma foreign_key_check").all(), []);
  database.close();
});

test("map import migrates active footprints when the newest ready parent has no bindings", async () => {
  const database = freshDatabase();
  seedImport(database, importedSvg);
  seedDetachedReadyVersion(database);
  const item = await runImport(database, new R2Bucket(new StoredObject(importedSvg)));
  const job = database.prepare("select status,result_json as resultJson from jobs where id='job_import'").get();
  const result = JSON.parse(job.resultJson);

  assert.equal(item.acknowledged, true);
  assert.equal(job.status, "succeeded");
  assert.equal(
    database.prepare("select parent_version_id as parentVersionId from map_versions where id=?").get(result.mapVersionId).parentVersionId,
    "version_detached",
  );
  assert.deepEqual(
    database.prepare(
      `select m.from_feature_id as fromFeatureId,next.source_element_id as sourceElementId
         from map_feature_mappings m join map_features next on next.id=m.to_feature_id
        where next.map_version_id=? order by m.from_feature_id`,
    ).all(result.mapVersionId).map((row) => ({ ...row })),
    [
      { fromFeatureId: "feature_detached_building", sourceElementId: "building" },
      { fromFeatureId: "feature_detached_other", sourceElementId: "other" },
      { fromFeatureId: "feature_previous_building", sourceElementId: "building" },
    ],
  );
  assert.ok(database.prepare("select valid_to as validTo from location_anchors where id='anchor_previous'").get().validTo);
  assert.equal(
    database.prepare(
      `select mf.source_element_id as sourceElementId
         from entity_locations el join location_anchors la on la.id=el.anchor_id
         join map_features mf on mf.id=la.map_feature_id
        where el.entity_id='place_import' and el.role='footprint' and el.valid_to is null and la.valid_to is null`,
    ).get().sourceElementId,
    "building",
  );
  assert.deepEqual(database.prepare("pragma foreign_key_check").all(), []);
  database.close();
});

test("map import rejects R2 size and raw-byte checksum mismatches before writing lineage", async () => {
  for (const fixture of [
    {
      label: "size",
      object: new StoredObject(importedSvg, importedSvg.byteLength + 1),
      expectedError: `Import object size ${importedSvg.byteLength + 1} does not match stored byte size ${importedSvg.byteLength}`,
    },
    {
      label: "checksum",
      object: new StoredObject(importedSvg),
      digest: "0".repeat(64),
      expectedError: "Import object checksum mismatch",
    },
    {
      label: "body size",
      object: new StoredObject(importedSvg.subarray(0, importedSvg.byteLength - 1), importedSvg.byteLength),
      expectedError: `Import object body size ${importedSvg.byteLength - 1} does not match stored byte size ${importedSvg.byteLength}`,
    },
  ]) {
    const database = freshDatabase();
    seedImport(database, importedSvg, fixture.digest ? { digest: fixture.digest } : undefined);
    const item = await runImport(database, new R2Bucket(fixture.object), { silenceExpectedFailure: true });
    const job = database.prepare(
      "select status,attempt_count as attemptCount,error_message as errorMessage from jobs where id='job_import'",
    ).get();
    assert.deepEqual({ ...job }, {
      status: "queued",
      attemptCount: 1,
      errorMessage: fixture.expectedError,
    }, fixture.label);
    assert.equal(item.acknowledged, false, fixture.label);
    assert.equal(item.retried, true, fixture.label);
    assert.equal(database.prepare("select count(*) as count from map_assets where id<>'asset_previous' and id not like 'map_asset_campus_%'").get().count, 0);
    assert.equal(database.prepare("select count(*) as count from map_feature_mappings").get().count, 0);
    database.close();
  }
});

test("map import rejects stored media sizes above the 50 MiB contract before reading R2", async () => {
  const database = freshDatabase();
  seedImport(database, importedSvg, { byteSize: 50 * 1024 * 1024 + 1 });
  const bucket = new R2Bucket(new StoredObject(importedSvg));
  const item = await runImport(database, bucket, { silenceExpectedFailure: true });
  const job = database.prepare("select status,error_message as errorMessage from jobs where id='job_import'").get();

  assert.equal(job.status, "queued");
  assert.equal(job.errorMessage, `Import media has invalid stored byte size ${50 * 1024 * 1024 + 1}`);
  assert.deepEqual(bucket.gets, []);
  assert.equal(item.retried, true);
  database.close();
});

test("map import rejects invalid UTF-8 before writing lineage", async () => {
  const invalidUtf8 = Uint8Array.from([0x3c, 0x73, 0x76, 0x67, 0x3e, 0xc3, 0x28, 0x3c, 0x2f, 0x73, 0x76, 0x67, 0x3e]);
  const database = freshDatabase();
  seedImport(database, invalidUtf8);
  const item = await runImport(database, new R2Bucket(new StoredObject(invalidUtf8)), { silenceExpectedFailure: true });
  const job = database.prepare("select status,error_message as errorMessage from jobs where id='job_import'").get();

  assert.equal(job.status, "queued");
  assert.equal(job.errorMessage, "Import SVG is not valid UTF-8");
  assert.equal(item.acknowledged, false);
  assert.equal(item.retried, true);
  assert.equal(database.prepare("select count(*) as count from map_assets where id<>'asset_previous' and id not like 'map_asset_campus_%'").get().count, 0);
  assert.equal(database.prepare("select count(*) as count from map_feature_mappings").get().count, 0);
  database.close();
});

test("map import rejects removal of an active building footprint element", async () => {
  const missingFootprintSvg = new TextEncoder().encode(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <g id="other"><rect x="40" y="40" width="5" height="5"/></g>
    </svg>
  `);
  const database = freshDatabase();
  seedImport(database, missingFootprintSvg);
  const item = await runImport(database, new R2Bucket(new StoredObject(missingFootprintSvg)), { silenceExpectedFailure: true });
  const job = database.prepare("select status,error_message as errorMessage from jobs where id='job_import'").get();

  assert.equal(job.status, "queued");
  assert.equal(job.errorMessage, "Map SVG is missing active building footprint elements: building");
  assert.equal(item.acknowledged, false);
  assert.equal(item.retried, true);
  assert.equal(database.prepare("select valid_to as validTo from location_anchors where id='anchor_previous'").get().validTo, null);
  assert.equal(database.prepare("select valid_to as validTo from entity_locations where id='binding_previous'").get().validTo, null);
  assert.equal(database.prepare("select count(*) as count from map_assets where id<>'asset_previous' and id not like 'map_asset_campus_%'").get().count, 0);
  assert.equal(database.prepare("select count(*) as count from map_feature_mappings").get().count, 0);
  database.close();
});
