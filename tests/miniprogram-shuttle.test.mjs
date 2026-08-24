// 小程序端校车时刻表逻辑自验（不经微信开发者工具，直接在 node 里跑）。
//
// 用 esbuild 把 miniprogram/miniprogram/lib/transit/schedule.ts 编成 cjs 后断言：
// 1. 日期分桶与 Web 端一致（工作日/周六/假日/调班/寒假/暑假各取一个代表日）；
// 2. 快照按「校区对 → 线路」组织，预约/非预约拆成两条线，时刻与
//    data/shuttle-schedule.json 原文一致（0024 校区对校区改版）；
// 3. 断网（wx 未定义）时 fetchCampusLinesWithFallback 自动降级到快照；
// 4. 剩余班次过滤、上下车点提取与班次预览 buildLinePreview。

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
const source = JSON.parse(readFileSync(join(repoRoot, "data/shuttle-schedule.json"), "utf8"));

// 校区名 → 端点 id（与生成脚本、release manifest 一致）
const ENDPOINT_ID = {
  宝山校区: "campus_baoshan",
  嘉定校区: "campus_jiading",
  延长校区: "campus_yanchang",
  陈太公寓: "stop:stop_陈太公寓",
};

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
// 2. 快照线路与原文一致（预约班次拆成独立线；仅混合方向加「（预约）」后缀，对齐服务端拆分）
// ---------------------------------------------------------------------------
function assertSnapshotPair(routeId, date, bucket) {
  const route = source.routes.find((r) => r.id === routeId);
  const lines = schedule.snapshotCampusLines(ENDPOINT_ID[route.from], ENDPOINT_ID[route.to], date);
  assert.ok(lines !== null, `快照应包含校区对 ${route.from} → ${route.to}`);

  const entries = route.schedules[bucket];
  const normalTimes = entries.filter((e) => !e.isReservation).map((e) => e.departureTime);
  const reservationTimes = entries.filter((e) => e.isReservation).map((e) => e.departureTime);
  const totalNormal = Object.values(route.schedules).flat().filter((e) => !e.isReservation).length;
  const totalReservation = Object.values(route.schedules).flat().filter((e) => e.isReservation).length;

  // 某方向没有该类班次就不出那条线
  assert.equal(lines.length, (totalNormal > 0 ? 1 : 0) + (totalReservation > 0 ? 1 : 0));

  for (const line of lines) {
    const isReservation = line.bookingPolicy === "required";
    const expectedTimes = isReservation ? reservationTimes : normalTimes;
    const mixed = totalNormal > 0 && totalReservation > 0;
    assert.equal(line.routeName, `${route.from} → ${route.to}${isReservation && mixed ? "（预约）" : ""}`);
    assert.equal(line.bookingUrl, null);
    assert.deepEqual(line.patterns, [], "快照线路没有站点粒度数据");
    assert.deepEqual(
      line.journeys.map((j) => j.departureTime),
      expectedTimes,
      `${routeId} ${bucket} ${isReservation ? "预约" : "普通"}线时刻应与原文一致`,
    );
    for (const journey of line.journeys) {
      assert.ok(journey.tripId.startsWith("snapshot:"), "快照班次带合成 tripId");
      assert.deepEqual(journey.stopTimes, []);
    }
  }
  return lines;
}

for (const routeId of ["baoshan-to-yanchang", "jiading-to-baoshan", "chentaigongyu-to-baoshan"]) {
  assertSnapshotPair(routeId, new Date(2026, 5, 18), "weekday");
  assertSnapshotPair(routeId, new Date(2026, 5, 20), "weekend");
  assertSnapshotPair(routeId, new Date(2026, 7, 10), "summerBreak");
}

// 陈太公寓线全部是预约班次：只有一条预约线，没有普通线；纯预约方向对齐服务端拆分，保留原名不加后缀
const chentai = schedule.snapshotCampusLines(ENDPOINT_ID["陈太公寓"], ENDPOINT_ID["宝山校区"], new Date(2026, 5, 18));
assert.equal(chentai.length, 1);
assert.equal(chentai[0].bookingPolicy, "required");
assert.equal(chentai[0].routeName, "陈太公寓 → 宝山校区");

// 快照里没有的校区对返回 null
assert.equal(schedule.snapshotCampusLines(ENDPOINT_ID["延长校区"], ENDPOINT_ID["陈太公寓"], new Date(2026, 5, 18)), null);

// ---------------------------------------------------------------------------
// 3. 断网降级：node 里没有 wx，apiGet 必然失败 → 自动走快照
// ---------------------------------------------------------------------------
const endpoints = schedule.snapshotEndpoints();
assert.deepEqual(
  endpoints.map((e) => e.id),
  ["campus_baoshan", "campus_jiading", "campus_yanchang", "stop:stop_陈太公寓"],
  "快照端点应为三个校区 + 陈太公寓伪端点（顺序对齐 listTransitEndpoints）",
);
const { lines, source: fallbackSource } = await schedule.fetchCampusLinesWithFallback(
  endpoints.find((e) => e.id === "campus_baoshan"),
  endpoints.find((e) => e.id === "campus_yanchang"),
  new Date(2026, 5, 18),
);
assert.equal(fallbackSource, "snapshot", "断网时应降级到快照");
const expectedWeekday = source.routes.find((r) => r.id === "baoshan-to-yanchang").schedules.weekday;
assert.equal(
  lines.reduce((sum, line) => sum + line.journeys.length, 0),
  expectedWeekday.length,
  "降级后班次总数应与快照原文一致",
);

// loadTransitEndpoints 断网时同样降级
const endpointsResult = await schedule.loadTransitEndpoints();
assert.equal(endpointsResult.source, "snapshot");
assert.equal(endpointsResult.endpoints.length, 4);
assert.deepEqual(endpointsResult.stops, [], "快照模式下没有 manifest 站点");

// ---------------------------------------------------------------------------
// 4. listTransitEndpoints（manifest 推导：有站点的校区 + 无校区伪端点）
// ---------------------------------------------------------------------------
const manifestEndpoints = schedule.listTransitEndpoints({
  campuses: [
    { id: "campus_baoshan", name: "宝山校区" },
    { id: "campus_jiading", name: "嘉定校区" },
    { id: "campus_yanchang", name: "延长校区" },
  ],
  transit: {
    stops: [
      { id: "stop_嘉定校区", campus_id: "campus_jiading" },
      { id: "stop_宝山校区", campus_id: "campus_baoshan" },
      { id: "stop_延长校区", campus_id: "campus_yanchang" },
      { id: "stop_陈太公寓", campus_id: null },
    ],
  },
});
assert.deepEqual(
  manifestEndpoints.map((e) => e.id),
  ["campus_baoshan", "campus_jiading", "campus_yanchang", "stop:stop_陈太公寓"],
);

// ---------------------------------------------------------------------------
// 5. 剩余班次过滤（getRemainingJourneys）
// ---------------------------------------------------------------------------
const normalLine = lines.find((line) => line.bookingPolicy === "not_required");
const remaining = schedule.getRemainingJourneys(normalLine.journeys, new Date(2026, 5, 18, 16, 59));
assert.ok(remaining.length > 0);
assert.equal(remaining[0].departureTime, "17:00", "16:59 之后下一班应为 17:00");
assert.equal(schedule.getRemainingJourneys(normalLine.journeys, new Date(2026, 5, 18, 22, 0)).length, 0);

// ---------------------------------------------------------------------------
// 6. 上下车点提取与班次预览 buildLinePreview（数据形状与 campus-lines 一致）
// ---------------------------------------------------------------------------
const apiLine = {
  routeId: "route_1",
  routeName: "宝山校区 → 延长校区",
  bookingPolicy: "not_required",
  bookingUrl: null,
  patterns: [
    {
      patternId: "pattern_1",
      name: "宝山校区 → 延长校区",
      stops: [
        { stopId: "stop_宝山校区", stopName: "宝山校区", stopSequence: 0, pickupType: "regular", dropoffType: "none" },
        { stopId: "stop_延长校区", stopName: "延长校区", stopSequence: 1, pickupType: "none", dropoffType: "regular" },
      ],
    },
  ],
  journeys: [
    {
      tripId: "trip_1",
      patternId: "pattern_1",
      publicLabel: null,
      departureTime: "07:00",
      arrivalTime: null,
      stopTimes: [{ stopSequence: 0, arrivalTime: null, departureTime: "07:00" }],
    },
  ],
};
assert.deepEqual(schedule.lineBoardingStops(apiLine), [{ stopId: "stop_宝山校区", stopName: "宝山校区" }]);
assert.deepEqual(schedule.lineAlightingStops(apiLine), [{ stopId: "stop_延长校区", stopName: "延长校区" }]);

const preview = schedule.buildLinePreview(apiLine, apiLine.journeys[0]);
assert.equal(preview.stops.length, 2);
assert.equal(preview.stops[0].role, "boarding");
assert.equal(preview.stops[0].time, "07:00");
assert.equal(preview.stops[0].timeLabel, "发车");
assert.equal(preview.stops[1].role, "alighting");
assert.equal(preview.stops[1].time, null); // 无估算样本时下车站仍为空
assert.equal(preview.stops[1].isEstimated, false);
assert.equal(preview.durationMinutes, null);
assert.equal(preview.hasEstimated, false);

// ---------------------------------------------------------------------------
// 7. 估算到达时间（服务端 estimatedArrivalTime，来自区间用时采样）
//
// 这一段钉的是「推算值不能被当成排班时刻」：isEstimated 必须为 true，页面据此
// 把文案写成「预计 …… 到达」。首站永远不推算——它的发车时刻就是排班本身。
// ---------------------------------------------------------------------------
const estimatedJourney = {
  ...apiLine.journeys[0],
  estimatedArrivalTime: "07:23",
  estimatedArrivalDayOffset: 0,
  estimatedDurationMinutes: 23,
  stopTimes: [
    { stopSequence: 0, arrivalTime: null, departureTime: "07:00", estimatedArrivalTime: null, estimatedArrivalDayOffset: null },
    { stopSequence: 1, arrivalTime: null, departureTime: null, estimatedArrivalTime: "07:23", estimatedArrivalDayOffset: 0 },
  ],
};
const estimatedPreview = schedule.buildLinePreview(apiLine, estimatedJourney);
assert.equal(estimatedPreview.stops[0].time, "07:00");
assert.equal(estimatedPreview.stops[0].isEstimated, false, "首站是排班发车时刻，不是推算值");
assert.equal(estimatedPreview.stops[1].time, "07:23");
assert.equal(estimatedPreview.stops[1].isEstimated, true, "下车站的时间来自推算，必须标出来");
assert.equal(estimatedPreview.durationMinutes, 23);
assert.equal(estimatedPreview.hasEstimated, true);

// 录了真实到达时刻时优先用它，估算只做兜底（真实值不标「预计」）。
const realArrival = {
  ...estimatedJourney,
  stopTimes: [
    { stopSequence: 0, arrivalTime: null, departureTime: "07:00", estimatedArrivalTime: null, estimatedArrivalDayOffset: null },
    { stopSequence: 1, arrivalTime: "07:30", departureTime: null, estimatedArrivalTime: "07:23", estimatedArrivalDayOffset: 0 },
  ],
};
const realPreview = schedule.buildLinePreview(apiLine, realArrival);
assert.equal(realPreview.stops[1].time, "07:30", "排班到达时刻优先于估算值");
assert.equal(realPreview.stops[1].isEstimated, false);

// 跨零点的末班车：dayOffset 透传，页面显示「预计 次日 00:40 到达」。
const overnight = {
  ...estimatedJourney,
  departureTime: "22:00",
  stopTimes: [
    { stopSequence: 0, arrivalTime: null, departureTime: "22:00", estimatedArrivalTime: null, estimatedArrivalDayOffset: null },
    { stopSequence: 1, arrivalTime: null, departureTime: null, estimatedArrivalTime: "00:40", estimatedArrivalDayOffset: 1 },
  ],
};
const overnightPreview = schedule.buildLinePreview(apiLine, overnight);
assert.equal(overnightPreview.stops[1].time, "00:40");
assert.equal(overnightPreview.stops[1].dayOffset, 1, "跨天标记要透传，否则末班车看不出是次日");

// 快照（离线）模式：合成的班次带齐估算字段且全为 null，不会让预览逻辑崩。
const snapshotLines = schedule.snapshotCampusLines("campus_baoshan", "campus_yanchang", new Date(2026, 5, 18));
if (snapshotLines) {
  for (const line of snapshotLines) {
    for (const journey of line.journeys) {
      assert.equal(journey.estimatedArrivalTime, null, "快照没有采样数据，估算必须是 null");
      assert.equal(journey.estimatedDurationMinutes, null);
    }
  }
}

// ---------------------------------------------------------------------------
// 8. 同一发车时刻的多趟班次（journeysAtTime）
//
// 时刻网格把同一时刻的预约与非预约合并成一格（「预 非」两个角标），点开必须
// 两班都给出来。以前是 find(...) 只取先命中的那一班，摊平顺序里非预约常在前，
// 于是预约车在界面上没有任何入口 —— 这一段就是钉住那个回归。
// ---------------------------------------------------------------------------
const freeLine = {
  ...apiLine,
  routeId: "route_free",
  bookingPolicy: "not_required",
  journeys: [{ ...apiLine.journeys[0], tripId: "trip_free" }],
};
const bookedLine = {
  ...apiLine,
  routeId: "route_booked",
  bookingPolicy: "required",
  bookingUrl: "https://example.test/book",
  journeys: [{ ...apiLine.journeys[0], tripId: "trip_booked" }],
};

// 预约线在前传入，验证顺序由 journeysAtTime 决定而不是由入参顺序决定
const mixedFlat = schedule.flattenLineJourneys([bookedLine, freeLine]);
const atSeven = schedule.journeysAtTime(mixedFlat, "07:00");
assert.equal(atSeven.length, 2, "同一时刻的两班车都要出现，不能只取一班");
assert.equal(atSeven[0].isReservation, false, "非预约在上");
assert.equal(atSeven[1].isReservation, true, "预约在下");
assert.equal(atSeven[1].line.bookingUrl, "https://example.test/book",
  "每趟要能取回自己线路的预约地址（两趟的预约入口不能串味）");

// 时刻网格那一格确实标成 mixed，与上面两班一一对应
assert.deepEqual(schedule.mergeSchedulesByTime(mixedFlat), [{ departureTime: "07:00", status: "mixed" }]);

// 只有一班时照常返回一条；没有该时刻时返回空数组（调用方据此不开弹层）
assert.equal(schedule.journeysAtTime(schedule.flattenLineJourneys([freeLine]), "07:00").length, 1);
assert.deepEqual(schedule.journeysAtTime(mixedFlat, "23:59"), []);

// ---------------------------------------------------------------------------
// 9. 站点 → 地图 POI 键（mapPoiKeyForStop）与导航终点（navigationPointForStop）
//
// 两条都曾经整体失效，且失效方式相似：拿错了「站点在发布数据里的身份」。
//   · 地图深链原先用 stop.place_id，而 11 个站点里 10 个 place_id 是 null，
//     于是全部落到 `campus:` 分支——那个深链只切校区、不开详情，正是
//     「点上下车点回到地图却没打开 POI」；
//   · 导航原先要求 isPrimary===1，而站点的 primary 名额被候车点占着，
//     navigation_target 必然是 0，于是「导航」入口从未出现过。
// ---------------------------------------------------------------------------
const canvasPoint = {
  entityType: "transit_stop",
  entityId: "stop_baoshan",
  role: "boarding_point",
  isPrimary: 1,
  geometry_type: "Point",
  geometry_json: '{"type":"Point","coordinates":[300,400]}',
  crs: "svg_viewbox",
  location_hint: null,
};
const navTarget = {
  entityType: "transit_stop",
  entityId: "stop_baoshan",
  role: "navigation_target",
  // 关键：候车点占着 primary，导航终点必然是 0
  isPrimary: 0,
  geometry_type: "Point",
  geometry_json: '{"type":"Point","coordinates":[121.39,31.31]}',
  crs: "GCJ02",
  location_hint: "宝山-北门",
};
const mappedStop = { id: "stop_baoshan", place_id: null, campus_id: "campus_baoshan", name: "宝山-北门" };

assert.equal(
  schedule.mapPoiKeyForStop(mappedStop, [canvasPoint, navTarget]),
  "transit_stop:stop_baoshan",
  "有画布点位的站点，地图身份是 transit_stop:<id>（不是它绑的地点）",
);
assert.deepEqual(
  schedule.navigationPointForStop(mappedStop, [canvasPoint, navTarget]),
  { longitude: 121.39, latitude: 31.31, displayName: "宝山-北门" },
  "isPrimary=0 的 navigation_target 必须被采信，否则导航入口全部消失",
);

// 借绑定地点上图的站点（嘉定北门那种）：键仍是 transit_stop:<id>
const borrowedStop = { id: "stop_jiading", place_id: "place_gate", campus_id: "campus_jiading", name: "嘉定北门" };
assert.equal(
  schedule.mapPoiKeyForStop(borrowedStop, [{ ...canvasPoint, entityType: "place", entityId: "place_gate" }]),
  "transit_stop:stop_jiading",
);

// 只有 GCJ02 坐标、没有画布点位（陈太公寓）：地图上确实没有 POI 可开，
// 如实返回 null，让调用方不要给出可点入口（而不是给一个只切校区的假入口）。
const offMapStop = { id: "stop_chentai", place_id: null, campus_id: null, name: "陈太公寓" };
assert.equal(schedule.mapPoiKeyForStop(offMapStop, [{ ...navTarget, entityId: "stop_chentai" }]), null);
// 但它照样能导航（GCJ02 点位是有的）
assert.deepEqual(
  schedule.navigationPointForStop(offMapStop, [{ ...navTarget, entityId: "stop_chentai", location_hint: "陈太公寓" }]),
  { longitude: 121.39, latitude: 31.31, displayName: "陈太公寓" },
);

console.log("miniprogram-shuttle: all assertions passed");
