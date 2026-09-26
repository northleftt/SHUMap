import test from "node:test";
import crypto from "node:crypto";
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
      export { processQueue } from "./worker/modules/jobs.ts";
      export { ReleaseCoordinator } from "./worker/modules/releases.ts";
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

test("non-building place cannot declare a footprint location", async () => {
  const databaseSync = database();
  const feature = databaseSync.prepare(
    `select id from map_features
      where map_version_id='map_version_campus_baoshan' and feature_kind='building_footprint'
      order by id limit 1`,
  ).get();
  assert.ok(feature);
  const env = { DB: new D1Database(databaseSync) };

  const draft = revision(feature.id);
  const nonBuilding = {
    ...draft,
    structure: { ...draft.structure, building: null },
  };
  await assert.rejects(
    handlers.createPlaceHandler(request(nonBuilding), env, principal, "request_create_non_building"),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, "validation_error");
      assert.match(error.message, /Only a building place can have a footprint location/);
      return true;
    },
  );
  databaseSync.close();
});

async function existingBuildingDraft(db) {
  db.prepare("update map_versions set created_at='2026-08-01T00:00:00Z'").run();
  const env = { DB: new D1Database(db) };
  const feature = db.prepare("select id from map_features where map_version_id='map_version_campus_baoshan' and feature_kind='building_footprint' order by id limit 1").get();
  const created = await (await handlers.createPlaceHandler(request(revision(feature.id)), env, principal, 'create')).json();
  await handlers.submitRevision(request({}), env, principal, 'place', created.revisionId, 'submit');
  await handlers.reviewRevision(request({ decision: 'approve' }), env, principal, 'place', created.revisionId, 'approve');
  const original = db.prepare('select * from place_revisions where id=?').get(created.revisionId);
  db.prepare(`insert into place_revisions(id,place_id,revision_no,editorial_status,display_name,summary,description,content_json,structure_json,source_id,based_on_revision_id,content_hash,created_by,created_at)
    values('draft_after_import',?,2,'in_review',?,?,?,?,?,?,?,?,?,?)`).run(created.id, '只修改名称', original.summary, original.description, original.content_json, original.structure_json, original.source_id, created.revisionId, original.content_hash, principal.userId, '2026-09-01T00:00:00Z');
  return { env, featureId: feature.id, placeId: created.id, draftId: 'draft_after_import' };
}

function nextMap(db, fromFeatureId, suffix, options = {}) {
  const from = db.prepare('select * from map_features where id=?').get(fromFeatureId);
  const mapId = `map_next_${suffix}`, featureId = `feature_next_${suffix}`;
  db.prepare(`insert into map_versions(id,campus_id,map_asset_id,parent_version_id,version_label,coordinate_space_type,coordinate_space_json,lifecycle_status,created_at)
    select ?,campus_id,map_asset_id,id,?,'svg_viewbox','{"x":0,"y":0,"width":921.6,"height":1019.7}','ready',? from map_versions where id=?`).run(mapId, suffix, `2026-09-${suffix}T00:00:00Z`, from.map_version_id);
  db.prepare(`insert into map_features(id,map_version_id,stable_feature_key,source_element_id,feature_kind,geometry_json,metadata_json)
    values(?,?,?,?,'building_footprint',?,'{}')`).run(featureId,mapId,from.stable_feature_key,from.source_element_id,options.geometry ?? from.geometry_json);
  db.prepare('insert into map_feature_mappings(from_feature_id,to_feature_id,mapping_status,confidence) values(?,?,?,?)').run(fromFeatureId,featureId,options.status ?? 'automatic',options.confidence ?? 1);
  return { mapId, featureId };
}

function liveFootprint(db, placeId) {
  return db.prepare(`select la.* from location_anchors la join entity_locations el on el.anchor_id=la.id
    where el.entity_id=? and el.role='footprint' and el.valid_to is null`).get(placeId);
}

test('approval after multiple map imports preserves migrated footprint and updates approved snapshot/hash', async () => {
  const db = database();
  const { env, featureId, placeId, draftId } = await existingBuildingDraft(db);
  const middle = nextMap(db, featureId, '02');
  const current = nextMap(db, middle.featureId, '03', { geometry: '{"type":"MultiPolygon","coordinates":[[[[0,0],[1,0],[1,1],[0,0]]]]}' });
  db.prepare('update location_anchors set map_version_id=?,map_feature_id=?,geometry_type=? where id=?').run(current.mapId,current.featureId,'MultiPolygon',liveFootprint(db,placeId).id);
  const beforeHash = db.prepare('select content_hash from place_revisions where id=?').get(draftId).content_hash;
  await handlers.reviewRevision(request({ decision: 'approve' }),env,principal,'place',draftId,'approve_stale');
  const live = liveFootprint(db,placeId);
  assert.equal(live.map_version_id,current.mapId);
  assert.equal(live.map_feature_id,current.featureId);
  assert.equal(live.geometry_type,'MultiPolygon');
  const approved = db.prepare('select * from place_revisions where id=?').get(draftId);
  assert.equal(approved.display_name,'只修改名称');
  assert.equal(JSON.parse(approved.structure_json).locations[0].mapFeatureId,current.featureId);
  assert.notEqual(approved.content_hash,beforeHash);
  db.close();
});

for (const scenario of ['missing','ambiguous','cycle','rejected','low-confidence','cross-campus','non-polygon','occupied']) {
  test(`approval refuses ${scenario} footprint mapping without replacing live locations`, async () => {
    const db = database();
    const { env,featureId,placeId,draftId } = await existingBuildingDraft(db);
    const current = nextMap(db,featureId,'02');
    if (scenario === 'missing') db.prepare('delete from map_feature_mappings where from_feature_id=?').run(featureId);
    if (scenario === 'ambiguous') nextMap(db,featureId,'03');
    if (scenario === 'cycle') {
      nextMap(db,current.featureId,'03');
      db.prepare('update map_feature_mappings set to_feature_id=? where from_feature_id=?').run(featureId,current.featureId);
    }
    if (scenario === 'rejected') db.prepare("update map_feature_mappings set mapping_status='rejected' where from_feature_id=?").run(featureId);
    if (scenario === 'low-confidence') db.prepare('update map_feature_mappings set confidence=0.5 where from_feature_id=?').run(featureId);
    if (scenario === 'cross-campus') db.prepare("update map_versions set campus_id='campus_jiading' where id='map_version_campus_baoshan'").run();
    if (scenario === 'non-polygon') db.prepare(`update map_features set geometry_json='{"type":"Point","coordinates":[1,1]}' where id=?`).run(current.featureId);
    if (scenario === 'occupied') {
      db.prepare("insert into places(id,kind_id,campus_id,lifecycle_status,created_at,updated_at) values('other_building','building','campus_baoshan','active','2026-09-01','2026-09-01')").run();
      db.prepare("insert into buildings(place_id,public_access_level) values('other_building','unknown')").run();
      const other = { place_id: 'other_building' };
      db.prepare(`insert into location_anchors(id,campus_id,building_place_id,role,geometry_type,map_version_id,map_feature_id,precision_level,verification_status,created_at,updated_at)
        values('occupied','campus_baoshan',?,'footprint','Polygon',?,?,'exact','verified','2026-09-01','2026-09-01')`).run(other.place_id,current.mapId,current.featureId);
      db.prepare(`insert into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,created_at)
        values('occupied','place',?,'occupied','footprint',0,'2026-09-01')`).run(other.place_id);
    }
    const before = liveFootprint(db,placeId);
    await assert.rejects(handlers.reviewRevision(request({ decision:'approve' }),env,principal,'place',draftId,'blocked'),error => {
      assert.equal(error.code,['occupied','cross-campus'].includes(scenario) ? 'validation_error' : 'footprint_migration_required');
      return true;
    });
    assert.deepEqual(liveFootprint(db,placeId),before);
    assert.equal(db.prepare('select editorial_status from place_revisions where id=?').get(draftId).editorial_status,'in_review');
    db.close();
  });
}

test('rejecting a stale draft does not require a migration or change current locations', async () => {
  const db = database();
  const { env,featureId,placeId,draftId } = await existingBuildingDraft(db);
  nextMap(db,featureId,'02');
  db.prepare('delete from map_feature_mappings where from_feature_id=?').run(featureId);
  const before = liveFootprint(db,placeId);
  await handlers.reviewRevision(request({ decision:'reject' }),env,principal,'place',draftId,'reject');
  assert.deepEqual(liveFootprint(db,placeId),before);
  db.close();
});

test('real map import followed by text-only draft approval publishes the migrated footprint', async () => {
  const db = database();
  const { env,featureId,placeId,draftId } = await existingBuildingDraft(db);
  const source = db.prepare('select source_element_id from map_features where id=?').get(featureId).source_element_id;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 856 842"><rect id="${source}" x="1" y="1" width="20" height="30"/></svg>`;
  const bytes = new TextEncoder().encode(svg);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  db.prepare(`insert into media_assets(id,bucket_scope,object_key,original_name,content_type,byte_size,sha256,status,created_at)
    values('import_media','private','maps/regression.svg','regression.svg','image/svg+xml',?,?,'approved','2026-09-01')`).run(bytes.length,digest);
  db.prepare(`insert into jobs(id,job_type,idempotency_key,status,payload_json,attempt_count,created_at)
    values('import_regression','map_import','regression','queued',?,0,'2026-09-01')`).run(JSON.stringify({ mediaAssetId:'import_media',campusId:'campus_baoshan',versionLabel:'regression-import' }));
  const objects = new Map([['maps/regression.svg',bytes]]);
  env.SHUMAP_BUCKET = {
    async get(key) { const bytes=objects.get(key); return bytes ? { size:bytes.length,arrayBuffer:async()=>bytes.slice().buffer } : null; },
    async put(key,value) { objects.set(key,new TextEncoder().encode(value)); },
  };
  const item = { body:{jobId:'import_regression',jobType:'map_import'},ack(){},retry(){throw Error('unexpected retry');} };
  await handlers.processQueue({messages:[item]},env);
  assert.equal(db.prepare("select status from jobs where id='import_regression'").get().status,'succeeded');
  const migrated = liveFootprint(db,placeId);
  assert.notEqual(migrated.map_feature_id,featureId);
  await handlers.reviewRevision(request({decision:'approve'}),env,principal,'place',draftId,'approve_imported');
  assert.equal(liveFootprint(db,placeId).map_feature_id,migrated.map_feature_id);
  const coordinator = new handlers.ReleaseCoordinator({blockConcurrencyWhile:callback=>callback()},env);
  const response = await coordinator.fetch(new Request('https://release.internal/release',{
    method:'POST',headers:{'content-type':'application/json','x-shumap-user-id':principal.userId},
    body:JSON.stringify({version:'regression-release',summary:null,reason:null,mapVersionIds:[migrated.map_version_id]}),
  }));
  const result = await response.json();
  assert.equal(response.status,201,JSON.stringify(result));
  assert.equal(result.validation.valid,true);
  const release = db.prepare('select artifact_key from releases where id=?').get(result.id);
  const manifest = JSON.parse(new TextDecoder().decode(objects.get(release.artifact_key)));
  const footprint = manifest.locations.find(row=>row.entityId===placeId && row.role==='footprint');
  assert.equal(footprint.map_version_id,migrated.map_version_id);
  assert.equal(footprint.map_feature_id,migrated.map_feature_id);
  db.close();
});

test('approval preserves an intentional selection on the current map', async () => {
  const db=database();
  const { env,featureId,placeId,draftId }=await existingBuildingDraft(db);
  const current=nextMap(db,featureId,'02');
  const row=db.prepare('select structure_json from place_revisions where id=?').get(draftId);
  const structure=JSON.parse(row.structure_json);
  structure.locations[0].mapVersionId=current.mapId;
  structure.locations[0].mapFeatureId=current.featureId;
  structure.locations[0].locationHint='保留编辑的位置说明';
  db.prepare('update place_revisions set structure_json=? where id=?').run(JSON.stringify(structure),draftId);
  db.prepare('delete from map_feature_mappings where from_feature_id=?').run(featureId);
  await handlers.reviewRevision(request({decision:'approve'}),env,principal,'place',draftId,'approve_current');
  assert.equal(liveFootprint(db,placeId).map_feature_id,current.featureId);
  assert.equal(liveFootprint(db,placeId).location_hint,'保留编辑的位置说明');
  db.close();
});

test('confirmed lineage supports a draft referencing an archived source map', async () => {
  const db=database();
  const { env,featureId,placeId,draftId }=await existingBuildingDraft(db);
  const current=nextMap(db,featureId,'02',{status:'confirmed',confidence:0.8});
  db.prepare("update map_versions set lifecycle_status='archived' where id='map_version_campus_baoshan'").run();
  await handlers.reviewRevision(request({decision:'approve'}),env,principal,'place',draftId,'approve_archived');
  assert.equal(liveFootprint(db,placeId).map_feature_id,current.featureId);
  db.close();
});
