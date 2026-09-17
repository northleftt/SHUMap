import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

// 与 building-footprint-review-flow.test.mjs 同一个 D1 模拟器：直接跑真 handler。
const bundle = await build({
  stdin: {
    contents: `
      export { updatePlaceLifecycle, deletePlace } from "./worker/modules/places.ts";
      export { updateFacilityLifecycle } from "./worker/modules/facilities.ts";
      export { updateMerchantLifecycle } from "./worker/modules/merchants.ts";
    `,
    resolveDir: root,
    sourcefile: "lifecycle-reactivation-guards-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`;
const handlers = await import(moduleUrl);

class Statement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new Statement(this.database, this.sql, values);
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.values) ?? null;
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.values) };
  }

  async run() {
    this.database.prepare(this.sql).run(...this.values);
    return { success: true };
  }
}

class D1Database {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new Statement(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("begin");
    try {
      for (const statement of statements) this.database.prepare(statement.sql).run(...statement.values);
      this.database.exec("commit");
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
    return statements.map(() => ({ success: true }));
  }
}

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys=on");
  for (const name of fs.readdirSync(path.join(root, "migrations-v2")).filter((value) => value.endsWith(".sql")).sort()) {
    db.exec(read(`migrations-v2/${name}`));
  }
  db.prepare(
    `insert into users(id,email,display_name,password_hash,status,token_version,created_at,updated_at)
     values('user_editor','editor@example.test','编辑','hash','active',1,'2026-08-01','2026-08-01')`,
  ).run();
  return db;
}

function lifecycleRequest(lifecycleStatus) {
  return new Request("https://example.test/api/admin/test", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lifecycleStatus }),
  });
}

const principal = { userId: "user_editor", permissions: ["write:content"] };

function insertRetiredPlace(db, id, kindId) {
  db.prepare(
    `insert into places(id,kind_id,campus_id,lifecycle_status,approval_pending,created_at,updated_at)
     values(?,?,'campus_baoshan','retired',0,'2026-08-01','2026-08-01')`,
  ).run(id, kindId);
}

/** 停用楼栋 + 它的 footprint 锚点与绑定；bindingValidTo 非空表示绑定已随停用关闭。 */
function insertRetiredBuildingWithFootprint(db, placeId, featureId, bindingValidTo) {
  insertRetiredPlace(db, placeId, "building");
  db.prepare("insert into buildings(place_id) values(?)").run(placeId);
  db.prepare(
    `insert into location_anchors(
       id,campus_id,building_place_id,role,geometry_type,geometry_json,crs,map_version_id,map_feature_id,
       precision_level,verification_status,valid_from,valid_to,created_at,updated_at
     ) values(?,'campus_baoshan',?,'footprint','Polygon',null,null,'map_version_campus_baoshan',?,
              'exact','reviewed',null,null,'2026-08-01','2026-08-01')`,
  ).run(`anchor_${placeId}`, placeId, featureId);
  db.prepare(
    `insert into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,valid_from,valid_to,created_at)
     values(?,?,?,?,'footprint',1,null,?,'2026-08-01')`,
  ).run(`eloc_${placeId}`, "place", placeId, `anchor_${placeId}`, bindingValidTo);
}

// ---------------------------------------------------------------------------
// 「停用后无法恢复」的残留病例：恢复路径上还有两个触发器会把请求打成裸 500。
// 停用期间保护性触发器（protect_used_*）不拦 retired 成员，于是筛选组可以下线、
// 设施类型可以禁用、轮廓图形可以被别的楼认领——恢复时 0012/0015 的守卫触发器
// raise(abort)，全局错误处理把它变成没有说明的 internal_error。
// 修复：updatePlaceLifecycle / updateFacilityLifecycle 在离开 retired 前先做
// 前置检查，用可读的 409 说清楚该先修什么。
// ---------------------------------------------------------------------------

test("reactivating a place whose kind lost its active map filter returns 409, not a trigger 500", async () => {
  const db = database();
  // 没有筛选组成员的分类：insert 触发器只拦非 retired，retired 地点能落库。
  db.prepare("insert into place_kinds(id,name) values('kind_orphan','孤儿分类')").run();
  insertRetiredPlace(db, "place_orphan", "kind_orphan");

  // 先证明 500 路径真实存在：裸 update 会被 0012 触发器拒掉。
  assert.throws(
    () => db.prepare("update places set lifecycle_status='active' where id='place_orphan'").run(),
    /place kind must belong to an active map filter/,
  );

  const env = { DB: new D1Database(db) };
  await assert.rejects(
    handlers.updatePlaceLifecycle(lifecycleRequest("active"), env, principal, "place_orphan", "request_reactivate"),
    (error) => error.status === 409 && error.code === "place_kind_filter_inactive",
  );
  const row = db.prepare("select lifecycle_status as status from places where id='place_orphan'").get();
  assert.equal(row.status, "retired", "409 之后状态不该被改一半");
});

test("reactivating a building whose footprint was claimed elsewhere returns 409, not a trigger 500", async () => {
  const db = database();
  const feature = db.prepare(
    `select id from map_features
      where map_version_id='map_version_campus_baoshan' and feature_kind='building_footprint'
      order by id limit 1`,
  ).get();
  assert.ok(feature);
  // b1 停用、绑定关闭；b2 在 b1 停用期间认领了同一图形（占用查询只看存活绑定，合法）。
  insertRetiredBuildingWithFootprint(db, "place_b1", feature.id, "2026-08-02T00:00:00.000Z");
  db.prepare(
    `insert into places(id,kind_id,campus_id,lifecycle_status,approval_pending,created_at,updated_at)
     values('place_b2','building','campus_baoshan','active',0,'2026-08-01','2026-08-01')`,
  ).run();
  db.prepare("insert into buildings(place_id) values('place_b2')").run();
  db.prepare(
    `insert into location_anchors(
       id,campus_id,building_place_id,role,geometry_type,geometry_json,crs,map_version_id,map_feature_id,
       precision_level,verification_status,created_at,updated_at
     ) values('anchor_b2','campus_baoshan','place_b2','footprint','Polygon',null,null,
              'map_version_campus_baoshan',?,'exact','reviewed','2026-08-02','2026-08-02')`,
  ).run(feature.id);
  db.prepare(
    `insert into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,valid_from,valid_to,created_at)
     values('eloc_b2','place','place_b2','anchor_b2','footprint',1,null,null,'2026-08-02')`,
  ).run();

  // 500 路径实证：直接复活 b1 的绑定会撞 require_unique_active_feature_footprint_update。
  assert.throws(
    () => db.prepare(
      "update entity_locations set valid_to=null where entity_type='place' and entity_id='place_b1' and valid_to='2026-08-02T00:00:00.000Z'",
    ).run(),
    /map feature already has an active footprint binding/,
  );

  const env = { DB: new D1Database(db) };
  await assert.rejects(
    handlers.updatePlaceLifecycle(lifecycleRequest("active"), env, principal, "place_b1", "request_reactivate"),
    (error) => error.status === 409 && error.code === "place_footprint_conflict",
  );
});

test("reactivating a facility whose type was disabled returns 409, not a trigger 500", async () => {
  const db = database();
  db.prepare(
    `insert into facility_types(id,code,name,category,visibility_policy_json,status,created_at,updated_at)
     values('ft_dead','dead','已下线类型','other','{}','disabled','2026-08-01','2026-08-01')`,
  ).run();
  db.prepare(
    `insert into facility_instances(id,facility_type_id,lifecycle_status,approval_pending,created_at,updated_at)
     values('facility_dead','ft_dead','retired',0,'2026-08-01','2026-08-01')`,
  ).run();

  // 500 路径实证：裸 update 会被 0012 触发器拒掉。
  assert.throws(
    () => db.prepare("update facility_instances set lifecycle_status='active' where id='facility_dead'").run(),
    /facility type must be enabled and belong to an active map filter/,
  );

  const env = { DB: new D1Database(db) };
  await assert.rejects(
    handlers.updateFacilityLifecycle(lifecycleRequest("active"), env, principal, "facility_dead", "request_reactivate"),
    (error) => error.status === 409 && error.code === "facility_type_inactive",
  );
});

test("reactivating a clean retired place still works and restores its footprint binding", async () => {
  const db = database();
  const feature = db.prepare(
    `select id from map_features
      where map_version_id='map_version_campus_baoshan' and feature_kind='building_footprint'
      order by id limit 1`,
  ).get();
  assert.ok(feature);
  insertRetiredBuildingWithFootprint(db, "place_ok", feature.id, "2026-08-02T00:00:00.000Z");

  const env = { DB: new D1Database(db) };
  const response = await handlers.updatePlaceLifecycle(lifecycleRequest("active"), env, principal, "place_ok", "request_reactivate");
  assert.equal(response.status, 200);
  const place = db.prepare("select lifecycle_status as status from places where id='place_ok'").get();
  assert.equal(place.status, "active");
  const binding = db.prepare(
    "select valid_to as validTo from entity_locations where id='eloc_place_ok'",
  ).get();
  assert.equal(binding.validTo, null, "轮廓绑定应被重新打开");
});

test("reactivating a clean retired facility still works", async () => {
  const db = database();
  const type = db.prepare("select id from facility_types where status='active' limit 1").get();
  assert.ok(type, "0011/0019 应种好至少一个启用的设施类型");
  db.prepare(
    `insert into facility_instances(id,facility_type_id,lifecycle_status,approval_pending,created_at,updated_at)
     values('facility_ok',?,'retired',0,'2026-08-01','2026-08-01')`,
  ).run(type.id);

  const env = { DB: new D1Database(db) };
  const response = await handlers.updateFacilityLifecycle(lifecycleRequest("active"), env, principal, "facility_ok", "request_reactivate");
  assert.equal(response.status, 200);
  const row = db.prepare("select lifecycle_status as status from facility_instances where id='facility_ok'").get();
  assert.equal(row.status, "active");
});

test("reactivating a merchant while its filter is deactivated returns 409, not a trigger 500", async () => {
  const db = database();
  db.prepare(
    `insert into merchant_outlets(id,lifecycle_status,approval_pending,created_at,updated_at)
     values('outlet_dead','retired',0,'2026-08-01','2026-08-01')`,
  ).run();
  // 商户筛选组整体下线：protect_used_map_filter_deactivation 不拦 retired 商户，合法。
  db.prepare(
    `update map_filter_categories set active=0
      where id in (select category_id from map_filter_members where includes_merchants=1)`,
  ).run();

  // 500 路径实证：裸 update 会被 0012 的 require_merchant_active_map_filter_update 拒掉。
  assert.throws(
    () => db.prepare("update merchant_outlets set lifecycle_status='active' where id='outlet_dead'").run(),
    /merchants must belong to an active map filter/,
  );

  const env = { DB: new D1Database(db) };
  await assert.rejects(
    handlers.updateMerchantLifecycle(lifecycleRequest("active"), env, principal, "outlet_dead", "request_reactivate"),
    (error) => error.status === 409 && error.code === "merchant_filter_inactive",
  );
});

// ---------------------------------------------------------------------------
// collection_tasks 是 cascade 不是 restrict：删楼不撞外键，但会把这栋楼的采集
// 任务连同已采集 payload 一起静默抹掉。placeUsage 现在把它也计为引用。
// ---------------------------------------------------------------------------

test("placeUsage counts collection tasks so deleting a building does not silently wipe them", () => {
  const places = read("worker/modules/places.ts");
  assert.match(places, /from collection_tasks where building_place_id=\?/);

  const db = database();
  insertRetiredPlace(db, "place_collect", "other");
  db.prepare(
    `insert into collection_tasks(building_place_id,device_id,assignee_name,status,created_at,updated_at)
     values('place_collect','device_1','志愿者','collecting','2026-08-01','2026-08-01')`,
  ).run();
  const row = db.prepare("select count(*) as count from collection_tasks where building_place_id=?").get("place_collect");
  assert.equal(row.count, 1, "采集任务必须被计为引用，deletePlace 才回 409 而不是静默级联");
});

test("deletePlace returns a 409 with reference details through the real handler", async () => {
  const db = database();
  insertRetiredPlace(db, "place_del", "other");
  db.prepare("insert into buildings(place_id) values('place_del')").run();
  // 别的实体（运营事件）把位置锚进了这栋楼——placeUsage 的 locationRefs 要接住它。
  db.prepare(
    `insert into location_anchors(id,building_place_id,role,geometry_type,precision_level,verification_status,created_at,updated_at)
     values('anchor_foreign','place_del','event_location','Point','building','reviewed','2026-08-01','2026-08-01')`,
  ).run();

  const env = { DB: new D1Database(db) };
  await assert.rejects(
    handlers.deletePlace(env, principal, "place_del", "request_delete"),
    (error) => error.status === 409 && error.code === "place_in_use" && error.details?.locationRefs === 1,
  );
  assert.ok(db.prepare("select id from places where id='place_del'").get(), "409 之后行必须还在");
});

test("the new 409 codes all have actionable copy in the content page", () => {
  const content = read("src/admin/pages/ContentPage.tsx");
  for (const code of ["place_kind_filter_inactive", "place_footprint_conflict", "facility_type_inactive", "merchant_filter_inactive"]) {
    assert.match(content, new RegExp(code), `${code} 需要在 ERROR_TEXT 里有可照做的文案`);
  }
});
