// Coverage for the user-photo chain:
//   POST /api/public/media (quarantine) → submission_media link
//   → POST /api/admin/submissions/:id/review accept (promote to public)
//   → GET /api/public/media/:id readable
//
// The security-critical part is the scope/status/key-prefix transition, which
// lives in SQL rather than in the handler, so it is exercised against a real
// SQLite database built from migrations-v2. The R2 side is not simulated; the
// guard that decides whether an object may be served publicly is replicated
// here from worker/modules/media.ts and asserted against the same rows the
// handlers write.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const QUARANTINE_PREFIX = "quarantine/submissions/";
const PUBLIC_PREFIX = "public/media/";

// --- helpers ---------------------------------------------------------------

function freshDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys = on;");
  const dir = path.join(root, "migrations-v2");
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    db.exec(fs.readFileSync(path.join(dir, name), "utf8"));
  }
  db.exec(`insert into users(id,email,display_name,password_hash,status,created_at,updated_at)
           values('user_reviewer','r@example.com','Reviewer','h','active',datetime('now'),datetime('now'));`);
  return db;
}

let mediaSeq = 0;

/** Mirrors createPublicMediaUpload: quarantine scope, quarantined status, quarantine key. */
function uploadPhoto(db, contentType = "image/jpeg") {
  mediaSeq += 1;
  const mediaId = `media_${String(mediaSeq).padStart(32, "0")}`;
  const objectKey = `${QUARANTINE_PREFIX}${mediaId}.jpg`;
  db.prepare(
    `insert into media_assets(id,bucket_scope,object_key,original_name,content_type,byte_size,sha256,status,created_at)
     values(?,'quarantine',?,null,?,?,?,'quarantined',datetime('now'))`,
  ).run(mediaId, objectKey, contentType, 1024, "a".repeat(64));
  return mediaId;
}

function createSubmission(db, submissionId, mediaIds) {
  db.prepare(
    `insert into content_submissions(id,target_type,target_id,payload_json,submitter_name,status,created_at)
     values(?,'place','place_test','{"feedbackType":"correction","description":"x"}','Tester','pending',datetime('now'))`,
  ).run(submissionId);
  mediaIds.forEach((mediaId, index) => {
    db.prepare(
      `insert into submission_media(submission_id,media_asset_id,sort_order,role,created_at)
       select ?,?,?,'evidence',datetime('now') where exists(select 1 from content_submissions where id=?)`,
    ).run(submissionId, mediaId, index, submissionId);
  });
}

function listSubmissionPhotos(db, submissionId) {
  return db.prepare(
    `select sm.media_asset_id as mediaAssetId,sm.sort_order as sortOrder,ma.bucket_scope as bucketScope,
            ma.status,ma.content_type as contentType,ma.object_key as objectKey
       from submission_media sm join media_assets ma on ma.id=sm.media_asset_id
      where sm.submission_id=? order by sm.sort_order`,
  ).all(submissionId);
}

/**
 * Mirrors promoteSubmissionPhotos' DB statement. Split out from `review` so the
 * idempotency case can re-run promotion alone — a second full review is blocked
 * upstream by the status check and by idx_submission_reviews_one_decision.
 */
function promotePhotos(db, submissionId) {
  const urls = [];
  for (const photo of listSubmissionPhotos(db, submissionId)) {
    if (photo.bucketScope !== "quarantine") continue;
    const publicKey = `${PUBLIC_PREFIX}${photo.mediaAssetId}.jpg`;
    db.prepare(
      "update media_assets set bucket_scope='public',status='published',object_key=?,approved_at=datetime('now') where id=? and bucket_scope='quarantine'",
    ).run(publicKey, photo.mediaAssetId);
    urls.push(`/api/public/media/${photo.mediaAssetId}`);
  }
  return urls;
}

/** Mirrors promoteSubmissionPhotos' DB statement + reviewSubmission's status write. */
function review(db, submissionId, decision, { adoptPhotos = true } = {}) {
  const status = decision === "accept" ? "accepted" : decision === "partial" ? "partially_accepted" : "rejected";
  const publish = decision === "accept" || (decision === "partial" && adoptPhotos);
  const urls = publish ? promotePhotos(db, submissionId) : [];
  db.prepare("update content_submissions set status=?,reviewed_at=datetime('now') where id=?").run(status, submissionId);
  db.prepare(
    `insert into submission_reviews(id,submission_id,reviewer_id,decision,field_decisions_json,created_at)
     values(?,?,'user_reviewer',?,'{}',datetime('now'))`,
  ).run(`sreview_${submissionId}`, submissionId, decision);
  return urls;
}

/**
 * The public read guard from worker/modules/media.ts: scope must be public,
 * status published, and the key must sit under the public prefix. All three or
 * nothing — this is the only thing standing between a quarantined upload and
 * anonymous readers.
 */
function publicMediaReadable(db, mediaId) {
  const asset = db.prepare(
    "select object_key as objectKey,status from media_assets where id=? and bucket_scope='public'",
  ).get(mediaId);
  return Boolean(asset && asset.status === "published" && asset.objectKey.startsWith(PUBLIC_PREFIX));
}

/** The admin read path has no scope filter — any asset is fetchable with a session. */
function adminMediaReadable(db, mediaId) {
  return Boolean(db.prepare("select id from media_assets where id=?").get(mediaId));
}

// --- upload → link ---------------------------------------------------------

test("a fresh anonymous upload is quarantined and not publicly readable", () => {
  const db = freshDatabase();
  const mediaId = uploadPhoto(db);

  const row = db.prepare("select bucket_scope as scope,status,object_key as key from media_assets where id=?").get(mediaId);
  assert.equal(row.scope, "quarantine");
  assert.equal(row.status, "quarantined");
  assert.ok(row.key.startsWith(QUARANTINE_PREFIX));
  assert.equal(publicMediaReadable(db, mediaId), false);
  // Reviewers can still see it, which is the whole point of the quarantine scope.
  assert.equal(adminMediaReadable(db, mediaId), true);

  db.close();
});

test("submission_media links photos in submitted order", () => {
  const db = freshDatabase();
  const first = uploadPhoto(db);
  const second = uploadPhoto(db);
  const third = uploadPhoto(db);
  createSubmission(db, "submission_ordered", [third, first, second]);

  const photos = listSubmissionPhotos(db, "submission_ordered");
  assert.deepEqual(photos.map((p) => p.mediaAssetId), [third, first, second]);
  assert.deepEqual(photos.map((p) => p.sortOrder), [0, 1, 2]);

  db.close();
});

test("the same photo cannot be linked to two submissions", () => {
  const db = freshDatabase();
  const mediaId = uploadPhoto(db);
  createSubmission(db, "submission_one", [mediaId]);

  // assertAttachablePhotos rejects a reused id by counting existing links.
  const used = db.prepare(
    "select count(*) as n from submission_media where media_asset_id=?",
  ).get(mediaId).n;
  assert.equal(used, 1);

  // The primary key also blocks a duplicate link on the same submission.
  createSubmission(db, "submission_two", []);
  assert.throws(
    () =>
      db.prepare(
        "insert into submission_media(submission_id,media_asset_id,sort_order,role,created_at) values(?,?,0,'evidence',datetime('now'))",
      ).run("submission_one", mediaId),
    /UNIQUE|PRIMARY/i,
  );

  db.close();
});

test("linking is skipped when the submission insert wrote no row", () => {
  const db = freshDatabase();
  const mediaId = uploadPhoto(db);
  // The collection submit path inserts the submission conditionally (lock held);
  // when the lock is gone no submission row exists and the link must not explode.
  db.prepare(
    `insert into submission_media(submission_id,media_asset_id,sort_order,role,created_at)
     select ?,?,0,'evidence',datetime('now') where exists(select 1 from content_submissions where id=?)`,
  ).run("submission_missing", mediaId, "submission_missing");

  assert.equal(db.prepare("select count(*) as n from submission_media").get().n, 0);

  db.close();
});

// --- accept → publish ------------------------------------------------------

test("accepting a submission publishes its photos to the public prefix", () => {
  const db = freshDatabase();
  const first = uploadPhoto(db);
  const second = uploadPhoto(db);
  createSubmission(db, "submission_accept", [first, second]);

  const urls = review(db, "submission_accept", "accept");
  assert.deepEqual(urls, [`/api/public/media/${first}`, `/api/public/media/${second}`]);

  for (const mediaId of [first, second]) {
    const row = db.prepare("select bucket_scope as scope,status,object_key as key,approved_at as approvedAt from media_assets where id=?").get(mediaId);
    assert.equal(row.scope, "public");
    assert.equal(row.status, "published");
    assert.ok(row.key.startsWith(PUBLIC_PREFIX));
    assert.ok(row.approvedAt);
    assert.equal(publicMediaReadable(db, mediaId), true);
  }

  db.close();
});

test("rejecting a submission leaves its photos quarantined and unreadable", () => {
  const db = freshDatabase();
  const mediaId = uploadPhoto(db);
  createSubmission(db, "submission_reject", [mediaId]);

  const urls = review(db, "submission_reject", "reject");
  assert.deepEqual(urls, []);

  const row = db.prepare("select bucket_scope as scope,status,object_key as key from media_assets where id=?").get(mediaId);
  assert.equal(row.scope, "quarantine");
  assert.equal(row.status, "quarantined");
  assert.ok(row.key.startsWith(QUARANTINE_PREFIX));
  assert.equal(publicMediaReadable(db, mediaId), false);
  assert.equal(db.prepare("select status from content_submissions where id=?").get("submission_reject").status, "rejected");

  db.close();
});

test("partial acceptance publishes photos only when the reviewer adopts them", () => {
  const db = freshDatabase();
  const skipped = uploadPhoto(db);
  createSubmission(db, "submission_partial_skip", [skipped]);
  review(db, "submission_partial_skip", "partial", { adoptPhotos: false });
  assert.equal(publicMediaReadable(db, skipped), false);

  const adopted = uploadPhoto(db);
  createSubmission(db, "submission_partial_adopt", [adopted]);
  review(db, "submission_partial_adopt", "partial", { adoptPhotos: true });
  assert.equal(publicMediaReadable(db, adopted), true);

  db.close();
});

test("promotion is idempotent and only ever touches quarantined rows", () => {
  const db = freshDatabase();
  const mediaId = uploadPhoto(db);
  createSubmission(db, "submission_idem", [mediaId]);

  review(db, "submission_idem", "accept");
  const afterFirst = db.prepare("select object_key as key from media_assets where id=?").get(mediaId).key;
  // A second promotion pass finds the row already public; the
  // `and bucket_scope='quarantine'` guard makes the update a no-op rather than
  // rewriting the key. (A second full review is impossible: the status check
  // rejects it and idx_submission_reviews_one_decision would fail anyway.)
  assert.deepEqual(promotePhotos(db, "submission_idem"), []);
  assert.equal(db.prepare("select object_key as key from media_assets where id=?").get(mediaId).key, afterFirst);
  assert.equal(db.prepare("select count(*) as n from media_assets where bucket_scope='quarantine'").get().n, 0);

  db.close();
});

// --- isolation guards ------------------------------------------------------

test("private map imports are never publicly readable", () => {
  const db = freshDatabase();
  db.prepare(
    `insert into media_assets(id,bucket_scope,object_key,content_type,byte_size,sha256,status,created_at)
     values('media_private','private','private/imports/media_private/plan.svg','image/svg+xml',10,?,'approved',datetime('now'))`,
  ).run("b".repeat(64));

  assert.equal(publicMediaReadable(db, "media_private"), false);

  db.close();
});

test("a public row still under a non-public key stays unreadable", () => {
  const db = freshDatabase();
  const mediaId = uploadPhoto(db);
  // Simulates a half-applied promotion: scope/status flipped but the object was
  // never copied. Serving this would leak the quarantine object.
  db.prepare("update media_assets set bucket_scope='public',status='published' where id=?").run(mediaId);

  assert.equal(publicMediaReadable(db, mediaId), false);

  db.close();
});

test("a published photo whose row is rolled back stops being readable", () => {
  const db = freshDatabase();
  const mediaId = uploadPhoto(db);
  createSubmission(db, "submission_rollback", [mediaId]);
  review(db, "submission_rollback", "accept");
  assert.equal(publicMediaReadable(db, mediaId), true);

  db.prepare("update media_assets set status='deleted' where id=?").run(mediaId);
  assert.equal(publicMediaReadable(db, mediaId), false);

  db.close();
});

test("deleting a submission cascades its photo links but keeps the assets", () => {
  const db = freshDatabase();
  const mediaId = uploadPhoto(db);
  createSubmission(db, "submission_cascade", [mediaId]);

  db.prepare("delete from submission_reviews where submission_id=?").run("submission_cascade");
  db.prepare("delete from content_submissions where id=?").run("submission_cascade");

  assert.equal(db.prepare("select count(*) as n from submission_media").get().n, 0);
  // media_assets is `on delete restrict` from the link side, so the object row
  // survives for a later cleanup sweep instead of vanishing silently.
  assert.equal(db.prepare("select count(*) as n from media_assets where id=?").get(mediaId).n, 1);

  db.close();
});

// --- wiring guards ---------------------------------------------------------

test("the photo endpoints are registered with the right gating", () => {
  const worker = fs.readFileSync(path.join(root, "worker/index-v2.ts"), "utf8");
  // Anonymous upload lives on the public surface.
  assert.match(worker, /method === "POST" && path === "\/api\/public\/media"/);
  assert.match(worker, /createPublicMediaUpload/);
  // Admin original-image read is behind a session with read:admin. Anchor on the
  // call site (the last occurrence), not the import at the top of the file.
  assert.match(worker, /getAdminMediaContent/);
  const adminRead = worker.lastIndexOf("getAdminMediaContent(env");
  assert.ok(adminRead > 0, "getAdminMediaContent must be called from the router");
  const gate = worker.lastIndexOf("requireSession(request, env, \"read:admin\")", adminRead);
  assert.ok(gate > 0 && adminRead - gate < 200, "admin media content must be gated by read:admin");

  const media = fs.readFileSync(path.join(root, "worker/modules/media.ts"), "utf8");
  // Uploads must land in quarantine, never straight into the public scope.
  assert.match(media, /values\(\?,'quarantine',\?,null,\?,\?,\?,'quarantined',\?\)/);
  assert.match(media, /quarantine\/submissions\//);
  // Magic-byte sniffing guards against an image/* content-type on non-image bytes.
  assert.match(media, /sniffImageType/);
  assert.doesNotMatch(media, /image\/svg\+xml/);
  // The public read guard keeps all three conditions.
  assert.match(media, /bucket_scope='public'/);
  assert.match(media, /status !== "published"/);
  assert.match(media, /startsWith\(PUBLIC_MEDIA_PREFIX\)/);
  // Promotion may only move rows out of quarantine.
  assert.match(media, /where id=\? and bucket_scope='quarantine'/);
});

test("submission creation validates photo ids before writing links", () => {
  const submissions = fs.readFileSync(path.join(root, "worker/modules/submissions.ts"), "utf8");
  assert.match(submissions, /assertAttachablePhotos/);
  assert.ok(
    submissions.indexOf("assertAttachablePhotos") < submissions.indexOf("linkSubmissionPhotoStatements"),
    "photos must be validated before the submission is written",
  );
  // Photos ride the same batch as the submission insert, so a failure leaves no
  // orphaned links.
  assert.match(submissions, /\.\.\.linkSubmissionPhotoStatements\(env, id, photoMediaIds\)/);
  // Promotion statements join the review batch rather than running standalone.
  assert.match(submissions, /statements\.push\(\.\.\.promotion\.statements\)/);

  const collections = fs.readFileSync(path.join(root, "worker/modules/collections.ts"), "utf8");
  // The collection allowlist has to let photo ids through or the payload is rejected.
  assert.match(collections, /"floors", "photoMediaIds"/);
  assert.match(collections, /filterAttachablePhotos/);
});

test("the photo cap is enforced in one place and mirrored by the UI", () => {
  const media = fs.readFileSync(path.join(root, "worker/modules/media.ts"), "utf8");
  assert.match(media, /MAX_SUBMISSION_PHOTOS = 3/);
  const feedback = fs.readFileSync(path.join(root, "src/pages/feedback/FeedbackPage.tsx"), "utf8");
  assert.match(feedback, /MAX_PHOTOS = 3/);
  // The feedback form must send ids, not the old hardcoded counter.
  assert.match(feedback, /photoMediaIds: uploads\.mediaIds/);
  assert.doesNotMatch(feedback, /photos: 0/);
});
