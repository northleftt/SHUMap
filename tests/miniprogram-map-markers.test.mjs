// 小程序端地图标记层/命中测试纯逻辑自验（不经微信开发者工具，直接在 node 里跑）。
//
// 用 esbuild 把 miniprogram/miniprogram/lib/map/markers.ts 编成 cjs 后断言：
// 1. pointInGeometry：Polygon（含洞）/MultiPolygon/GeometryCollection/LineString；
// 2. buildMarkers 的可见性策略（campusDefault、不可用+whenUnavailable、校区过滤）；
// 3. buildBuildingShapes 按 sourceElementId 绑定底图要素、center 取 bbox 中心；
// 4. hitTest：容差内最近图钉优先、楼宇包含命中、嵌套 footprint 取最小、空点返回 null。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "tmp/map-test");
mkdirSync(outDir, { recursive: true });

execFileSync(join(repoRoot, "node_modules/.bin/esbuild"), [
  join(repoRoot, "miniprogram/miniprogram/lib/map/markers.ts"),
  "--bundle",
  "--format=cjs",
  "--platform=node",
  `--outfile=${join(outDir, "markers.cjs")}`,
]);

const require = createRequire(import.meta.url);
const markers = require(join(outDir, "markers.cjs"));

const VISIBLE = {
  default: true, searchable: true, filterable: true, search: true, filter: true, whenUnavailable: true,
};

function pointPoi(overrides) {
  return {
    id: "place:p1",
    poiKey: "place:p1",
    entityType: "place",
    name: "测试点",
    kindName: "地点",
    campusKey: "baoshan",
    markerPoint: { x: 100, y: 100 },
    markerIconKey: "generic",
    facilityOperationalStatus: null,
    visibility: { ...VISIBLE },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. pointInGeometry
// ---------------------------------------------------------------------------
{
  // 外环 0,0-100,100 顺时针，洞 20,20-40,40
  const polygon = {
    type: "Polygon",
    coordinates: [
      [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]],
      [[20, 20], [40, 20], [40, 40], [20, 40], [20, 20]],
    ],
  };
  assert.equal(markers.pointInGeometry(polygon, { x: 50, y: 50 }), true, "外环内应命中");
  assert.equal(markers.pointInGeometry(polygon, { x: 30, y: 30 }), false, "洞内不命中");
  assert.equal(markers.pointInGeometry(polygon, { x: 150, y: 50 }), false, "外环外不命中");

  const multi = {
    type: "MultiPolygon",
    coordinates: [
      [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
      [[[100, 100], [110, 100], [110, 110], [100, 110], [100, 100]]],
    ],
  };
  assert.equal(markers.pointInGeometry(multi, { x: 105, y: 105 }), true, "MultiPolygon 第二个面应命中");
  assert.equal(markers.pointInGeometry(multi, { x: 50, y: 50 }), false, "MultiPolygon 面间不命中");

  const collection = {
    type: "GeometryCollection",
    geometries: [
      { type: "LineString", coordinates: [[0, 0], [10, 10]] },
      polygon,
    ],
  };
  assert.equal(markers.pointInGeometry(collection, { x: 50, y: 50 }), true, "GeometryCollection 里的面应命中");
  assert.equal(
    markers.pointInGeometry({ type: "LineString", coordinates: [[0, 0], [10, 10]] }, { x: 5, y: 5 }),
    false,
    "LineString 不可命中",
  );
}

// ---------------------------------------------------------------------------
// 2. buildMarkers 可见性策略
// ---------------------------------------------------------------------------
{
  const pois = [
    pointPoi({ poiKey: "a", name: "A" }),
    pointPoi({ poiKey: "b", name: "B", visibility: { ...VISIBLE, default: false } }),
    pointPoi({
      poiKey: "c",
      name: "C",
      entityType: "facility",
      facilityOperationalStatus: "unavailable",
      visibility: { ...VISIBLE, whenUnavailable: false },
    }),
    pointPoi({
      poiKey: "d",
      name: "D",
      entityType: "facility",
      facilityOperationalStatus: "unavailable",
    }),
    pointPoi({ poiKey: "e", name: "E", campusKey: "jiading" }),
    // 楼宇（markerPoint 为 null）不出图钉
    pointPoi({ poiKey: "f", name: "F", entityType: "building", markerPoint: null }),
  ];
  const list = markers.buildMarkers(pois, "baoshan");
  const keys = list.map((marker) => marker.poiKey);
  assert.deepEqual(keys, ["a", "d"], "default:false / 不可用且不允许展示 / 外校区 / 楼宇都应被过滤");
  assert.equal(list[1].dimmed, true, "不可用但策略允许展示时应置灰");
}

// ---------------------------------------------------------------------------
// 3. buildBuildingShapes：按 sourceElementId 绑定底图要素
// ---------------------------------------------------------------------------
{
  const pois = [
    pointPoi({
      poiKey: "bldg1",
      name: "一号楼",
      kindName: "教学楼",
      entityType: "building",
      markerPoint: null,
      sourceElementId: "bldg_1",
    }),
    pointPoi({
      poiKey: "bldg2",
      name: "二号楼",
      entityType: "building",
      markerPoint: null,
      sourceElementId: "missing_element",
    }),
  ];
  const features = [
    {
      order: 0,
      sourceElementId: "bldg_1",
      stableKey: "bldg-1",
      geometry: { type: "Polygon", coordinates: [[[0, 0], [40, 0], [40, 20], [0, 20], [0, 0]]] },
      bbox: [0, 0, 40, 20],
      approximated: false,
      label: null,
    },
  ];
  const shapes = markers.buildBuildingShapes(pois, features, "baoshan");
  assert.equal(shapes.length, 1, "底图缺失要素的楼宇静默跳过");
  assert.deepEqual(shapes[0].center, { x: 20, y: 10 }, "center 取 bbox 中心");
}

// ---------------------------------------------------------------------------
// 4. hitTest
// ---------------------------------------------------------------------------
{
  const markerList = [
    { poiKey: "m1", entityType: "place", name: "M1", kindName: "地点", iconKey: "generic", x: 100, y: 100, dimmed: false },
    { poiKey: "m2", entityType: "place", name: "M2", kindName: "地点", iconKey: "generic", x: 200, y: 100, dimmed: false },
  ];
  const buildings = [
    {
      poiKey: "big",
      name: "大建筑",
      kindName: "教学楼",
      sourceElementId: "big",
      geometry: { type: "Polygon", coordinates: [[[0, 0], [300, 0], [300, 300], [0, 300], [0, 0]]] },
      bbox: [0, 0, 300, 300],
      center: { x: 150, y: 150 },
    },
    {
      poiKey: "small",
      name: "小建筑",
      kindName: "教学楼",
      sourceElementId: "small",
      geometry: { type: "Polygon", coordinates: [[[50, 50], [80, 50], [80, 80], [50, 80], [50, 50]]] },
      bbox: [50, 50, 80, 80],
      center: { x: 65, y: 65 },
    },
  ];

  // 容差内最近图钉
  const hitM2 = markers.hitTest(markerList, buildings, { x: 190, y: 100 }, 15);
  assert.equal(hitM2.kind, "marker");
  assert.equal(hitM2.marker.poiKey, "m2", "应命中最近的图钉");

  // 图钉落在楼宇上时图钉优先
  const hitOnBuilding = markers.hitTest(markerList, buildings, { x: 100, y: 100 }, 15);
  assert.equal(hitOnBuilding.kind, "marker", "图钉与楼宇重叠时图钉优先");

  // 容差外 → 楼宇；嵌套时取 bbox 最小的
  const hitSmall = markers.hitTest(markerList, buildings, { x: 60, y: 60 }, 5);
  assert.equal(hitSmall.kind, "building");
  assert.equal(hitSmall.building.poiKey, "small", "嵌套 footprint 取最具体的");

  const hitBig = markers.hitTest(markerList, buildings, { x: 250, y: 250 }, 5);
  assert.equal(hitBig.building.poiKey, "big");

  // 什么都不沾
  assert.equal(markers.hitTest(markerList, buildings, { x: 500, y: 500 }, 5), null, "空白处返回 null");
}

// ---------------------------------------------------------------------------
// 6. 管理端图钉档位：scale 随 marker 投影传递，markerPinStyles 换算内联尺寸
//    （worklet 反向缩放是统一通道，per-marker 系数只能走内联样式）
// ---------------------------------------------------------------------------
{
  const withScale = markers.buildMarkers([
    pointPoi({ poiKey: "s", markerScale: 1.35 }),
    pointPoi({ poiKey: "t" }),
  ], "baoshan");
  assert.equal(withScale[0].scale, 1.35, "管理端系数应投影到 marker");
  assert.equal(withScale[1].scale, 1, "缺省回落标准档");

  const std = markers.markerPinStyles(1);
  assert.match(std.pinStyle, /width: 44px/, "标准档 pin 44px");
  assert.match(std.pinStyle, /left: -22px/, "标准档锚点偏移 -22px");
  assert.match(std.pinStyle, /transform-origin: 22px 22px/, "锚点居中，反向缩放不漂");
  assert.match(std.circleStyle, /width: 32px/);
  assert.match(std.iconStyle, /width: 22px/);

  const large = markers.markerPinStyles(1.35);
  assert.match(large.pinStyle, /width: 59.4px/, "large 档 pin = 44 × 1.35");
  assert.match(large.pinStyle, /left: -29.7px/);
  assert.match(large.pinStyle, /transform-origin: 29.7px 29.7px/);
  assert.match(large.circleStyle, /width: 43.2px/, "圆 = 32 × 1.35");
  assert.match(large.iconStyle, /width: 29.7px/, "图标 = 22 × 1.35");

  const small = markers.markerPinStyles(0.72);
  assert.match(small.pinStyle, /width: 31.68px/);

  for (const dirty of [0, -1, NaN, Infinity]) {
    assert.match(markers.markerPinStyles(dirty).pinStyle, /width: 44px/, `脏系数 ${dirty} 应回落标准档`);
  }
}

console.log("miniprogram-map-markers: all assertions passed");
