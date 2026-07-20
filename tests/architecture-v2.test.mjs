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

test("collection workflow is persisted and routed through the public API", () => {
  const migration = fs.readFileSync(path.join(root, "migrations-v2/0002_collection_tasks.sql"), "utf8");
  const worker = fs.readFileSync(path.join(root, "worker/index-v2.ts"), "utf8");
  const module = fs.readFileSync(path.join(root, "worker/modules/collections.ts"), "utf8");
  assert.match(migration, /create table collection_tasks/i);
  assert.match(migration, /submission_id text references content_submissions/i);
  assert.match(worker, /\/api\/public\/collection-tasks/);
  assert.match(module, /collection_locked/);
  assert.match(module, /insert into content_submissions/i);
});

test("admin content lists expose pending revisions without changing the published pointer", () => {
  for (const file of ["places.ts", "facilities.ts", "merchants.ts"]) {
    const source = fs.readFileSync(path.join(root, "worker/modules", file), "utf8");
    assert.match(source, /editorial_status in \('draft','in_review'\)/i);
    assert.match(source, /current_revision_id/i);
    assert.match(source, /r\.id as currentRevisionId/i);
  }
});

test("public write APIs have persistent guards and analytics has a v2 route", () => {
  const migration = fs.readFileSync(path.join(root, "migrations-v2/0003_public_api_guards.sql"), "utf8");
  const worker = fs.readFileSync(path.join(root, "worker/index-v2.ts"), "utf8");
  const collections = fs.readFileSync(path.join(root, "worker/modules/collections.ts"), "utf8");
  assert.match(migration, /create table public_rate_limits/i);
  assert.match(migration, /create table analytics_events/i);
  assert.match(worker, /\/api\/analytics\/events/);
  assert.match(collections, /readJsonLimited/);
  assert.match(collections, /collection_lock_expired/);
  assert.match(collections, /select \?,'place',building_place_id/i);
});

test("review queue is revision-based and collected floors are materialized", () => {
  const reviews = fs.readFileSync(path.join(root, "worker/modules/reviews.ts"), "utf8");
  const submissions = fs.readFileSync(path.join(root, "worker/modules/submissions.ts"), "utf8");
  assert.match(reviews, /listPendingRevisions/);
  assert.match(reviews, /where r\.editorial_status='in_review'/);
  assert.match(reviews, /insert into floors/i);
  assert.match(reviews, /insert into facility_instances/i);
  assert.match(submissions, /collectionSubmissionId/);
});

test("content editors reuse drafts and block writes while a revision is in review", () => {
  for (const file of ["places.ts", "facilities.ts", "merchants.ts"]) {
    const source = fs.readFileSync(path.join(root, "worker/modules", file), "utf8");
    assert.match(source, /revision_in_review/);
    assert.match(source, /editorial_status='draft'/);
    assert.match(source, /status: pending \? 200 : 201/);
  }
});
