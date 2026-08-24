// GET /api/public/transit/campus-lines（0024 校区对校区改版）的契约测试。
//
// harness 范式同 tests/building-footprint-review-flow.test.mjs：esbuild 把
// worker/modules/transit.ts 编成 esm 后 data: URL import；node:sqlite :memory:
// 建库跑 migrations-v2 全量，D1Database/Statement 包装类照抄。
//
// 自建最小数据集（直接 SQL insert）：
//   campuses: campus_baoshan / campus_jiading / campus_empty（无任何站点）
//   transit_stops: bs-a、bs-b（宝山）、jd-a（嘉定）、stop_chentai（无校区）、
//     stop_inactive（嘉定，status='retired'，验证端点集合过滤）
//   transit_routes: route_normal（not_required，带 booking_url）、
//     route_resv（required，booking_url=null）、route_reverse（not_required）
//   patterns（首站在 from 集合、末站在 to 集合判定方向）：
//     p1/p2: bs-a/bs-b → jd-a（route_normal）；p3: bs-a → jd-a（route_resv）；
//     p4: jd-a → bs-a、p5: stop_chentai → bs-a（route_reverse）；
//     p6: stop_inactive → bs-a（route_reverse，不应被 campus_jiading 命中）
//   service_calendars cal_a：2026-08-01..2026-08-31，friday=1/tuesday=1，
//     exception added 2026-08-23（周日）、removed 2026-08-28（周五）
//
// 已知星期：2026-08-21 周五、2026-08-22 周六、2026-08-23 周日、
// 2026-08-25 周二、2026-08-28 周五、2026-09-01 周二（已用 Intl 验证）。

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
    contents: `export { publicCampusLines, resolveDayType } from "./worker/modules/transit.ts";`,
    resolveDir: root,
    sourcefile: "transit-campus-lines-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`;
const { publicCampusLines, resolveDayType } = await import(moduleUrl);

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

const NOW = "2026-08-01T00:00:00.000Z";

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys=on");
  for (const name of fs.readdirSync(path.join(root, "migrations-v2")).filter((value) => value.endsWith(".sql")).sort()) {
    db.exec(fs.readFileSync(path.join(root, "migrations-v2", name), "utf8"));
  }

  // 三个真实校区由 0001 迁移内置（campus_baoshan/campus_jiading/campus_yanchang），
  // 这里只补一个没有任何站点的校区。
  db.prepare(
    "insert into campuses(id,code,name,status,created_at,updated_at) values('campus_empty','empty','空校区','active',?,?)",
  ).run(NOW, NOW);

  const insertStop = db.prepare(
    "insert into transit_stops(id,place_id,campus_id,code,name,status,created_at,updated_at) values(?,null,?,?,?,?,?,?)",
  );
  insertStop.run("bs-a", "campus_baoshan", null, "宝山-A站", "active", NOW, NOW);
  insertStop.run("bs-b", "campus_baoshan", null, "宝山-B站", "active", NOW, NOW);
  insertStop.run("jd-a", "campus_jiading", null, "嘉定-A站", "active", NOW, NOW);
  insertStop.run("stop_chentai", null, null, "陈太公寓", "active", NOW, NOW);
  insertStop.run("stop_inactive", "campus_jiading", null, "已停用站", "retired", NOW, NOW);

  const insertRoute = db.prepare(
    "insert into transit_routes(id,code,name,operator_id,status,booking_policy,booking_url,created_at,updated_at) values(?,?,?,null,'active',?,?,?,?)",
  );
  insertRoute.run("route_normal", "bs-jd", "宝山校区 → 嘉定校区", "not_required", "https://vcard.example/book", NOW, NOW);
  insertRoute.run("route_resv", "bs-jd-r", "宝山校区 → 嘉定校区（预约）", "required", null, NOW, NOW);
  insertRoute.run("route_reverse", "jd-bs", "嘉定校区 → 宝山校区", "not_required", null, NOW, NOW);

  const insertPattern = db.prepare(
    "insert into transit_patterns(id,route_id,direction_id,name) values(?,?,0,?)",
  );
  const insertPatternStop = db.prepare(
    "insert into transit_pattern_stops(pattern_id,stop_id,stop_sequence,pickup_type,dropoff_type) values(?,?,?,?,?)",
  );
  const pattern = (id, routeId, name, stops) => {
    insertPattern.run(id, routeId, name);
    stops.forEach(([stopId, pickup, dropoff], index) => insertPatternStop.run(id, stopId, index, pickup, dropoff));
  };
  pattern("p1", "route_normal", "A线", [["bs-a", "regular", "none"], ["jd-a", "none", "regular"]]);
  pattern("p2", "route_normal", "B线", [["bs-b", "regular", "none"], ["jd-a", "none", "regular"]]);
  pattern("p3", "route_resv", "预约线", [["bs-a", "regular", "none"], ["jd-a", "none", "regular"]]);
  pattern("p4", "route_reverse", "反向", [["jd-a", "regular", "none"], ["bs-a", "none", "regular"]]);
  pattern("p5", "route_reverse", "陈太线", [["stop_chentai", "regular", "none"], ["bs-a", "none", "regular"]]);
  pattern("p6", "route_reverse", "停用站线", [["stop_inactive", "regular", "none"], ["bs-a", "none", "regular"]]);

  db.prepare(
    `insert into service_calendars(id,name,valid_from,valid_to,monday,tuesday,wednesday,thursday,friday,saturday,sunday)
     values('cal_a','测试日历','2026-08-01','2026-08-31',0,1,0,0,1,0,0)`,
  ).run();
  const insertException = db.prepare(
    "insert into service_calendar_exceptions(calendar_id,service_date,exception_type,label) values('cal_a',?,?,null)",
  );
  insertException.run("2026-08-23", "added"); // 周日加开
  insertException.run("2026-08-28", "removed"); // 周五停运

  const insertTrip = db.prepare(
    "insert into transit_trips(id,pattern_id,service_calendar_id,public_label,booking_policy,booking_url,status) values(?,?,'cal_a',null,?,?,?)",
  );
  const insertStopTime = db.prepare(
    "insert into transit_stop_times(trip_id,stop_id,stop_sequence,arrival_time,departure_time) values(?,?,?,?,?)",
  );
  const trip = (id, patternId, bookingPolicy, bookingUrl, status, times) => {
    insertTrip.run(id, patternId, bookingPolicy, bookingUrl, status);
    times.forEach(([stopId, sequence, arrival, departure]) => insertStopTime.run(id, stopId, sequence, arrival, departure));
  };
  // 故意乱序插入，验证响应按 departureTime 排序
  trip("t2", "p1", "not_required", null, "active", [["bs-a", 0, null, "09:30"], ["jd-a", 1, "10:30", null]]);
  trip("t1", "p1", "not_required", null, "active", [["bs-a", 0, null, "07:00"], ["jd-a", 1, "08:00", null]]);
  trip("t4", "p2", "not_required", null, "active", [["bs-b", 0, null, "08:00"], ["jd-a", 1, "09:00", null]]);
  trip("t8", "p1", "not_required", null, "cancelled", [["bs-a", 0, null, "06:00"], ["jd-a", 1, "07:00", null]]);
  // 线路 booking_url 为 null 时回落到班次的非空值
  trip("t3", "p3", "required", "https://trip.example/book", "active", [["bs-a", 0, null, "12:00"], ["jd-a", 1, "13:00", null]]);
  trip("t5", "p4", "not_required", null, "active", [["jd-a", 0, null, "10:00"], ["bs-a", 1, "11:00", null]]);
  trip("t6", "p5", "not_required", null, "active", [["stop_chentai", 0, null, "11:00"], ["bs-a", 1, "11:30", null]]);
  trip("t7", "p6", "not_required", null, "active", [["stop_inactive", 0, null, "12:30"], ["bs-a", 1, "13:00", null]]);

  return db;
}

function call(db, query) {
  return publicCampusLines(new Request(`https://test/api/public/transit/campus-lines?${query}`), { DB: new D1Database(db) });
}

async function callJson(db, query) {
  const response = await call(db, query);
  assert.equal(response.status, 200, `应返回 200：${query}`);
  return response.json();
}

test("campus 端点归组命中多首站 pattern，线路级预约属性与 bookingUrl 回落", async () => {
  const db = database();
  const payload = await callJson(db, "from=campus_baoshan&to=campus_jiading&date=2026-08-21");

  assert.equal(payload.date, "2026-08-21");
  assert.equal(payload.timezone, "Asia/Shanghai");
  assert.deepEqual(payload.from, { id: "campus_baoshan", name: "宝山校区" });
  assert.deepEqual(payload.to, { id: "campus_jiading", name: "嘉定校区" });
  assert.equal(payload.lines.length, 2, "正向应有两条线路（普通 + 预约）");

  const normal = payload.lines.find((line) => line.routeId === "route_normal");
  // 端点归组：bs-a 与 bs-b 为首站的 pattern 都归到 campus_baoshan
  assert.deepEqual(normal.patterns.map((p) => p.patternId).sort(), ["p1", "p2"]);
  // 预约是线路级属性
  assert.equal(normal.bookingPolicy, "not_required");
  // 线路自带 booking_url 时优先于班次
  assert.equal(normal.bookingUrl, "https://vcard.example/book");
  // journeys 按 departureTime 排序（t8 已取消不出现），stopTimes 随班次返回
  assert.deepEqual(normal.journeys.map((j) => j.departureTime), ["07:00", "08:00", "09:30"]);
  const t1 = normal.journeys[0];
  assert.equal(t1.tripId, "t1");
  assert.equal(t1.patternId, "p1");
  assert.equal(t1.arrivalTime, "08:00");
  // 估算字段随每站返回；这个库里没有采样样本，所以全是 null（页面按「暂无」渲染）。
  assert.deepEqual(t1.stopTimes, [
    { stopSequence: 0, arrivalTime: null, departureTime: "07:00", estimatedArrivalTime: null, estimatedArrivalDayOffset: null },
    { stopSequence: 1, arrivalTime: "08:00", departureTime: null, estimatedArrivalTime: null, estimatedArrivalDayOffset: null },
  ]);
  assert.equal(t1.estimatedArrivalTime, null);
  assert.equal(t1.estimatedDurationMinutes, null);
  // pattern 停靠序列带 pickup/dropoff
  const p1 = normal.patterns.find((p) => p.patternId === "p1");
  assert.deepEqual(p1.stops, [
    { stopId: "bs-a", stopName: "宝山-A站", stopSequence: 0, pickupType: "regular", dropoffType: "none" },
    { stopId: "jd-a", stopName: "嘉定-A站", stopSequence: 1, pickupType: "none", dropoffType: "regular" },
  ]);

  const reserved = payload.lines.find((line) => line.routeId === "route_resv");
  assert.equal(reserved.bookingPolicy, "required");
  // 线路 booking_url 为 null → 回落到班次的非空 booking_url
  assert.equal(reserved.bookingUrl, "https://trip.example/book");
  assert.deepEqual(reserved.journeys.map((j) => j.tripId), ["t3"]);
  db.close();
});

test("方向匹配：反向查询不返回正向线路", async () => {
  const db = database();
  const payload = await callJson(db, "from=campus_jiading&to=campus_baoshan&date=2026-08-21");
  assert.equal(payload.lines.length, 1, "反向只有 route_reverse");
  assert.equal(payload.lines[0].routeId, "route_reverse");
  // 停用站不作为端点集合成员：p6（stop_inactive 首站）不被 campus_jiading 命中
  assert.deepEqual(payload.lines[0].patterns.map((p) => p.patternId), ["p4"]);
  assert.deepEqual(payload.lines[0].journeys.map((j) => j.tripId), ["t5"]);
  db.close();
});

test("日历过滤：weekday 标记 / added / removed / valid 范围", async () => {
  const db = database();
  const tripIds = (payload) => payload.lines.flatMap((line) => line.journeys.map((j) => j.tripId));

  // 2026-08-22 周六：cal_a saturday=0 → 无班次（但线路骨架仍在）
  const saturday = await callJson(db, "from=campus_baoshan&to=campus_jiading&date=2026-08-22");
  assert.equal(saturday.lines.length, 2);
  assert.deepEqual(tripIds(saturday), []);

  // 2026-08-23 周日：exception added → 出班次
  const added = await callJson(db, "from=campus_baoshan&to=campus_jiading&date=2026-08-23");
  assert.deepEqual(tripIds(added).sort(), ["t1", "t2", "t3", "t4"]);

  // 2026-08-28 周五：exception removed → 不出班次
  const removed = await callJson(db, "from=campus_baoshan&to=campus_jiading&date=2026-08-28");
  assert.deepEqual(tripIds(removed), []);

  // 2026-08-25 周二：tuesday=1 且在有效期内 → 出班次
  const tuesday = await callJson(db, "from=campus_baoshan&to=campus_jiading&date=2026-08-25");
  assert.deepEqual(tuesday.lines.length > 0 && tripIds(tuesday).length > 0, true);

  // 2026-09-01 周二：weekday 标记命中但超出 valid_to → 不出班次
  const outOfRange = await callJson(db, "from=campus_baoshan&to=campus_jiading&date=2026-09-01");
  assert.deepEqual(tripIds(outOfRange), []);
  db.close();
});

test("伪端点 stop:<stopId> 正常解析", async () => {
  const db = database();
  const payload = await callJson(db, "from=stop:stop_chentai&to=campus_baoshan&date=2026-08-21");
  assert.deepEqual(payload.from, { id: "stop:stop_chentai", name: "陈太公寓" });
  assert.equal(payload.lines.length, 1);
  assert.equal(payload.lines[0].routeId, "route_reverse");
  assert.deepEqual(payload.lines[0].patterns.map((p) => p.patternId), ["p5"]);
  assert.deepEqual(payload.lines[0].journeys.map((j) => j.tripId), ["t6"]);
  db.close();
});

test("参数与端点校验：400 / 404 / 空校区 200 lines=[]", async () => {
  const db = database();

  // 缺参数 → 400
  await assert.rejects(call(db, "to=campus_jiading&date=2026-08-21"), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, "validation_error");
    return true;
  });

  // from == to → 400
  await assert.rejects(call(db, "from=campus_baoshan&to=campus_baoshan&date=2026-08-21"), (error) => {
    assert.equal(error.status, 400);
    return true;
  });

  // 不存在的 campus id → 404
  await assert.rejects(call(db, "from=campus_nope&to=campus_jiading&date=2026-08-21"), (error) => {
    assert.equal(error.status, 404);
    assert.equal(error.code, "not_found");
    return true;
  });
  // 不存在的伪端点 → 404
  await assert.rejects(call(db, "from=stop:stop_nope&to=campus_jiading&date=2026-08-21"), (error) => {
    assert.equal(error.status, 404);
    return true;
  });

  // 校区存在但没有任何站点 → 200 且 lines=[]
  const empty = await callJson(db, "from=campus_empty&to=campus_jiading&date=2026-08-21");
  assert.deepEqual(empty.from, { id: "campus_empty", name: "空校区" });
  assert.deepEqual(empty.lines, []);
  db.close();
});

// ---------------------------------------------------------------------------
// 日型（0025：day_type 上收到服务日历）
//
// 为什么值得单独钉：这个标签此前算在客户端，数据源是 data/academic-calendar
// （2026-03-11 提交 1ee1733 手写的草稿，与班次归属所依据的 service_calendars
// 没有任何连通），于是会出现「页面说今天是假日、但假日班次一个都不出」。
// 现在标签和班次读同一批日历，两者必须同源。
// ---------------------------------------------------------------------------

test("resolveDayType 的优先级：假日 > 寒假 > 暑假 > 周末 > 工作日", () => {
  // 现有数据里日历有效期重叠（「工作日」日历覆盖整个寒暑假），同一天会命中多条，
  // 所以优先级必须确定，否则标签随查询顺序漂。
  assert.equal(resolveDayType([{ dayType: "weekday" }, { dayType: "holiday" }], "monday"), "holiday");
  assert.equal(resolveDayType([{ dayType: "weekday" }, { dayType: "winter_break" }], "monday"), "winter_break");
  assert.equal(resolveDayType([{ dayType: "weekday" }, { dayType: "summer_break" }], "monday"), "summer_break");
  // 寒假里的周六该显示「寒假」，不是「周末」
  assert.equal(resolveDayType([{ dayType: "weekend" }, { dayType: "winter_break" }], "saturday"), "winter_break");
  assert.equal(resolveDayType([{ dayType: "weekday" }], "monday"), "weekday");
});

test("resolveDayType 忽略 'other'，并在无命中时按星期回落", () => {
  // 'other' 是逃生舱（考试周、临时加开）：班次照常运营，但不参与日型标签。
  assert.equal(resolveDayType([{ dayType: "other" }], "monday"), "weekday");
  assert.equal(resolveDayType([{ dayType: "other" }], "saturday"), "weekend");
  // 一条都没命中（学年空档）也要给个标签，只是标签，不影响班次。
  assert.equal(resolveDayType([], "sunday"), "weekend");
  assert.equal(resolveDayType([], "wednesday"), "weekday");
});

test("campus-lines 响应带 dayType，且与班次读同一批日历", async () => {
  const db = database();
  // cal_a 建表时没给 day_type → 默认 'other' → 回落按星期（2026-08-21 是周五）
  const fallback = await callJson(db, "from=campus_baoshan&to=campus_jiading&date=2026-08-21");
  assert.equal(fallback.dayType, "weekday", "day_type='other' 时按星期回落");

  // 把 cal_a 标成假日日历：同一天的标签必须跟着变（而班次不变——同一批日历）
  db.prepare("update service_calendars set day_type='holiday' where id='cal_a'").run();
  const holiday = await callJson(db, "from=campus_baoshan&to=campus_jiading&date=2026-08-21");
  assert.equal(holiday.dayType, "holiday");
  assert.deepEqual(
    holiday.lines.flatMap((line) => line.journeys.map((journey) => journey.tripId)).sort(),
    fallback.lines.flatMap((line) => line.journeys.map((journey) => journey.tripId)).sort(),
    "改日型不该改变班次归属",
  );

  // 日历没命中的那天（周六 saturday=0）：标签回落按星期，而不是沿用 holiday
  const saturday = await callJson(db, "from=campus_baoshan&to=campus_jiading&date=2026-08-22");
  assert.equal(saturday.dayType, "weekend", "日历没命中时不该沿用它的日型");

  // added 例外日（2026-08-23 周日加开）：日历命中 → 标签用日历的日型，不按星期
  const added = await callJson(db, "from=campus_baoshan&to=campus_jiading&date=2026-08-23");
  assert.equal(added.dayType, "holiday", "added 例外日命中日历，标签要跟日历走");

  // removed 例外日（2026-08-28 周五停运）：日历被排除 → 标签回落，班次也为空
  const removed = await callJson(db, "from=campus_baoshan&to=campus_jiading&date=2026-08-28");
  assert.equal(removed.dayType, "weekday", "removed 例外日排除日历，标签要回落");
  assert.deepEqual(removed.lines.flatMap((line) => line.journeys), [], "removed 当天不该有班次");
  db.close();
});
