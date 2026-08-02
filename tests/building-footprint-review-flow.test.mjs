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
      export { createPlaceHandler } from "./worker/modules/places.ts";
      export { submitRevision, reviewRevision } from "./worker/modules/reviews.ts";
    `,
    resolveDir: root,
    sourcefile: "building-footprint-review-flow-entry.ts",
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

function database() {
  const database = new DatabaseSync(":memory:");
  database.exec("pragma foreign_keys=on");
  for (const name of fs.readdirSync(path.join(root, "migrations-v2")).filter((value) => value.endsWith(".sql")).sort()) {
    database.exec(fs.readFileSync(path.join(root, "migrations-v2", name), "utf8"));
  }
  const now = "2026-08-01T00:00:00.000Z";
  database.prepare(
    `insert into users(id,email,display_name,password_hash,status,token_version,created_at,updated_at)
     values('user_editor','editor@example.test','编辑','hash','active',1,?,?)`,
  ).run(now, now);
  return database;
}

function request(body) {
  return new Request("https://example.test/api/admin/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function revision(featureId) {
  return {
    displayName: "新楼宇",
    summary: null,
    description: null,
    content: { detail: { facts: [], media: [] } },
    sourceId: null,
    structure: {
      kindId: "building",
      campusId: "campus_baoshan",
      parentPlaceId: null,
      stableCode: "building-review-flow",
      aliases: [],
      building: { buildingCode: "BRF", managingOrganizationId: null, publicAccessLevel: "unknown" },
      locations: [{
        campusId: "campus_baoshan",
        buildingPlaceId: null,
        floorId: null,
        indoorSpaceId: null,
        role: "footprint",
        geometryType: "Polygon",
        geometry: null,
        crs: null,
        mapVersionId: "map_version_campus_baoshan",
        mapFeatureId: featureId,
        locationHint: null,
        precisionLevel: "exact",
        accuracyMeters: null,
        sourceId: null,
        validFrom: null,
        validTo: null,
        isPrimary: true,
      }],
    },
  };
}

const principal = { userId: "user_editor", permissions: ["write:content", "review:content"] };

test("new building review binds an imported SVG feature through canonical locations", async () => {
  const databaseSync = database();
  const feature = databaseSync.prepare(
    `select id from map_features
      where map_version_id='map_version_campus_baoshan' and feature_kind='building_footprint'
      order by id limit 1`,
  ).get();
  assert.ok(feature);
  databaseSync.prepare("update map_features set feature_kind='other',stable_feature_key=null where id=?").run(feature.id);
  const env = { DB: new D1Database(databaseSync) };

  const createdResponse = await handlers.createPlaceHandler(request(revision(feature.id)), env, principal, "request_create");
  const created = await createdResponse.json();
  const storedStructure = JSON.parse(databaseSync.prepare("select structure_json from place_revisions where id=?").get(created.revisionId).structure_json);
  assert.equal(storedStructure.locations[0].buildingPlaceId, created.id);

  await handlers.submitRevision(request({}), env, principal, "place", created.revisionId, "request_submit");
  await handlers.reviewRevision(
    request({ decision: "approve", note: null }),
    env,
    principal,
    "place",
    created.revisionId,
    "request_approve",
  );

  const applied = databaseSync.prepare(
    `select p.lifecycle_status as lifecycleStatus,p.approval_pending as approvalPending,
            e.entity_id as entityId,a.building_place_id as buildingPlaceId,
            a.map_feature_id as mapFeatureId,mf.feature_kind as featureKind,mf.stable_feature_key as stableFeatureKey
       from places p join entity_locations e on e.entity_type='place' and e.entity_id=p.id and e.role='footprint'
       join location_anchors a on a.id=e.anchor_id join map_features mf on mf.id=a.map_feature_id
      where p.id=?`,
  ).get(created.id);
  assert.deepEqual({ ...applied }, {
    lifecycleStatus: "active",
    approvalPending: 0,
    entityId: created.id,
    buildingPlaceId: created.id,
    mapFeatureId: feature.id,
    featureKind: "building_footprint",
    stableFeatureKey: `place:${created.id}`,
  });
  databaseSync.close();
});
