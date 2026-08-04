import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = path.join(root, "migrations-v2");

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys = on;");
  const migrations = fs.readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of migrations) {
    db.exec(fs.readFileSync(path.join(migrationsDirectory, name), "utf8"));
  }
  return db;
}

function insertPlace(db, id, kindId, lifecycleStatus = "active") {
  db.prepare(
    `insert into places(id,kind_id,campus_id,lifecycle_status,created_at,updated_at)
     values(?,?,'campus_baoshan',?,datetime('now'),datetime('now'))`,
  ).run(id, kindId, lifecycleStatus);
}

test("live POIs require taxonomy targets attached to active map filters", () => {
  const placeDb = database();
  placeDb.exec("insert into place_kinds(id,name) values('unmapped_kind','未归属类型')");
  assert.throws(
    () => insertPlace(placeDb, "place_unmapped", "unmapped_kind", "planned"),
    /place kind must belong to an active map filter/,
  );
  placeDb.close();

  const facilityDb = database();
  facilityDb.exec(`
    insert into facility_types(
      id,code,name,category,icon_key,visibility_policy_json,status,created_at,updated_at
    ) values(
      'facility_type_unmapped','unmapped','未归属设施','other','generic','{}','disabled',datetime('now'),datetime('now')
    );
  `);
  assert.throws(
    () => facilityDb.exec(`
      insert into facility_instances(
        id,facility_type_id,lifecycle_status,operational_status,created_at,updated_at
      ) values(
        'facility_unmapped','facility_type_unmapped','planned','unknown',datetime('now'),datetime('now')
      );
    `),
    /facility type must be enabled and belong to an active map filter/,
  );
  assert.throws(
    () => facilityDb.exec("update facility_types set status='active' where id='facility_type_unmapped'"),
    /active facility type must belong to an active map filter/,
  );
  facilityDb.close();

  const merchantDb = database();
  merchantDb.exec("delete from map_filter_members where includes_merchants=1");
  assert.throws(
    () => merchantDb.exec(`
      insert into merchant_outlets(id,lifecycle_status,created_at,updated_at)
      values('merchant_unmapped','planned',datetime('now'),datetime('now'))
    `),
    /merchants must belong to an active map filter/,
  );
  merchantDb.close();
});

test("live map-filter categories and members cannot be deactivated, moved, or removed", () => {
  const db = database();
  insertPlace(db, "place_live", "building");
  // 搬去哪儿需要一个停用标签。以前这里借用种子里的 map_filter_outdoor，但 0019 把
  // 楼外那四个标签全启用了（否则后台建不了楼外地点），种子里已没有天然停用的标签。
  // 断言的是触发器行为，不是种子长什么样，所以样本自己造。
  db.exec(`
    insert into map_filter_categories(id,key,label,active,sort_order,created_at,updated_at)
    values('map_filter_move_target','moveTarget','搬运目标（停用）',0,900,datetime('now'),datetime('now'));
  `);

  assert.throws(
    () => db.exec("update map_filter_categories set active=0 where id='map_filter_teaching'"),
    /map filter with live members cannot be deactivated/,
  );
  assert.throws(
    () => db.exec(`
      update map_filter_members set category_id='map_filter_move_target'
       where id='map_filter_member_teaching'
    `),
    /live map filter member cannot move to an inactive map filter/,
  );
  assert.throws(
    () => db.exec("delete from map_filter_members where id='map_filter_member_teaching'"),
    /live map filter member cannot be deleted/,
  );

  assert.throws(
    () => db.exec("update map_filter_categories set active=0 where id='map_filter_printing'"),
    /map filter with live members cannot be deactivated/,
  );
  assert.throws(
    () => db.exec(`
      update map_filter_members set category_id='map_filter_move_target'
       where id='map_filter_member_printing'
    `),
    /live map filter member cannot move to an inactive map filter/,
  );
  assert.throws(
    () => db.exec("delete from map_filter_members where id='map_filter_member_printing'"),
    /live map filter member cannot be deleted/,
  );

  assert.deepEqual(db.prepare("pragma foreign_key_check").all(), []);
  db.close();
});

test("unused taxonomy targets support atomic creation, movement, deactivation, and deletion", () => {
  const db = database();
  db.exec(`
    insert into map_filter_categories(id,key,label,active,sort_order,created_at,updated_at)
    values
      ('map_filter_test_active','testActive','测试启用',1,800,datetime('now'),datetime('now')),
      ('map_filter_test_inactive','testInactive','测试停用',0,810,datetime('now'),datetime('now'));

    insert into place_kinds(id,name) values('test_kind','测试地点');
    insert into map_filter_members(
      id,category_id,place_kind_id,facility_type_id,includes_merchants,sort_order,created_at
    ) values(
      'map_filter_member_test_kind','map_filter_test_active','test_kind',null,0,10,datetime('now')
    );

    insert into facility_types(
      id,code,name,category,icon_key,visibility_policy_json,status,created_at,updated_at
    ) values(
      'facility_type_test','test_facility','测试设施','other','generic','{}','disabled',datetime('now'),datetime('now')
    );
    insert into map_filter_members(
      id,category_id,place_kind_id,facility_type_id,includes_merchants,sort_order,created_at
    ) values(
      'map_filter_member_test_facility','map_filter_test_active',null,'facility_type_test',0,20,datetime('now')
    );
    update facility_types set status='active' where id='facility_type_test';
  `);

  assert.equal(
    db.prepare("select status from facility_types where id='facility_type_test'").get().status,
    "active",
  );

  db.exec(`
    update facility_types set status='disabled' where id='facility_type_test';
    update map_filter_members set category_id='map_filter_test_inactive'
      where id='map_filter_member_test_facility';
    delete from map_filter_members where id='map_filter_member_test_facility';
    delete from facility_types where id='facility_type_test';

    update map_filter_members set category_id='map_filter_test_inactive'
      where id='map_filter_member_test_kind';
    delete from map_filter_members where id='map_filter_member_test_kind';
    delete from place_kinds where id='test_kind';

    update map_filter_categories set active=0 where id='map_filter_test_active';
  `);

  assert.equal(
    db.prepare("select active from map_filter_categories where id='map_filter_test_active'").get().active,
    0,
  );
  assert.deepEqual(db.prepare("pragma foreign_key_check").all(), []);
  db.close();
});
