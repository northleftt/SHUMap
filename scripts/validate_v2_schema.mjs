#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(root, "migrations-v2");
const sql = fs.readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => fs.readFileSync(path.join(migrationsDir, name), "utf8"))
  .join("\n");

const requiredTables = [
  "users", "roles", "sessions", "audit_events", "data_sources", "media_assets", "campuses", "places", "place_revisions",
  "buildings", "floors", "indoor_spaces", "map_assets", "map_versions", "map_features", "location_anchors", "entity_locations",
  "facility_types", "facility_instances", "facility_revisions", "merchant_outlets", "merchant_revisions", "operational_events",
  "campaigns", "transit_stops", "transit_routes", "transit_patterns", "service_calendars", "transit_trips", "transit_stop_times",
  "content_submissions", "submission_reviews", "collection_tasks", "public_rate_limits", "analytics_events", "verification_records", "releases", "release_items", "search_documents", "jobs",
];

const missing = requiredTables.filter((table) => !new RegExp(`create table ${table}\\s*\\(`, "i").test(sql));
if (missing.length) {
  console.error(`Missing required v2 tables: ${missing.join(", ")}`);
  process.exit(1);
}

for (const forbidden of ["status != 'hidden'", "ADMIN_TOKEN_SECRET", "poi_bindings", "poi_tags"]) {
  if (sql.includes(forbidden)) {
    console.error(`Forbidden schema token remains in v2 migration: ${forbidden}`);
    process.exit(1);
  }
}

const createTableCount = (sql.match(/create table /gi) ?? []).length;
const checkCount = (sql.match(/ check \(/gi) ?? []).length;
const foreignKeyCount = (sql.match(/ references /gi) ?? []).length;
if (createTableCount < 45 || checkCount < 35 || foreignKeyCount < 50) {
  console.error(`Schema guard failed: tables=${createTableCount}, checks=${checkCount}, foreignKeys=${foreignKeyCount}`);
  process.exit(1);
}

console.log(`v2 schema validated: ${createTableCount} tables, ${checkCount} checks, ${foreignKeyCount} foreign keys`);
