// 小程序端运营事件纯逻辑自验（不经微信开发者工具，直接在 node 里跑）。
//
// 用 esbuild 把 lib/release/operations.ts + lib/geoGeometry.ts 编成 cjs 后断言：
// 1. parseGeoGeometryJson：Point/Polygon 正常、非法 JSON/未闭合环报错；
// 2. parseOperationsResponse：最小合法响应、字段违约报错；
// 3. activeOperations / buildEventOverlayItems / overlayItemsForCampus / overlayAnchor；
// 4. formatEventDateRange：区间与「起 · 长期」；
// 5. resolveEventTargetNames / eventsTargetingPoi（place/楼内设施/transit_stop）。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "tmp/map-test");
mkdirSync(outDir, { recursive: true });

for (const [entry, out] of [
  ["miniprogram/miniprogram/lib/geoGeometry.ts", "geo-geometry.cjs"],
  ["miniprogram/miniprogram/lib/release/operations.ts", "operations.cjs"],
]) {
  execFileSync(join(repoRoot, "node_modules/.bin/esbuild"), [
    join(repoRoot, entry),
    "--bundle",
    "--format=cjs",
    "--platform=node",
    `--outfile=${join(outDir, out)}`,
  ]);
}

const require = createRequire(import.meta.url);
const geo = require(join(outDir, "geo-geometry.cjs"));
const ops = require(join(outDir, "operations.cjs"));

// ---------------------------------------------------------------------------
// 1. parseGeoGeometryJson
// ---------------------------------------------------------------------------
{
  const point = geo.parseGeoGeometryJson('{"type":"Point","coordinates":[1,2]}', "t");
  assert.deepEqual(point, { type: "Point", coordinates: [1, 2] });
  const polygon = geo.parseGeoGeometryJson(
    '{"type":"Polygon","coordinates":[[[0,0],[10,0],[10,10],[0,0]]]}',
    "t",
  );
  assert.equal(polygon.type, "Polygon");
  assert.throws(() => geo.parseGeoGeometryJson("not json", "t"), /invalid JSON/);
  assert.throws(
    () => geo.parseGeoGeometryJson('{"type":"Polygon","coordinates":[[[0,0],[10,0],[10,10],[1,1]]]}', "t"),
    /must be closed/,
    "未闭合环应报契约错误",
  );
  assert.throws(
    () => geo.parseGeoGeometryJson('{"type":"Point","coordinates":[1,2],"extra":1}', "t"),
    /exactly type and coordinates/,
  );
}

// ---------------------------------------------------------------------------
// 2. parseOperationsResponse
// ---------------------------------------------------------------------------
function eventRow(overrides = {}) {
  return {
    id: "event_1",
    eventType: "maintenance",
    severity: "warning",
    operationalStatus: "scheduled",
    title: "施工",
    description: null,
    startsAt: "2026-07-19T16:00:00.000Z",
    expectedEndsAt: "2026-07-29T16:00:00.000Z",
    targets: [],
    updates: [],
    locations: [],
    ...overrides,
  };
}
{
  const events = ops.parseOperationsResponse({ items: [eventRow()] });
  assert.equal(events.length, 1);
  assert.equal(events[0].id, "event_1");
  assert.throws(() => ops.parseOperationsResponse({ items: [{}] }), /contract violation/i);
  assert.throws(() => ops.parseOperationsResponse({}), /items must be an array/);
  assert.throws(
    () => ops.parseOperationsResponse({ items: [eventRow({ eventType: "party" })] }),
    /eventType/,
    "未知 eventType 应报契约错误",
  );
  assert.throws(
    () => ops.parseOperationsResponse({ items: [eventRow({ locations: [{ id: "l1", geometryType: "Point", geometryJson: "{}", crs: "gcj02", campusId: null }] })] }),
    /crs must be svg_viewbox/,
  );
}

// ---------------------------------------------------------------------------
// 3. active / overlay items / 校区过滤 / 锚点
// ---------------------------------------------------------------------------
{
  const polygonLocation = {
    id: "loc_1",
    role: "impact_area",
    geometryType: "Polygon",
    geometryJson: '{"type":"Polygon","coordinates":[[[0,0],[10,0],[10,10],[0,0]]]}',
    crs: "svg_viewbox",
    campusId: "campus_baoshan",
  };
  const pointLocation = {
    id: "loc_2",
    role: "event_location",
    geometryType: "Point",
    geometryJson: '{"type":"Point","coordinates":[5,6]}',
    crs: "svg_viewbox",
    campusId: null,
  };
  const active = ops.parseOperationsResponse({
    items: [eventRow({ locations: [polygonLocation, pointLocation] })],
  });
  const ended = ops.parseOperationsResponse({
    items: [eventRow({ id: "event_old", operationalStatus: "resolved" })],
  });

  assert.deepEqual(ops.activeOperations([...active, ...ended]).map((e) => e.id), ["event_1"], "只保留 scheduled/active");

  const items = ops.buildEventOverlayItems(active);
  assert.equal(items.length, 2, "events × locations 展开");
  assert.equal(items[0].campusId, "campus_baoshan");
  assert.equal(items[1].campusId, null);
  assert.throws(
    () => ops.buildEventOverlayItems(ops.parseOperationsResponse({
      items: [eventRow({ locations: [{ ...pointLocation, geometryType: "LineString" }] })],
    })),
    /must match geometryJson.type/,
    "geometryType 与 geometryJson 不一致应报契约错误",
  );

  const baoshan = ops.overlayItemsForCampus(items, "campus_baoshan");
  assert.equal(baoshan.length, 2, "campusId 为空 = 通用，匹配 = 保留");
  const jiading = ops.overlayItemsForCampus(items, "campus_jiading");
  assert.deepEqual(jiading.map((item) => item.locationId), ["loc_2"], "其他校区只留通用项");

  assert.deepEqual(ops.overlayAnchor(items[1].geometry), [5, 6], "Point 用原坐标");
  const anchor = ops.overlayAnchor(items[0].geometry);
  // 环 [[0,0],[10,0],[10,10],[0,0]] 四点均值 = (5, 2.5)
  assert.ok(Math.abs(anchor[0] - 5) < 1e-9 && Math.abs(anchor[1] - 2.5) < 1e-9, "Polygon 用顶点质心");
  assert.deepEqual(
    ops.overlayAnchor({ type: "LineString", coordinates: [[0, 0], [10, 10]] }),
    [5, 5],
    "LineString 用顶点质心",
  );

  // 图钉只给点状「事件位置」；区域/路径靠轮廓 + eventRegionHit（对齐 Web 端）
  assert.deepEqual(ops.eventMarkerItems(items).map((item) => item.locationId), ["loc_2"]);
}

// ---------------------------------------------------------------------------
// 4. 文案：日期区间 / 类型 / 状态 / severity
// ---------------------------------------------------------------------------
{
  const event = ops.parseOperationsResponse({ items: [eventRow()] })[0];
  const range = ops.formatEventDateRange(event);
  assert.match(range, /^\d+月\d+日 - \d+月\d+日$/, "有 expectedEndsAt 显示区间");
  const open = { ...event, expectedEndsAt: null };
  assert.match(ops.formatEventDateRange(open), /^\d+月\d+日 起 · 长期$/, "无结束时间显示「起 · 长期」");
  assert.equal(ops.formatEventDateRange({ ...event, startsAt: "not-a-date" }), "时间待定");
  assert.equal(ops.eventTypeLabel("closure"), "关闭");
  assert.equal(ops.eventTypeLabel("activity"), "活动");
  assert.equal(ops.eventTypeLabel("notice"), "通知");
  assert.equal(ops.eventStatusLabel("scheduled"), "已排期");
  assert.equal(ops.severityLabel("critical"), "严重");
  assert.equal(ops.severityColor("warning"), "#f59e0b");
  // color：管理端自选颜色优先，未设置回落 severity 默认色（同 Web 端 eventColor）
  assert.equal(ops.eventColor({ severity: "warning", color: "#7c3aed" }), "#7c3aed");
  assert.equal(ops.eventColor({ severity: "warning", color: null }), "#f59e0b");
  const colored = ops.parseOperationsResponse({ items: [eventRow({ color: "#059669" })] })[0];
  assert.equal(colored.color, "#059669", "color 字段应透传");
  assert.equal(ops.parseOperationsResponse({ items: [eventRow()] })[0].color, null, "缺 color 字段按 null 处理");
  assert.match(ops.formatEventDay("2026-07-22T11:21:09.239Z"), /^\d+月\d+日$/);
}

// ---------------------------------------------------------------------------
// 5. resolveEventTargetNames / eventsTargetingPoi
// ---------------------------------------------------------------------------
{
  const building = {
    poiKey: "place_baoshan_lib",
    entityType: "building",
    entityId: "place_baoshan_lib",
    name: "本部图书馆",
    facilities: [{ id: "fac_1", displayName: "三楼饮水点" }],
    merchants: [{ id: "mch_1", name: "咖啡店" }],
  };
  const stop = {
    poiKey: "transit_stop:stop_1",
    entityType: "transit_stop",
    entityId: "stop_1",
    name: "本部北门站",
    facilities: [],
    merchants: [],
  };
  const facilityPoi = {
    poiKey: "facility:fac_9",
    entityType: "facility",
    entityId: "fac_9",
    name: "独立打印机",
    facilities: [],
    merchants: [],
  };
  const pois = [building, stop, facilityPoi];

  const names = ops.resolveEventTargetNames(
    [
      { targetType: "place", targetId: "place_baoshan_lib", impactType: "affected" },
      { targetType: "facility", targetId: "fac_1", impactType: "affected" },
      { targetType: "transit_stop", targetId: "stop_1", impactType: "affected" },
      { targetType: "floor", targetId: "floor_1", impactType: "affected" },
      { targetType: "place", targetId: "missing", impactType: "affected" },
    ],
    pois,
  );
  assert.deepEqual(
    names,
    [
      { key: "place:place_baoshan_lib", name: "本部图书馆" },
      { key: "facility:fac_1", name: "三楼饮水点" },
      { key: "transit_stop:stop_1", name: "本部北门站" },
      { key: "place:missing", name: "关联地点" },
    ],
    "place/楼内设施/站点解析名称；floor 跳过；缺失给兜底",
  );

  const targeting = (targets) => [eventRow({ targets })];
  assert.equal(ops.eventsTargetingPoi(targeting([{ targetType: "place", targetId: "place_baoshan_lib" }]), building).length, 1, "place target 命中楼宇");
  assert.equal(ops.eventsTargetingPoi(targeting([{ targetType: "place", targetId: "place_baoshan_lib" }]), stop).length, 0, "place target 不命中站点");
  assert.equal(ops.eventsTargetingPoi(targeting([{ targetType: "facility", targetId: "fac_1" }]), building).length, 1, "楼内设施 target 命中楼宇");
  assert.equal(ops.eventsTargetingPoi(targeting([{ targetType: "facility", targetId: "fac_9" }]), facilityPoi).length, 1, "独立设施 target 命中自己");
  assert.equal(ops.eventsTargetingPoi(targeting([{ targetType: "transit_stop", targetId: "stop_1" }]), stop).length, 1, "站点 target 命中站点");
  assert.equal(ops.eventsTargetingPoi(targeting([]), building).length, 0, "无 targets 不命中");
}

// ---------------------------------------------------------------------------
// 6. eventRegionHit：多边形（含洞）/ 线段距离命中；Point 不在这里命中（走锚点）
// ---------------------------------------------------------------------------
{
  const square = {
    event: { id: "event_sq" },
    geometry: {
      type: "Polygon",
      coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
    },
  };
  const holed = {
    event: { id: "event_hole" },
    geometry: {
      type: "Polygon",
      coordinates: [
        [[20, 0], [40, 0], [40, 20], [20, 20], [20, 0]],
        [[25, 5], [35, 5], [35, 15], [25, 15], [25, 5]],
      ],
    },
  };
  const lineItem = {
    event: { id: "event_line" },
    geometry: { type: "LineString", coordinates: [[0, 20], [10, 20], [10, 30]] },
  };
  const pointItem = {
    event: { id: "event_pt" },
    geometry: { type: "Point", coordinates: [5, 5] },
  };
  const items = [square, holed, lineItem, pointItem];

  assert.equal(ops.eventRegionHit(items, [5, 5], 0.5), "event_sq", "多边形内部命中");
  assert.equal(ops.eventRegionHit(items, [15, 5], 0.5), null, "多边形外部不命中");
  assert.equal(ops.eventRegionHit(items, [30, 2], 0.5), "event_hole", "外环内、洞外命中");
  assert.equal(ops.eventRegionHit(items, [30, 10], 0.5), null, "洞内不命中");
  assert.equal(ops.eventRegionHit(items, [5, 21], 2), "event_line", "线段 tolerance 内命中");
  assert.equal(ops.eventRegionHit(items, [5, 26], 2), null, "线段 tolerance 外不命中");
  assert.equal(ops.eventRegionHit([pointItem], [5, 5], 0.5), null, "Point 不在区域命中（锚点已覆盖）");
}

console.log("miniprogram-operations: all assertions passed");
