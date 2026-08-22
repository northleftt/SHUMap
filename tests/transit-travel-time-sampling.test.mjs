// 校车区间用时采样（worker/modules/travel-time.ts）。
//
// 为什么这些点值得钉在测试里 —— 每一条都是「不报错但结果是错的」那类故障：
//
//   1. **坐标顺序**。腾讯的 from/to 参数是 `纬度,经度`，GeoJSON 是 [经度, 纬度]。
//      写反了照样返回 status 0 和一个合理的耗时（上海附近反过来落在海上/内陆，
//      driving 仍然能算出一条路），页面上只是数字偏了。所以 URL 拼装单独测。
//
//   2. **只能用 matrix，不能用 direction**。实测 direction 静默忽略
//      departure_time（传 `abc` 都返回 status 0），换过去之后所有班次会显示
//      同一个到达时间且完全不报错。这里对源码做正则守卫。
//
//   3. **每次调用最多 5 个矩阵元素**。第 6 个开始返回 status 120，文案却是
//      「每秒请求量已达到上限」——很容易被误读成限流而去加 sleep，实际要拆批。
//
//   4. **缺坐标的站点必须整段跳过**。地理编码兜底是错的：实测「上海大学陈台公寓」
//      落点离宝山校区中心只有 600m（可信度 3），换个写法又跳到十几公里外。
//      宁可没有样本，也不要一条静默错误的耗时。
//
//   5. **跨零点**。22:00 发车 + 40 分钟要显示成次日 00:40，不能回绕成当天。

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
  absWorkingDir: root,
  entryPoints: ["worker/modules/travel-time.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const travelTime = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
);
const {
  MATRIX_MAX_ELEMENTS,
  MEDIAN_SAMPLE_WINDOW,
  PROVIDER,
  addSecondsToTimeOfDay,
  estimateStopArrivals,
  loadSegmentMedians,
  loadSegments,
  matrixRequestUrl,
  medianDurationSeconds,
  nextServiceInstant,
  parseMatrixElements,
  planSampleCalls,
  sampleTravelTimes,
  scopeSegmentMedians,
  segmentKeyOf,
} = travelTime;

// ---------------------------------------------------------------------------
// D1 替身（同 tests/guide-documents.test.mjs）
// ---------------------------------------------------------------------------

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

function migrated() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("pragma foreign_keys=on");
  for (const name of fs.readdirSync(path.join(root, "migrations-v2")).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(read(`migrations-v2/${name}`));
  }
  return sqlite;
}

const NOW_ISO = "2026-08-20T00:00:00.000Z";

/**
 * 站点 + 坐标，**照线上的形状建**：候车点（boarding_point，svg_viewbox 画布点）
 * 占 is_primary=1 的那个名额，导航坐标（navigation_target，GCJ02）只能是
 * is_primary=0。
 *
 * 这不是随手写的：idx_entity_locations_one_primary 是 (entity_type, entity_id)
 * 上的唯一索引（0015 版加了 valid_to is null 限定），每个实体只允许一个 primary
 * 绑定。站点的那个名额被地图图钉用的 boarding_point 占着，所以 navigation_target
 * 必然是 0 —— 线上 release manifest 里两个带坐标的站点都是这样。
 *
 * 开发中这个 seed 原本图省事写了 is_primary=1，而 loadStopPoints 当时也要求
 * is_primary=1，两边一起错、测试全绿，线上却会一条样本都采不到（核对线上
 * manifest 才发现）。所以这里刻意按线上形状建，别改回 1。
 */
function seedStop(sqlite, { id, name, longitude, latitude }) {
  sqlite.prepare(
    "insert into transit_stops(id,name,status,created_at,updated_at) values(?,?,'active',?,?)",
  ).run(id, name, NOW_ISO, NOW_ISO);
  if (longitude === undefined) return;
  // 候车点：画布坐标，占掉 primary 名额（线上就是它占着）。
  sqlite.prepare(
    `insert into location_anchors(id,role,geometry_type,geometry_json,crs,precision_level,created_at,updated_at)
     values(?,'boarding_point','Point',?,'svg_viewbox','exact',?,?)`,
  ).run(`anchor_bp_${id}`, JSON.stringify({ type: "Point", coordinates: [100, 200] }), NOW_ISO, NOW_ISO);
  sqlite.prepare(
    `insert into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,created_at)
     values(?,'transit_stop',?,?,'boarding_point',1,?)`,
  ).run(`eloc_bp_${id}`, id, `anchor_bp_${id}`, NOW_ISO);
  // 导航坐标：GCJ02，只能是非 primary。采样读的是这一条。
  const anchorId = `anchor_${id}`;
  sqlite.prepare(
    `insert into location_anchors(id,role,geometry_type,geometry_json,crs,precision_level,created_at,updated_at)
     values(?,'navigation_target','Point',?,'GCJ02','exact',?,?)`,
  ).run(anchorId, JSON.stringify({ type: "Point", coordinates: [longitude, latitude] }), NOW_ISO, NOW_ISO);
  sqlite.prepare(
    `insert into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,created_at)
     values(?,'transit_stop',?,?,'navigation_target',0,?)`,
  ).run(`eloc_${id}`, id, anchorId, NOW_ISO);
}

/** 一条点对点线路：route + pattern + 两个停靠 + 日历 + 每个发车时刻一个 trip。 */
function seedRoute(sqlite, { id, fromStopId, toStopId, departures, calendarId = "cal_all" }) {
  sqlite.prepare(
    "insert into transit_routes(id,name,status,created_at,updated_at) values(?,?,'active',?,?)",
  ).run(id, id, NOW_ISO, NOW_ISO);
  sqlite.prepare(
    "insert into transit_patterns(id,route_id,direction_id,name) values(?,?,0,?)",
  ).run(`pat_${id}`, id, id);
  sqlite.prepare(
    "insert into transit_pattern_stops(pattern_id,stop_id,stop_sequence,pickup_type,dropoff_type) values(?,?,0,'regular','none')",
  ).run(`pat_${id}`, fromStopId);
  sqlite.prepare(
    "insert into transit_pattern_stops(pattern_id,stop_id,stop_sequence,pickup_type,dropoff_type) values(?,?,1,'none','regular')",
  ).run(`pat_${id}`, toStopId);
  for (const [index, departureTime] of departures.entries()) {
    const tripId = `trip_${id}_${index}`;
    sqlite.prepare(
      "insert into transit_trips(id,pattern_id,service_calendar_id,status) values(?,?,?,'active')",
    ).run(tripId, `pat_${id}`, calendarId);
    sqlite.prepare(
      "insert into transit_stop_times(trip_id,stop_id,stop_sequence,arrival_time,departure_time) values(?,?,0,?,?)",
    ).run(tripId, fromStopId, departureTime, departureTime);
    sqlite.prepare(
      "insert into transit_stop_times(trip_id,stop_id,stop_sequence,arrival_time,departure_time) values(?,?,1,null,null)",
    ).run(tripId, toStopId);
  }
}

function seedCalendar(sqlite, id, days) {
  sqlite.prepare(
    `insert into service_calendars(id,name,timezone,valid_from,valid_to,monday,tuesday,wednesday,thursday,friday,saturday,sunday)
     values(?,?,'Asia/Shanghai','2026-01-01','2030-12-31',?,?,?,?,?,?,?)`,
  ).run(
    id, id,
    days.includes(1) ? 1 : 0, days.includes(2) ? 1 : 0, days.includes(3) ? 1 : 0, days.includes(4) ? 1 : 0,
    days.includes(5) ? 1 : 0, days.includes(6) ? 1 : 0, days.includes(0) ? 1 : 0,
  );
}

/** 真实拓扑的最小复刻：宝山/延长/嘉定三点、四条线，宝山 17:00 同时发两班。 */
function seedCampusNetwork(sqlite) {
  seedCalendar(sqlite, "cal_all", [0, 1, 2, 3, 4, 5, 6]);
  seedStop(sqlite, { id: "stop_bs", name: "宝山校区", longitude: 121.3983, latitude: 31.3155 });
  seedStop(sqlite, { id: "stop_yc", name: "延长校区", longitude: 121.4565, latitude: 31.2749 });
  seedStop(sqlite, { id: "stop_jd", name: "嘉定校区", longitude: 121.2506, latitude: 31.3778 });
  seedRoute(sqlite, { id: "bs-yc", fromStopId: "stop_bs", toStopId: "stop_yc", departures: ["07:00", "17:00"] });
  seedRoute(sqlite, { id: "bs-jd", fromStopId: "stop_bs", toStopId: "stop_jd", departures: ["17:00"] });
  seedRoute(sqlite, { id: "yc-bs", fromStopId: "stop_yc", toStopId: "stop_bs", departures: ["09:00"] });
  return sqlite;
}

function envOf(sqlite, overrides = {}) {
  return { DB: new D1(sqlite), TENCENT_MAP_KEY: "TEST-KEY", ...overrides };
}

/** 固定耗时的 fetcher 替身，并记录每次查询供断言。 */
function recordingFetcher(durationSeconds = 1300) {
  const queries = [];
  const fetcher = async (query) => {
    queries.push(query);
    return query.destinations.map(() => ({ durationSeconds, distanceMeters: 10650 }));
  };
  return { fetcher, queries };
}

const noSleep = async () => {};

// ---------------------------------------------------------------------------
// nextServiceInstant
// ---------------------------------------------------------------------------

test("nextServiceInstant 解析出的是上海本地壁钟时刻（UTC+8）", () => {
  // 2026-08-20 是周四；周一到周五运营。北京 07:00 = UTC 前一日 23:00。
  const instant = nextServiceInstant("07:00", [1, 2, 3, 4, 5], new Date("2026-08-20T00:00:00Z"));
  assert.equal(instant.departureAt, "2026-08-20T23:00:00.000Z");
  assert.equal(instant.unixSeconds, Math.floor(Date.parse("2026-08-20T23:00:00Z") / 1000));
});

test("nextServiceInstant 跳过太近的时刻（provider 要求出发时间在未来）", () => {
  // 北京 2026-08-20 15:00（= UTC 07:00）问 15:05 那班：只剩 5 分钟，跳到下一个运营日。
  const instant = nextServiceInstant("15:05", [1, 2, 3, 4, 5], new Date("2026-08-20T07:00:00Z"));
  assert.equal(instant.departureAt, "2026-08-21T07:05:00.000Z");
});

test("nextServiceInstant 只挑该区间真的运营的星期", () => {
  // 只在周日（0）运营；2026-08-20 是周四，下一个周日是 08-23。
  const instant = nextServiceInstant("08:30", [0], new Date("2026-08-20T00:00:00Z"));
  assert.equal(instant.departureAt.slice(0, 10), "2026-08-23");
});

test("nextServiceInstant 在窗口内无运营日时返回 null，而不是硬凑一个时刻", () => {
  assert.equal(nextServiceInstant("08:30", [], new Date("2026-08-20T00:00:00Z")), null);
  // 只在周日跑，但窗口只剩两天（周四、周五）。
  assert.equal(nextServiceInstant("08:30", [0], new Date("2026-08-20T00:00:00Z"), { maxLeadDays: 2 }), null);
});

test("nextServiceInstant 拒绝非法时刻串", () => {
  for (const value of ["24:00", "7:00", "07:60", "", "0700"]) {
    assert.equal(nextServiceInstant(value, [1, 2, 3, 4, 5], new Date(NOW_ISO)), null, value);
  }
});

// ---------------------------------------------------------------------------
// planSampleCalls
// ---------------------------------------------------------------------------

function segment(overrides) {
  return {
    patternId: "pat_a",
    fromStopSequence: 0,
    toStopSequence: 1,
    departureTime: "07:00",
    fromStopId: "stop_bs",
    toStopId: "stop_yc",
    serviceDays: [0, 1, 2, 3, 4, 5, 6],
    ...overrides,
  };
}

test("同起点同发车时刻的多条线路合并成一次调用（省配额）", () => {
  const calls = planSampleCalls(
    [
      segment({ patternId: "pat_bs_yc", departureTime: "17:00", toStopId: "stop_yc" }),
      segment({ patternId: "pat_bs_jd", departureTime: "17:00", toStopId: "stop_jd" }),
    ],
    new Map(),
    new Date(NOW_ISO),
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].destinations.map((d) => d.toStopId).sort(), ["stop_jd", "stop_yc"]);
});

test("不同发车时刻不合并：时段是有效信号，不能一条线只采一个耗时", () => {
  const calls = planSampleCalls(
    [segment({ departureTime: "07:00" }), segment({ departureTime: "17:00", patternId: "pat_b" })],
    new Map(),
    new Date(NOW_ISO),
  );
  assert.equal(calls.length, 2);
});

test("终点数超过矩阵元素上限时拆批（第 6 个元素会被 provider 拒）", () => {
  const segments = Array.from({ length: MATRIX_MAX_ELEMENTS + 2 }, (_unused, index) =>
    segment({ patternId: `pat_${index}`, toStopId: `stop_${index}` }));
  const calls = planSampleCalls(segments, new Map(), new Date(NOW_ISO), { maxCalls: 99 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].destinations.length, MATRIX_MAX_ELEMENTS);
  assert.equal(calls[1].destinations.length, 2);
  for (const call of calls) assert.ok(call.destinations.length <= MATRIX_MAX_ELEMENTS);
});

test("还在刷新周期内的区间不重采", () => {
  const fresh = segment();
  const lastSampled = new Map([[segmentKeyOf(fresh), "2026-08-19T00:00:00.000Z"]]);
  assert.equal(planSampleCalls([fresh], lastSampled, new Date(NOW_ISO)).length, 0);
  // 超过 7 天就该重采了。
  const stale = new Map([[segmentKeyOf(fresh), "2026-08-01T00:00:00.000Z"]]);
  assert.equal(planSampleCalls([fresh], stale, new Date(NOW_ISO)).length, 1);
});

test("从没采过的区间排在最前（空串先于任何 ISO 时间戳）", () => {
  const sampled = segment({ patternId: "pat_sampled", toStopId: "stop_sampled", departureTime: "07:00" });
  const never = segment({ patternId: "pat_never", toStopId: "stop_never", departureTime: "08:00" });
  const calls = planSampleCalls(
    [sampled, never],
    new Map([[segmentKeyOf(sampled), "2026-07-01T00:00:00.000Z"]]),
    new Date(NOW_ISO),
    { maxCalls: 1 },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].destinations[0].toStopId, "stop_never");
});

test("两条 pattern 共用同一对站点时终点只问一次，结果归给两条区间", () => {
  const calls = planSampleCalls(
    [segment({ patternId: "pat_a" }), segment({ patternId: "pat_b" })],
    new Map(),
    new Date(NOW_ISO),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].destinations.length, 1);
  assert.deepEqual(calls[0].destinations[0].segments.map((s) => s.patternId).sort(), ["pat_a", "pat_b"]);
});

test("单轮调用次数封顶（cron 时长可控，剩下的下一轮再采）", () => {
  const segments = Array.from({ length: 50 }, (_unused, index) =>
    segment({ patternId: `pat_${index}`, fromStopId: `stop_from_${index}` }));
  assert.equal(planSampleCalls(segments, new Map(), new Date(NOW_ISO), { maxCalls: 3 }).length, 3);
});

test("窗口内排不出未来时刻的区间被跳过，不会产生空调用", () => {
  const calls = planSampleCalls(
    [segment({ serviceDays: [0] })],
    new Map(),
    new Date("2026-08-20T00:00:00Z"),
    { maxLeadDays: 1 },
  );
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// parseMatrixElements
// ---------------------------------------------------------------------------

const matrixBody = (elements) => ({ status: 0, message: "Success", result: { rows: [{ elements }] } });

test("解析正常 matrix 响应", () => {
  const parsed = parseMatrixElements(matrixBody([{ duration: 1300, distance: 10650 }]), 1);
  assert.deepEqual(parsed, [{ durationSeconds: 1300, distanceMeters: 10650 }]);
});

test("status 非 0 直接抛（120 = 元素数/限流，348 = 出发时间越界）", () => {
  assert.throws(
    () => parseMatrixElements({ status: 120, message: "此key每秒请求量已达到上限" }, 1),
    /matrix status 120/,
  );
  assert.throws(() => parseMatrixElements({ status: 348, message: "参数错误" }, 1), /matrix status 348/);
});

test("单个元素坏掉只记 null，不连坐同批其他终点", () => {
  const parsed = parseMatrixElements(
    matrixBody([{ duration: 1300, distance: 10650 }, { duration: 0 }, { duration: -5 }, {}]),
    4,
  );
  assert.equal(parsed[0].durationSeconds, 1300);
  assert.deepEqual(parsed.slice(1), [null, null, null]);
});

test("响应元素少于请求数时按请求数补 null（位置与终点严格对齐）", () => {
  const parsed = parseMatrixElements(matrixBody([{ duration: 1300 }]), 3);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].distanceMeters, null);
  assert.deepEqual(parsed.slice(1), [null, null]);
});

test("响应结构不对时抛，而不是静默返回空", () => {
  assert.throws(() => parseMatrixElements(null, 1), /not an object/);
  assert.throws(() => parseMatrixElements({ status: 0, result: { rows: [] } }, 1), /no rows/);
  assert.throws(() => parseMatrixElements({ status: 0, result: { rows: [{}] } }, 1), /no elements/);
});

// ---------------------------------------------------------------------------
// URL 拼装与 provider 选择
// ---------------------------------------------------------------------------

test("matrix URL 的坐标是「纬度,经度」——写反不会报错，只会静默偏移", () => {
  const url = new URL(matrixRequestUrl(
    {
      origin: { longitude: 121.3983, latitude: 31.3155 },
      destinations: [{ longitude: 121.4565, latitude: 31.2749 }],
      unixSeconds: 1787241600,
    },
    "TEST-KEY",
  ));
  assert.equal(url.searchParams.get("from"), "31.3155,121.3983");
  assert.equal(url.searchParams.get("to"), "31.2749,121.4565");
  assert.equal(url.searchParams.get("mode"), "driving");
  assert.equal(url.searchParams.get("departure_time"), "1787241600");
  assert.equal(url.searchParams.get("key"), "TEST-KEY");
});

test("多个终点用分号分隔", () => {
  const url = new URL(matrixRequestUrl(
    {
      origin: { longitude: 121.3983, latitude: 31.3155 },
      destinations: [{ longitude: 121.4565, latitude: 31.2749 }, { longitude: 121.2506, latitude: 31.3778 }],
      unixSeconds: 1787241600,
    },
    "TEST-KEY",
  ));
  assert.equal(url.searchParams.get("to"), "31.2749,121.4565;31.3778,121.2506");
});

test("必须打在 matrix 接口上：direction 静默忽略 departure_time", () => {
  const source = read("worker/modules/travel-time.ts");
  assert.match(source, /apis\.map\.qq\.com\/ws\/distance\/v1\/matrix/);
  // 只允许出现在注释里解释「为什么不用」，不能出现在端点常量或 fetch 里。
  const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
  assert.doesNotMatch(code, /ws\/direction/);
});

// ---------------------------------------------------------------------------
// 中位数与到达时刻
// ---------------------------------------------------------------------------

test("中位数抗单次抖动（平均值会被一次堵车拉走）", () => {
  assert.equal(medianDurationSeconds([1300, 1320, 1290, 1310, 4000]), 1310);
  assert.equal(medianDurationSeconds([1300, 1320]), 1310);
  assert.equal(medianDurationSeconds([1300]), 1300);
});

test("中位数忽略非法样本，全非法时返回 null（页面显示「暂无」而不是 0）", () => {
  assert.equal(medianDurationSeconds([]), null);
  assert.equal(medianDurationSeconds([0, -1, NaN]), null);
  assert.equal(medianDurationSeconds([0, 1300, 1320]), 1310);
});

test("到达时刻跨零点带 dayOffset：末班 22:00 + 40min 是次日 00:40", () => {
  assert.deepEqual(addSecondsToTimeOfDay("22:00", 40 * 60), { time: "22:40", dayOffset: 0 });
  assert.deepEqual(addSecondsToTimeOfDay("23:40", 40 * 60), { time: "00:20", dayOffset: 1 });
  assert.deepEqual(addSecondsToTimeOfDay("17:00", 1300), { time: "17:22", dayOffset: 0 });
});

test("到达时刻拒绝非法输入", () => {
  assert.equal(addSecondsToTimeOfDay("24:00", 60), null);
  assert.equal(addSecondsToTimeOfDay("17:00", -1), null);
  assert.equal(addSecondsToTimeOfDay("17:00", NaN), null);
});

// ---------------------------------------------------------------------------
// 端到端（真 schema + fetcher 替身）
// ---------------------------------------------------------------------------

test("一轮采样把样本写进库，且合并了同起点同时刻的调用", async () => {
  const sqlite = seedCampusNetwork(migrated());
  const { fetcher, queries } = recordingFetcher();
  const summary = await sampleTravelTimes(envOf(sqlite), { fetcher, sleep: noSleep });

  // 4 个 (线路 × 发车时刻)，其中宝山 17:00 的两条并成一次 → 3 次调用。
  assert.equal(summary.planned, 3);
  assert.equal(summary.called, 3);
  assert.equal(summary.inserted, 4);
  assert.equal(summary.failedCalls, 0);
  assert.equal(queries.filter((query) => query.destinations.length === 2).length, 1);

  const rows = sqlite.prepare(
    "select pattern_id, departure_time, duration_seconds, distance_meters, provider from transit_travel_time_samples order by pattern_id, departure_time",
  ).all();
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.duration_seconds, 1300);
    assert.equal(row.distance_meters, 10650);
    assert.equal(row.provider, PROVIDER);
  }
  assert.deepEqual(
    rows.map((row) => `${row.pattern_id}@${row.departure_time}`),
    ["pat_bs-jd@17:00", "pat_bs-yc@07:00", "pat_bs-yc@17:00", "pat_yc-bs@09:00"],
  );
});

test("问 provider 的出发时刻确实是未来，且落在 7 天窗口内", async () => {
  const sqlite = seedCampusNetwork(migrated());
  const { fetcher, queries } = recordingFetcher();
  await sampleTravelTimes(envOf(sqlite), { fetcher, sleep: noSleep });
  const nowSeconds = Math.floor(Date.now() / 1000);
  for (const query of queries) {
    assert.ok(query.unixSeconds > nowSeconds, "出发时刻必须在未来");
    assert.ok(query.unixSeconds - nowSeconds < 7 * 24 * 3600, "超过 7 天 provider 会返回 348");
  }
});

test("缺坐标的站点整段跳过，不做地理编码兜底", async () => {
  const sqlite = migrated();
  seedCalendar(sqlite, "cal_all", [0, 1, 2, 3, 4, 5, 6]);
  seedStop(sqlite, { id: "stop_bs", name: "宝山校区", longitude: 121.3983, latitude: 31.3155 });
  seedStop(sqlite, { id: "stop_ct", name: "陈台公寓" }); // 没有 navigation_target
  seedRoute(sqlite, { id: "bs-ct", fromStopId: "stop_bs", toStopId: "stop_ct", departures: ["11:45"] });

  const { fetcher, queries } = recordingFetcher();
  const summary = await sampleTravelTimes(envOf(sqlite), { fetcher, sleep: noSleep });
  assert.equal(queries.length, 0);
  assert.equal(summary.skippedNoCoordinates, 1);
  assert.equal(summary.inserted, 0);
  assert.equal(sqlite.prepare("select count(*) as n from transit_travel_time_samples").get().n, 0);
});

test("站点自己没坐标时借它绑定的 place 的（与客户端 navigationPointForStop 同语义）", async () => {
  const sqlite = migrated();
  seedCalendar(sqlite, "cal_all", [0, 1, 2, 3, 4, 5, 6]);
  sqlite.prepare("insert into campuses(id,code,name,created_at,updated_at) values('cam_bs','BS','宝山',?,?)")
    .run(NOW_ISO, NOW_ISO);
  sqlite.prepare(
    "insert into places(id,kind_id,campus_id,lifecycle_status,created_at,updated_at) values('place_yc','other','cam_bs','active',?,?)",
  ).run(NOW_ISO, NOW_ISO);
  sqlite.prepare(
    `insert into location_anchors(id,role,geometry_type,geometry_json,crs,precision_level,created_at,updated_at)
     values('anchor_place_yc','navigation_target','Point',?,'GCJ02','exact',?,?)`,
  ).run(JSON.stringify({ type: "Point", coordinates: [121.4565, 31.2749] }), NOW_ISO, NOW_ISO);
  // 同 seedStop：地点的 primary 名额也不给 navigation_target（线上那个绑了站点的
  // 地点就是 boarding_point 占 primary、navigation_target 为 0）。
  sqlite.prepare(
    `insert into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,created_at)
     values('eloc_place_yc','place','place_yc','anchor_place_yc','navigation_target',0,?)`,
  ).run(NOW_ISO);

  seedStop(sqlite, { id: "stop_bs", name: "宝山校区", longitude: 121.3983, latitude: 31.3155 });
  sqlite.prepare(
    "insert into transit_stops(id,place_id,name,status,created_at,updated_at) values('stop_yc','place_yc','延长校区','active',?,?)",
  ).run(NOW_ISO, NOW_ISO);
  seedRoute(sqlite, { id: "bs-yc", fromStopId: "stop_bs", toStopId: "stop_yc", departures: ["07:00"] });

  const { fetcher, queries } = recordingFetcher();
  const summary = await sampleTravelTimes(envOf(sqlite), { fetcher, sleep: noSleep });
  assert.equal(summary.inserted, 1);
  assert.deepEqual(queries[0].destinations, [{ longitude: 121.4565, latitude: 31.2749 }]);
});

// 这条是回归测试，钉的是一个已经犯过的错：loadStopPoints 曾照抄客户端
// navigationPointForStop 的 isPrimary===1 条件，而线上站点的 primary 名额被
// boarding_point 占着，navigation_target 必然是 0 —— 采样会永远采到 0 条且不报错。
// 当时 seed 也写了 is_primary=1，两边一起错所以测试全绿，是核对线上 release
// manifest 才发现的。这条测试保证以后再加回 is_primary=1 会立刻红。
test("navigation_target 是非 primary 也要能采（primary 名额被候车点占着）", async () => {
  const sqlite = migrated();
  seedCalendar(sqlite, "cal_all", [0, 1, 2, 3, 4, 5, 6]);
  seedStop(sqlite, { id: "stop_bs", name: "宝山校区", longitude: 121.3983, latitude: 31.3155 });
  seedStop(sqlite, { id: "stop_yc", name: "延长校区", longitude: 121.4565, latitude: 31.2749 });
  seedRoute(sqlite, { id: "bs-yc", fromStopId: "stop_bs", toStopId: "stop_yc", departures: ["07:00"] });

  // 先确认 seed 真的是线上那个形状：候车点 primary=1、导航点 primary=0。
  const bindings = sqlite.prepare(
    "select role, is_primary as p from entity_locations where entity_id='stop_bs' order by role",
  ).all().map((row) => `${row.role}:${row.p}`);
  assert.deepEqual([...bindings], ["boarding_point:1", "navigation_target:0"]);

  const { fetcher, queries } = recordingFetcher();
  const summary = await sampleTravelTimes(envOf(sqlite), { fetcher, sleep: noSleep });
  assert.equal(summary.skippedNoCoordinates, 0, "非 primary 的导航坐标不该被当成缺坐标");
  assert.equal(summary.inserted, 1);
  assert.deepEqual(queries[0].origin, { longitude: 121.3983, latitude: 31.3155 });
});

test("一个站点不可能有两个 primary 绑定（上一条的前提由唯一索引保证）", () => {
  const sqlite = migrated();
  seedStop(sqlite, { id: "stop_bs", name: "宝山校区", longitude: 121.3983, latitude: 31.3155 });
  // 想把 navigation_target 也提成 primary 会撞 idx_entity_locations_one_primary，
  // 所以「导航点必然非 primary」不是巧合，是 schema 决定的。
  assert.throws(
    () => sqlite.prepare("update entity_locations set is_primary=1 where role='navigation_target'").run(),
    /UNIQUE constraint failed/,
  );
});

test("未配置 key 时安静跳过，不抛也不写库", async () => {
  const sqlite = seedCampusNetwork(migrated());
  const summary = await sampleTravelTimes(envOf(sqlite, { TENCENT_MAP_KEY: undefined }), { sleep: noSleep });
  assert.equal(summary.planned, 0);
  assert.equal(summary.inserted, 0);
  assert.equal(sqlite.prepare("select count(*) as n from transit_travel_time_samples").get().n, 0);
});

test("一次调用失败不影响其余调用（cron 不能因为一格挂掉整轮）", async () => {
  const sqlite = seedCampusNetwork(migrated());
  let calls = 0;
  const fetcher = async (query) => {
    calls += 1;
    if (calls === 1) throw new Error("matrix status 120: 此key每秒请求量已达到上限");
    return query.destinations.map(() => ({ durationSeconds: 1300, distanceMeters: 10650 }));
  };
  const summary = await sampleTravelTimes(envOf(sqlite), { fetcher, sleep: noSleep });
  assert.equal(summary.failedCalls, 1);
  assert.equal(summary.called, 2);
  assert.ok(summary.inserted > 0);
});

test("provider 抛异常也不让 scheduled 挂掉（吞错记日志）", async () => {
  const sqlite = seedCampusNetwork(migrated());
  const fetcher = async () => { throw new Error("network down"); };
  const summary = await sampleTravelTimes(envOf(sqlite), { fetcher, sleep: noSleep });
  assert.equal(summary.inserted, 0);
  assert.equal(summary.failedCalls, 3);
});

test("第二轮不重采刚采过的区间（刷新周期生效）", async () => {
  const sqlite = seedCampusNetwork(migrated());
  const first = recordingFetcher();
  await sampleTravelTimes(envOf(sqlite), { fetcher: first.fetcher, sleep: noSleep });
  const second = recordingFetcher();
  const summary = await sampleTravelTimes(envOf(sqlite), { fetcher: second.fetcher, sleep: noSleep });
  assert.equal(summary.planned, 0);
  assert.equal(second.queries.length, 0);
  assert.equal(sqlite.prepare("select count(*) as n from transit_travel_time_samples").get().n, 4);
});

test("只采相邻停靠对：三站线路不额外采「首站→末站」", async () => {
  const sqlite = migrated();
  seedCalendar(sqlite, "cal_all", [0, 1, 2, 3, 4, 5, 6]);
  seedStop(sqlite, { id: "stop_a", name: "A", longitude: 121.39, latitude: 31.31 });
  seedStop(sqlite, { id: "stop_b", name: "B", longitude: 121.42, latitude: 31.29 });
  seedStop(sqlite, { id: "stop_c", name: "C", longitude: 121.45, latitude: 31.27 });
  sqlite.prepare("insert into transit_routes(id,name,status,created_at,updated_at) values('r3','r3','active',?,?)")
    .run(NOW_ISO, NOW_ISO);
  sqlite.prepare("insert into transit_patterns(id,route_id,direction_id,name) values('pat_r3','r3',0,'r3')").run();
  for (const [sequence, stopId] of [["0", "stop_a"], ["1", "stop_b"], ["2", "stop_c"]]) {
    sqlite.prepare(
      "insert into transit_pattern_stops(pattern_id,stop_id,stop_sequence,pickup_type,dropoff_type) values('pat_r3',?,?,'regular','regular')",
    ).run(stopId, Number(sequence));
  }
  sqlite.prepare("insert into transit_trips(id,pattern_id,service_calendar_id,status) values('trip_r3','pat_r3','cal_all','active')").run();
  for (const [sequence, stopId, time] of [[0, "stop_a", "07:00"], [1, "stop_b", "07:30"], [2, "stop_c", "08:00"]]) {
    sqlite.prepare(
      "insert into transit_stop_times(trip_id,stop_id,stop_sequence,arrival_time,departure_time) values('trip_r3',?,?,?,?)",
    ).run(stopId, sequence, time, time);
  }

  const { fetcher } = recordingFetcher();
  await sampleTravelTimes(envOf(sqlite), { fetcher, sleep: noSleep });
  const rows = sqlite.prepare(
    "select from_stop_sequence as f, to_stop_sequence as t from transit_travel_time_samples order by f",
  ).all();
  // node:sqlite 返回 null 原型的行对象，deepStrictEqual 会因原型不同而失败，
  // 所以这里比对映射出的纯数组。
  assert.deepEqual(rows.map((row) => [row.f, row.t]), [[0, 1], [1, 2]]);
});

test("停运线路与已停班次不参与采样", async () => {
  const sqlite = migrated();
  seedCalendar(sqlite, "cal_all", [0, 1, 2, 3, 4, 5, 6]);
  seedStop(sqlite, { id: "stop_bs", name: "宝山校区", longitude: 121.3983, latitude: 31.3155 });
  seedStop(sqlite, { id: "stop_yc", name: "延长校区", longitude: 121.4565, latitude: 31.2749 });
  seedRoute(sqlite, { id: "bs-yc", fromStopId: "stop_bs", toStopId: "stop_yc", departures: ["07:00"] });
  sqlite.prepare("update transit_routes set status='suspended' where id='bs-yc'").run();

  const { fetcher, queries } = recordingFetcher();
  const summary = await sampleTravelTimes(envOf(sqlite), { fetcher, sleep: noSleep });
  assert.equal(queries.length, 0);
  assert.equal(summary.inserted, 0);
});

test("过期日历（valid_to 已过）不参与采样", async () => {
  const sqlite = migrated();
  sqlite.prepare(
    `insert into service_calendars(id,name,timezone,valid_from,valid_to,monday,tuesday,wednesday,thursday,friday,saturday,sunday)
     values('cal_old','旧','Asia/Shanghai','2024-01-01','2024-12-31',1,1,1,1,1,1,1)`,
  ).run();
  seedStop(sqlite, { id: "stop_bs", name: "宝山校区", longitude: 121.3983, latitude: 31.3155 });
  seedStop(sqlite, { id: "stop_yc", name: "延长校区", longitude: 121.4565, latitude: 31.2749 });
  seedRoute(sqlite, {
    id: "bs-yc", fromStopId: "stop_bs", toStopId: "stop_yc", departures: ["07:00"], calendarId: "cal_old",
  });

  const { fetcher, queries } = recordingFetcher();
  await sampleTravelTimes(envOf(sqlite), { fetcher, sleep: noSleep });
  assert.equal(queries.length, 0);
});

test("多个 trip 共用同一 (pattern, 区间, 发车时刻) 时只采一条，星期取并集", async () => {
  const sqlite = migrated();
  seedCalendar(sqlite, "cal_weekday", [1, 2, 3, 4, 5]);
  seedCalendar(sqlite, "cal_weekend", [0, 6]);
  seedStop(sqlite, { id: "stop_bs", name: "宝山校区", longitude: 121.3983, latitude: 31.3155 });
  seedStop(sqlite, { id: "stop_yc", name: "延长校区", longitude: 121.4565, latitude: 31.2749 });
  seedRoute(sqlite, {
    id: "bs-yc", fromStopId: "stop_bs", toStopId: "stop_yc", departures: ["07:00"], calendarId: "cal_weekday",
  });
  // 同一 pattern 上再挂一个周末班，发车时刻相同。
  sqlite.prepare(
    "insert into transit_trips(id,pattern_id,service_calendar_id,status) values('trip_we','pat_bs-yc','cal_weekend','active')",
  ).run();
  sqlite.prepare(
    "insert into transit_stop_times(trip_id,stop_id,stop_sequence,arrival_time,departure_time) values('trip_we','stop_bs',0,'07:00','07:00')",
  ).run();

  const { fetcher, queries } = recordingFetcher();
  const summary = await sampleTravelTimes(envOf(sqlite), { fetcher, sleep: noSleep });
  assert.equal(queries.length, 1);
  assert.equal(summary.inserted, 1);
});

test("HH:MM:SS 形式的发车时刻归一成 HH:MM（与迁移的 CHECK 一致）", async () => {
  const sqlite = migrated();
  seedCalendar(sqlite, "cal_all", [0, 1, 2, 3, 4, 5, 6]);
  seedStop(sqlite, { id: "stop_bs", name: "宝山校区", longitude: 121.3983, latitude: 31.3155 });
  seedStop(sqlite, { id: "stop_yc", name: "延长校区", longitude: 121.4565, latitude: 31.2749 });
  seedRoute(sqlite, { id: "bs-yc", fromStopId: "stop_bs", toStopId: "stop_yc", departures: ["07:00:00"] });

  const { fetcher } = recordingFetcher();
  const summary = await sampleTravelTimes(envOf(sqlite), { fetcher, sleep: noSleep });
  assert.equal(summary.inserted, 1);
  assert.equal(
    sqlite.prepare("select departure_time from transit_travel_time_samples").get().departure_time,
    "07:00",
  );
});

test("采样只写自己那张表，不碰 transit_stop_times", async () => {
  const sqlite = seedCampusNetwork(migrated());
  const before = sqlite.prepare("select count(*) as n from transit_stop_times").get().n;
  const { fetcher } = recordingFetcher();
  await sampleTravelTimes(envOf(sqlite), { fetcher, sleep: noSleep });
  assert.equal(sqlite.prepare("select count(*) as n from transit_stop_times").get().n, before);
  assert.equal(
    sqlite.prepare("select count(*) as n from transit_stop_times where arrival_time is not null and stop_sequence=1").get().n,
    0,
    "第一步不改任何面向用户的显示",
  );
});

test("迁移把区间方向与 provider 钉在 CHECK 里", () => {
  const sqlite = seedCampusNetwork(migrated());
  const insert = (values) => sqlite.prepare(
    `insert into transit_travel_time_samples(
       id,pattern_id,from_stop_sequence,to_stop_sequence,departure_time,departure_at,duration_seconds,provider,sampled_at
     ) values(?,?,?,?,?,?,?,?,?)`,
  ).run(...values);

  // 反向区间会让累加算出负的到达时间。
  assert.throws(
    () => insert(["tts_bad", "pat_bs-yc", 1, 0, "07:00", NOW_ISO, 1300, PROVIDER, NOW_ISO]),
    /CHECK|constraint/i,
  );
  // 混进别的引擎会串味（matrix 与 direction 差 20%）。
  assert.throws(
    () => insert(["tts_bad2", "pat_bs-yc", 0, 1, "07:00", NOW_ISO, 1300, "tencent_direction", NOW_ISO]),
    /CHECK|constraint/i,
  );
  assert.throws(
    () => insert(["tts_bad3", "pat_bs-yc", 0, 1, "7:00", NOW_ISO, 1300, PROVIDER, NOW_ISO]),
    /CHECK|constraint/i,
  );
  assert.throws(
    () => insert(["tts_bad4", "pat_bs-yc", 0, 1, "07:00", NOW_ISO, 0, PROVIDER, NOW_ISO]),
    /CHECK|constraint/i,
  );
  insert(["tts_ok", "pat_bs-yc", 0, 1, "07:00", NOW_ISO, 1300, PROVIDER, NOW_ISO]);
});

test("班次被删时样本随 pattern 级联清理（不留孤儿）", () => {
  const sqlite = seedCampusNetwork(migrated());
  sqlite.prepare(
    `insert into transit_travel_time_samples(
       id,pattern_id,from_stop_sequence,to_stop_sequence,departure_time,departure_at,duration_seconds,provider,sampled_at
     ) values('tts_1','pat_bs-yc',0,1,'07:00',?,1300,?,?)`,
  ).run(NOW_ISO, PROVIDER, NOW_ISO);
  sqlite.prepare("delete from transit_stop_times where trip_id like 'trip_bs-yc%'").run();
  sqlite.prepare("delete from transit_trips where pattern_id='pat_bs-yc'").run();
  sqlite.prepare("delete from transit_patterns where id='pat_bs-yc'").run();
  assert.equal(sqlite.prepare("select count(*) as n from transit_travel_time_samples").get().n, 0);
});

test("cron 入口挂上了采样（否则这张表永远是空的）", () => {
  const source = read("worker/index-v2.ts");
  assert.match(source, /sampleTravelTimes/);
  assert.match(source, /ctx\.waitUntil\(sampleTravelTimes\(env\)\)/);
});

// ---------------------------------------------------------------------------
// 多站链（0024 校区对校区改版之后的真实拓扑）
// ---------------------------------------------------------------------------

/**
 * 多站链线路：首站上车、其余站全是下车点。复刻线上 pattern_jiading-to-baoshan
 * 的形状 —— 只有 seq=0 是 pickup='regular'，中间站 pickup='none'；
 * 且只有 seq=0 录了 departure_time，其余站到发时刻全空。
 */
function seedChainRoute(sqlite, { id, stopIds, departures, calendarId = "cal_all" }) {
  sqlite.prepare(
    "insert into transit_routes(id,name,status,created_at,updated_at) values(?,?,'active',?,?)",
  ).run(id, id, NOW_ISO, NOW_ISO);
  sqlite.prepare("insert into transit_patterns(id,route_id,direction_id,name) values(?,?,0,?)")
    .run(`pat_${id}`, id, id);
  for (const [sequence, stopId] of stopIds.entries()) {
    sqlite.prepare(
      "insert into transit_pattern_stops(pattern_id,stop_id,stop_sequence,pickup_type,dropoff_type) values(?,?,?,?,?)",
    ).run(`pat_${id}`, stopId, sequence, sequence === 0 ? "regular" : "none", sequence === 0 ? "none" : "regular");
  }
  for (const [index, departureTime] of departures.entries()) {
    const tripId = `trip_${id}_${index}`;
    sqlite.prepare("insert into transit_trips(id,pattern_id,service_calendar_id,status) values(?,?,?,'active')")
      .run(tripId, `pat_${id}`, calendarId);
    for (const [sequence, stopId] of stopIds.entries()) {
      sqlite.prepare(
        "insert into transit_stop_times(trip_id,stop_id,stop_sequence,arrival_time,departure_time) values(?,?,?,?,?)",
      ).run(tripId, stopId, sequence, null, sequence === 0 ? departureTime : null);
    }
  }
}

function seedChainNetwork(sqlite) {
  seedCalendar(sqlite, "cal_all", [0, 1, 2, 3, 4, 5, 6]);
  seedStop(sqlite, { id: "stop_jd", name: "嘉定北门", longitude: 121.2506, latitude: 31.3778 });
  seedStop(sqlite, { id: "stop_bs1", name: "宝山-三角花坛", longitude: 121.3983, latitude: 31.3155 });
  seedStop(sqlite, { id: "stop_bs2", name: "宝山-西门", longitude: 121.3951, latitude: 31.3172 });
  seedStop(sqlite, { id: "stop_bs3", name: "宝山-北门", longitude: 121.3990, latitude: 31.3201 });
  seedChainRoute(sqlite, {
    id: "jd-bs",
    stopIds: ["stop_jd", "stop_bs1", "stop_bs2", "stop_bs3"],
    departures: ["07:00"],
  });
  return sqlite;
}

test("多站链的每一段都进采样清单（回归：早先只采到首站那一段）", async () => {
  // 线上 pattern_jiading-to-baoshan 是 6 站链，只有首站 pickup<>'none'。
  // 早先的 SQL 要求区间起点 pickup<>'none'，于是只采 0→1，后面四段永远没样本
  // —— 6 个站里 4 个推不出到达时间，且完全不报错。
  const sqlite = seedChainNetwork(migrated());
  const segments = await loadSegments(envOf(sqlite), "2026-08-20");
  const pairs = segments
    .map((segment) => `${segment.fromStopSequence}->${segment.toStopSequence}`)
    .sort();
  assert.deepEqual(pairs, ["0->1", "1->2", "2->3"]);
  // 全链共用首站发车时刻：中间站的通过时刻库里没有，也不可能有。
  assert.deepEqual([...new Set(segments.map((segment) => segment.departureTime))], ["07:00"]);
});

test("多站链采样后每段都落库，且能推出每一站的到达时间", async () => {
  const sqlite = seedChainNetwork(migrated());
  const { fetcher } = recordingFetcher(600); // 每段 10 分钟
  const summary = await sampleTravelTimes(envOf(sqlite), { fetcher, sleep: noSleep });
  assert.equal(summary.inserted, 3, "三段相邻区间各一条样本");

  const medians = await loadSegmentMedians(envOf(sqlite), ["pat_jd-bs"]);
  const scoped = scopeSegmentMedians(medians, "pat_jd-bs", "07:00");
  assert.deepEqual([...scoped.entries()].sort(), [["0|1", 600], ["1|2", 600], ["2|3", 600]]);

  const arrivals = estimateStopArrivals([0, 1, 2, 3], scoped, "07:00");
  assert.equal(arrivals.get(1).time, "07:10");
  assert.equal(arrivals.get(2).time, "07:20");
  assert.equal(arrivals.get(3).time, "07:30");
  assert.equal(arrivals.has(0), false, "首站是发车不是到达");
});

// ---------------------------------------------------------------------------
// estimateStopArrivals
// ---------------------------------------------------------------------------

test("到达时间是相邻区间累加（N 站只需 N-1 段样本）", () => {
  const medians = new Map([["0|1", 300], ["1|2", 600], ["2|3", 900]]);
  const arrivals = estimateStopArrivals([0, 1, 2, 3], medians, "08:00");
  assert.equal(arrivals.get(1).durationSeconds, 300);
  assert.equal(arrivals.get(2).durationSeconds, 900);
  assert.equal(arrivals.get(3).durationSeconds, 1800);
  assert.equal(arrivals.get(3).time, "08:30");
});

test("缺一段就断链：后面所有站返回空，而不是跳过那段接着加", () => {
  // 少一段的和会系统性偏小。用户按偏早的时间到站、车其实还没来，比没有信息更糟。
  const medians = new Map([["0|1", 300], ["2|3", 900]]); // 缺 1|2
  const arrivals = estimateStopArrivals([0, 1, 2, 3], medians, "08:00");
  assert.equal(arrivals.get(1).time, "08:05");
  assert.equal(arrivals.has(2), false);
  assert.equal(arrivals.has(3), false, "断链之后不能接着累加");
});

test("一段样本都没有时返回空 Map（页面显示「暂无」）", () => {
  assert.equal(estimateStopArrivals([0, 1, 2], new Map(), "08:00").size, 0);
});

test("序号不连续也照常累加（停靠序号可能有空洞）", () => {
  const medians = new Map([["0|3", 600], ["3|7", 600]]);
  const arrivals = estimateStopArrivals([0, 3, 7], medians, "08:00");
  assert.equal(arrivals.get(3).time, "08:10");
  assert.equal(arrivals.get(7).time, "08:20");
});

test("跨零点的末班车：到达时间带 dayOffset=1", () => {
  const arrivals = estimateStopArrivals([0, 1], new Map([["0|1", 2400]]), "23:30");
  assert.equal(arrivals.get(1).time, "00:10");
  assert.equal(arrivals.get(1).dayOffset, 1);
});

// ---------------------------------------------------------------------------
// loadSegmentMedians / scopeSegmentMedians
// ---------------------------------------------------------------------------

test("中位数只回看最近 MEDIAN_SAMPLE_WINDOW 条样本", async () => {
  const sqlite = seedChainNetwork(migrated());
  const insert = sqlite.prepare(
    `insert into transit_travel_time_samples(
       id,pattern_id,from_stop_sequence,to_stop_sequence,departure_time,departure_at,duration_seconds,provider,sampled_at
     ) values(?,'pat_jd-bs',0,1,'07:00',?,?,?,?)`,
  );
  // 最近 8 条都是 600s；更早的一批是 6000s，若被算进来中位数会明显偏大。
  for (let index = 0; index < MEDIAN_SAMPLE_WINDOW; index += 1) {
    insert.run(`tts_new_${index}`, NOW_ISO, 600, PROVIDER, `2026-08-2${index}T00:00:00.000Z`);
  }
  for (let index = 0; index < 10; index += 1) {
    insert.run(`tts_old_${index}`, NOW_ISO, 6000, PROVIDER, `2026-01-0${index}T00:00:00.000Z`);
  }
  const medians = await loadSegmentMedians(envOf(sqlite), ["pat_jd-bs"]);
  assert.equal(medians.get("pat_jd-bs|0|1|07:00"), 600);
});

test("中位数按 (pattern, 区间, 发车时刻) 分组，不同发车时刻互不干扰", async () => {
  const sqlite = seedChainNetwork(migrated());
  const insert = sqlite.prepare(
    `insert into transit_travel_time_samples(
       id,pattern_id,from_stop_sequence,to_stop_sequence,departure_time,departure_at,duration_seconds,provider,sampled_at
     ) values(?,'pat_jd-bs',0,1,?,?,?,?,?)`,
  );
  insert.run("tts_am", "07:00", NOW_ISO, 1200, PROVIDER, NOW_ISO);
  insert.run("tts_pm", "17:00", NOW_ISO, 2400, PROVIDER, NOW_ISO);
  const medians = await loadSegmentMedians(envOf(sqlite), ["pat_jd-bs"]);
  assert.equal(medians.get("pat_jd-bs|0|1|07:00"), 1200);
  assert.equal(medians.get("pat_jd-bs|0|1|17:00"), 2400);
});

test("pattern 清单为空时不查库", async () => {
  const sqlite = migrated();
  assert.equal((await loadSegmentMedians(envOf(sqlite), [])).size, 0);
});

test("其他 provider 的样本不混进中位数（引擎不同，短线偏差 20%）", async () => {
  const sqlite = seedChainNetwork(migrated());
  sqlite.prepare(
    `insert into transit_travel_time_samples(
       id,pattern_id,from_stop_sequence,to_stop_sequence,departure_time,departure_at,duration_seconds,provider,sampled_at
     ) values('tts_1','pat_jd-bs',0,1,'07:00',?,1200,?,?)`,
  ).run(NOW_ISO, PROVIDER, NOW_ISO);
  const medians = await loadSegmentMedians(envOf(sqlite), ["pat_jd-bs"]);
  assert.equal(medians.size, 1, "当前只有一个 provider；换 provider 要新增枚举值而不是混算");
});

test("scopeSegmentMedians 把 HH:MM:SS 截断到 HH:MM 再比（样本表 CHECK 是 __:__）", () => {
  const medians = new Map([["pat_a|0|1|07:00", 600], ["pat_b|0|1|07:00", 900]]);
  const scoped = scopeSegmentMedians(medians, "pat_a", "07:00:00");
  assert.deepEqual([...scoped.entries()], [["0|1", 600]]);
});

test("scopeSegmentMedians 只取本 pattern 本发车时刻的段", () => {
  const medians = new Map([
    ["pat_a|0|1|07:00", 600],
    ["pat_a|1|2|07:00", 700],
    ["pat_a|0|1|17:00", 800],
    ["pat_b|0|1|07:00", 900],
  ]);
  const scoped = scopeSegmentMedians(medians, "pat_a", "07:00");
  assert.deepEqual([...scoped.entries()].sort(), [["0|1", 600], ["1|2", 700]]);
});
