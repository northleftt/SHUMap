// 楼层与楼层图管理。
//
// 关注三件事：
//   1. 楼层编号在写入口就被规范成 F<n>/B<n>——0016 迁移修过一行 level_code='一层'，
//      成因正是这个端点当年把它当自由文本收下。
//   2. 楼层页看到的设施 / 商户是按 floor_id **反查**出来的，不是复制的副本。
//      这就是「双向同步」的实现方式：改设施侧，楼层页刷新即变。
//   3. 删除楼层必须先解除引用，否则会留下悬空设施与看不到的图纸。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const bundle = await build({
  stdin: {
    contents: `
      export {
        canonicalLevelCode,
        levelOrderOf,
        levelDisplayName,
        listFloorsForBuilding,
        getFloorDetail,
        deleteFloor,
        updateFloorPlanStatus,
      } from "./worker/modules/floors.ts";
      export { createFloor, updateFloor } from "./worker/modules/spaces.ts";
    `,
    resolveDir: root,
    sourcefile: "floor-management-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const handlers = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
);

class Statement {
  constructor(sqlite, sql, values = []) {
    this.sqlite = sqlite;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new Statement(this.sqlite, this.sql, values);
  }

  async first() {
    return this.sqlite.prepare(this.sql).get(...this.values) ?? null;
  }

  async all() {
    return { results: this.sqlite.prepare(this.sql).all(...this.values) };
  }

  async run() {
    this.sqlite.prepare(this.sql).run(...this.values);
    return { success: true };
  }
}

class D1 {
  constructor(sqlite) {
    this.sqlite = sqlite;
  }

  prepare(sql) {
    return new Statement(this.sqlite, sql);
  }

  async batch(statements) {
    this.sqlite.exec("begin");
    try {
      for (const statement of statements) this.sqlite.prepare(statement.sql).run(...statement.values);
      this.sqlite.exec("commit");
    } catch (error) {
      this.sqlite.exec("rollback");
      throw error;
    }
    return statements.map(() => ({ success: true }));
  }
}

const now = "2026-08-03T00:00:00.000Z";
const principal = { userId: "user_editor", permissions: ["write:maps"] };

/** 一栋楼 + 一个可用账号，作为所有用例的起点。 */
function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("pragma foreign_keys=on");
  for (const name of fs.readdirSync(path.join(root, "migrations-v2")).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(read(`migrations-v2/${name}`));
  }
  sqlite.prepare(
    `insert into users(id,email,display_name,password_hash,status,token_version,created_at,updated_at)
     values('user_editor','editor@example.test','编辑','hash','active',1,?,?)`,
  ).run(now, now);
  sqlite.prepare(
    `insert into places(id,kind_id,campus_id,lifecycle_status,created_at,updated_at)
     values('place_tower','building','campus_baoshan','active',?,?)`,
  ).run(now, now);
  sqlite.prepare(
    "insert into buildings(place_id,building_code,public_access_level) values('place_tower','TOWER','public')",
  ).run();
  return sqlite;
}

function jsonRequest(body, method = "POST") {
  return new Request("https://example.test/api/admin/floors", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function addFloor(env, levelCode, displayName = "") {
  const response = await handlers.createFloor(
    jsonRequest({ buildingPlaceId: "place_tower", levelCode, levelOrder: 0, displayName, isPublic: true }),
    env,
    principal,
    "request_floor",
  );
  assert.equal(response.status, 201);
  return response.json();
}

/** 一张就绪的楼层平面图（map_assets → map_versions）。 */
function addPlan(sqlite, floorId, { id, label = "2026-08", status = "ready" }) {
  sqlite.prepare(
    `insert into media_assets(id,bucket_scope,object_key,content_type,byte_size,sha256,status,created_at)
     values(?,'private',?,'image/svg+xml',10,?,'approved',?)`,
  ).run(`media_${id}`, `private/imports/${id}.svg`, `hash_${id}`, now);
  sqlite.prepare(
    "insert into map_assets(id,asset_type,media_asset_id,checksum,created_at) values(?,'floor_svg',?,?,?)",
  ).run(`asset_${id}`, `media_${id}`, `hash_${id}`, now);
  sqlite.prepare(
    `insert into map_versions(id,campus_id,floor_id,map_asset_id,version_label,coordinate_space_type,
       coordinate_space_json,lifecycle_status,created_at)
     values(?,null,?,?,?,'svg_viewbox','{"width":100,"height":100}',?,?)`,
  ).run(id, floorId, `asset_${id}`, label, status, now);
}

// --- 编号规范化 ------------------------------------------------------------

test("level codes are normalized to the one form the schema contract allows", () => {
  const { canonicalLevelCode } = handlers;
  // 用户可能写的各种形式，全部落到同一个存储形式。
  for (const [input, expected] of [
    ["3", "F3"], ["F3", "F3"], ["f3", "F3"], ["F03", "F3"], ["3F", "F3"], ["3f", "F3"], [" 3F ", "F3"],
    ["B1", "B1"], ["b1", "B1"], ["B01", "B1"], ["1B", "B1"],
  ]) {
    assert.equal(canonicalLevelCode(input), expected, `${input} should normalize to ${expected}`);
  }

  // 0016 修过的那个值必须被挡住，否则同一个坑会再挖一遍。
  for (const bad of ["一层", "", "   ", "F", "B", "G", "F3.5", "3层", "F-1", "FB1", null, 3, undefined]) {
    assert.throws(
      () => canonicalLevelCode(bad),
      (error) => error.status === 400 && error.code === "validation_error",
      `${JSON.stringify(bad)} must be rejected`,
    );
  }
});

test("order and display name agree with the collection review path", () => {
  const { levelOrderOf, levelDisplayName } = handlers;
  assert.equal(levelOrderOf("F3"), 3);
  assert.equal(levelOrderOf("B2"), -2);
  assert.equal(levelDisplayName("F1"), "1 层");
  assert.equal(levelDisplayName("B1"), "地下 1 层");

  // reviews.ts 从采集提交建楼层时用的是自己那一对函数；两边必须同口径，
  // 否则手工建的楼层和审核建的楼层在用户端显示不一致。
  const reviews = read("worker/modules/reviews.ts");
  assert.match(reviews, /\$\{Number\(above\[1\]\)\} 层/);
  assert.match(reviews, /地下 \$\{Number\(below\[1\]\)\} 层/);
});

// --- 写入口 ----------------------------------------------------------------

test("creating a floor stores the canonical code and derives its order", async () => {
  const sqlite = database();
  const env = { DB: new D1(sqlite) };

  // 请求体里 levelOrder 传的是 0，服务端必须按编号推导而不是采信它，
  // 否则楼层顺序会和编号打架。
  const created = await addFloor(env, "3F");
  assert.equal(created.levelCode, "F3");
  assert.equal(created.levelOrder, 3);
  assert.equal(created.displayName, "3 层");

  const stored = sqlite.prepare("select level_code,level_order,display_name from floors where id=?").get(created.id);
  assert.equal(stored.level_code, "F3");
  assert.equal(stored.level_order, 3);

  const basement = await addFloor(env, "b1");
  assert.equal(basement.levelCode, "B1");
  assert.equal(basement.levelOrder, -1);
  assert.equal(basement.displayName, "地下 1 层");

  // 0016 结尾的契约：level_code 必须是首字母 + 无前导零的整数。
  const violations = sqlite.prepare(
    `select count(*) as count from floors
      where (level_code not glob 'F[0-9]*' and level_code not glob 'B[0-9]*')
         or level_code<>substr(level_code,1,1)||cast(substr(level_code,2) as integer)`,
  ).get();
  assert.equal(violations.count, 0);
});

test("an explicit display name is kept, and the same level cannot be added twice", async () => {
  const sqlite = database();
  const env = { DB: new D1(sqlite) };

  const created = await addFloor(env, "F2", "二层大厅");
  assert.equal(created.displayName, "二层大厅");

  // "2F" 规范化后与已存在的 F2 相同，必须回可读的 409 而不是外键错误。
  await assert.rejects(
    () => addFloor(env, "2F"),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "floor_exists");
      return true;
    },
  );
  assert.equal(sqlite.prepare("select count(*) as count from floors").get().count, 1);
});

// --- 反查即同步 ------------------------------------------------------------

test("floor detail reverse-looks-up the facilities and merchants bound to it", async () => {
  const sqlite = database();
  const env = { DB: new D1(sqlite) };
  const floor = await addFloor(env, "F1");
  const other = await addFloor(env, "F2");

  // 设施与商户在各自编辑器里选楼层，这里只写 floor_id——楼层侧不存副本。
  sqlite.prepare(
    `insert into facility_instances(id,facility_type_id,host_place_id,floor_id,lifecycle_status,operational_status,created_at,updated_at)
     values('facility_printer','facility_type_printer','place_tower',?,'active','available',?,?)`,
  ).run(floor.id, now, now);
  sqlite.prepare(
    `insert into merchant_outlets(id,host_place_id,floor_id,lifecycle_status,created_at,updated_at)
     values('merchant_cafe','place_tower',?,'active',?,?)`,
  ).run(floor.id, now, now);

  const detail = await (await handlers.getFloorDetail(env, floor.id)).json();
  assert.equal(detail.floor.levelCode, "F1");
  assert.equal(detail.floor.buildingName, null, "楼宇还没有当前修订，名称应为 null 而不是编造一个");
  assert.deepEqual(detail.facilities.map((row) => row.id), ["facility_printer"]);
  assert.deepEqual(detail.merchants.map((row) => row.id), ["merchant_cafe"]);
  // 没有修订时设施名回落到类型名，与内容管理列表同口径。
  assert.equal(detail.facilities[0].displayName, "打印服务");
  assert.equal(detail.facilities[0].positionedCount, 0, "还没在平面图上落点");

  // 另一层不应该看到这些内容。
  const otherDetail = await (await handlers.getFloorDetail(env, other.id)).json();
  assert.deepEqual(otherDetail.facilities, []);
  assert.deepEqual(otherDetail.merchants, []);

  // 关键：在设施侧改楼层归属，楼层页无需任何同步动作就跟着变。
  sqlite.prepare("update facility_instances set floor_id=? where id='facility_printer'").run(other.id);
  const afterMove = await (await handlers.getFloorDetail(env, floor.id)).json();
  assert.deepEqual(afterMove.facilities, [], "设施移走后原楼层立刻不再列出它");
  const movedTo = await (await handlers.getFloorDetail(env, other.id)).json();
  assert.deepEqual(movedTo.facilities.map((row) => row.id), ["facility_printer"]);
});

test("a facility anchored on the floor plan is reported as positioned", async () => {
  const sqlite = database();
  const env = { DB: new D1(sqlite) };
  const floor = await addFloor(env, "F1");
  addPlan(sqlite, floor.id, { id: "map_version_f1" });
  sqlite.prepare(
    `insert into facility_instances(id,facility_type_id,host_place_id,floor_id,lifecycle_status,operational_status,created_at,updated_at)
     values('facility_printer','facility_type_printer','place_tower',?,'active','available',?,?)`,
  ).run(floor.id, now, now);
  sqlite.prepare(
    `insert into location_anchors(id,floor_id,role,geometry_type,geometry_json,crs,map_version_id,
       precision_level,verification_status,created_at,updated_at)
     values('anchor_printer',?,'service_position','Point','{"type":"Point","coordinates":[10,20]}','svg_viewbox',
       'map_version_f1','exact','reviewed',?,?)`,
  ).run(floor.id, now, now);
  sqlite.prepare(
    `insert into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,created_at)
     values('eloc_printer','facility','facility_printer','anchor_printer','service_position',1,?)`,
  ).run(now);

  const detail = await (await handlers.getFloorDetail(env, floor.id)).json();
  assert.equal(detail.facilities[0].positionedCount, 1);
  assert.deepEqual(detail.plans.map((plan) => plan.id), ["map_version_f1"]);
  assert.equal(detail.plans[0].lifecycleStatus, "ready");
  assert.equal(detail.anchors.length, 1);
  assert.equal(detail.anchors[0].entityId, "facility_printer");
});

test("the building overview lists floors top-down with their plans and usage", async () => {
  const sqlite = database();
  const env = { DB: new D1(sqlite) };
  const basement = await addFloor(env, "B1");
  const first = await addFloor(env, "F1");
  const second = await addFloor(env, "F2");
  addPlan(sqlite, first.id, { id: "map_version_f1" });
  sqlite.prepare(
    `insert into facility_instances(id,facility_type_id,host_place_id,floor_id,lifecycle_status,operational_status,created_at,updated_at)
     values('facility_printer','facility_type_printer','place_tower',?,'active','available',?,?)`,
  ).run(first.id, now, now);

  const response = await handlers.listFloorsForBuilding(
    new Request("https://example.test/api/admin/floors?buildingPlaceId=place_tower"),
    env,
  );
  const payload = await response.json();
  // 高层在上，与真实楼层示意一致。
  assert.deepEqual(payload.items.map((row) => row.levelCode), ["F2", "F1", "B1"]);
  assert.equal(payload.building.placeId, "place_tower");

  const firstRow = payload.items.find((row) => row.id === first.id);
  assert.deepEqual(firstRow.plans.map((plan) => plan.id), ["map_version_f1"]);
  assert.equal(firstRow.usage.facilities, 1);
  assert.equal(firstRow.usage.mapVersions, 1);
  assert.equal(firstRow.isPublic, true);

  const emptyRow = payload.items.find((row) => row.id === second.id);
  assert.deepEqual(emptyRow.plans, []);
  assert.equal(emptyRow.usage.facilities, 0);
  assert.ok(basement, "地下层同样出现在总览里");

  await assert.rejects(
    () => handlers.listFloorsForBuilding(new Request("https://example.test/api/admin/floors"), env),
    (error) => error.status === 400 && error.code === "validation_error",
  );
});

// --- 删除与可见性 ----------------------------------------------------------

test("a floor with content attached cannot be deleted, and says what is holding it", async () => {
  const sqlite = database();
  const env = { DB: new D1(sqlite) };
  const floor = await addFloor(env, "F1");
  sqlite.prepare(
    `insert into facility_instances(id,facility_type_id,host_place_id,floor_id,lifecycle_status,operational_status,created_at,updated_at)
     values('facility_printer','facility_type_printer','place_tower',?,'active','available',?,?)`,
  ).run(floor.id, now, now);
  addPlan(sqlite, floor.id, { id: "map_version_f1" });

  await assert.rejects(
    () => handlers.deleteFloor(env, principal, floor.id, "request_delete"),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "floor_in_use");
      // 明细要能让界面说清「先把 1 个设施移走」，而不是丢一个数据库错误。
      assert.equal(error.details.facilities, 1);
      assert.equal(error.details.mapVersions, 1);
      return true;
    },
  );
  assert.equal(sqlite.prepare("select count(*) as count from floors where id=?").get(floor.id).count, 1);

  // 解除引用后可以删。
  sqlite.prepare("delete from facility_instances where id='facility_printer'").run();
  sqlite.prepare("delete from map_versions where id='map_version_f1'").run();
  const deleted = await (await handlers.deleteFloor(env, principal, floor.id, "request_delete")).json();
  assert.equal(deleted.deleted, true);
  assert.equal(sqlite.prepare("select count(*) as count from floors where id=?").get(floor.id).count, 0);
  // 删除要留痕。
  assert.equal(
    sqlite.prepare("select count(*) as count from audit_events where action='floor.delete'").get().count,
    1,
  );
});

test("hiding a floor keeps it and its content, unlike deleting", async () => {
  const sqlite = database();
  const env = { DB: new D1(sqlite) };
  const floor = await addFloor(env, "F1");
  sqlite.prepare(
    `insert into facility_instances(id,facility_type_id,host_place_id,floor_id,lifecycle_status,operational_status,created_at,updated_at)
     values('facility_printer','facility_type_printer','place_tower',?,'active','available',?,?)`,
  ).run(floor.id, now, now);

  await handlers.updateFloor(jsonRequest({ isPublic: false }, "PATCH"), env, principal, floor.id, "request_hide");
  const stored = sqlite.prepare("select is_public from floors where id=?").get(floor.id);
  assert.equal(stored.is_public, 0);
  // 内容原样保留——这正是「下架」与「删除」的区别。
  assert.equal(sqlite.prepare("select count(*) as count from facility_instances").get().count, 1);
});

// --- 图纸状态 --------------------------------------------------------------

test("floor plans can be archived but publishing stays with the release flow", async () => {
  const sqlite = database();
  const env = { DB: new D1(sqlite) };
  const floor = await addFloor(env, "F1");
  addPlan(sqlite, floor.id, { id: "map_version_old", label: "2026-07", status: "ready" });
  addPlan(sqlite, floor.id, { id: "map_version_live", label: "2026-08", status: "published" });
  addPlan(sqlite, floor.id, { id: "map_version_importing", label: "2026-09", status: "draft" });

  // 旧图归档：同一层不应该同时有两张可用图纸。
  const archived = await (await handlers.updateFloorPlanStatus(
    jsonRequest({ lifecycleStatus: "archived" }, "PATCH"),
    env,
    principal,
    "map_version_old",
    "request_archive",
  )).json();
  assert.equal(archived.lifecycleStatus, "archived");
  assert.equal(
    sqlite.prepare("select lifecycle_status from map_versions where id='map_version_old'").get().lifecycle_status,
    "archived",
  );

  // 已发布的图归发版流程管，这里动不了。
  await assert.rejects(
    () => handlers.updateFloorPlanStatus(
      jsonRequest({ lifecycleStatus: "archived" }, "PATCH"),
      env, principal, "map_version_live", "request_live",
    ),
    (error) => error.status === 409 && error.code === "invalid_state",
  );

  // 还在导入的图没有「就绪」可言。
  await assert.rejects(
    () => handlers.updateFloorPlanStatus(
      jsonRequest({ lifecycleStatus: "ready" }, "PATCH"),
      env, principal, "map_version_importing", "request_draft",
    ),
    (error) => error.status === 409 && error.code === "invalid_state",
  );

  // published 不是这个端点能写的取值。
  await assert.rejects(
    () => handlers.updateFloorPlanStatus(
      jsonRequest({ lifecycleStatus: "published" }, "PATCH"),
      env, principal, "map_version_old", "request_publish",
    ),
    (error) => error.status === 400 && error.code === "validation_error",
  );
});

test("the plan endpoint refuses campus maps, which belong to the release flow", async () => {
  const sqlite = database();
  const env = { DB: new D1(sqlite) };
  sqlite.prepare(
    `insert into media_assets(id,bucket_scope,object_key,content_type,byte_size,sha256,status,created_at)
     values('media_campus','private','private/imports/campus.svg','image/svg+xml',10,'hash_campus','approved',?)`,
  ).run(now);
  sqlite.prepare(
    "insert into map_assets(id,asset_type,media_asset_id,checksum,created_at) values('asset_campus','campus_svg','media_campus','hash_campus',?)",
  ).run(now);
  sqlite.prepare(
    `insert into map_versions(id,campus_id,floor_id,map_asset_id,version_label,coordinate_space_type,
       coordinate_space_json,lifecycle_status,created_at)
     values('map_version_campus','campus_baoshan',null,'asset_campus','2026-08','svg_viewbox','{}','ready',?)`,
  ).run(now);

  await assert.rejects(
    () => handlers.updateFloorPlanStatus(
      jsonRequest({ lifecycleStatus: "archived" }, "PATCH"),
      env, principal, "map_version_campus", "request_campus",
    ),
    (error) => error.status === 400 && error.code === "validation_error",
  );
});

// --- 接线 ------------------------------------------------------------------

test("the floor endpoints are registered behind the map permission", () => {
  const worker = read("worker/index-v2.ts");
  assert.match(worker, /path === "\/api\/admin\/floors"[\s\S]{0,200}?listFloorsForBuilding/);
  assert.match(worker, /getFloorDetail/);
  assert.match(worker, /deleteFloor/);
  assert.match(worker, /floor-plans\/:id\/status/);

  // 写操作要 write:maps，读用 read:admin。
  for (const call of ["deleteFloor(env", "updateFloorPlanStatus(request"]) {
    const at = worker.lastIndexOf(call);
    assert.ok(at > 0, `${call} must be called from the router`);
    const gate = worker.lastIndexOf('requireSession(request, env, "write:maps")', at);
    assert.ok(gate > 0 && at - gate < 200, `${call} must be gated by write:maps`);
  }
  const detailAt = worker.lastIndexOf("getFloorDetail(env");
  const detailGate = worker.lastIndexOf('requireSession(request, env, "read:admin")', detailAt);
  assert.ok(detailGate > 0 && detailAt - detailGate < 200, "floor detail must require read:admin");
});

test("the admin floor page links back to the content editors instead of copying their fields", () => {
  const page = read("src/admin/pages/FloorsPage.tsx");
  // 楼层页不编辑设施内容，只跳转过去——避免同一份数据两处可改。
  assert.match(page, /\/admin\/content\/facilities\//);
  assert.match(page, /\/admin\/content\/merchants\//);
  assert.match(page, /listBuildingFloors/);
  assert.match(page, /updateFloorPlanStatus/);
  // 上传楼层图走既有的 import 管线（意图 → 上传 → 导入任务）。
  assert.match(page, /createMapUploadIntent/);
  assert.match(page, /createImportJob/);
  assert.match(page, /floor_svg/);

  const adminShell = read("src/admin/AdminPage.tsx");
  assert.match(adminShell, /path="floors"/);
  assert.match(adminShell, /FloorsPage/);
});
