// Coverage for the M5 floor-plan asset chain:
//   GET /api/public/maps/:mapVersionId/asset
//
// The gate that matters is release membership: only a map version listed in
// release_map_versions for the currently ACTIVE release may be streamed out of
// R2. That is a SQL join, so it is exercised against a real SQLite database
// built from migrations-v2 rather than mocked.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Applies the v2 migrations to an in-memory database. */
function freshDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys = on;");
  const dir = path.join(root, "migrations-v2");
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    db.exec(fs.readFileSync(path.join(dir, name), "utf8"));
  }
  return db;
}

/**
 * The exact query worker/modules/public.ts#getPublicMapAsset runs: the media row
 * is reachable only through release_map_versions of the active release.
 */
const ASSET_QUERY = `select me.object_key,me.content_type,me.sha256,me.bucket_scope,me.status
   from release_map_versions rmv
   join releases rel on rel.id=rmv.release_id and rel.status='active'
   join map_versions mv on mv.id=rmv.map_version_id
   join map_assets ma on ma.id=mv.map_asset_id
   join media_assets me on me.id=ma.media_asset_id
  where rmv.map_version_id=?`;

const READABLE_SCOPES = ["private", "public"];
const READABLE_STATUSES = ["approved", "published"];
const RENDERABLE_TYPES = ["image/svg+xml", "image/png", "image/jpeg", "image/webp"];

/** Mirrors the handler: query + scope/status/content-type guards. 404 => null. */
function resolveAsset(db, mapVersionId) {
  const row = db.prepare(ASSET_QUERY).get(mapVersionId);
  if (!row) return null;
  if (!READABLE_SCOPES.includes(row.bucket_scope)) return null;
  if (!READABLE_STATUSES.includes(row.status)) return null;
  if (!RENDERABLE_TYPES.includes(row.content_type.toLowerCase())) return null;
  return row;
}

// migrations-v2/0001 already seeds campuses ('campus_baoshan') and place_kinds
// ('building'); re-inserting them would trip the primary keys.
function seedBase(db) {
  const now = "2026-07-30T00:00:00.000Z";
  db.exec(`
    insert into users(id,email,display_name,password_hash,status,created_at,updated_at)
      values('user_test','t@example.com','Tester','h','active','${now}','${now}');
    insert into places(id,kind_id,campus_id,lifecycle_status,created_at,updated_at)
      values('place_lib','building','campus_baoshan','active','${now}','${now}');
    insert into buildings(place_id,public_access_level) values('place_lib','public');
    insert into floors(id,building_place_id,level_code,level_order,display_name,is_public,created_at,updated_at)
      values('floor_lib_1','place_lib','F1',1,'一层',1,'${now}','${now}');
  `);
  return now;
}

/**
 * One floor map version: media asset (private/approved, as the import pipeline
 * leaves it) -> map_asset -> map_version bound to floor_id.
 */
function seedFloorMapVersion(db, suffix, { status = "approved", scope = "private", contentType = "image/svg+xml", lifecycle = "ready" } = {}) {
  const now = "2026-07-30T00:00:00.000Z";
  db.prepare(
    `insert into media_assets(id,bucket_scope,object_key,original_name,content_type,byte_size,sha256,status,created_at)
     values(?,?,?,?,?,?,?,?,?)`,
  ).run(`media_${suffix}`, scope, `private/imports/media_${suffix}/plan.svg`, "plan.svg", contentType, 1024, `sha_${suffix}`, status, now);
  db.prepare(
    "insert into map_assets(id,asset_type,media_asset_id,checksum,metadata_json,created_at) values(?,'floor_svg',?,?,'{}',?)",
  ).run(`mapasset_${suffix}`, `media_${suffix}`, `sha_${suffix}`, now);
  db.prepare(
    `insert into map_versions(id,campus_id,floor_id,map_asset_id,version_label,coordinate_space_type,coordinate_space_json,parser_version,lifecycle_status,created_at)
     values(?,null,'floor_lib_1',?,?,'svg_viewbox','{}','svg-dom-v2',?,?)`,
  ).run(`mapver_${suffix}`, `mapasset_${suffix}`, suffix, lifecycle, now);
  return `mapver_${suffix}`;
}

function seedRelease(db, id, status, mapVersionIds) {
  const now = "2026-07-30T00:00:00.000Z";
  db.prepare(
    `insert into releases(id,version,schema_version,status,artifact_key,artifact_sha256,created_by,created_at)
     values(?,?,2,?,?,?, 'user_test',?)`,
  ).run(id, `v-${id}`, status, `release/artifacts/${id}/manifest.json`, `hash_${id}`, now);
  for (const mapVersionId of mapVersionIds) {
    db.prepare("insert into release_map_versions(release_id,map_version_id) values(?,?)").run(id, mapVersionId);
  }
  return id;
}

// --- release membership gate -----------------------------------------------

test("a floor map version in the active release is readable", () => {
  const db = freshDatabase();
  seedBase(db);
  const mapVersionId = seedFloorMapVersion(db, "active", { lifecycle: "published" });
  seedRelease(db, "release_now", "active", [mapVersionId]);

  const asset = resolveAsset(db, mapVersionId);
  assert.ok(asset, "active release member must resolve");
  assert.equal(asset.object_key, "private/imports/media_active/plan.svg");
  assert.equal(asset.content_type, "image/svg+xml");
  // The object stays on its original private key — no public copy is made.
  assert.equal(asset.bucket_scope, "private");
  assert.match(asset.object_key, /^private\/imports\//);

  db.close();
});

test("an imported but unreleased map version is not readable", () => {
  const db = freshDatabase();
  seedBase(db);
  const released = seedFloorMapVersion(db, "released", { lifecycle: "published" });
  // Import produced a 'ready' version that no release references yet.
  const pending = seedFloorMapVersion(db, "pending", { lifecycle: "ready" });
  seedRelease(db, "release_now", "active", [released]);

  assert.ok(resolveAsset(db, released));
  assert.equal(resolveAsset(db, pending), null, "a version outside the active release must 404");

  db.close();
});

test("membership in a superseded release does not grant public read", () => {
  const db = freshDatabase();
  seedBase(db);
  const oldVersion = seedFloorMapVersion(db, "old", { lifecycle: "archived" });
  const newVersion = seedFloorMapVersion(db, "new", { lifecycle: "published" });
  seedRelease(db, "release_old", "superseded", [oldVersion]);
  seedRelease(db, "release_new", "active", [newVersion]);

  assert.equal(resolveAsset(db, oldVersion), null, "superseded release members must 404");
  assert.ok(resolveAsset(db, newVersion));

  db.close();
});

test("a release that is only validating/ready never exposes its map versions", () => {
  const db = freshDatabase();
  seedBase(db);
  const candidate = seedFloorMapVersion(db, "candidate");
  seedRelease(db, "release_candidate", "ready", [candidate]);

  assert.equal(resolveAsset(db, candidate), null);

  // Flipping that release to active is what makes the asset readable.
  db.prepare("update releases set status='active' where id='release_candidate'").run();
  assert.ok(resolveAsset(db, candidate));

  db.close();
});

// --- object-level guards ---------------------------------------------------

test("quarantine objects cannot leak through the map asset channel", () => {
  const db = freshDatabase();
  seedBase(db);
  const mapVersionId = seedFloorMapVersion(db, "quarantined", { scope: "quarantine", status: "quarantined" });
  seedRelease(db, "release_now", "active", [mapVersionId]);

  // The join finds the row, but the scope/status guards still refuse it.
  assert.ok(db.prepare(ASSET_QUERY).get(mapVersionId));
  assert.equal(resolveAsset(db, mapVersionId), null);

  db.close();
});

test("non-image sources (PDF/CAD) are not served as renderable assets", () => {
  const db = freshDatabase();
  seedBase(db);
  const mapVersionId = seedFloorMapVersion(db, "pdf", { contentType: "application/pdf" });
  seedRelease(db, "release_now", "active", [mapVersionId]);

  assert.equal(resolveAsset(db, mapVersionId), null);

  db.close();
});

test("an unknown map version id resolves to nothing", () => {
  const db = freshDatabase();
  seedBase(db);
  seedRelease(db, "release_now", "active", []);
  assert.equal(resolveAsset(db, "mapver_does_not_exist"), null);
  db.close();
});

// --- wiring guards ---------------------------------------------------------

test("the public map asset endpoint is registered without a session gate", () => {
  const worker = fs.readFileSync(path.join(root, "worker/index-v2.ts"), "utf8");
  assert.match(worker, /\/api\/public\/maps\/:mapVersionId\/asset/);
  assert.match(worker, /getPublicMapAsset/);

  const publicModule = fs.readFileSync(path.join(root, "worker/modules/public.ts"), "utf8");
  // Membership must be part of the SQL, not an afterthought in JS.
  assert.match(publicModule, /join releases rel on rel\.id=rmv\.release_id and rel\.status='active'/);
  assert.match(publicModule, /x-content-type-options": "nosniff/);
  assert.match(publicModule, /content-security-policy/);
  // The asset must not be routed through the submission photo copy channel.
  assert.doesNotMatch(publicModule, /public\/media\//);
});

test("floor imports bind the map version to a floor, not a campus", () => {
  const jobs = fs.readFileSync(path.join(root, "worker/modules/jobs.ts"), "utf8");
  assert.match(jobs, /payload\.floorId \? "floor_svg" : "campus_svg"/);
  assert.match(jobs, /\.bind\(mapVersionId, payload\.campusId, payload\.floorId,/);
  assert.match(jobs, /Map import payload must identify exactly one campus or floor/);
  assert.match(jobs, /job\.job_type === "floor_import" && payload\.floorId === null/);

  const maps = fs.readFileSync(path.join(root, "worker/modules/maps.ts"), "utf8");
  // Exactly one of campusId/floorId, matching the map_versions check constraint.
  assert.match(maps, /Exactly one of campusId or floorId is required/);

  const mapsPage = fs.readFileSync(path.join(root, "src/admin/pages/MapsPage.tsx"), "utf8");
  assert.match(mapsPage, /assetType: targetKind === "floor" \? "floor_svg" : "campus_svg"/);
  assert.match(mapsPage, /floorId: targetKind === "floor" \? floorId : null/);
});

test("the map_versions check constraint still enforces campus/floor exclusivity", () => {
  const db = freshDatabase();
  seedBase(db);
  const now = "2026-07-30T00:00:00.000Z";
  db.prepare(
    `insert into media_assets(id,bucket_scope,object_key,original_name,content_type,byte_size,sha256,status,created_at)
     values('media_x','private','private/imports/media_x/plan.svg','plan.svg','image/svg+xml',10,'sha_x','approved',?)`,
  ).run(now);
  db.prepare(
    "insert into map_assets(id,asset_type,media_asset_id,checksum,metadata_json,created_at) values('mapasset_x','floor_svg','media_x','sha_x','{}',?)",
  ).run(now);

  const insertBoth = () =>
    db.prepare(
      `insert into map_versions(id,campus_id,floor_id,map_asset_id,version_label,coordinate_space_type,coordinate_space_json,lifecycle_status,created_at)
       values('mapver_x','campus_baoshan','floor_lib_1','mapasset_x','both','svg_viewbox','{}','ready',?)`,
    ).run(now);
  assert.throws(insertBoth, /constraint/i);

  const insertNeither = () =>
    db.prepare(
      `insert into map_versions(id,campus_id,floor_id,map_asset_id,version_label,coordinate_space_type,coordinate_space_json,lifecycle_status,created_at)
       values('mapver_y',null,null,'mapasset_x','neither','svg_viewbox','{}','ready',?)`,
    ).run(now);
  assert.throws(insertNeither, /constraint/i);

  db.close();
});
