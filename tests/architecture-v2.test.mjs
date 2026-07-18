import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("v2 schema encodes the agreed spatial model", () => {
  const sql = fs.readFileSync(path.join(root, "migrations-v2/0001_architecture_v2.sql"), "utf8");
  assert.match(sql, /create table location_anchors/i);
  assert.match(sql, /create table entity_locations/i);
  assert.match(sql, /create unique index idx_entity_locations_one_primary/i);
  assert.match(sql, /map_version_id text references map_versions/i);
  assert.match(sql, /facility_instances/i);
  assert.doesNotMatch(sql, /create table poi_bindings/i);
});

test("v2 release model is immutable and explicit", () => {
  const sql = fs.readFileSync(path.join(root, "migrations-v2/0001_architecture_v2.sql"), "utf8");
  assert.match(sql, /create table release_items/i);
  assert.match(sql, /create table release_map_versions/i);
  assert.match(sql, /create table release_activations/i);
  assert.match(sql, /create unique index idx_one_active_release/i);
});

test("seed generator is non-destructive and imports canonical entities", () => {
  const output = execFileSync(process.execPath, [path.join(root, "scripts/generate_v2_seed.mjs")], { encoding: "utf8" });
  assert.match(output, /pragma foreign_keys = on;/);
  assert.match(output, /insert or ignore into places/);
  assert.match(output, /insert or ignore into location_anchors/);
  assert.match(output, /insert or ignore into transit_trips/);
  assert.doesNotMatch(output, /delete from/i);
});

test("worker entrypoint exposes only v2 routes", () => {
  const source = fs.readFileSync(path.join(root, "worker/index-v2.ts"), "utf8");
  assert.match(source, /\/api\/public\/releases\/current/);
  assert.match(source, /\/api\/admin\/releases/);
  assert.match(source, /ReleaseCoordinator/);
  assert.doesNotMatch(source, /\/api\/auth\/setup/);
  assert.doesNotMatch(source, /\/api\/media\/file\?key/);
});
