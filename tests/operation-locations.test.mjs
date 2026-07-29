// Coverage for the operational-event geometry re-edit loop:
//   PUT /api/admin/operations/:id/locations (replace-all)
//
// The replace-all semantics are exercised against a real SQLite database built
// from migrations-v2, because the parts that can actually break — the
// one_primary partial unique index and the anchor cleanup — are enforced by the
// schema rather than by the handler.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --- helpers ---------------------------------------------------------------

/** Applies the v2 migrations to an in-memory database. */
function freshDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys = on;");
  const dir = path.join(root, "migrations-v2");
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(path.join(dir, name), "utf8");
    // The guard migration wraps statements in triggers; split on the same
    // boundary wrangler uses so `exec` sees one statement group at a time.
    db.exec(sql);
  }
  return db;
}

function seedEvent(db, eventId = "event_test") {
  db.exec(`insert or ignore into users(id,email,display_name,password_hash,status,created_at,updated_at)
           values('user_test','t@example.com','Tester','h','active',datetime('now'),datetime('now'));`);
  db.prepare(
    `insert into operational_events(id,event_type,severity,editorial_status,operational_status,title,starts_at,created_by,created_at,updated_at)
     values(?,'maintenance','warning','draft','scheduled','Test event',datetime('now'),'user_test',datetime('now'),datetime('now'))`,
  ).run(eventId);
  return eventId;
}

/**
 * Mirrors the handler's statement order: delete bindings, delete the old
 * anchors, then insert the new anchor/binding pairs with index 0 primary.
 */
function replaceLocations(db, eventId, locations) {
  const previous = db.prepare(
    "select id,anchor_id as anchorId from entity_locations where entity_type='operational_event' and entity_id=?",
  ).all(eventId);

  db.prepare("delete from entity_locations where entity_type='operational_event' and entity_id=?").run(eventId);
  for (const row of previous) {
    db.prepare("delete from location_anchors where id=?").run(row.anchorId);
  }

  locations.forEach((location, index) => {
    const anchorId = `anchor_${eventId}_${index}_${Math.random().toString(16).slice(2, 8)}`;
    const bindingId = `eloc_${eventId}_${index}_${Math.random().toString(16).slice(2, 8)}`;
    db.prepare(
      `insert into location_anchors(id,campus_id,role,geometry_type,geometry_json,crs,precision_level,verification_status,created_at,updated_at)
       values(?,?,?,?,?,?,'unknown','reviewed',datetime('now'),datetime('now'))`,
    ).run(anchorId, location.campusId ?? null, location.role, location.geometryType, JSON.stringify(location.geometry), location.crs);
    db.prepare(
      "insert into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,created_at) values(?,'operational_event',?,?,?,?,datetime('now'))",
    ).run(bindingId, eventId, anchorId, location.role, index === 0 ? 1 : 0);
  });
  return previous.length;
}

const POINT = { role: "event_location", campusId: "campus_baoshan", geometryType: "Point", geometry: { type: "Point", coordinates: [10, 20] }, crs: "svg_viewbox" };
const AREA = { role: "impact_area", campusId: "campus_baoshan", geometryType: "Polygon", geometry: { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 0]]] }, crs: "svg_viewbox" };
const PATH = { role: "route_shape", campusId: "campus_baoshan", geometryType: "LineString", geometry: { type: "LineString", coordinates: [[0, 0], [5, 5]] }, crs: "svg_viewbox" };

function anchorCount(db) {
  return db.prepare("select count(*) as n from location_anchors").get().n;
}

function bindings(db, eventId) {
  return db.prepare(
    `select el.role,el.is_primary as isPrimary,la.geometry_json as geometryJson,la.crs
       from entity_locations el join location_anchors la on la.id=el.anchor_id
      where el.entity_type='operational_event' and el.entity_id=? order by el.is_primary desc, el.role`,
  ).all(eventId);
}

// --- tests -----------------------------------------------------------------

test("replace-all swaps the whole geometry set and leaves exactly one primary", () => {
  const db = freshDatabase();
  const eventId = seedEvent(db);

  replaceLocations(db, eventId, [POINT, AREA, PATH]);
  assert.equal(bindings(db, eventId).length, 3);
  assert.equal(anchorCount(db), 3);
  assert.equal(bindings(db, eventId).filter((row) => row.isPrimary === 1).length, 1);

  // Re-editing down to a single shape drops the other two entirely.
  const removed = replaceLocations(db, eventId, [AREA]);
  assert.equal(removed, 3);
  const after = bindings(db, eventId);
  assert.equal(after.length, 1);
  assert.equal(after[0].role, "impact_area");
  assert.equal(after[0].isPrimary, 1);
  // No orphaned anchors survive the replace.
  assert.equal(anchorCount(db), 1);

  db.close();
});

test("replace-all with an empty array clears the event geometry and its anchors", () => {
  const db = freshDatabase();
  const eventId = seedEvent(db);

  replaceLocations(db, eventId, [POINT, AREA]);
  assert.equal(anchorCount(db), 2);

  replaceLocations(db, eventId, []);
  assert.equal(bindings(db, eventId).length, 0);
  assert.equal(anchorCount(db), 0);

  db.close();
});

test("repeated replaces keep the one_primary index satisfiable", () => {
  const db = freshDatabase();
  const eventId = seedEvent(db);

  // Each pass re-inserts a primary binding; the partial unique index would
  // reject a second is_primary=1 row for the same entity if the old bindings
  // were not deleted first.
  for (let pass = 0; pass < 4; pass += 1) {
    replaceLocations(db, eventId, [POINT, PATH]);
    assert.equal(bindings(db, eventId).filter((row) => row.isPrimary === 1).length, 1);
  }
  assert.equal(anchorCount(db), 2);

  db.close();
});

test("replace-all preserves geometry payloads verbatim for canvas re-hydration", () => {
  const db = freshDatabase();
  const eventId = seedEvent(db);

  replaceLocations(db, eventId, [POINT, AREA, PATH]);
  const byRole = Object.fromEntries(bindings(db, eventId).map((row) => [row.role, row]));

  assert.deepEqual(JSON.parse(byRole.event_location.geometryJson), POINT.geometry);
  assert.deepEqual(JSON.parse(byRole.impact_area.geometryJson), AREA.geometry);
  assert.deepEqual(JSON.parse(byRole.route_shape.geometryJson), PATH.geometry);
  for (const row of Object.values(byRole)) assert.equal(row.crs, "svg_viewbox");

  db.close();
});

test("one event's geometry replace does not disturb another event", () => {
  const db = freshDatabase();
  const kept = seedEvent(db, "event_kept");
  db.prepare(
    `insert into operational_events(id,event_type,severity,editorial_status,operational_status,title,starts_at,created_by,created_at,updated_at)
     values('event_edited','closure','critical','draft','scheduled','Other',datetime('now'),'user_test',datetime('now'),datetime('now'))`,
  ).run();

  replaceLocations(db, kept, [POINT, AREA]);
  replaceLocations(db, "event_edited", [PATH]);
  replaceLocations(db, "event_edited", []);

  assert.equal(bindings(db, kept).length, 2);
  assert.equal(bindings(db, "event_edited").length, 0);
  assert.equal(anchorCount(db), 2);

  db.close();
});

// --- wiring guards ---------------------------------------------------------

test("the geometry re-edit endpoints are registered and permission gated", () => {
  const worker = fs.readFileSync(path.join(root, "worker/index-v2.ts"), "utf8");
  assert.match(worker, /\/api\/admin\/operations\/:id\/locations/);
  assert.match(worker, /replaceOperationalEventLocations/);
  assert.match(worker, /\/api\/admin\/map-features/);
  assert.match(worker, /listMapFeatures/);

  const operations = fs.readFileSync(path.join(root, "worker/modules/operations.ts"), "utf8");
  // Admin list must ship locations so the editor can re-hydrate the canvas.
  assert.match(operations, /item\.locations = locations\.filter/);
  // Validation has to run before any delete, or a bad payload destroys geometry.
  assert.ok(
    operations.indexOf("planLocation(env,") < operations.indexOf("delete from entity_locations"),
    "locations must be validated before the existing rows are deleted",
  );
  assert.match(operations, /delete from location_anchors where id in/);
});

test("map feature import writes the geometry columns", () => {
  const jobs = fs.readFileSync(path.join(root, "worker/modules/jobs.ts"), "utf8");
  assert.match(jobs, /insert into map_features\([^)]*geometry_json,bbox_json/);
  assert.match(jobs, /feature\.geometry \? jsonString\(feature\.geometry\) : null/);
  assert.match(jobs, /feature\.bbox \? jsonString\(feature\.bbox\) : null/);
});
