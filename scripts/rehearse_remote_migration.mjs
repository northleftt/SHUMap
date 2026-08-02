#!/usr/bin/env node
// Rehearse the pending migration chain against a snapshot of the remote data.
//
// Applyability (D1 authorizer, wrangler's splitter, statement size, compound
// SELECT terms) is covered by scripts/validate_migration_applicability.mjs and
// by applying the chain to a real local D1. What neither of those covers is the
// data-dependent half: 0011/0013/0014 contain guard tables whose CHECK(valid=1)
// aborts the migration when the real rows do not match what the migration
// expects. The remote rows differ from the local ones, so the guards have to be
// rehearsed against an actual remote snapshot before touching the remote DB.
//
// Usage: node scripts/rehearse_remote_migration.mjs <exported-remote.sql>

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(root, "migrations-v2");

const snapshotPath = process.argv[2];
if (!snapshotPath) {
  console.error("usage: node scripts/rehearse_remote_migration.mjs <exported-remote.sql>");
  process.exit(1);
}

const db = new DatabaseSync(":memory:");
db.exec("pragma foreign_keys = off");
db.exec(readFileSync(snapshotPath, "utf8"));

const applied = new Set(
  db.prepare("select name from d1_migrations").all().map((row) => row.name),
);
console.log(`snapshot loaded: ${applied.size} migrations already recorded`);

const pending = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .filter((name) => !applied.has(name));

if (pending.length === 0) {
  console.log("nothing pending — snapshot is already at head");
  process.exit(0);
}

console.log(`pending: ${pending.join(", ")}\n`);

db.exec("pragma foreign_keys = on");

for (const name of pending) {
  const sql = readFileSync(path.join(migrationsDir, name), "utf8");
  try {
    db.exec(sql);
  } catch (error) {
    console.error(`FAILED ${name}: ${error.message}`);
    process.exit(1);
  }
  db.prepare("insert into d1_migrations(name) values(?)").run(name);
  console.log(`applied ${name}`);
}

// Post-conditions that matter for the client: referential integrity, no
// migration scratch tables surviving, and the chip/place-kind invariants the
// unified taxonomy exists to guarantee.
const violations = db.prepare("pragma foreign_key_check").all();
if (violations.length > 0) {
  console.error(`\nforeign key violations after migration: ${violations.length}`);
  for (const row of violations.slice(0, 20)) console.error(`  ${JSON.stringify(row)}`);
  process.exit(1);
}

const integrity = db.prepare("pragma integrity_check").get();
const integrityValue = Object.values(integrity)[0];
if (integrityValue !== "ok") {
  console.error(`\nintegrity_check: ${integrityValue}`);
  process.exit(1);
}

const scratch = db.prepare(`
  select name from sqlite_master
   where type='table'
     and (name like '%_migration' or name like '%_guard'
          or name like 'collection_contract_%' or name like '%_assembly'
          or name like '%_verified' or name in (
            'place_import_map','collection_referenced_facility_codes',
            'deleted_collection_facility_types','submission_expected_review_fields'
          ))
`).all();
if (scratch.length > 0) {
  console.error(`\nmigration scratch tables survived: ${scratch.map((r) => r.name).join(", ")}`);
  process.exit(1);
}

const orphanChips = db.prepare(`
  select count(*) as n from map_filter_categories c
   where c.active=1
     and not exists (select 1 from map_filter_members m where m.category_id=c.id)
`).get().n;
if (orphanChips > 0) {
  console.error(`\n${orphanChips} active chip(s) have no member`);
  process.exit(1);
}

const unownedKinds = db.prepare(`
  select k.id,count(m.id) as owners
    from place_kinds k
    left join map_filter_members m on m.place_kind_id=k.id
    join map_filter_categories c on c.id=m.category_id and c.active=1
   group by k.id having owners<>1
`).all();
if (unownedKinds.length > 0) {
  console.error(`\nplace kinds not owned by exactly one active chip: ${JSON.stringify(unownedKinds)}`);
  process.exit(1);
}

console.log("\npost-migration checks passed (foreign keys, integrity, scratch tables, chip invariants)");

const distribution = db.prepare(`
  select k.name,count(p.id) as n
    from place_kinds k left join places p on p.kind_id=k.id and p.lifecycle_status<>'retired'
   group by k.id order by n desc,k.id
`).all();
console.log("\nplace kind distribution:");
for (const row of distribution) console.log(`  ${row.name} ${row.n}`);

db.close();
