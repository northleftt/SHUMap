// Regression guard for PR #2 review blocking 1:
// facility/merchant revisions written before indoor_spaces was dropped (0034) still
// carry `indoorSpaceId` in structure_json — at the structure level and inside each
// locations[] entry. The submit/review path re-validates stored JSON against the
// new exactRecord whitelist, so those legacy keys must be tolerated (stripped),
// not rejected with 400.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await build({
  stdin: {
    contents: `
      export { submitRevision, reviewRevision } from "./worker/modules/reviews.ts";
    `,
    resolveDir: root,
    sourcefile: "legacy-indoor-space-revision-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`;
const handlers = await import(moduleUrl);

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

const NOW = "2026-08-01T00:00:00.000Z";
const principal = { userId: "user_editor", permissions: ["write:content", "review:content"] };

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys=on");
  for (const name of fs.readdirSync(path.join(root, "migrations-v2")).filter((value) => value.endsWith(".sql")).sort()) {
    db.exec(fs.readFileSync(path.join(root, "migrations-v2", name), "utf8"));
  }
  db.prepare(
    `insert into users(id,email,display_name,password_hash,status,token_version,created_at,updated_at)
     values('user_editor','editor@example.test','编辑','hash','active',1,?,?)`,
  ).run(NOW, NOW);
  db.prepare(
    `insert into places(id,kind_id,campus_id,parent_place_id,stable_code,lifecycle_status,created_at,updated_at)
     values('place_host','building','campus_baoshan',null,'legacy-host','active',?,?)`,
  ).run(NOW, NOW);
  db.prepare(
    "insert into buildings(place_id,building_code,public_access_level) values('place_host','LH','unknown')",
  ).run();
  return db;
}

function request(body) {
  return new Request("https://example.test/api/admin/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// 0034 之前写库的结构：structure 与 locations[] 元素都带 indoorSpaceId。
function legacyLocation() {
  return {
    campusId: "campus_baoshan",
    buildingPlaceId: "place_host",
    floorId: null,
    indoorSpaceId: null,
    role: "service_position",
    geometryType: "Point",
    geometry: null,
    crs: null,
    mapVersionId: null,
    mapFeatureId: null,
    locationHint: "一楼服务台",
    precisionLevel: "building",
    accuracyMeters: null,
    sourceId: null,
    validFrom: null,
    validTo: null,
    isPrimary: true,
  };
}

test("a stored facility revision with legacy indoorSpaceId keys still submits and approves", async () => {
  const db = database();
  const env = { DB: new D1Database(db) };
  db.prepare(
    `insert into facility_instances(id,facility_type_id,host_place_id,floor_id,lifecycle_status,approval_pending,operational_status,quantity,created_at,updated_at)
     values('facility_legacy','facility_type_printer','place_host',null,'active',1,'available',1,?,?)`,
  ).run(NOW, NOW);
  db.prepare(
    `insert into facility_revisions(id,facility_id,revision_no,editorial_status,display_name,content_json,structure_json,content_hash,created_by,created_at)
     values('frev_legacy','facility_legacy',1,'draft','打印点','{}',?,'hash_legacy','user_editor',?)`,
  ).run(JSON.stringify({
    facilityTypeId: "facility_type_printer",
    hostPlaceId: "place_host",
    floorId: null,
    indoorSpaceId: null,
    quantity: 1,
    operationalStatus: "available",
    locations: [legacyLocation()],
  }), NOW);

  await handlers.submitRevision(request({}), env, principal, "facility", "frev_legacy", "request_submit");
  await handlers.reviewRevision(
    request({ decision: "approve", note: null }),
    env,
    principal,
    "facility",
    "frev_legacy",
    "request_approve",
  );

  const revision = db.prepare("select editorial_status as status from facility_revisions where id='frev_legacy'").get();
  assert.equal(revision.status, "approved");
  const facility = db.prepare(
    "select current_revision_id as currentRevisionId,approval_pending as approvalPending from facility_instances where id='facility_legacy'",
  ).get();
  assert.equal(facility.currentRevisionId, "frev_legacy");
  assert.equal(facility.approvalPending, 0);
  const anchor = db.prepare(
    `select a.building_place_id as buildingPlaceId from location_anchors a
       join entity_locations e on e.anchor_id=a.id
      where e.entity_type='facility' and e.entity_id='facility_legacy' and e.valid_to is null`,
  ).get();
  assert.equal(anchor.buildingPlaceId, "place_host", "locations[] 里的 legacy 键被丢弃后位置照常落库");
  db.close();
});

test("a stored merchant revision with legacy indoorSpaceId keys still submits and approves", async () => {
  const db = database();
  const env = { DB: new D1Database(db) };
  db.prepare(
    `insert into merchant_outlets(id,organization_id,host_place_id,floor_id,lifecycle_status,approval_pending,created_at,updated_at)
     values('merchant_legacy',null,'place_host',null,'active',1,?,?)`,
  ).run(NOW, NOW);
  db.prepare(
    `insert into merchant_revisions(id,outlet_id,revision_no,editorial_status,display_name,content_json,structure_json,content_hash,created_by,created_at)
     values('mrev_legacy','merchant_legacy',1,'draft','咖啡店','{}',?,'hash_legacy','user_editor',?)`,
  ).run(JSON.stringify({
    organizationId: null,
    hostPlaceId: "place_host",
    floorId: null,
    indoorSpaceId: null,
    locations: [legacyLocation()],
  }), NOW);

  await handlers.submitRevision(request({}), env, principal, "merchant", "mrev_legacy", "request_submit");
  await handlers.reviewRevision(
    request({ decision: "approve", note: null }),
    env,
    principal,
    "merchant",
    "mrev_legacy",
    "request_approve",
  );

  const revision = db.prepare("select editorial_status as status from merchant_revisions where id='mrev_legacy'").get();
  assert.equal(revision.status, "approved");
  const outlet = db.prepare(
    "select current_revision_id as currentRevisionId from merchant_outlets where id='merchant_legacy'",
  ).get();
  assert.equal(outlet.currentRevisionId, "mrev_legacy");
  db.close();
});
