// Behavioural guards for the publish / review handoff. The SQL under test is extracted
// from the worker modules and executed against the real v2 schema (node:sqlite), so a
// query regression fails here instead of only in production.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readSource(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function freshDatabase() {
  const migrationsDir = path.join(root, "migrations-v2");
  const db = new DatabaseSync(":memory:");
  for (const name of fs.readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort()) {
    db.exec(fs.readFileSync(path.join(migrationsDir, name), "utf8"));
  }
  return db;
}

function extract(source, pattern, label) {
  const match = source.match(pattern);
  assert.ok(match, `could not extract ${label} from source`);
  return match[1];
}

function seedMapVersion(db, { id, campusId, label, status, createdAt }) {
  db.prepare("insert into media_assets(id,bucket_scope,object_key,original_name,content_type,byte_size,sha256,status,created_at) values(?,'private',?,?,'image/svg+xml',10,?,'approved',?)")
    .run(`media_${id}`, `maps/${id}.svg`, `${id}.svg`, `hash_${id}`, createdAt);
  db.prepare("insert into map_assets(id,asset_type,media_asset_id,checksum,metadata_json,created_at) values(?,'campus_svg',?,?,'{}',?)")
    .run(`asset_${id}`, `media_${id}`, `hash_${id}`, createdAt);
  db.prepare(
    `insert into map_versions(id,campus_id,floor_id,map_asset_id,version_label,coordinate_space_type,coordinate_space_json,lifecycle_status,created_at)
     values(?,?,null,?,?,'svg_viewbox','{"width":100,"height":100}',?,?)`,
  ).run(id, campusId, `asset_${id}`, label, status, createdAt);
}

function seedCampus(db, id, code) {
  db.prepare("insert into campuses(id,code,name,timezone,status,created_at,updated_at) values(?,?,?,'Asia/Shanghai','active','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')")
    .run(id, code, `校区 ${code}`);
}

// --- Bug 2: the default publish path must not depend on a lifecycle nobody writes ----

test("default release candidate picks the latest ready or published map version per space", () => {
  const db = freshDatabase();
  const sql = extract(
    readSource("worker/modules/releases.ts"),
    /const DEFAULT_MAP_VERSION_QUERY = `(select mv\.\*[\s\S]*?)`;/,
    "default map version query",
  );

  seedCampus(db, "campus_a", "A");
  seedCampus(db, "campus_b", "B");
  seedMapVersion(db, { id: "mv_a_old", campusId: "campus_a", label: "A v1", status: "ready", createdAt: "2026-01-01T00:00:00Z" });
  seedMapVersion(db, { id: "mv_a_new", campusId: "campus_a", label: "A v2", status: "ready", createdAt: "2026-02-01T00:00:00Z" });
  seedMapVersion(db, { id: "mv_a_draft", campusId: "campus_a", label: "A v3", status: "draft", createdAt: "2026-03-01T00:00:00Z" });
  seedMapVersion(db, { id: "mv_b_pub", campusId: "campus_b", label: "B v1", status: "published", createdAt: "2026-01-05T00:00:00Z" });

  const ids = db.prepare(sql).all()
    .filter((row) => row.campus_id === "campus_a" || row.campus_id === "campus_b")
    .map((row) => row.id)
    .sort();
  // Import jobs only ever write 'ready' (worker/modules/jobs.ts), so a published-only
  // filter would return nothing and block every default publish.
  assert.deepEqual(ids, ["mv_a_new", "mv_b_pub"]);
});

test("activating a release promotes its ready map versions to published", () => {
  const db = freshDatabase();
  const source = readSource("worker/modules/releases.ts");
  const sql = extract(
    source,
    /"(update map_versions set lifecycle_status='published' where id=\? and lifecycle_status='ready')"/,
    "map version promotion statement",
  );

  seedCampus(db, "campus_a", "A");
  seedMapVersion(db, { id: "mv_ready", campusId: "campus_a", label: "A v1", status: "ready", createdAt: "2026-01-01T00:00:00Z" });
  seedMapVersion(db, { id: "mv_draft", campusId: "campus_a", label: "A v2", status: "draft", createdAt: "2026-02-01T00:00:00Z" });

  db.prepare(sql).run("mv_ready");
  db.prepare(sql).run("mv_draft");
  const statuses = Object.fromEntries(
    db.prepare("select id,lifecycle_status from map_versions").all().map((row) => [row.id, row.lifecycle_status]),
  );
  assert.equal(statuses.mv_ready, "published");
  assert.equal(statuses.mv_draft, "draft", "promotion must not touch drafts");
});

// --- Bug 3: an adopted submission must land in the review queue --------------------

test("a revision produced by adopting a submission enters the pending review queue", () => {
  const db = freshDatabase();
  const insertSql = extract(
    readSource("worker/modules/submissions.ts"),
    /`(insert into place_revisions\([\s\S]*?)`/,
    "produced revision insert",
  );
  const queueSql = extract(
    readSource("worker/modules/reviews.ts"),
    /`(select 'place' as type[\s\S]*?)`/,
    "pending revision queue query",
  );

  seedCampus(db, "campus_a", "A");
  db.prepare("insert into users(id,email,display_name,password_hash,status,token_version,created_at,updated_at) values('user_reviewer','reviewer@example.com','审核员','x','active',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run();
  db.prepare("insert into places(id,kind_id,campus_id,lifecycle_status,current_revision_id,created_at,updated_at) values('place_1','building','campus_a','active','prev_1','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run();
  db.prepare(
    `insert into place_revisions(id,place_id,revision_no,editorial_status,display_name,content_json,structure_json,content_hash,created_by,created_at)
     values('prev_1','place_1',1,'approved','图书馆','{}','{}','hash1','user_reviewer','2026-01-01T00:00:00Z')`,
  ).run();
  // A plain draft revision on another place stays out of the queue.
  db.prepare("insert into places(id,kind_id,campus_id,lifecycle_status,current_revision_id,created_at,updated_at) values('place_2','building','campus_a','active',null,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run();
  db.prepare(
    `insert into place_revisions(id,place_id,revision_no,editorial_status,display_name,content_json,structure_json,content_hash,created_by,created_at)
     values('prev_draft','place_2',1,'draft','食堂','{}','{}','hash2','user_reviewer','2026-01-01T00:00:00Z')`,
  ).run();

  db.prepare(insertSql).run(
    "prev_2", "place_1", 2, "图书馆（新）", null, null, "{}", "{}", null, "prev_1", "hash2",
    "user_reviewer", "2026-02-01T00:00:00Z", "2026-02-01T00:00:00Z",
  );

  const produced = db.prepare("select editorial_status,submitted_at from place_revisions where id='prev_2'").get();
  assert.equal(produced.editorial_status, "in_review");
  assert.ok(produced.submitted_at, "submitted_at must be set so the queue can sort by it");

  const queued = db.prepare(queueSql).all();
  assert.deepEqual(queued.map((row) => row.revisionId), ["prev_2"]);
});

test("place review still drives the collection task from submitted to accepted", () => {
  const db = freshDatabase();
  const taskSql = extract(
    readSource("worker/modules/reviews.ts"),
    /`(update collection_tasks set status=\?[\s\S]*?)`/,
    "collection task transition",
  );

  seedCampus(db, "campus_a", "A");
  db.prepare("insert into users(id,email,display_name,password_hash,status,token_version,created_at,updated_at) values('user_reviewer','reviewer@example.com','审核员','x','active',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run();
  db.prepare("insert into places(id,kind_id,campus_id,lifecycle_status,current_revision_id,created_at,updated_at) values('place_1','building','campus_a','active',null,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run();
  db.prepare(
    `insert into place_revisions(id,place_id,revision_no,editorial_status,display_name,content_json,content_hash,created_by,created_at,submitted_at)
     values('prev_2','place_1',1,'in_review','图书馆','{}','hash1','user_reviewer','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
  ).run();
  db.prepare(
    `insert into content_submissions(id,target_type,target_id,payload_json,status,created_at,reviewed_at)
     values('sub_1','place','place_1','{}','accepted','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z')`,
  ).run();
  db.prepare(
    `insert into submission_reviews(id,submission_id,reviewer_id,decision,field_decisions_json,produced_revision_type,produced_revision_id,created_at)
     values('sreview_1','sub_1','user_reviewer','accept','{}','place','prev_2','2026-01-02T00:00:00Z')`,
  ).run();
  db.prepare(
    `insert into collection_tasks(building_place_id,device_id,assignee_name,status,payload_json,submission_id,created_at,updated_at,submitted_at)
     values('place_1','device_1','采集员','submitted','{}','sub_1','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z','2026-01-02T00:00:00Z')`,
  ).run();

  const now = "2026-01-03T00:00:00Z";
  db.prepare(taskSql).run("accepted", now, now, "prev_2", "accepted");
  assert.equal(db.prepare("select status from collection_tasks where building_place_id='place_1'").get().status, "accepted");

  db.prepare("update collection_tasks set status='submitted' where building_place_id='place_1'").run();
  db.prepare(taskSql).run("needs_recollection", now, now, "prev_2", "needs_recollection");
  assert.equal(db.prepare("select status from collection_tasks where building_place_id='place_1'").get().status, "needs_recollection");
});

// --- Bugs 1, 4, 5: thin source guards for the client / review-note plumbing ---------

test("release validation failures survive the client error path and reach the UI", () => {
  const client = readSource("src/lib/api/client.ts");
  const page = readSource("src/admin/pages/ReleasesPage.tsx");
  assert.match(client, /public readonly body\?: unknown/);
  assert.match(page, /validationFailure/);
  assert.match(page, /err\.status !== 422/);
});

test("operational event review carries the reviewer note end to end", () => {
  const api = readSource("src/lib/api/admin.ts");
  const page = readSource("src/admin/pages/ReviewPage.tsx");
  const worker = readSource("worker/modules/operations.ts");
  const migration = readSource("migrations-v2/0004_operational_event_review_note.sql");
  assert.match(api, /reviewOperation\([\s\S]*?note\?: string/);
  assert.match(page, /reviewOperation\(selected\.id, \{ decision, note:/);
  assert.match(worker, /review_note=\?/);
  assert.match(migration, /alter table operational_events add column review_note text/);
  assert.doesNotMatch(page, /待后端部署后可用/);
});
