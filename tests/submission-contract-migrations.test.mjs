import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = path.join(root, "migrations-v2");
const retiredMarker = String.fromCharCode(108, 101, 103, 97, 99, 121);

function migrationSql(name) {
  return fs.readFileSync(path.join(migrationsDirectory, name), "utf8");
}

function databaseThrough(lastMigration) {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys=on");
  for (const name of fs.readdirSync(migrationsDirectory).filter((item) => item.endsWith(".sql")).sort()) {
    if (name > lastMigration) break;
    db.exec(migrationSql(name));
  }
  return db;
}

function seedPlace(db) {
  db.exec(`
    insert into users(id,email,display_name,password_hash,status,created_at,updated_at)
    values('user_contract','contract@example.com','Reviewer','hash','active',datetime('now'),datetime('now'));
    insert into places(id,kind_id,campus_id,lifecycle_status,created_at,updated_at)
    values('place_contract','building','campus_baoshan','active',datetime('now'),datetime('now'));
    insert into buildings(place_id,public_access_level) values('place_contract','public');
    insert into place_revisions(
      id,place_id,revision_no,editorial_status,display_name,content_json,structure_json,
      content_hash,created_by,created_at,submitted_at,reviewed_by,reviewed_at
    ) values(
      'prev_contract','place_contract',1,'approved','契约楼','{}','{}','hash',
      'user_contract',datetime('now'),datetime('now'),'user_contract',datetime('now')
    );
    update places set current_revision_id='prev_contract' where id='place_contract';
  `);
}

function mediaId(digit) {
  return `media_${digit.repeat(32)}`;
}

function seedMedia(db, id) {
  db.prepare(`
    insert into media_assets(
      id,bucket_scope,object_key,content_type,byte_size,sha256,status,created_at
    ) values(?,'quarantine',?,'image/jpeg',100,?,'quarantined',datetime('now'))
  `).run(id, `quarantine/submissions/${id}.jpg`, digitHash(id));
}

function digitHash(id) {
  return id.slice(-1).repeat(64);
}

test("0013 canonicalizes historical feedback and collection records", () => {
  const db = databaseThrough("0012_map_filter_integrity.sql");
  seedPlace(db);
  const entrancePhoto = mediaId("1");
  const floorPhoto = mediaId("2");
  seedMedia(db, entrancePhoto);
  seedMedia(db, floorPhoto);

  const oldCollection = {
    openHours: " 08:00-22:00 ",
    phone: " 12345 ",
    organization: " 后勤处 ",
    floors: [{
      id: " floor-one ",
      levelCode: "01",
      note: " 东侧 ",
      facilities: [{
        id: " facility-one ",
        typeCode: " restroom ",
        name: " ",
        locationText: " 走廊尽头 ",
      }],
      photoMediaIds: [floorPhoto],
    }],
    photoMediaIds: [entrancePhoto],
  };
  const collectionSubmission = JSON.stringify({ submissionKind: "collection", collection: oldCollection });
  const collectionTask = structuredClone(oldCollection);
  delete collectionTask.floors[0].photoMediaIds;

  db.prepare(`
    insert into content_submissions(
      id,target_type,target_id,payload_json,status,created_at,reviewed_at
    ) values('submission_feedback','place','place_contract',?,'accepted',datetime('now'),datetime('now'))
  `).run(JSON.stringify({ feedbackType: "correction", description: " 描述有误 " }));
  db.prepare(`
    insert into content_submissions(
      id,target_type,target_id,payload_json,status,created_at,reviewed_at
    ) values('submission_collection','place','place_contract',?,'rejected',datetime('now'),datetime('now'))
  `).run(collectionSubmission);
  db.prepare(`
    insert into submission_media(submission_id,media_asset_id,sort_order,role,created_at)
    values('submission_collection',?,0,'evidence',datetime('now')),
          ('submission_collection',?,1,'evidence',datetime('now'))
  `).run(entrancePhoto, floorPhoto);
  db.exec(`
    insert into submission_reviews(
      id,submission_id,reviewer_id,decision,field_decisions_json,created_at
    ) values
      ('review_feedback','submission_feedback','user_contract','accept','{}',datetime('now')),
      ('review_collection','submission_collection','user_contract','reject','{}',datetime('now'));
  `);
  db.prepare(`
    insert into collection_tasks(
      building_place_id,device_id,assignee_name,status,payload_json,created_at,updated_at
    ) values('place_contract','device_00000000-0000-0000-0000-000000000000','Volunteer','collecting',?,datetime('now'),datetime('now'))
  `).run(JSON.stringify(collectionTask));

  db.exec(migrationSql("0013_submission_contract.sql"));

  const feedback = JSON.parse(db.prepare(
    "select payload_json from content_submissions where id='submission_feedback'",
  ).get().payload_json);
  assert.deepEqual(feedback, {
    submissionKind: "feedback",
    feedbackType: "correction",
    description: "描述有误",
  });

  const storedCollection = JSON.parse(db.prepare(
    "select payload_json from content_submissions where id='submission_collection'",
  ).get().payload_json).collection;
  assert.deepEqual(storedCollection, {
    openHours: "08:00-22:00",
    phone: "12345",
    organization: "后勤处",
    floors: [{
      id: "floor-one",
      levelCode: "F1",
      note: "东侧",
      facilities: [{ id: "facility-one", typeCode: "restroom", name: "", locationText: "走廊尽头" }],
      photoMediaIds: [floorPhoto],
    }],
    photoMediaIds: [entrancePhoto],
  });

  const task = JSON.parse(db.prepare(
    "select payload_json from collection_tasks where building_place_id='place_contract'",
  ).get().payload_json);
  assert.equal(task.floors[0].levelCode, "F1");
  assert.deepEqual(task.floors[0].photoMediaIds, []);
  assert.equal(task.floors[0].facilities[0].typeCode, "restroom");

  assert.equal(db.prepare(
    "select base_revision_id from content_submissions where id='submission_feedback'",
  ).get().base_revision_id, "prev_contract");
  assert.deepEqual(JSON.parse(db.prepare(
    "select field_decisions_json from submission_reviews where id='review_feedback'",
  ).get().field_decisions_json), { description: "adopt" });
  assert.deepEqual(JSON.parse(db.prepare(
    "select field_decisions_json from submission_reviews where id='review_collection'",
  ).get().field_decisions_json), {
    "collection.openHours": "skip",
    "collection.phone": "skip",
    "collection.organization": "skip",
    "collection.floors": "skip",
    photos: "skip",
  });
  assert.deepEqual(db.prepare("pragma foreign_key_check").all(), []);
  db.close();
});

test("0013 upgrades the five historical submission shapes and preserves a referenced deleted facility type", () => {
  const db = databaseThrough("0012_map_filter_integrity.sql");
  seedPlace(db);
  const acceptedPhoto = mediaId("3");
  const rejectedPhoto = mediaId("4");
  const newPlacePhotoOne = mediaId("5");
  const newPlacePhotoTwo = mediaId("6");
  for (const id of [acceptedPhoto, rejectedPhoto, newPlacePhotoOne, newPlacePhotoTwo]) seedMedia(db, id);

  db.exec(`
    insert into place_revisions(
      id,place_id,revision_no,based_on_revision_id,editorial_status,display_name,
      content_json,structure_json,content_hash,created_by,created_at,submitted_at
    ) values(
      'produced_contract','place_contract',2,'prev_contract','in_review','契约楼',
      '{}','{}','produced-hash','user_contract',datetime('now'),datetime('now')
    );
  `);
  const feedback = JSON.stringify({ feedbackType: "correction", description: " 往返验证：门口照片已更新 " });
  const newPlace = JSON.stringify({ feedbackType: "new_place", description: " 往返验证：新增地点 " });
  const collection = JSON.stringify({
    submissionKind: "collection",
    collection: { openHours: "07:00-21:00", phone: "12345", organization: "后勤", floors: [] },
  });
  const insertSubmission = db.prepare(`
    insert into content_submissions(
      id,target_type,target_id,payload_json,status,created_at,reviewed_at
    ) values(?,?,?,?,?,datetime('now'),?)
  `);
  insertSubmission.run("submission_collection_real", "place", "place_contract", collection, "pending", null);
  insertSubmission.run("submission_new_one", "new_place", null, newPlace, "pending", null);
  insertSubmission.run("submission_new_two", "new_place", null, newPlace, "pending", null);
  insertSubmission.run("submission_accepted_real", "place", "place_contract", feedback, "accepted", "2026-07-29T19:19:57Z");
  insertSubmission.run("submission_rejected_real", "place", "place_contract", feedback, "rejected", "2026-07-29T19:19:58Z");
  db.prepare(`
    insert into submission_media(submission_id,media_asset_id) values
      ('submission_new_one',?),('submission_new_two',?),
      ('submission_accepted_real',?),('submission_rejected_real',?)
  `).run(newPlacePhotoOne, newPlacePhotoTwo, acceptedPhoto, rejectedPhoto);
  db.exec(`
    insert into submission_reviews(
      id,submission_id,reviewer_id,decision,field_decisions_json,
      produced_revision_type,produced_revision_id,created_at
    ) values(
      'review_accepted_real','submission_accepted_real','user_contract','accept','{}',
      'place','produced_contract',datetime('now')
    );
    insert into submission_reviews(
      id,submission_id,reviewer_id,decision,field_decisions_json,created_at
    ) values(
      'review_rejected_real','submission_rejected_real','user_contract','reject','{}',datetime('now')
    );

    insert into collection_tasks(
      building_place_id,device_id,assignee_name,status,payload_json,submission_id,
      created_at,updated_at,submitted_at
    ) values(
      'place_contract','device_contract','Volunteer','submitted',
      '{"openHours":"07:00-21:00","phone":"12345","organization":"后勤","floors":[]}',
      'submission_collection_real',datetime('now'),datetime('now'),datetime('now')
    );
    insert into places(id,kind_id,campus_id,lifecycle_status,created_at,updated_at)
    values('place_collection_draft','building','campus_baoshan','active',datetime('now'),datetime('now'));
    insert into buildings(place_id,public_access_level) values('place_collection_draft','public');
    insert into collection_tasks(
      building_place_id,device_id,assignee_name,status,payload_json,created_at,updated_at
    ) values(
      'place_collection_draft','device_contract_2','Volunteer','collecting',
      '{"openHours":"","phone":"","organization":"","floors":[{"id":"f1","levelCode":"1F","note":"","facilities":[{"id":"x1","typeCode":"deleted_probe","name":"","locationText":""}],"photoMediaIds":[]}],"photoMediaIds":[]}',
      datetime('now'),datetime('now')
    );

    insert into audit_events(
      id,actor_user_id,action,entity_type,entity_id,request_id,
      before_json,after_json,created_at
    ) values(
      'audit_facility_created','user_contract','facility_type.create','facility_type',
      'facility_type_deleted_probe','request_create','{}',
      '{"code":"deleted_probe","name":"已删采集类型","category":"other","iconKey":"generic","verificationIntervalDays":null}',
      '2026-07-29T19:00:00Z'
    );
    insert into audit_events(
      id,actor_user_id,action,entity_type,entity_id,request_id,
      before_json,after_json,created_at
    ) values(
      'audit_facility_deleted','user_contract','facility_type.delete','facility_type',
      'facility_type_deleted_probe','request_delete',
      '{"id":"facility_type_deleted_probe","code":"deleted_probe","name":"已删采集类型","status":"active"}',
      '{}','2026-07-29T19:00:01Z'
    );
  `);

  db.exec(migrationSql("0013_submission_contract.sql"));

  const rows = db.prepare(`
    select id,payload_json as payloadJson,base_revision_id as baseRevisionId
      from content_submissions order by id
  `).all();
  assert.equal(rows.length, 5);
  for (const row of rows) assert.ok(JSON.parse(row.payloadJson).submissionKind);
  assert.equal(rows.find((row) => row.id === "submission_accepted_real").baseRevisionId, "prev_contract");
  assert.equal(rows.find((row) => row.id === "submission_rejected_real").baseRevisionId, "prev_contract");
  assert.equal(rows.find((row) => row.id === "submission_collection_real").baseRevisionId, "prev_contract");
  assert.equal(rows.find((row) => row.id === "submission_new_one").baseRevisionId, null);
  assert.equal(rows.find((row) => row.id === "submission_new_two").baseRevisionId, null);

  const collectionPayload = JSON.parse(db.prepare(
    "select payload_json from content_submissions where id='submission_collection_real'",
  ).get().payload_json).collection;
  assert.deepEqual(collectionPayload.photoMediaIds, []);
  const draft = JSON.parse(db.prepare(
    "select payload_json from collection_tasks where building_place_id='place_collection_draft'",
  ).get().payload_json);
  assert.equal(draft.floors[0].levelCode, "F1");
  assert.equal(draft.floors[0].facilities[0].typeCode, "deleted_probe");

  assert.deepEqual({ ...db.prepare(`
    select ft.id,ft.code,ft.name,ft.category,ft.icon_key as iconKey,ft.status,
           member.category_id as mapFilterCategoryId
      from facility_types ft
      join map_filter_members member on member.facility_type_id=ft.id
     where ft.code='deleted_probe'
  `).get() }, {
    id: "facility_type_deleted_probe",
    code: "deleted_probe",
    name: "已删采集类型",
    category: "other",
    iconKey: "generic",
    status: "active",
    mapFilterCategoryId: "map_filter_other",
  });
  assert.deepEqual(JSON.parse(db.prepare(
    "select field_decisions_json from submission_reviews where id='review_accepted_real'",
  ).get().field_decisions_json), { description: "adopt", photos: "adopt" });
  assert.deepEqual(JSON.parse(db.prepare(
    "select field_decisions_json from submission_reviews where id='review_rejected_real'",
  ).get().field_decisions_json), { description: "skip", photos: "skip" });

  assert.throws(
    () => db.exec("delete from facility_types where code='deleted_probe'"),
    /facility type is referenced by collection data/,
  );
  assert.throws(
    () => db.exec("update facility_types set code='renamed_probe' where code='deleted_probe'"),
    /facility type code is immutable/,
  );
  assert.throws(
    () => db.exec("update facility_types set status='disabled' where code='deleted_probe'"),
    /active collection workflow requires an active facility type/,
  );
  assert.throws(
    () => db.exec(`
      update collection_tasks
         set payload_json=replace(payload_json,'deleted_probe','missing_probe')
       where building_place_id='place_collection_draft'
    `),
    /editable collection data requires active facility types/,
  );
  assert.throws(
    () => db.prepare(`
      insert into content_submissions(
        id,target_type,target_id,base_revision_id,payload_json,status,created_at
      ) values('submission_unknown_type','place','place_contract','prev_contract',?,'pending',datetime('now'))
    `).run(JSON.stringify({
      submissionKind: "collection",
      collection: {
        openHours: "08:00-20:00",
        phone: "",
        organization: "",
        floors: [{
          id: "unknown-floor",
          levelCode: "F1",
          note: "",
          facilities: [{ id: "unknown-facility", typeCode: "missing_probe", name: "", locationText: "" }],
          photoMediaIds: [],
        }],
        photoMediaIds: [],
      },
    })),
    /collection submission requires active facility types/,
  );
  db.exec(`
    update content_submissions
       set payload_json=json_object(
         'submissionKind','collection',
         'collection',json((
           select payload_json from collection_tasks
            where building_place_id='place_collection_draft'
         ))
       )
     where id='submission_collection_real';
    update collection_tasks
       set status='submitted',submission_id='submission_collection_real'
     where building_place_id='place_collection_draft';
  `);
  assert.throws(
    () => db.exec("update facility_types set status='disabled' where code='deleted_probe'"),
    /active collection workflow requires an active facility type/,
  );
  db.exec(`
    update content_submissions set status='accepted',reviewed_at=datetime('now')
     where id='submission_collection_real';
  `);
  assert.throws(
    () => db.exec("update facility_types set status='disabled' where code='deleted_probe'"),
    /active collection workflow requires an active facility type/,
  );
  db.exec(`
    update collection_tasks set status='accepted',reviewed_at=datetime('now')
     where building_place_id='place_collection_draft';
    update facility_types set status='disabled' where code='deleted_probe';
  `);
  assert.equal(db.prepare(
    "select status from facility_types where code='deleted_probe'",
  ).get().status, "disabled");
  assert.deepEqual(db.prepare("pragma foreign_key_check").all(), []);
  db.close();
});

test("0013 rejects an empty partial review instead of guessing field decisions", () => {
  const db = databaseThrough("0012_map_filter_integrity.sql");
  seedPlace(db);
  db.prepare(`
    insert into content_submissions(
      id,target_type,target_id,payload_json,status,created_at,reviewed_at
    ) values('submission_partial','place','place_contract',?,'partially_accepted',datetime('now'),datetime('now'))
  `).run(JSON.stringify({ feedbackType: "correction", description: "描述有误" }));
  db.exec(`
    insert into submission_reviews(
      id,submission_id,reviewer_id,decision,field_decisions_json,created_at
    ) values('review_partial','submission_partial','user_contract','partial','{}',datetime('now'));
  `);

  assert.throws(
    () => db.exec(migrationSql("0013_submission_contract.sql")),
    /CHECK constraint failed/,
  );
  db.close();
});

test("0013 rejects malformed nested collection records", () => {
  const db = databaseThrough("0012_map_filter_integrity.sql");
  seedPlace(db);
  const payload = {
    submissionKind: "collection",
    collection: {
      openHours: "08:00-22:00",
      phone: "",
      organization: "",
      floors: [{
        id: "floor-one",
        levelCode: "F1",
        note: "",
        facilities: [{ id: "facility-one", typeCode: "restroom", name: "", locationText: "", extra: true }],
        photoMediaIds: [],
      }],
      photoMediaIds: [],
    },
  };
  db.prepare(`
    insert into content_submissions(
      id,target_type,target_id,payload_json,status,created_at
    ) values('submission_bad','place','place_contract',?,'pending',datetime('now'))
  `).run(JSON.stringify(payload));

  assert.throws(
    () => db.exec(migrationSql("0013_submission_contract.sql")),
    /CHECK constraint failed/,
  );
  db.close();
});

function seedTransitPattern(db) {
  db.exec(`
    insert into transit_routes(id,code,name,status,created_at,updated_at)
    values('route_contract','contract','Contract Route','active',datetime('now'),datetime('now'));
    insert into transit_patterns(id,route_id,direction_id,name)
    values('pattern_contract','route_contract',0,'Outbound');
  `);
}

function calendarValues(id, name, validTo = "2026-08-31") {
  return [id, name, "Asia/Shanghai", "2025-09-01", validTo, 1, 1, 1, 1, 1, 0, 0];
}

function insertCalendar(db, values) {
  db.prepare(`
    insert into service_calendars(
      id,name,timezone,valid_from,valid_to,monday,tuesday,wednesday,thursday,friday,saturday,sunday
    ) values(?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(...values);
}

test("0014 merges equivalent calendar identities and rewrites dependent rows", () => {
  const db = databaseThrough("0013_submission_contract.sql");
  seedTransitPattern(db);
  const oldId = `calendar_${retiredMarker}_weekday`;
  const canonicalId = "calendar_2025-2026_weekday";
  insertCalendar(db, calendarValues(oldId, "Old weekday"));
  insertCalendar(db, calendarValues(canonicalId, "2025-2026 工作日"));
  db.prepare(`
    insert into service_calendars(
      id,name,timezone,valid_from,valid_to,
      monday,tuesday,wednesday,thursday,friday,saturday,sunday
    ) values('cal_weekday',?,'Asia/Shanghai','2026-01-01','2026-12-31',1,1,1,1,1,1,1)
  `).run(`${retiredMarker} weekday`);
  db.prepare(`
    insert into transit_trips(id,pattern_id,service_calendar_id,status)
    values('trip_contract','pattern_contract',?,'active'),
          ('trip_named_contract','pattern_contract','cal_weekday','active')
  `).run(oldId);
  db.prepare(`
    insert into service_calendar_exceptions(calendar_id,service_date,exception_type,label)
    values(?,'2026-01-01','removed','New Year')
  `).run(oldId);

  db.exec(migrationSql("0014_service_calendar_identity.sql"));

  assert.equal(db.prepare("select service_calendar_id from transit_trips where id='trip_contract'").get().service_calendar_id, canonicalId);
  assert.deepEqual({ ...db.prepare(`
    select calendar_id as calendarId,service_date as serviceDate,exception_type as exceptionType,label
      from service_calendar_exceptions
  `).get() }, {
    calendarId: canonicalId,
    serviceDate: "2026-01-01",
    exceptionType: "removed",
    label: "New Year",
  });
  assert.equal(db.prepare("select count(*) as count from service_calendars where id=?").get(oldId).count, 0);
  assert.equal(db.prepare(
    "select name from service_calendars where id='cal_weekday'",
  ).get().name, "2026 每日");
  assert.equal(db.prepare(
    "select service_calendar_id from transit_trips where id='trip_named_contract'",
  ).get().service_calendar_id, "cal_weekday");
  assert.deepEqual(db.prepare("pragma foreign_key_check").all(), []);
  db.close();
});

test("0014 rejects conflicting canonical calendar definitions", () => {
  const db = databaseThrough("0013_submission_contract.sql");
  const oldId = `calendar_${retiredMarker}_weekday`;
  insertCalendar(db, calendarValues(oldId, "Old weekday"));
  insertCalendar(db, calendarValues("calendar_2025-2026_weekday", "2025-2026 工作日", "2027-08-31"));

  assert.throws(
    () => db.exec(migrationSql("0014_service_calendar_identity.sql")),
    /CHECK constraint failed/,
  );
  db.close();
});
