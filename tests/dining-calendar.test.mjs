import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

// 就餐与校历（0035/0036）：校历是日型唯一数据源，service_calendars 降为临时规则；
// 开放安排/供餐时段即时生效不进 release。这里用真实迁移建内存库，端到端盯住
// 日型判定、就餐公开接口、安排写入契约与 place content.dining 校验。

const bundle = await build({
  stdin: {
    contents: `
      export { resolveCampusDayType, shanghaiWeekday } from "./worker/lib/daytype.ts";
      export {
        createDiningSchedule, updateDiningSchedule, deleteDiningSchedule,
        publicDiningSchedule, publicMerchantStatus,
        createAcademicYear, deleteAcademicYear, replaceMealPeriods, listDiningAdmin,
      } from "./worker/modules/dining.ts";
      export { normalizePlaceContent } from "./worker/lib/revision-contracts.ts";
    `,
    resolveDir: root,
    sourcefile: "dining-calendar-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const handlers = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys = on;");
  for (const name of fs.readdirSync(path.join(root, "migrations-v2")).filter((value) => value.endsWith(".sql")).sort()) {
    db.exec(read(`migrations-v2/${name}`));
  }
  db.exec("insert into users(id,email,display_name,password_hash,created_at,updated_at) values('user_test','t@t.dev','测试','x','2026-01-01','2026-01-01')");
  return db;
}

/** node:sqlite（同步）→ worker 期望的异步 D1 接口。 */
function d1(db) {
  const wrap = (sql, values) => ({
    sql,
    values,
    async first() { return db.prepare(sql).get(...values) ?? null; },
    async all() { return { results: db.prepare(sql).all(...values) }; },
    async run() { db.prepare(sql).run(...values); return { success: true }; },
  });
  return {
    prepare(sql) {
      return {
        bind(...values) { return wrap(sql, values); },
        first: () => wrap(sql, []).first(),
        all: () => wrap(sql, []).all(),
        run: () => wrap(sql, []).run(),
      };
    },
    async batch(statements) {
      for (const statement of statements) await statement.run();
      return statements.map(() => ({ success: true }));
    },
  };
}

function envOf(db) {
  return { DB: d1(db) };
}

const principal = { userId: "user_test" };

async function dayType(db, date) {
  const weekday = handlers.shanghaiWeekday(date);
  return handlers.resolveCampusDayType(envOf(db), date, weekday);
}

// --- 日型判定：校历五条路径（种子 = 2025-2026 学年） ---

test("日型判定：周末 / 工作日 / 法定节假日 / 调休工作日 / 寒暑假", async () => {
  const db = database();
  assert.equal(await dayType(db, "2026-09-19"), "weekend");   // 周六
  assert.equal(await dayType(db, "2026-09-21"), "weekday");   // 周一
  assert.equal(await dayType(db, "2025-10-01"), "holiday");   // 节假日列表
  assert.equal(await dayType(db, "2025-09-28"), "weekday");   // 调休工作日（周日上班）
  assert.equal(await dayType(db, "2026-01-27"), "winter_break"); // 寒假区间
  assert.equal(await dayType(db, "2026-08-10"), "summer_break"); // 暑假区间
});

test("日型判定：服务日历的 day_type 不影响标签（校历为准）", async () => {
  const db = database();
  // 服务日历只是班次调度规则，不再参与日型标签：即便同一天命中一条 holiday 日历，
  // 标签仍按校历（2026-09-19 周六 → weekend）。
  db.exec(`insert into service_calendars(id,name,timezone,valid_from,valid_to,day_type,monday,tuesday,wednesday,thursday,friday,saturday,sunday)
    values('cal_rule','国庆调班','Asia/Shanghai','2026-09-19','2026-09-19','holiday',0,0,0,0,0,1,0)`);
  assert.equal(await dayType(db, "2026-09-19"), "weekend");
});

test("shanghaiWeekday 不受运行环境 TZ 影响", () => {
  assert.equal(handlers.shanghaiWeekday("2026-09-19"), "saturday");
  assert.equal(handlers.shanghaiWeekday("2026-09-21"), "monday");
  assert.equal(handlers.shanghaiWeekday("not-a-date"), null);
});

// --- 公开接口 ---

test("dining/schedule：日型 + 时段表下发，无安排时 arrangement 为 null", async () => {
  const db = database();
  const res = await handlers.publicDiningSchedule(new Request("http://x/api/public/dining/schedule?date=2026-09-19"), envOf(db));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("cache-control") ?? "", /max-age=30/);
  const body = await res.json();
  assert.equal(body.dayType, "weekend");
  assert.equal(body.arrangement, null);
  assert.deepEqual(
    body.mealPeriods.map((p) => [p.meal, p.startTime, p.endTime]),
    [["breakfast", "06:30", "09:30"], ["lunner", "11:00", "13:00"], ["lunner", "16:40", "18:30"], ["latenight", "19:30", "22:00"]],
  );
});

test("dining/schedule：非法日期 400", async () => {
  const db = database();
  await assert.rejects(
    handlers.publicDiningSchedule(new Request("http://x/api/public/dining/schedule?date=2026/09/19"), envOf(db)),
    (error) => { assert.equal(error.status, 400); return true; },
  );
});

// --- 开放安排写入契约 ---

function seedCanteenFloor(db) {
  db.exec(`insert into places(id,kind_id,campus_id,lifecycle_status,created_at,updated_at)
    values('place_ct','canteen','campus_baoshan','active','2026-01-01','2026-01-01')`);
  db.exec("insert into buildings(place_id,building_code) values('place_ct','CT-01')");
  db.exec(`insert into floors(id,building_place_id,level_code,level_order,display_name,lifecycle_status,created_at,updated_at)
    values('floor_ct_1f','place_ct','1',1,'一层食堂','active','2026-01-01','2026-01-01')`);
}

function scheduleRequest(body) {
  return new Request("http://x/api/admin/dining/schedules", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("dining schedule 创建 → 公开接口按日型命中；非法输入 400", async () => {
  const db = database();
  seedCanteenFloor(db);
  const created = await handlers.createDiningSchedule(
    scheduleRequest({
      validFrom: "2026-09-19",
      validTo: "2026-09-20",
      dayTypes: ["weekend"],
      floors: [{ floorId: "floor_ct_1f", noBreakfast: true }],
    }),
    envOf(db), principal, "req-1",
  );
  assert.equal(created.status, 201);

  const hit = await handlers.publicDiningSchedule(new Request("http://x/api/public/dining/schedule?date=2026-09-19"), envOf(db));
  const hitBody = await hit.json();
  assert.deepEqual(hitBody.arrangement.floors, [{ floorId: "floor_ct_1f", noBreakfast: true }]);

  // 日型不匹配（周一）不命中
  const miss = await handlers.publicDiningSchedule(new Request("http://x/api/public/dining/schedule?date=2026-09-21"), envOf(db));
  assert.equal((await miss.json()).arrangement, null);

  // 非法日期 / 空日型 / 不存在的楼层
  for (const bad of [
    { validFrom: "2026/09/19", validTo: "2026-09-19", dayTypes: ["weekend"], floors: [] },
    { validFrom: "2026-09-19", validTo: "2026-09-19", dayTypes: [], floors: [] },
    { validFrom: "2026-09-20", validTo: "2026-09-19", dayTypes: ["weekend"], floors: [] },
    { validFrom: "2026-09-19", validTo: "2026-09-19", dayTypes: ["weekend"], floors: [{ floorId: "floor_nope" }] },
  ]) {
    await assert.rejects(
      handlers.createDiningSchedule(scheduleRequest(bad), envOf(db), principal, "req-bad"),
      (error) => { assert.ok(error.status === 400 || error.status === 404, `应拒绝：${JSON.stringify(bad)} → ${error.status}`); return true; },
    );
  }
});

test("dining schedule 更新替换楼层清单，删除后不再命中", async () => {
  const db = database();
  seedCanteenFloor(db);
  db.exec(`insert into floors(id,building_place_id,level_code,level_order,display_name,lifecycle_status,created_at,updated_at)
    values('floor_ct_2f','place_ct','2',2,'二层茶餐厅','active','2026-01-01','2026-01-01')`);
  const created = await handlers.createDiningSchedule(
    scheduleRequest({ validFrom: "2026-09-19", validTo: "2026-09-19", dayTypes: ["weekend"], floors: [{ floorId: "floor_ct_1f" }] }),
    envOf(db), principal, "req-1",
  );
  const { id } = await created.json();
  const updated = await handlers.updateDiningSchedule(
    new Request("http://x", { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ validFrom: "2026-09-19", validTo: "2026-09-19", dayTypes: ["weekend"], floors: [{ floorId: "floor_ct_2f", noBreakfast: true }] }) }),
    envOf(db), principal, id, "req-2",
  );
  assert.equal(updated.status, 200);
  const body = await (await handlers.publicDiningSchedule(new Request("http://x/api/public/dining/schedule?date=2026-09-19"), envOf(db))).json();
  assert.deepEqual(body.arrangement.floors, [{ floorId: "floor_ct_2f", noBreakfast: true }]);

  await handlers.deleteDiningSchedule(envOf(db), principal, id, "req-3");
  const after = await (await handlers.publicDiningSchedule(new Request("http://x/api/public/dining/schedule?date=2026-09-19"), envOf(db))).json();
  assert.equal(after.arrangement, null);
});

// --- 供餐时段表 ---

test("meal-periods 整表替换并校验格式", async () => {
  const db = database();
  const res = await handlers.replaceMealPeriods(
    new Request("http://x", { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ periods: [{ meal: "lunner", startTime: "11:00", endTime: "13:30" }] }) }),
    envOf(db), principal, "req-1",
  );
  assert.equal(res.status, 200);
  const body = await (await handlers.publicDiningSchedule(new Request("http://x/api/public/dining/schedule?date=2026-09-21"), envOf(db))).json();
  assert.deepEqual(body.mealPeriods.map((p) => [p.meal, p.startTime, p.endTime]), [["lunner", "11:00", "13:30"]]);

  await assert.rejects(
    handlers.replaceMealPeriods(
      new Request("http://x", { method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ periods: [{ meal: "brunch", startTime: "11:00", endTime: "13:00" }] }) }),
      envOf(db), principal, "req-2",
    ),
    (error) => { assert.equal(error.status, 400); return true; },
  );
});

// --- 校历 ---

test("学年删除保护：覆盖今天的学年 409，非当前学年可删", async () => {
  const db = database();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
  // 种一个覆盖今天的学年 → 409（种子学年的区间是否覆盖今天随日期漂，不作前提）
  db.exec(`insert into academic_years(id,name,created_at,updated_at) values('ay_now','2098-2099','2026-01-01','2026-01-01')`);
  db.exec(`insert into academic_terms(id,year_id,name,day_type,valid_from,valid_to) values('aterm_now','ay_now','全年','term','2000-01-01','2099-12-31')`);
  assert.ok(db.prepare("select count(*) as c from academic_terms where year_id='ay_now' and valid_from<=? and valid_to>=?").get(today, today).c === 1);
  await assert.rejects(
    handlers.deleteAcademicYear(envOf(db), principal, "ay_now", "req-1"),
    (error) => { assert.equal(error.status, 409); assert.equal(error.code, "academic_year_current"); return true; },
  );

  const created = await handlers.createAcademicYear(
    new Request("http://x", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "2099-2100", terms: [{ name: "秋季学期", dayType: "term", validFrom: "2099-09-01", validTo: "2100-01-15" }], dates: [] }) }),
    envOf(db), principal, "req-2",
  );
  assert.equal(created.status, 201);
  const { id } = await created.json();
  const gone = await handlers.deleteAcademicYear(envOf(db), principal, id, "req-3");
  assert.equal(gone.status, 204);
  assert.equal(db.prepare("select count(*) as c from academic_terms where year_id=?").get(id).c, 0);
});

// --- place content.dining 校验 ---

const BASE_CONTENT = { detail: { facts: [], media: [] } };

test("place content.dining：合法结构通过，非法餐别/超量标签拒绝", () => {
  const ok = handlers.normalizePlaceContent({
    ...BASE_CONTENT,
    dining: { floors: [{ levelCode: "1", meals: ["breakfast", "lunner"], stallTypes: ["自选", "小炒"] }] },
  });
  assert.equal(ok.dining.floors[0].stallTypes.length, 2);

  assert.throws(
    () => handlers.normalizePlaceContent({ ...BASE_CONTENT, dining: { floors: [{ levelCode: "1", meals: ["brunch"], stallTypes: [] }] } }),
    /meals\[0\]/,
  );
  assert.throws(
    () => handlers.normalizePlaceContent({ ...BASE_CONTENT, dining: { floors: [{ levelCode: "1", meals: [], stallTypes: Array.from({ length: 21 }, (_, i) => `档口${i}`) }] } }),
    /stallTypes/,
  );
  // dining 之外的 content 键照旧透传（契约不破坏既有内容）
  const passthrough = handlers.normalizePlaceContent({ ...BASE_CONTENT, address: "宝山校区" });
  assert.equal(passthrough.address, "宝山校区");
});

// --- schema ---

test("dining_schedule_floors 级联删除与 CHECK 约束", () => {
  const db = database();
  seedCanteenFloor(db);
  db.exec(`insert into dining_schedules(id,valid_from,valid_to,day_types,created_at,updated_at)
    values('ds_1','2026-09-19','2026-09-19','["weekend"]','2026-01-01','2026-01-01')`);
  db.exec("insert into dining_schedule_floors(schedule_id,floor_id,no_breakfast) values('ds_1','floor_ct_1f',1)");
  db.exec("delete from dining_schedules where id='ds_1'");
  assert.equal(db.prepare("select count(*) as c from dining_schedule_floors where schedule_id='ds_1'").get().c, 0);

  assert.throws(
    () => db.exec("insert into dining_meal_periods(id,meal,start_time,end_time) values('x','brunch','11:00','12:00')"),
    /CHECK/i,
  );
  assert.throws(
    () => db.exec("insert into academic_terms(id,year_id,name,day_type,valid_from,valid_to) values('x','ay_2025-2026','考试周','exam_week','2026-12-01','2026-12-07')"),
    /CHECK/i,
  );
});
