// POST /api/admin/transit/trips（createTrip）的回归测试。
//
// 背景：0024 把预约与否改成线路级属性后，前端 saveTrips 不再提交 bookingPolicy，
// 但 worker 的 exactObject 仍把它列在必填位 —— 管理端「添加班次」因此一律 400
// validation_error（界面只显示「填写的内容不完整或不正确」）。0024 之后的存量班次
// 全部由脚本导入，这个破口直到第一次手工给新线路排班（城璟公寓）才暴露。
// 修复：bookingPolicy 移入 exactObject 的可选位，收下但以所属线路为准。
//
// harness 范式同 tests/transit-campus-lines.test.mjs。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await build({
  stdin: {
    contents: `export { createTrip } from "./worker/modules/transit.ts";`,
    resolveDir: root,
    sourcefile: "transit-trip-create-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`;
const { createTrip } = await import(moduleUrl);

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

const NOW = "2026-09-01T00:00:00.000Z";

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys=on");
  for (const name of fs.readdirSync(path.join(root, "migrations-v2")).filter((value) => value.endsWith(".sql")).sort()) {
    db.exec(fs.readFileSync(path.join(root, "migrations-v2", name), "utf8"));
  }
  db.prepare(
    "insert into users(id,email,display_name,password_hash,status,token_version,created_at,updated_at) values('user_admin','admin@test','管理员','x','active',0,?,?)",
  ).run(NOW, NOW);
  db.prepare(
    "insert into transit_stops(id,place_id,campus_id,code,name,status,created_at,updated_at) values('stop_a',null,null,null,'城璟公寓','active',?,?)",
  ).run(NOW, NOW);
  db.prepare(
    "insert into transit_stops(id,place_id,campus_id,code,name,status,created_at,updated_at) values('stop_b',null,'campus_baoshan',null,'宝山-钱伟长图书馆','active',?,?)",
  ).run(NOW, NOW);
  db.prepare(
    "insert into transit_routes(id,code,name,operator_id,status,booking_policy,booking_url,created_at,updated_at) values('route_resv',null,'城璟公寓 → 宝山校区',null,'active','required',null,?,?)",
  ).run(NOW, NOW);
  db.prepare("insert into transit_patterns(id,route_id,direction_id,name) values('p1','route_resv',0,'默认')").run();
  db.prepare(
    "insert into transit_pattern_stops(pattern_id,stop_id,stop_sequence,pickup_type,dropoff_type) values('p1','stop_a',0,'regular','none')",
  ).run();
  db.prepare(
    "insert into transit_pattern_stops(pattern_id,stop_id,stop_sequence,pickup_type,dropoff_type) values('p1','stop_b',1,'none','regular')",
  ).run();
  db.prepare(
    "insert into service_calendars(id,name,day_type,valid_from,valid_to,monday,tuesday,wednesday,thursday,friday,saturday,sunday) values('cal_w','2026-2027 工作日','weekday','2026-09-01','2027-01-31',1,1,1,1,1,0,0)",
  ).run();
  return db;
}

const principal = { userId: "user_admin", permissions: ["write:transit"] };

function env(db) {
  return { DB: new D1Database(db) };
}

function request(body) {
  return new Request("https://example.test/api/admin/transit/trips", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// 与管理端 saveTrips 实际发送的载荷一致：没有 bookingPolicy。
function tripPayload() {
  return {
    patternId: "p1",
    serviceCalendarId: "cal_w",
    publicLabel: null,
    bookingUrl: null,
    sourceId: null,
    stopTimes: [
      { arrivalTime: "07:15", departureTime: "07:15" },
      { arrivalTime: null, departureTime: null },
    ],
  };
}

test("不带 bookingPolicy 创建班次成功（0024 后前端的实际载荷）", async () => {
  const db = database();
  const response = await createTrip(request(tripPayload()), env(db), principal, "req_create");
  assert.equal(response.status, 201);
  const { id } = await response.json();
  const trip = db.prepare("select booking_policy as policy from transit_trips where id=?").get(id);
  // 落库以所属线路为准（route_resv 是 required），与请求里带不带 bookingPolicy 无关。
  assert.equal(trip.policy, "required");
  const times = db
    .prepare("select stop_id as stopId,arrival_time as arr,departure_time as dep from transit_stop_times where trip_id=? order by stop_sequence")
    .all(id);
  // node:sqlite 返回 null-prototype 对象，deepStrictEqual 会拒，先过一遍 JSON 抹平。
  assert.deepEqual(JSON.parse(JSON.stringify(times)), [
    { stopId: "stop_a", arr: "07:15", dep: "07:15" },
    { stopId: "stop_b", arr: null, dep: null },
  ]);
});

test("带 bookingPolicy 的旧客户端也收下（向后兼容），但以线路为准", async () => {
  const db = database();
  const response = await createTrip(request({ ...tripPayload(), bookingPolicy: "not_required" }), env(db), principal, "req_legacy");
  assert.equal(response.status, 201);
  const { id } = await response.json();
  const trip = db.prepare("select booking_policy as policy from transit_trips where id=?").get(id);
  assert.equal(trip.policy, "required", "线路是 required，请求里的 not_required 不生效");
});

test("未知字段仍然拒绝", async () => {
  const db = database();
  await assert.rejects(
    createTrip(request({ ...tripPayload(), nonsense: 1 }), env(db), principal, "req_unknown"),
    (error) => error.status === 400 && error.code === "validation_error",
  );
});

test("stopTimes 数量与站点序列不一致仍然拒绝", async () => {
  const db = database();
  const payload = { ...tripPayload(), stopTimes: [{ arrivalTime: "07:15", departureTime: "07:15" }] };
  await assert.rejects(
    createTrip(request(payload), env(db), principal, "req_mismatch"),
    (error) => error.status === 400 && error.code === "validation_error",
  );
});
