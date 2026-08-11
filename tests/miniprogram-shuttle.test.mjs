// 小程序端校车时刻表逻辑自验（不经微信开发者工具，直接在 node 里跑）。
//
// 用 esbuild 把 miniprogram/miniprogram/lib/transit/schedule.ts 编成 cjs 后断言：
// 1. 日期分桶与 Web 端一致（工作日/周六/假日/调班/寒假/暑假各取一个代表日）；
// 2. 快照兜底班次与 data/shuttle-schedule.json 原文一致；
// 3. 断网（wx 未定义）时 fetchSchedulesWithFallback 自动降级到快照；
// 4. 时刻合并（同一时刻预约+非预约 → mixed）与剩余班次过滤。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "tmp/shuttle-test");
mkdirSync(outDir, { recursive: true });

execFileSync(join(repoRoot, "node_modules/.bin/esbuild"), [
  join(repoRoot, "miniprogram/miniprogram/lib/transit/schedule.ts"),
  "--bundle",
  "--format=cjs",
  "--platform=node",
  `--outfile=${join(outDir, "schedule.cjs")}`,
]);

const require = createRequire(import.meta.url);
const schedule = require(join(outDir, "schedule.cjs"));
const snapshot = JSON.parse(readFileSync(join(repoRoot, "data/shuttle-schedule.json"), "utf8"));

// ---------------------------------------------------------------------------
// 1. 日期分桶（日历数据源：data/academic-calendar.json 2025-2026 学年）
// ---------------------------------------------------------------------------
const bucketCases = [
  [new Date(2026, 5, 18), "weekday"], // 2026-06-18 周四，第二学期内
  [new Date(2026, 5, 20), "weekend"], // 2026-06-20 周六
  [new Date(2026, 4, 1), "holiday"], // 2026-05-01 劳动节（周五但假日优先）
  [new Date(2026, 4, 9), "weekday"], // 2026-05-09 周六调班 → 工作日
  [new Date(2026, 1, 10), "winterBreak"], // 2026-02-10 寒假
  [new Date(2026, 7, 10), "summerBreak"], // 2026-08-10 周一，暑假
];
for (const [date, expected] of bucketCases) {
  assert.equal(schedule.getCurrentDateBucket(date), expected, `${date.toDateString()} 分桶应为 ${expected}`);
}

// ---------------------------------------------------------------------------
// 2. 快照班次与原文一致（工作日 / 周六 / 暑假日三种日历）
// ---------------------------------------------------------------------------
function assertSnapshot(fromName, toName, routeId, date, bucket) {
  const items = schedule.snapshotSchedules(fromName, toName, date);
  assert.ok(items !== null, `快照应包含线路 ${routeId}`);
  const route = snapshot.routes.find((r) => r.id === routeId);
  const expected = route.schedules[bucket];
  assert.deepEqual(
    items.map((s) => ({ departureTime: s.departureTime, isReservation: s.isReservation })),
    expected,
    `${routeId} ${bucket} 班次应与快照原文一致`,
  );
  // 快照班次带合成 tripId 且 bookingPolicy 与预约标记一致
  for (const item of items) {
    assert.ok(item.tripId.startsWith(`snapshot:${routeId}:`));
    assert.equal(item.bookingPolicy, item.isReservation ? "required" : "not_required");
  }
}

for (const [fromName, toName, routeId] of [
  ["宝山校区", "延长校区", "baoshan-to-yanchang"],
  ["嘉定校区", "宝山校区", "jiading-to-baoshan"],
  ["陈太公寓", "宝山校区", "chentaigongyu-to-baoshan"],
]) {
  assertSnapshot(fromName, toName, routeId, new Date(2026, 5, 18), "weekday");
  assertSnapshot(fromName, toName, routeId, new Date(2026, 5, 20), "weekend");
  assertSnapshot(fromName, toName, routeId, new Date(2026, 7, 10), "summerBreak");
}

// 快照里没有的线路返回 null
assert.equal(schedule.snapshotSchedules("延长校区", "陈太公寓", new Date(2026, 5, 18)), null);

// ---------------------------------------------------------------------------
// 3. 断网降级：node 里没有 wx，requestGet 必然失败 → 自动走快照
// ---------------------------------------------------------------------------
const stops = schedule.snapshotStops();
assert.deepEqual(
  stops.map((s) => s.name),
  ["宝山校区", "延长校区", "嘉定校区", "陈太公寓"],
  "快照站点集合应为四个校区/公寓",
);
const { schedules, source } = await schedule.fetchSchedulesWithFallback(
  stops.find((s) => s.name === "宝山校区"),
  stops.find((s) => s.name === "延长校区"),
  new Date(2026, 5, 18),
);
assert.equal(source, "snapshot", "断网时应降级到快照");
const expectedWeekday = snapshot.routes.find((r) => r.id === "baoshan-to-yanchang").schedules.weekday;
assert.equal(schedules.length, expectedWeekday.length, "降级后班次数应与快照一致");

// loadTransitStops 断网时同样降级
const stopsResult = await schedule.loadTransitStops();
assert.equal(stopsResult.source, "snapshot");
assert.equal(stopsResult.stops.length, 4);

// ---------------------------------------------------------------------------
// 4. 时刻合并与剩余班次
// ---------------------------------------------------------------------------
const merged = schedule.mergeSchedulesByTime(schedules);
const at1700 = merged.find((m) => m.departureTime === "17:00");
assert.equal(at1700.status, "mixed", "17:00 同时有预约与非预约班次应合并为 mixed");
const at1200 = merged.find((m) => m.departureTime === "12:00");
assert.equal(at1200.status, "reservation");

const remaining = schedule.getRemainingBuses(schedules, new Date(2026, 5, 18, 16, 59));
assert.ok(remaining.length > 0);
assert.equal(remaining[0].departureTime, "17:00", "16:59 之后下一班应为 17:00");
assert.equal(schedule.getRemainingBuses(schedules, new Date(2026, 5, 18, 22, 0)).length, 0);

// ---------------------------------------------------------------------------
// 5. 班次预览 buildTripPreview（数据形状与真实接口一致）
// ---------------------------------------------------------------------------
const preview = schedule.buildTripPreview(
  [
    { stopId: "stop_宝山校区", stopName: "宝山校区", stopSequence: 0, pickupType: "regular", dropoffType: "none", arrivalTime: null, departureTime: "07:00" },
    { stopId: "stop_延长校区", stopName: "延长校区", stopSequence: 1, pickupType: "none", dropoffType: "regular", arrivalTime: null, departureTime: null },
  ],
  { tripId: "t1", routeName: "宝山校区 → 延长校区", departureTime: "07:00", arrivalTime: null, isReservation: false, bookingPolicy: "not_required", bookingUrl: null, fromSequence: 0, toSequence: 1 },
);
assert.equal(preview.stops.length, 2);
assert.equal(preview.stops[0].role, "boarding");
assert.equal(preview.stops[0].time, "07:00");
assert.equal(preview.stops[0].timeLabel, "发车");
assert.equal(preview.stops[1].role, "alighting");
assert.equal(preview.stops[1].time, null); // 当前数据只有首站发车时刻
assert.equal(preview.durationMinutes, null);

console.log("miniprogram-shuttle: all assertions passed");
