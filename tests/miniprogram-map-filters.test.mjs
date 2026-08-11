// 小程序端地图筛选纯逻辑自验（不经微信开发者工具，直接在 node 里跑）。
//
// 用 esbuild 把 miniprogram/miniprogram/lib/release/filters.ts 编成 cjs 后断言：
// 1. filterMapPois：多选 OR、searchOrder 排序与过滤；
// 2. shouldRenderPointPoi 决策树全分支（无 markerPoint / 不可用策略 / 选中态 /
//    搜索+筛选 / 仅搜索 / 仅筛选 / 默认可见性）。

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
  join(repoRoot, "miniprogram/miniprogram/lib/release/filters.ts"),
  "--bundle",
  "--format=cjs",
  "--platform=node",
  `--outfile=${join(outDir, "filters.cjs")}`,
]);

const require = createRequire(import.meta.url);
const filters = require(join(outDir, "filters.cjs"));

const VISIBLE = {
  default: true, searchable: true, filterable: true, search: true, filter: true, whenUnavailable: true,
};

function poi(overrides) {
  return {
    poiKey: "place:p1",
    entityType: "place",
    markerPoint: { x: 1, y: 1 },
    facilityOperationalStatus: null,
    filterGroups: [],
    visibility: { ...VISIBLE },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. filterMapPois
// ---------------------------------------------------------------------------
{
  const pois = [
    poi({ poiKey: "a", filterGroups: ["library"] }),
    poi({ poiKey: "b", filterGroups: ["canteen"] }),
    poi({ poiKey: "c", filterGroups: ["library", "canteen"] }),
    poi({ poiKey: "d", filterGroups: [] }),
  ];
  assert.deepEqual(
    filters.filterMapPois(pois, [], null).map((p) => p.poiKey),
    ["a", "b", "c", "d"],
    "无选中标签 = 全部命中",
  );
  assert.deepEqual(
    filters.filterMapPois(pois, ["library", "canteen"], null).map((p) => p.poiKey),
    ["a", "b", "c"],
    "多选 OR：命中任一标签即保留",
  );
  assert.deepEqual(
    filters.filterMapPois(pois, ["library"], null).map((p) => p.poiKey),
    ["a", "c"],
    "单选只保留命中项",
  );
  // searchOrder：按搜索顺序输出，且被筛选再过滤一次
  assert.deepEqual(
    filters.filterMapPois(pois, [], ["c", "a", "missing", "d"]).map((p) => p.poiKey),
    ["c", "a", "d"],
    "searchOrder 排序输出，缺失 key 跳过",
  );
  assert.deepEqual(
    filters.filterMapPois(pois, ["canteen"], ["c", "a", "b"]).map((p) => p.poiKey),
    ["c", "b"],
    "searchOrder + 筛选：保序过滤",
  );
}

// ---------------------------------------------------------------------------
// 2. shouldRenderPointPoi 决策树
// ---------------------------------------------------------------------------
{
  const base = { selectedPoiKey: null, queryActive: false, activeFilters: [], matched: false };

  // 无 markerPoint（楼宇）不出图钉，选中也不行
  assert.equal(filters.shouldRenderPointPoi({ ...base, poi: poi({ markerPoint: null }) }), false);
  assert.equal(
    filters.shouldRenderPointPoi({ ...base, poi: poi({ markerPoint: null }), selectedPoiKey: "place:p1" }),
    false,
    "楼宇选中也不出图钉",
  );

  // 不可用且策略不允许 → 隐藏（选中也不例外，与 Web 端分支顺序一致）
  const unavailable = poi({
    entityType: "facility",
    facilityOperationalStatus: "unavailable",
    visibility: { ...VISIBLE, whenUnavailable: false },
  });
  assert.equal(filters.shouldRenderPointPoi({ ...base, poi: unavailable }), false);
  assert.equal(
    filters.shouldRenderPointPoi({ ...base, poi: unavailable, selectedPoiKey: "place:p1" }),
    false,
    "不可用+策略不允许时选中也不显示",
  );

  // 选中态永远显示（即使默认不显示、筛选未命中）
  const hiddenFacility = poi({ visibility: { ...VISIBLE, default: false } });
  assert.equal(filters.shouldRenderPointPoi({ ...base, poi: hiddenFacility }), false, "默认不显示");
  assert.equal(
    filters.shouldRenderPointPoi({ ...base, poi: hiddenFacility, selectedPoiKey: "place:p1" }),
    true,
    "选中态永远显示",
  );

  // 搜索+筛选：四个开关 + matched 缺一不可
  const qf = { ...base, queryActive: true, activeFilters: ["library"], matched: true };
  assert.equal(filters.shouldRenderPointPoi({ ...qf, poi: poi({}) }), true);
  assert.equal(
    filters.shouldRenderPointPoi({ ...qf, poi: poi({ visibility: { ...VISIBLE, searchable: false } }) }),
    false,
    "searchable=false 搜索+筛选不显示",
  );
  assert.equal(
    filters.shouldRenderPointPoi({ ...qf, poi: poi({ visibility: { ...VISIBLE, filter: false } }) }),
    false,
    "filter=false 搜索+筛选不显示",
  );
  assert.equal(
    filters.shouldRenderPointPoi({ ...qf, matched: false, poi: poi({}) }),
    false,
    "未命中搜索+筛选不显示",
  );

  // 仅搜索：searchable && search && matched
  const q = { ...base, queryActive: true, matched: true };
  assert.equal(filters.shouldRenderPointPoi({ ...q, poi: poi({}) }), true);
  assert.equal(
    filters.shouldRenderPointPoi({ ...q, poi: poi({ visibility: { ...VISIBLE, search: false } }) }),
    false,
    "search=false 仅搜索不显示",
  );
  // 仅搜索不看 filterable/filter
  assert.equal(
    filters.shouldRenderPointPoi({
      ...q,
      poi: poi({ visibility: { ...VISIBLE, filterable: false, filter: false } }),
    }),
    true,
    "仅搜索不看 filterable/filter",
  );

  // 仅筛选：filterable && filter && matched（默认不显示的设施被筛选命中要显示）
  const f = { ...base, activeFilters: ["printing"], matched: true };
  assert.equal(filters.shouldRenderPointPoi({ ...f, poi: hiddenFacility }), true, "筛选命中时默认不显示也要显示");
  assert.equal(
    filters.shouldRenderPointPoi({ ...f, poi: poi({ visibility: { ...VISIBLE, filterable: false } }) }),
    false,
    "filterable=false 仅筛选不显示",
  );
  assert.equal(
    filters.shouldRenderPointPoi({ ...f, matched: false, poi: poi({}) }),
    false,
    "筛选未命中不显示",
  );

  // 无搜索无筛选：visibility.default
  assert.equal(filters.shouldRenderPointPoi({ ...base, poi: poi({}) }), true);
  assert.equal(filters.shouldRenderPointPoi({ ...base, poi: hiddenFacility }), false);
}

console.log("miniprogram-map-filters: all assertions passed");
