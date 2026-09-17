import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await build({
  absWorkingDir: root,
  entryPoints: ["worker/modules/maps.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`;
const { listMapImportJobs } = await import(moduleUrl);

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

async function callList(database) {
  const response = await listMapImportJobs({ DB: new D1Database(database) });
  assert.equal(response.status, 200);
  return (await response.json()).items;
}

test("listMapImportJobs returns parsed payload fields and joined file name", async () => {
  const database = freshDatabase();
  const now = "2026-08-01T00:00:00.000Z";
  database.prepare(
    `insert into media_assets(id,bucket_scope,object_key,original_name,content_type,byte_size,sha256,status,created_at)
     values('media_a','private','maps/a.svg','宝山校区.svg','image/svg+xml',10,?, 'approved',?)`,
  ).run("0".repeat(64), now);
  database.prepare(
    `insert into jobs(id,job_type,idempotency_key,status,payload_json,attempt_count,error_message,created_at,started_at,finished_at)
     values('job_a','map_import','key-a','failed',?,2,'missing footprint',?,?,?)`,
  ).run(
    JSON.stringify({ mediaAssetId: "media_a", campusId: "campus_a", versionLabel: "2026-08-01" }),
    now,
    now,
    now,
  );

  const items = await callList(database);
  assert.equal(items.length, 1);
  assert.deepEqual({ ...items[0] }, {
    id: "job_a",
    jobType: "map_import",
    status: "failed",
    attemptCount: 2,
    errorMessage: "missing footprint",
    versionLabel: "2026-08-01",
    campusId: "campus_a",
    floorId: null,
    mediaAssetId: "media_a",
    fileName: "宝山校区.svg",
    anchorReview: [],
    anchorAutoMigrated: [],
    createdAt: now,
    startedAt: now,
    finishedAt: now,
  });
  database.close();
});

test("listMapImportJobs degrades payload fields to null instead of failing on bad payload", async () => {
  const database = freshDatabase();
  const now = "2026-08-01T00:00:00.000Z";
  // payload_json 有 json_valid 约束，「损坏」指合法 JSON 但不是预期的对象结构
  database.prepare(
    `insert into jobs(id,job_type,idempotency_key,status,payload_json,attempt_count,created_at)
     values('job_bad','floor_import','key-bad','queued','[]',0,?)`,
  ).run(now);

  const items = await callList(database);
  assert.equal(items.length, 1);
  const row = { ...items[0] };
  assert.equal(row.id, "job_bad");
  assert.equal(row.versionLabel, null);
  assert.equal(row.campusId, null);
  assert.equal(row.floorId, null);
  assert.equal(row.mediaAssetId, null);
  assert.equal(row.fileName, null);
  database.close();
});

test("listMapImportJobs returns an empty list when there are no import jobs", async () => {
  const database = freshDatabase();
  const items = await callList(database);
  assert.deepEqual(items, []);
  database.close();
});

test("listMapImportJobs parses anchorReview from succeeded job result", async () => {
  const database = freshDatabase();
  const now = "2026-08-01T00:00:00.000Z";
  database.prepare(
    `insert into jobs(id,job_type,idempotency_key,status,payload_json,result_json,attempt_count,created_at)
     values('job_ok','map_import','key-ok','succeeded',?,?,0,?)`,
  ).run(
    JSON.stringify({ mediaAssetId: "media_x", campusId: "campus_a", versionLabel: "v1" }),
    JSON.stringify({
      mapVersionId: "mapver_x",
      featureCount: 10,
      anchorReview: [
        { anchorId: "anchor_1", role: "primary_display", entityType: "facility", entityId: "facility_1", entityName: "饮水点" },
        { broken: true },
      ],
      anchorAutoMigrated: [
        { anchorId: "anchor_2", role: "boarding_point", entityType: "transit_stop", entityId: "stop_1", entityName: "北门" },
      ],
    }),
    now,
  );

  const items = await callList(database);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].anchorReview, [
    { anchorId: "anchor_1", role: "primary_display", entityType: "facility", entityId: "facility_1", entityName: "饮水点" },
    { anchorId: null, role: null, entityType: null, entityId: null, entityName: null },
  ]);
  assert.deepEqual(items[0].anchorAutoMigrated, [
    { anchorId: "anchor_2", role: "boarding_point", entityType: "transit_stop", entityId: "stop_1", entityName: "北门" },
  ]);
  database.close();
});
