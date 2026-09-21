// 就餐前台纯逻辑自验（node 直跑）：src/lib/dining/schedule.ts。
// 该模块只有 type-only 外部依赖，拷贝成 .mts 即可被 node:test 加载
//（package 是 "type": "commonjs"，Node 只对 ES module 做类型擦除）。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "src/lib/dining/schedule.ts");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shumap-dining-"));
const modulePath = path.join(tempDir, "schedule.mts");
fs.copyFileSync(source, modulePath);
const {
  buildCanteens,
  floorMediaOf,
  floorOpenStatus,
  floorStatusLabel,
  levelShortLabel,
  mealNow,
  minutesOf,
  orderCampusKeys,
  parseDiningScheduleResponse,
  parseMerchantStatusResponse,
  parsePlaceDining,
  periodBarText,
  segmentMealName,
} = await import(modulePath);

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

// 与 migrations-v2/0036 种子一致的基准时段表
const PERIODS = [
  { meal: "breakfast", startTime: "06:30", endTime: "09:30", sortOrder: 10 },
  { meal: "lunner", startTime: "11:00", endTime: "13:00", sortOrder: 20 },
  { meal: "lunner", startTime: "16:40", endTime: "18:30", sortOrder: 30 },
  { meal: "latenight", startTime: "19:30", endTime: "22:00", sortOrder: 40 },
];

function scheduleResponse(overrides = {}) {
  return {
    date: "2026-09-21",
    dayType: "weekday",
    mealPeriods: PERIODS,
    arrangement: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 响应解析
// ---------------------------------------------------------------------------

test("parseDiningScheduleResponse accepts a weekday payload without arrangement", () => {
  const parsed = parseDiningScheduleResponse(scheduleResponse());
  assert.equal(parsed.dayType, "weekday");
  assert.equal(parsed.arrangement, null);
  assert.equal(parsed.mealPeriods.length, 4);
  assert.equal(parsed.mealPeriods[1].meal, "lunner");
});

test("parseDiningScheduleResponse parses a weekend arrangement whitelist", () => {
  const parsed = parseDiningScheduleResponse(scheduleResponse({
    dayType: "weekend",
    arrangement: {
      scheduleId: "ds_1",
      floors: [
        { floorId: "floor_a", noBreakfast: false },
        { floorId: "floor_b", noBreakfast: true },
      ],
    },
  }));
  assert.equal(parsed.arrangement.scheduleId, "ds_1");
  assert.deepEqual(parsed.arrangement.floors[1], { floorId: "floor_b", noBreakfast: true });
});

test("parseDiningScheduleResponse rejects contract violations instead of guessing", () => {
  assert.throws(() => parseDiningScheduleResponse(scheduleResponse({ dayType: "sunday" })), /dayType/);
  assert.throws(
    () => parseDiningScheduleResponse(scheduleResponse({
      mealPeriods: [{ meal: "brunch", startTime: "11:00", endTime: "13:00", sortOrder: 1 }],
    })),
    /meal/,
  );
  assert.throws(
    () => parseDiningScheduleResponse(scheduleResponse({
      mealPeriods: [{ meal: "lunner", startTime: "25:00", endTime: "13:00", sortOrder: 1 }],
    })),
    /HH:MM/,
  );
  assert.throws(
    () => parseDiningScheduleResponse(scheduleResponse({
      arrangement: { scheduleId: "ds_1", floors: [{ floorId: "f1", noBreakfast: 1 }] },
    })),
    /noBreakfast/,
  );
});

test("parseMerchantStatusResponse validates lifecycle values", () => {
  const parsed = parseMerchantStatusResponse({
    statuses: { m1: "active", m2: "temporarily_closed", m3: "planned" },
  });
  assert.equal(parsed.statuses.m2, "temporarily_closed");
  assert.throws(() => parseMerchantStatusResponse({ statuses: { m1: "open" } }), /statuses/);
});

// ---------------------------------------------------------------------------
// 时段计算
// ---------------------------------------------------------------------------

test("segmentMealName splits lunner into 午餐/晚餐 by start time", () => {
  assert.equal(segmentMealName(PERIODS[0]), "早餐");
  assert.equal(segmentMealName(PERIODS[1]), "午餐");
  assert.equal(segmentMealName(PERIODS[2]), "晚餐");
  assert.equal(segmentMealName(PERIODS[3]), "夜宵");
  assert.equal(minutesOf("16:40"), 1000);
});

test("mealNow reports serving / break / ended", () => {
  assert.deepEqual(mealNow(PERIODS, minutesOf("12:00")), { kind: "serving", period: PERIODS[1] });
  const lunchBreak = mealNow(PERIODS, minutesOf("14:00"));
  assert.equal(lunchBreak.kind, "break");
  assert.equal(lunchBreak.previous, PERIODS[1]);
  assert.equal(lunchBreak.next, PERIODS[2]);
  const early = mealNow(PERIODS, minutesOf("05:00"));
  assert.equal(early.kind, "break");
  assert.equal(early.previous, null);
  assert.equal(early.next, PERIODS[0]);
  assert.deepEqual(mealNow(PERIODS, minutesOf("23:00")), { kind: "ended" });
  assert.deepEqual(mealNow([], minutesOf("12:00")), { kind: "ended" });
});

test("periodBarText renders the design-worded status line", () => {
  const weekday = scheduleResponse();
  assert.equal(periodBarText(weekday, minutesOf("12:00")), "当前：午餐时段（至 13:00）");
  assert.equal(periodBarText(weekday, minutesOf("07:30")), "当前：早餐时段（至 09:30）");
  assert.equal(periodBarText(weekday, minutesOf("14:00")), "当前：午休中 · 晚餐 16:40 开始");
  assert.equal(periodBarText(weekday, minutesOf("10:00")), "当前：供餐间歇 · 午餐 11:00 开始");
  assert.equal(periodBarText(weekday, minutesOf("23:00")), "当前：今日供餐已结束");
});

test("periodBarText appends the arrangement suffix on weekends with a schedule", () => {
  const weekend = scheduleResponse({
    dayType: "weekend",
    arrangement: { scheduleId: "ds_1", floors: [] },
  });
  assert.equal(periodBarText(weekend, minutesOf("12:00")), "当前：午餐时段（至 13:00） · 周末营业安排");
  const holiday = scheduleResponse({
    dayType: "holiday",
    arrangement: { scheduleId: "ds_1", floors: [] },
  });
  assert.equal(periodBarText(holiday, minutesOf("12:00")), "当前：午餐时段（至 13:00） · 节假日营业安排");
  // 无安排不加后缀（页面此时走「暂无安排信息」空态）
  const noSchedule = scheduleResponse({ dayType: "weekend" });
  assert.equal(periodBarText(noSchedule, minutesOf("12:00")), "当前：午餐时段（至 13:00）");
});

// ---------------------------------------------------------------------------
// 楼层开放状态
// ---------------------------------------------------------------------------

function status(input) {
  return floorOpenStatus({
    dayType: "weekday",
    arrangement: null,
    floorId: "floor_1",
    meals: ["breakfast", "lunner"],
    periods: PERIODS,
    nowMinutes: minutesOf("12:00"),
    placeClosed: false,
    ...input,
  });
}

test("weekday floors default to fully open during their serving segments", () => {
  assert.deepEqual(status({}), { kind: "open" });
  assert.deepEqual(status({ meals: ["lunner"], nowMinutes: minutesOf("17:00") }), { kind: "open" });
  assert.deepEqual(status({ meals: ["latenight"], nowMinutes: minutesOf("20:00") }), { kind: "open" });
});

test("a floor not serving right now shows its next segment, then 今日休息", () => {
  assert.deepEqual(
    status({ nowMinutes: minutesOf("14:00") }),
    { kind: "upcoming", meal: "晚餐", startTime: "16:40" },
  );
  assert.deepEqual(
    status({ meals: ["lunner"], nowMinutes: minutesOf("08:00") }),
    { kind: "upcoming", meal: "午餐", startTime: "11:00" },
  );
  assert.deepEqual(status({ meals: ["breakfast"], nowMinutes: minutesOf("20:00") }), { kind: "rest" });
  assert.equal(
    floorStatusLabel(status({ nowMinutes: minutesOf("14:00") })),
    "晚餐 16:40 开",
  );
  assert.equal(floorStatusLabel(status({})), null);
});

test("a closed canteen marks every floor 今日休息", () => {
  assert.deepEqual(status({ placeClosed: true }), { kind: "rest" });
});

test("weekend follows the arrangement whitelist; no arrangement never guesses", () => {
  const arrangement = {
    scheduleId: "ds_1",
    floors: [{ floorId: "floor_1", noBreakfast: false }],
  };
  assert.deepEqual(status({ dayType: "weekend", arrangement }), { kind: "open" });
  assert.deepEqual(
    status({ dayType: "weekend", arrangement, floorId: "floor_2" }),
    { kind: "rest" },
  );
  // arrangement 为 null 属页面级空态；真走到这里按未命中兜底
  assert.deepEqual(status({ dayType: "weekend", arrangement: null }), { kind: "rest" });
});

test("noBreakfast removes the breakfast segment for that floor", () => {
  const arrangement = {
    scheduleId: "ds_1",
    floors: [{ floorId: "floor_1", noBreakfast: true }],
  };
  assert.deepEqual(
    status({ dayType: "weekend", arrangement, nowMinutes: minutesOf("08:00") }),
    { kind: "upcoming", meal: "午餐", startTime: "11:00" },
  );
  // 只供早餐的楼层 noBreakfast → 今天没有它的餐段
  assert.deepEqual(
    status({ dayType: "weekend", arrangement, meals: ["breakfast"], nowMinutes: minutesOf("08:00") }),
    { kind: "rest" },
  );
  // 工作日不受 noBreakfast 影响（arrangement 只约束周末/节假日）
  assert.deepEqual(
    status({ dayType: "weekday", arrangement, meals: ["breakfast"], nowMinutes: minutesOf("08:00") }),
    { kind: "open" },
  );
});

// ---------------------------------------------------------------------------
// 校区排序
// ---------------------------------------------------------------------------

test("orderCampusKeys puts the located campus first, else 宝山→嘉定→延长", () => {
  const keys = ["baoshan", "jiading", "yanchang"];
  assert.deepEqual(orderCampusKeys(keys, null), keys);
  assert.deepEqual(orderCampusKeys(keys, "jiading"), ["jiading", "baoshan", "yanchang"]);
  // 定位校区不在列表里 / 未命中校区内 → 回退默认顺序
  assert.deepEqual(orderCampusKeys(keys, "yanchang"), ["yanchang", "baoshan", "jiading"]);
  assert.deepEqual(orderCampusKeys(["jiading"], null), ["jiading"]);
});

// ---------------------------------------------------------------------------
// release 派生数据
// ---------------------------------------------------------------------------

test("parsePlaceDining reads dining.floors and defaults to empty", () => {
  assert.deepEqual(parsePlaceDining("p1", {}), []);
  assert.deepEqual(parsePlaceDining("p1", { dining: null }), []);
  const parsed = parsePlaceDining("p1", {
    dining: {
      floors: [
        { levelCode: "F1", meals: ["breakfast", "lunner"], stallTypes: ["自选", "小炒"] },
        { levelCode: "F2", meals: ["lunner", "latenight"], stallTypes: ["面食"] },
      ],
    },
  });
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], { levelCode: "F1", meals: ["breakfast", "lunner"], stallTypes: ["自选", "小炒"] });
  assert.throws(
    () => parsePlaceDining("p1", { dining: { floors: [{ levelCode: "F1", meals: ["brunch"], stallTypes: [] }] } }),
    /meals/,
  );
  assert.throws(() => parsePlaceDining("p1", { dining: { floors: "F1" } }), /array/);
});

test("levelShortLabel normalizes level codes", () => {
  assert.equal(levelShortLabel("F1"), "1F");
  assert.equal(levelShortLabel("f12"), "12F");
  assert.equal(levelShortLabel("B1"), "B1");
  assert.equal(levelShortLabel("G"), "G");
});

test("floorMediaOf filters canonical detail.media by floorLevelCode", () => {
  const content = {
    detail: {
      facts: [],
      media: [
        { role: "gallery", url: "/api/public/media/a", floorLevelCode: "F1" },
        { role: "gallery", url: "/api/public/media/b", floorLevelCode: "F2" },
        { role: "cover", url: "/api/public/media/c" },
      ],
    },
  };
  assert.deepEqual(floorMediaOf("p1", content, "F1"), ["/api/public/media/a"]);
  assert.deepEqual(floorMediaOf("p1", content, "F3"), []);
  assert.throws(() => floorMediaOf("p1", { detail: { media: [{ url: "" }] } }, "F1"), /url/);
});

test("buildCanteens assembles canteens with floors, dining defaults and merchants", () => {
  const manifest = {
    places: [
      {
        id: "place_canteen_1",
        kindId: "canteen",
        campusId: "campus_bs",
        lifecycleStatus: "active",
        displayName: "益新食堂",
        content: {
          detail: { facts: [], media: [] },
          dining: { floors: [{ levelCode: "F2", meals: ["lunner"], stallTypes: ["智慧餐厅"] }] },
        },
      },
      {
        id: "place_canteen_2",
        kindId: "canteen",
        campusId: "campus_bs",
        lifecycleStatus: "temporarily_closed",
        displayName: "山明食堂",
        content: { detail: { facts: [], media: [] } },
      },
      {
        id: "place_lib",
        kindId: "library",
        campusId: "campus_bs",
        lifecycleStatus: "active",
        displayName: "图书馆",
        content: { detail: { facts: [], media: [] } },
      },
    ],
    floors: [
      { id: "floor_2", buildingPlaceId: "place_canteen_1", levelCode: "F2", levelOrder: 2, displayName: "二层", isPublic: 1, imageUrl: null },
      { id: "floor_1", buildingPlaceId: "place_canteen_1", levelCode: "F1", levelOrder: 1, displayName: "一层", isPublic: 1, imageUrl: "/api/public/media/plan1" },
      { id: "floor_hidden", buildingPlaceId: "place_canteen_1", levelCode: "F3", levelOrder: 3, displayName: "三层", isPublic: 0, imageUrl: null },
    ],
  };
  const campuses = [{ id: "campus_bs", key: "baoshan", label: "宝山校区" }];
  const merchantsByPlace = new Map([
    ["place_canteen_1", [
      { id: "m1", name: "KFC", openingHours: "全天", floorId: "floor_1" },
      { id: "m2", name: "咖啡", openingHours: "", floorId: null },
    ]],
  ]);
  const canteens = buildCanteens(manifest, campuses, merchantsByPlace);
  assert.equal(canteens.length, 2, "library 不进就餐页");
  const first = canteens[0];
  assert.equal(first.name, "益新食堂");
  assert.equal(first.campusKey, "baoshan");
  assert.equal(first.closed, false);
  // 楼层按 levelOrder 排序，isPublic=0 不进列表
  assert.deepEqual(first.floors.map((floor) => floor.floorId), ["floor_1", "floor_2"]);
  // 无 dining 数据的楼层默认早餐+午晚餐
  assert.deepEqual(first.floors[0].meals, ["breakfast", "lunner"]);
  // dining 覆盖餐别与品类
  assert.deepEqual(first.floors[1].meals, ["lunner"]);
  assert.deepEqual(first.floors[1].stallTypes, ["智慧餐厅"]);
  // 商家按 floorId 归层；没挂楼层的商家不出现在任何楼层
  assert.deepEqual(first.floors[0].merchants.map((m) => m.id), ["m1"]);
  assert.deepEqual(first.floors[1].merchants, []);
  // lifecycle 非 active → 整楼休息
  assert.equal(canteens[1].closed, true);
});

test("buildCanteens rejects a canteen without a released campus", () => {
  const manifest = {
    places: [{
      id: "place_canteen_1",
      kindId: "canteen",
      campusId: "campus_gone",
      lifecycleStatus: "active",
      displayName: "食堂",
      content: { detail: { facts: [], media: [] } },
    }],
    floors: [],
  };
  assert.throws(() => buildCanteens(manifest, [], new Map()), /campus/);
});
