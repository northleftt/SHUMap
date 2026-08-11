// 地图页（Part 2 canvas 引擎）的小程序端回归（miniprogram-automator）。
//
// 前置：微信开发者工具已打开本项目并开启「服务端口」，且已执行：
//   /Applications/wechatwebdevtools.app/Contents/MacOS/cli \
//     auto --project /Users/wangyixuan/SHUMap/miniprogram --auto-port 9420
// 期望数据从云托管上游的 Worker 自定义域名读取，不依赖本地 D1。
//
// 做什么：
//   - node 侧用同一份 loader + markers/viewport 代码打线上后端，算出期望值
//     （默认校区的 markerCount/buildingShapeCount/初始窗口）；
//   - 连开发者工具 reLaunch 到 pages/map/map，监听 console/exception；
//   - 轮询 evaluate 读页面 data.report 对比；
//   - evaluate 直接调页面 handleTapAt 模拟点中一个图钉，验证命中+选中链路；
//   - 截图 tmp/map-test/map-page.png 供人工核对底图渲染（SVG 经 <image> 渲染）。

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
  ["miniprogram/miniprogram/lib/release/loader.ts", "loader.cjs"],
  ["miniprogram/miniprogram/lib/release/search.ts", "search.cjs"],
  ["miniprogram/miniprogram/lib/release/filters.ts", "filters.cjs"],
  ["miniprogram/miniprogram/lib/release/operations.ts", "operations.cjs"],
  ["miniprogram/miniprogram/lib/map/markers.ts", "markers.cjs"],
  ["miniprogram/miniprogram/lib/map/viewport.ts", "viewport.cjs"],
  ["miniprogram/miniprogram/lib/svg-geometry.ts", "svg-geometry.cjs"],
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
const loader = require(join(outDir, "loader.cjs"));
const search = require(join(outDir, "search.cjs"));
const filtersLib = require(join(outDir, "filters.cjs"));
const operationsLib = require(join(outDir, "operations.cjs"));
const markers = require(join(outDir, "markers.cjs"));
const viewport = require(join(outDir, "viewport.cjs"));
const svgGeometry = require(join(outDir, "svg-geometry.cjs"));
const automator = require("miniprogram-automator");
const sharp = require("sharp");

const API_BASE = process.env.SHUMAN_API_BASE ?? "https://shumap-api.kitahidari.com";
const WS_ENDPOINT = process.env.AUTOMATOR_WS ?? "ws://localhost:9420";

// ---------------------------------------------------------------------------
// 1. 期望值：node 侧跑同一份装配代码，直打线上后端
// ---------------------------------------------------------------------------
const expected = await loader.loadReleaseWithCache({
  storage: (() => {
    const map = new Map();
    return {
      get: (key) => (map.has(key) ? map.get(key) : null),
      set: (key, value) => map.set(key, value),
      remove: (key) => map.delete(key),
    };
  })(),
  fetchManifestRaw: async () => {
    const res = await fetch(`${API_BASE}/api/public/releases/current`);
    if (!res.ok) throw new Error(`releases/current ${res.status}`);
    return res.json();
  },
  fetchSvg: async (mapVersionId) => {
    const res = await fetch(`${API_BASE}/api/public/maps/${encodeURIComponent(mapVersionId)}/asset`);
    if (!res.ok) throw new Error(`map asset ${mapVersionId} ${res.status}`);
    return res.text();
  },
});
const campus = expected.campuses[0];
const expectedMarkers = markers.buildMarkers(expected.pois, campus.key);
const expectedShapes = markers.buildBuildingShapes(
  expected.pois,
  svgGeometry.parseSvgFeatures(campus.svgRaw),
  campus.key,
);
const expectedViewBox = svgGeometry.parseSvgViewBox(campus.svgRaw);
console.log("[expect] campus:", campus.key, "markers:", expectedMarkers.length, "shapes:", expectedShapes.length);

// ---------------------------------------------------------------------------
// 2. 小程序侧：reLaunch 地图页，读 report
// ---------------------------------------------------------------------------
const miniProgram = await automator.connect({ wsEndpoint: WS_ENDPOINT });
const consoleMessages = [];
const exceptions = [];
miniProgram.on("console", (msg) => consoleMessages.push(`${msg.type}: ${msg.args?.map(String).join(" ")}`));
miniProgram.on("exception", (err) => exceptions.push(String(err?.message ?? err)));

await miniProgram.evaluate(() => wx.clearStorageSync());
await miniProgram.reLaunch("/pages/map/map");

let state = null;
const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  state = await miniProgram.evaluate(() => {
    const pages = getCurrentPages();
    const page = pages[pages.length - 1];
    if (!page) return null;
    return {
      report: page.data.report ?? null,
      errorMessage: page.data.errorMessage ?? "",
      containerSize: page.containerSize ?? null,
      selected: page.data.selected ?? null,
    };
  });
  if (state?.report || state?.errorMessage) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

if (!state?.report) {
  console.error("[actual] 地图页加载失败或超时:", state?.errorMessage || "(timeout)");
  console.error("[exceptions]", exceptions);
  process.exit(1);
}
const report = state.report;
console.log("[actual] campus:", report.campusKey, "markers:", report.markerCount, "shapes:", report.buildingShapeCount);

// ---------------------------------------------------------------------------
// 3. 对比装配结果与初始窗口
// ---------------------------------------------------------------------------
assert.equal(report.releaseId, expected.releaseId);
assert.equal(report.campusKey, campus.key);
assert.equal(report.mapVersionId, campus.mapVersionId);
assert.equal(report.markerCount, expectedMarkers.length, "图钉数应与装配一致");
assert.equal(report.buildingShapeCount, expectedShapes.length, "楼宇命中几何数应与装配一致");
assert.equal(report.viewBox, `0 0 ${expectedViewBox.width} ${expectedViewBox.height}`);
assert.equal(report.filterHighlightActive, false, "初始态不应有筛选楼宇覆盖层");
assert.equal(report.filterHighlightedBuildingCount, 0, "初始态筛选楼宇数应为 0");
const baseAssetState = await miniProgram.evaluate(() => {
  const page = getCurrentPages()[getCurrentPages().length - 1];
  const assetUrl = page.data.assetUrl;
  let assetExists = false;
  try {
    assetExists = Boolean(assetUrl) && Boolean(wx.getFileSystemManager().statSync(assetUrl));
  } catch {
    assetExists = false;
  }
  return { assetUrl, assetExists, guideVisible: page.data.guideVisible };
});
assert.ok(baseAssetState.assetUrl, "校区底图应有本地资源路径");
assert.equal(baseAssetState.assetExists, true, "校区底图本地文件应存在");
assert.equal(typeof baseAssetState.guideVisible, "boolean", "指南入口应完成发布状态判断");

const expectedWindow = viewport.createInitialWindow(
  campus,
  { width: expectedViewBox.width, height: expectedViewBox.height },
  state.containerSize,
);
const round = (value) => Math.round(value * 100) / 100;
assert.deepEqual(
  report.window,
  {
    x: round(expectedWindow.x),
    y: round(expectedWindow.y),
    width: round(expectedWindow.width),
    height: round(expectedWindow.height),
  },
  "初始窗口应与 createInitialWindow 一致",
);
console.log("[ok] 初始窗口:", JSON.stringify(report.window));

// ---------------------------------------------------------------------------
// 4. 模拟点中一个图钉：evaluate 直调 handleTapAt（Skyline 页面 automator tap 不可用）
// ---------------------------------------------------------------------------
assert.ok(expectedMarkers.length > 0, "默认校区应有可点的图钉");
const target = expectedMarkers[0];
const win = report.window;
const localX = ((target.x - win.x) / win.width) * state.containerSize.width;
const localY = ((target.y - win.y) / win.height) * state.containerSize.height;
const selected = await miniProgram.evaluate(
  (args) => {
    const pages = getCurrentPages();
    const page = pages[pages.length - 1];
    page.handleTapAt(args.localX, args.localY, args.win.x, args.win.y, args.scale);
    return page.data.selected ?? null;
  },
  { localX, localY, win, scale: state.containerSize.width / win.width },
);
assert.ok(selected, "点中图钉应有选中态");
assert.equal(selected.poiKey, target.poiKey, "选中的应是目标图钉");
console.log("[ok] tap 命中:", selected.poiKey, selected.name);

// 选中后窗口应向 focusPointWindow 目标移动（动画进行时不等终态，只验证选中卡片在）
await new Promise((resolve) => setTimeout(resolve, 600));
const afterReport = await miniProgram.evaluate(() => {
  const pages = getCurrentPages();
  return pages[pages.length - 1].data.report;
});
assert.equal(afterReport.selectedPoiKey, target.poiKey, "report 应反映选中态");
assert.equal(afterReport.selectedMarkerPoiKey, target.poiKey, "点状 POI 选中应标在图钉上");
assert.equal(afterReport.highlightActive, false, "点状 POI 不应有楼宇高亮覆盖层");

// ---------------------------------------------------------------------------
// 4.5 手势链路（JS 触摸事件方案）：evaluate 直调事件处理器做真端到端验证
// ---------------------------------------------------------------------------
const geom = await miniProgram.evaluate(() => {
  const pages = getCurrentPages();
  const page = pages[pages.length - 1];
  return { left: page.containerLeft, top: page.containerTop };
});
const viewBoxSize = { width: expectedViewBox.width, height: expectedViewBox.height };
const container = state.containerSize;
const near = (a, b, label) =>
  assert.ok(Math.abs(a - b) <= 0.5, `${label}: 实际 ${a} 期望 ${b}`);
function assertWindow(actual, expected, label) {
  near(actual.x, expected.x, `${label}.x`);
  near(actual.y, expected.y, `${label}.y`);
  near(actual.width, expected.width, `${label}.width`);
  near(actual.height, expected.height, `${label}.height`);
}
// 直读 shared 变量的实时视口：tap 后 selectAt 走 timing 动画，report.window
// 在动画进行中是中间值，读 data.report 会得到过期窗口导致期望算错。
const readWindow = () =>
  miniProgram.evaluate(() => {
    const pages = getCurrentPages();
    return pages[pages.length - 1].currentWindow();
  });
// 等 tap 定位动画（timing）跑完，避免 beginWin 读到动画中间值
await new Promise((resolve) => setTimeout(resolve, 600));

// 模拟 pan：单指 (200,400) → (250,360)，期望 = panWindowBy(before, +50, -40)
{
  const before = await readWindow();
  await miniProgram.evaluate(() => {
    const page = getCurrentPages()[getCurrentPages().length - 1];
    page.onSurfaceTouchStart({ touches: [{ clientX: 200, clientY: 400 }] });
    page.onSurfaceTouchMove({ touches: [{ clientX: 250, clientY: 360 }] });
    page.onSurfaceTouchEnd({ touches: [] });
    page.updateReport(); // 触摸处理器直写 shared，report 需要显式刷新
  });
  const actual = await readWindow();
  const expectedPan = viewport.panWindowBy(before, 50, -40, container, viewBoxSize, campus.edgePaddingRatio);
  assertWindow(actual, { x: expectedPan.x, y: expectedPan.y, width: expectedPan.width, height: expectedPan.height }, "pan");
  console.log("[ok] 模拟 pan:", JSON.stringify(actual));
}

// 模拟 pinch：双指间距 40 → 100（2.5x），期望 = zoomWindowAt + min/max clamp（node 侧同式）
{
  const before = await readWindow();
  await miniProgram.evaluate(() => {
    const page = getCurrentPages()[getCurrentPages().length - 1];
    page.onSurfaceTouchStart({ touches: [{ clientX: 180, clientY: 400 }, { clientX: 220, clientY: 400 }] });
    page.onSurfaceTouchMove({ touches: [{ clientX: 150, clientY: 400 }, { clientX: 250, clientY: 400 }] });
    page.onSurfaceTouchEnd({ touches: [] });
    page.updateReport();
  });
  const actual = await readWindow();
  const beginScale = container.width / before.width;
  const nextScale = viewport.clamp(
    beginScale * 2.5,
    viewport.getMinScale(campus, viewBoxSize, container),
    viewport.MAX_ZOOM_SCALE,
  );
  const focal = { x: 200 - geom.left, y: 400 - geom.top };
  const expectedPinch = viewport.zoomWindowAt(before, focal, nextScale, container, viewBoxSize, campus.edgePaddingRatio);
  assertWindow(actual, expectedPinch, "pinch");
  console.log("[ok] 模拟 pinch (2.5x):", JSON.stringify(actual));
}

// 模拟 tap：bindtap detail.x/y 是页面坐标，换算后应命中同一图钉。
// 真实 tap 事件序列是 touchstart → touchend（无位移）→ tap；前面的 pan/pinch
// 模拟会把 tapSuppress 置位，这里按真实序列走，顺带验证无位移手势不抑制 tap。
{
  const win = await readWindow();
  const localX = ((target.x - win.x) / win.width) * container.width;
  const localY = ((target.y - win.y) / win.height) * container.height;
  const tapped = await miniProgram.evaluate(
    (args) => {
      const page = getCurrentPages()[getCurrentPages().length - 1];
      page.onSurfaceTouchStart({ touches: [{ clientX: args.x, clientY: args.y }] });
      page.onSurfaceTouchEnd({ touches: [] });
      page.onSurfaceTap({ detail: { x: args.x, y: args.y } });
      return page.data.selected ?? null;
    },
    { x: localX + geom.left, y: localY + geom.top },
  );
  assert.ok(tapped, "onSurfaceTap 应有选中态");
  assert.equal(tapped.poiKey, target.poiKey, "onSurfaceTap 命中的应是目标图钉");
  console.log("[ok] 模拟 tap 命中:", tapped.poiKey, tapped.name);
  await miniProgram.evaluate(() => getCurrentPages()[getCurrentPages().length - 1].clearSelection());
}

// 拖动后的 bindtap 应被抑制（拖完地图误开 POI 的回归）
{
  const win = await readWindow();
  const localX = ((target.x - win.x) / win.width) * container.width;
  const localY = ((target.y - win.y) / win.height) * container.height;
  const suppressed = await miniProgram.evaluate(
    (args) => {
      const page = getCurrentPages()[getCurrentPages().length - 1];
      page.onSurfaceTouchStart({ touches: [{ clientX: args.x, clientY: args.y }] });
      page.onSurfaceTouchMove({ touches: [{ clientX: args.x + 30, clientY: args.y }] });
      page.onSurfaceTouchEnd({ touches: [] });
      page.onSurfaceTap({ detail: { x: args.x + 30, y: args.y } });
      return page.data.selected ?? null;
    },
    { x: localX + geom.left, y: localY + geom.top },
  );
  assert.equal(suppressed, null, "拖动后的 tap 应被抑制（不应有选中态）");
  console.log("[ok] 拖动后 tap 抑制生效");
}

// ---------------------------------------------------------------------------
// 4.6 楼宇选中：footprint 高亮覆盖层（SVG 注入选中 CSS 写本地临时文件）
// 点本部图书馆 footprint 中心 → 断言 highlightActive/详情 sheet → 截图人工核对
// 高亮渲染；再点空白处 → 断言高亮清除。
// ---------------------------------------------------------------------------
{
  const building =
    expectedShapes.find((shape) => shape.poiKey === "place_baoshan_main-library") ?? expectedShapes[0];
  assert.ok(building, "默认校区应有楼宇命中几何");
  const win = await readWindow();
  const scale = container.width / win.width;
  const localX = ((building.center.x - win.x) / win.width) * container.width;
  const localY = ((building.center.y - win.y) / win.height) * container.height;
  await miniProgram.evaluate(
    (args) => {
      const page = getCurrentPages()[getCurrentPages().length - 1];
      page.handleTapAt(args.localX, args.localY, args.win.x, args.win.y, args.scale);
    },
    { localX, localY, win, scale },
  );
  // 等 focus 动画 + 覆盖层 <image> 加载本地 SVG
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const buildingReport = await miniProgram.evaluate(() => {
    const page = getCurrentPages()[getCurrentPages().length - 1];
    return { report: page.data.report, highlightUrl: page.data.highlightUrl };
  });
  assert.equal(buildingReport.report.selectedPoiKey, building.poiKey, "选中的应是目标楼宇");
  assert.equal(buildingReport.report.highlightActive, true, "楼宇选中应激活高亮覆盖层");
  assert.ok(buildingReport.highlightUrl, "highlightUrl 应非空");
  assert.equal(buildingReport.report.selectedMarkerPoiKey, null, "楼宇没有图钉，不应有选中图钉");
  assert.equal(buildingReport.report.detailOpen, true, "楼宇详情 sheet 应打开");
  console.log("[ok] 楼宇选中高亮:", building.poiKey, building.name);
  await miniProgram.screenshot({ path: join(outDir, "map-highlight.png") });
  console.log("[ok] 截图: tmp/map-test/map-highlight.png（人工核对浅蓝填充+蓝描边）");

  // 点空白处：node 侧用同一份 hitTest 找一个不命中任何图钉/楼宇的世界坐标
  const TAP_TOLERANCE_PX = 24;
  let blank = null;
  for (let gy = 0; gy <= 10 && !blank; gy += 1) {
    for (let gx = 0; gx <= 10 && !blank; gx += 1) {
      const candidate = {
        x: expectedViewBox.width * (gx / 10),
        y: expectedViewBox.height * (gy / 10),
      };
      if (!markers.hitTest(expectedMarkers, expectedShapes, candidate, TAP_TOLERANCE_PX / scale)) {
        blank = candidate;
      }
    }
  }
  assert.ok(blank, "viewBox 内应能找到空白点");
  const win2 = await readWindow();
  await miniProgram.evaluate(
    (args) => {
      const page = getCurrentPages()[getCurrentPages().length - 1];
      page.handleTapAt(args.localX, args.localY, args.win.x, args.win.y, args.scale);
    },
    {
      localX: ((blank.x - win2.x) / win2.width) * container.width,
      localY: ((blank.y - win2.y) / win2.height) * container.height,
      win: win2,
      scale: container.width / win2.width,
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  const clearedReport = await miniProgram.evaluate(() => {
    const page = getCurrentPages()[getCurrentPages().length - 1];
    return page.data.report;
  });
  assert.equal(clearedReport.highlightActive, false, "点空白应清除高亮覆盖层");
  assert.equal(clearedReport.selectedPoiKey, null, "点空白应清除选中态");
  assert.equal(clearedReport.selectedMarkerPoiKey, null, "点空白应清除选中图钉");
  console.log("[ok] 点空白清除高亮");
}

// ---------------------------------------------------------------------------
// 4.65 主详情媒体：相对 API URL 经云托管下载并写入本地文件
// ---------------------------------------------------------------------------
{
  const mediaPoi = expected.pois.find(
    (poi) => poi.campusKey === campus.key
      && poi.detail.media.some((item) => item.url.startsWith("/") && !item.floorLevelCode),
  );
  if (mediaPoi) {
    const expectedMedia = mediaPoi.detail.media.filter((item) => item.url.trim() && !item.floorLevelCode);
    await miniProgram.evaluate(
      (poiKey) => getCurrentPages()[getCurrentPages().length - 1].openDetailByKey(poiKey, null),
      mediaPoi.poiKey,
    );
    let mediaState = [];
    const mediaDeadline = Date.now() + 20_000;
    while (Date.now() < mediaDeadline) {
      mediaState = await miniProgram.evaluate(() => {
        const rows = getCurrentPages()[getCurrentPages().length - 1].data.detail?.media ?? [];
        const fs = wx.getFileSystemManager();
        return rows.map((row) => {
          let exists = false;
          try {
            exists = Boolean(row.url) && Boolean(fs.statSync(row.url));
          } catch {
            exists = false;
          }
          return { sourceUrl: row.sourceUrl, url: row.url, local: row.local, exists };
        });
      });
      if (
        mediaState.length === expectedMedia.length
        && mediaState.every((item) => !item.sourceUrl.startsWith("/") || (item.local && item.exists))
      ) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(mediaState.length, expectedMedia.length, "详情媒体数应与 release 一致");
    assert.ok(
      mediaState.every((item) => !item.sourceUrl.startsWith("/") || (item.local && item.exists)),
      "相对详情媒体应全部写入本地文件",
    );
    console.log("[ok] 详情媒体本地化:", mediaPoi.poiKey, mediaState.length, "张");
    await miniProgram.evaluate(() => getCurrentPages()[getCurrentPages().length - 1].closePoi());
  } else {
    console.log("[skip] 默认校区当前没有主详情媒体，跳过本地化断言");
  }
}

// ---------------------------------------------------------------------------
// 4.7 图层筛选 + 运营事件（Part 3 增量）
// node 侧用同一份 filters/operations 纯函数 + 线上 /api/public/operations 算期望值，
// 页面侧 evaluate 直调 toggleFilter/toggleLayerPanel/handleTapAt 核对 report。
// ---------------------------------------------------------------------------
{
  // 运营事件期望值（与页面同一接口；失败则跳过事件断言，筛选断言不受影响）
  let expectedEventItems = [];
  try {
    const res = await fetch(`${API_BASE}/api/public/operations`);
    if (!res.ok) throw new Error(`operations ${res.status}`);
    const allEvents = operationsLib.parseOperationsResponse(await res.json());
    const activeEvents = operationsLib.activeOperations(allEvents);
    expectedEventItems = operationsLib.overlayItemsForCampus(
      operationsLib.buildEventOverlayItems(activeEvents),
      campus.id,
    );
  } catch (error) {
    console.log("[skip] operations 拉取失败，事件断言跳过:", String(error));
  }

  // 等页面 loadOperations 完成（boot 后异步拉取）
  const eventDeadline = Date.now() + 20_000;
  let eventReport = null;
  while (Date.now() < eventDeadline) {
    eventReport = await miniProgram.evaluate(() => {
      const page = getCurrentPages()[getCurrentPages().length - 1];
      return page.data.report;
    });
    if (eventReport.eventCount === expectedEventItems.length) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.equal(eventReport.eventCount, expectedEventItems.length, "事件 overlay 数应与 node 侧一致");
  assert.equal(eventReport.eventMarkerCount, expectedEventItems.length, "eventsOn 默认开，marker 数 = overlay 数");
  if (expectedEventItems.length > 0) {
    console.log("[ok] 事件 overlay:", eventReport.eventCount, "条（marker + 轮廓覆盖层）");
    await miniProgram.screenshot({ path: join(outDir, "map-events.png") });
  } else {
    console.log("[skip] 线上当前无本校区 active 事件，事件 marker/摘要卡断言跳过");
  }

  // 筛选：选择同时命中楼宇且会改变图钉数的标签，核对图钉与 footprint 覆盖层
  const campusPois = expected.pois.filter((poi) => poi.campusKey === campus.key);
  const shapePoiKeys = new Set(expectedShapes.map((shape) => shape.poiKey));
  const filterDef = expected.filters.find((filter) => {
    const matched = filtersLib.filterMapPois(campusPois, [filter.key], null);
    const hasBuilding = matched.some(
      (poi) => poi.entityType === "building" && poi.sourceElementId && shapePoiKeys.has(poi.poiKey),
    );
    const filteredMarkers = markers.buildVisibleMarkers(expected.pois, campus.key, {
      selectedPoiKey: null,
      queryActive: false,
      activeFilters: [filter.key],
      matchedKeys: new Set(matched.map((poi) => poi.poiKey)),
    });
    return hasBuilding && filteredMarkers.length !== eventReport.markerCount;
  });
  assert.ok(filterDef, "默认校区应有可命中楼宇且改变图钉数的筛选标签");
  const expectedMatched = filtersLib.filterMapPois(campusPois, [filterDef.key], null);
  const expectedMatchedBuildings = expectedMatched.filter(
    (poi) => poi.entityType === "building" && poi.sourceElementId,
  );
  const expectedMatchedBuildingIds = [...new Set(expectedMatchedBuildings.map((poi) => poi.sourceElementId))].sort();
  const detailBuilding = expectedMatchedBuildings.find((poi) => shapePoiKeys.has(poi.poiKey));
  assert.ok(detailBuilding, "筛选结果中应有可点中的楼宇");
  const detailBuildingShape = expectedShapes.find((shape) => shape.poiKey === detailBuilding.poiKey);
  assert.ok(detailBuildingShape, "筛选楼宇应有命中几何");
  const expectedFilteredMarkers = markers.buildVisibleMarkers(expected.pois, campus.key, {
    selectedPoiKey: null,
    queryActive: false,
    activeFilters: [filterDef.key],
    matchedKeys: new Set(expectedMatched.map((poi) => poi.poiKey)),
  });
  assert.ok(expectedFilteredMarkers.length !== eventReport.markerCount, "筛选项应改变图钉数");
  // 把一栋命中楼宇放到抽屉上方的可见区域，保存同视口基线图供像素级断言。
  const filterScreenshotState = await miniProgram.evaluate((center) => {
    const page = getCurrentPages()[getCurrentPages().length - 1];
    const width = Math.min(220, page.viewBoxSize.width);
    const scale = page.containerSize.width / width;
    const targetScreenY = Math.min(140, Math.max(72, page.data.sheetTop * 0.4));
    const window = {
      x: center.x - width / 2,
      y: center.y - targetScreenY / scale,
      width,
      height: page.containerSize.height / scale,
    };
    page.setWindowDirect(window);
    page.updateReport();
    return { sheetTop: page.data.sheetTop, containerSize: page.containerSize, window };
  }, detailBuildingShape.center);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const filterBeforePath = join(outDir, "map-filter-before.png");
  const filterActivePath = join(outDir, "map-filter-active.png");
  await miniProgram.screenshot({ path: filterBeforePath });
  await miniProgram.evaluate((key) => {
    const page = getCurrentPages()[getCurrentPages().length - 1];
    page.toggleFilter(key);
  }, filterDef.key);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const filterState = await miniProgram.evaluate((sourceElementIds) => {
    const page = getCurrentPages()[getCurrentPages().length - 1];
    const filterHighlightUrl = page.data.filterHighlightUrl;
    let filterFileExists = false;
    let hasWebMatchStyle = false;
    let hasAllBuildingSelectors = false;
    try {
      const fs = wx.getFileSystemManager();
      filterFileExists = Boolean(filterHighlightUrl) && Boolean(fs.statSync(filterHighlightUrl));
      const svg = filterFileExists ? String(fs.readFileSync(filterHighlightUrl, "utf8")) : "";
      hasWebMatchStyle = svg.includes("fill: rgba(215, 232, 243, 0.95) !important")
        && svg.includes("stroke: #1e80c1 !important")
        && svg.includes("stroke-width: 1.8 !important");
      hasAllBuildingSelectors = sourceElementIds.every((id) => svg.includes(`#${id} path`));
    } catch {
      filterFileExists = false;
    }
    return {
      report: page.data.report,
      filterHighlightUrl,
      filterFileExists,
      hasWebMatchStyle,
      hasAllBuildingSelectors,
    };
  }, expectedMatchedBuildingIds);
  const filterReport = filterState.report;
  assert.deepEqual(filterReport.activeFilters, [filterDef.key], "report 应反映 activeFilters");
  assert.equal(
    filterReport.markerCount,
    expectedFilteredMarkers.length,
    `筛选「${filterDef.label}」后图钉数应与 node 侧一致`,
  );
  assert.equal(filterReport.filterHighlightActive, true, "筛选命中楼宇后应激活 footprint 覆盖层");
  assert.equal(
    filterReport.filterHighlightedBuildingCount,
    expectedMatchedBuildingIds.length,
    "筛选高亮楼宇数应与 node 侧筛选结果一致",
  );
  assert.ok(filterState.filterHighlightUrl, "筛选楼宇覆盖层应有本地文件路径");
  assert.equal(filterState.filterFileExists, true, "筛选楼宇覆盖层本地文件应存在");
  assert.equal(filterState.hasWebMatchStyle, true, "筛选覆盖层应使用网页端 data-match 样式");
  assert.equal(filterState.hasAllBuildingSelectors, true, "筛选覆盖层应包含全部命中楼宇选择器");
  console.log(
    "[ok] 筛选 chip:",
    filterDef.label,
    `图钉 ${eventReport.markerCount} → ${filterReport.markerCount}，楼宇 ${expectedMatchedBuildingIds.length}`,
  );
  const beforePixels = await sharp(filterBeforePath).raw().toBuffer({ resolveWithObject: true });
  let changedMapPixels = 0;
  let changedTargetPixels = 0;
  const renderDeadline = Date.now() + 5000;
  do {
    await miniProgram.screenshot({ path: filterActivePath });
    const activePixels = await sharp(filterActivePath).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual(activePixels.info, beforePixels.info, "筛选前后截图尺寸与通道应一致");
    const pixelScale = activePixels.info.height / filterScreenshotState.containerSize.height;
    const visibleMapHeight = Math.min(
      activePixels.info.height,
      Math.max(1, Math.floor(filterScreenshotState.sheetTop * pixelScale)),
    );
    const worldScale = filterScreenshotState.containerSize.width / filterScreenshotState.window.width;
    const screenshotScaleX = activePixels.info.width / filterScreenshotState.containerSize.width;
    const screenshotScaleY = activePixels.info.height / filterScreenshotState.containerSize.height;
    const [minWorldX, minWorldY, maxWorldX, maxWorldY] = detailBuildingShape.bbox;
    const targetBounds = {
      left: Math.max(0, Math.floor((minWorldX - filterScreenshotState.window.x) * worldScale * screenshotScaleX) - 8),
      top: Math.max(0, Math.floor((minWorldY - filterScreenshotState.window.y) * worldScale * screenshotScaleY) - 8),
      right: Math.min(
        activePixels.info.width,
        Math.ceil((maxWorldX - filterScreenshotState.window.x) * worldScale * screenshotScaleX) + 8,
      ),
      bottom: Math.min(
        visibleMapHeight,
        Math.ceil((maxWorldY - filterScreenshotState.window.y) * worldScale * screenshotScaleY) + 8,
      ),
    };
    changedMapPixels = 0;
    changedTargetPixels = 0;
    for (let y = 0; y < visibleMapHeight; y += 1) {
      for (let x = 0; x < activePixels.info.width; x += 1) {
        const offset = (y * activePixels.info.width + x) * activePixels.info.channels;
        const difference =
          Math.abs(beforePixels.data[offset] - activePixels.data[offset])
          + Math.abs(beforePixels.data[offset + 1] - activePixels.data[offset + 1])
          + Math.abs(beforePixels.data[offset + 2] - activePixels.data[offset + 2]);
        if (difference > 12) {
          changedMapPixels += 1;
          if (
            x >= targetBounds.left && x < targetBounds.right
            && y >= targetBounds.top && y < targetBounds.bottom
          ) changedTargetPixels += 1;
        }
      }
    }
    if (changedMapPixels > 100 && changedTargetPixels > 20) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < renderDeadline);
  assert.ok(changedMapPixels > 100, "筛选覆盖层应让抽屉上方的地图像素发生可见变化");
  assert.ok(changedTargetPixels > 20, "目标命中楼宇区域应发生可见像素变化");
  console.log(
    "[ok] 筛选楼宇覆盖层实际渲染:",
    changedMapPixels,
    "个地图像素变化，目标楼宇区域",
    changedTargetPixels,
  );

  // 网页端详情态隐藏 data-match；关闭详情后按当前筛选恢复覆盖层
  await miniProgram.evaluate((poiKey) => {
    const page = getCurrentPages()[getCurrentPages().length - 1];
    const poi = page.poiByKey.get(poiKey);
    if (poi) page.openPoi(poi, null);
  }, detailBuilding.poiKey);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const detailFilterReport = await miniProgram.evaluate(() => {
    const page = getCurrentPages()[getCurrentPages().length - 1];
    return page.data.report;
  });
  assert.equal(detailFilterReport.detailOpen, true, "筛选楼宇详情应打开");
  assert.equal(detailFilterReport.filterHighlightActive, false, "POI 详情态应隐藏筛选楼宇覆盖层");
  assert.equal(detailFilterReport.filterHighlightedBuildingCount, 0, "详情态展示中的筛选楼宇数应为 0");
  await miniProgram.evaluate(() => {
    const page = getCurrentPages()[getCurrentPages().length - 1];
    page.closePoi();
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const restoredFilterState = await miniProgram.evaluate(() => {
    const page = getCurrentPages()[getCurrentPages().length - 1];
    const filterHighlightUrl = page.data.filterHighlightUrl;
    let fileExists = false;
    try {
      fileExists = Boolean(filterHighlightUrl)
        && Boolean(wx.getFileSystemManager().statSync(filterHighlightUrl));
    } catch {
      fileExists = false;
    }
    return { report: page.data.report, filterHighlightUrl, fileExists };
  });
  assert.equal(restoredFilterState.report.detailOpen, false, "关闭楼宇详情后详情态应清除");
  assert.equal(restoredFilterState.report.filterHighlightActive, true, "关闭详情后应恢复筛选楼宇覆盖层");
  assert.equal(
    restoredFilterState.report.filterHighlightedBuildingCount,
    expectedMatchedBuildingIds.length,
    "关闭详情后应恢复全部筛选楼宇",
  );
  assert.equal(restoredFilterState.fileExists, true, "恢复后的筛选楼宇覆盖层文件应存在");
  console.log("[ok] 筛选楼宇详情态隐藏，关闭详情后恢复");

  // 搜索面板内标签筛选：无 query 时结果 = 筛选命中的 POI 列表（设施要求 filterable）
  const expectedFilterRows = expectedMatched.filter(
    (poi) => poi.entityType !== "facility" || poi.visibility.filterable,
  );
  await miniProgram.evaluate(() => {
    const page = getCurrentPages()[getCurrentPages().length - 1];
    page.openSearchPanel();
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const panelReport = await miniProgram.evaluate(() => {
    const page = getCurrentPages()[getCurrentPages().length - 1];
    return { report: page.data.report, searchOpen: page.data.searchOpen };
  });
  assert.equal(panelReport.searchOpen, true);
  assert.equal(panelReport.report.filterRowCount, expectedFilterRows.length, "筛选结果列表应与 node 侧一致");
  await miniProgram.screenshot({ path: join(outDir, "map-search-filter-chips.png") });
  console.log("[ok] 搜索面板标签筛选:", panelReport.report.filterRowCount, "条筛选结果");
  await miniProgram.evaluate(() => {
    const page = getCurrentPages()[getCurrentPages().length - 1];
    page.closeSearchPanel();
    page.resetFilters();
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const clearedFilterState = await miniProgram.evaluate((previousPath) => {
    const page = getCurrentPages()[getCurrentPages().length - 1];
    let previousFileExists = false;
    try {
      previousFileExists = Boolean(previousPath)
        && Boolean(wx.getFileSystemManager().statSync(previousPath));
    } catch {
      previousFileExists = false;
    }
    return {
      report: page.data.report,
      filterHighlightUrl: page.data.filterHighlightUrl,
      previousFileExists,
    };
  }, restoredFilterState.filterHighlightUrl);
  assert.equal(clearedFilterState.filterHighlightUrl, "", "重置筛选后覆盖层路径应清空");
  assert.equal(clearedFilterState.report.filterHighlightActive, false, "重置筛选后覆盖层应关闭");
  assert.equal(clearedFilterState.report.filterHighlightedBuildingCount, 0, "重置筛选后高亮楼宇数应清零");
  assert.equal(clearedFilterState.previousFileExists, false, "重置筛选后应清理旧覆盖层文件");
  console.log("[ok] 重置筛选清空楼宇覆盖层及临时文件");

  // 图层浮卡：开浮卡 → chip toggle 只改筛选不弹搜索面板 → 运营事件开关显隐
  await miniProgram.evaluate(() => {
    const page = getCurrentPages()[getCurrentPages().length - 1];
    page.toggleLayerPanel();
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await miniProgram.screenshot({ path: join(outDir, "map-layer-panel.png") });
  const layerReport = await miniProgram.evaluate((key) => {
    const page = getCurrentPages()[getCurrentPages().length - 1];
    const before = page.data.report;
    page.onLayerFilterTap({ currentTarget: { dataset: { key } } });
    return { before, searchOpen: page.data.searchOpen, activeFilters: page.data.activeFilters };
  }, filterDef.key);
  assert.equal(layerReport.before.layerPanelOpen, true, "图层浮卡应打开");
  assert.equal(layerReport.searchOpen, false, "浮卡 chip toggle 不应弹搜索面板");
  assert.deepEqual(layerReport.activeFilters, [filterDef.key], "浮卡 chip 共享同一份 activeFilters");
  console.log("[ok] 图层浮卡 chip toggle（不弹搜索面板）");
  // 运营事件开关：关 → marker 清空；开 → 恢复
  const eventsToggled = await miniProgram.evaluate(() => {
    const page = getCurrentPages()[getCurrentPages().length - 1];
    page.toggleEvents();
    const off = page.data.report.eventMarkerCount;
    page.toggleEvents();
    const on = page.data.report.eventMarkerCount;
    page.resetFilters();
    page.toggleLayerPanel();
    return { off, on };
  });
  assert.equal(eventsToggled.off, 0, "事件开关关闭后 marker 应清空");
  assert.equal(eventsToggled.on, expectedEventItems.length, "事件开关重新打开后 marker 应恢复");
  console.log("[ok] 运营事件开关显隐:", eventsToggled.off, "→", eventsToggled.on);

  // 点事件 marker → 摘要卡 → 详情 sheet
  if (expectedEventItems.length > 0) {
    const win = await readWindow();
    const scale = container.width / win.width;
    const tolerance = 24 / scale;
    // 命中优先级是 POI 图钉 → 事件锚点 → 楼宇：挑一个离所有图钉都超过容差的
    // 事件锚点来点（否则像宝山「测试」图钉与事件相邻时，点的会是图钉）。
    const candidates = expectedEventItems
      .map((item) => {
        const [x, y] = operationsLib.overlayAnchor(item.geometry);
        const minMarkerDistance = expectedMarkers.reduce(
          (best, marker) => Math.min(best, Math.hypot(marker.x - x, marker.y - y)),
          Infinity,
        );
        return { item, x, y, minMarkerDistance };
      })
      .sort((a, b) => b.minMarkerDistance - a.minMarkerDistance);
    const target = candidates[0];
    assert.ok(
      target.minMarkerDistance > tolerance,
      `应有远离图钉的事件锚点可点（最近图钉 ${target.minMarkerDistance.toFixed(1)} > 容差 ${tolerance.toFixed(1)}）`,
    );
    await miniProgram.evaluate(
      (args) => {
        const page = getCurrentPages()[getCurrentPages().length - 1];
        page.handleTapAt(args.localX, args.localY, args.win.x, args.win.y, args.scale);
      },
      {
        localX: ((target.x - win.x) / win.width) * container.width,
        localY: ((target.y - win.y) / win.height) * container.height,
        win,
        scale,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const summaryReport = await miniProgram.evaluate(() => {
      const page = getCurrentPages()[getCurrentPages().length - 1];
      return page.data.report;
    });
    assert.equal(summaryReport.eventSummaryId, target.item.event.id, "点事件 marker 应出摘要卡");
    console.log("[ok] 事件摘要卡:", target.item.event.id, target.item.event.title);
    await miniProgram.screenshot({ path: join(outDir, "map-event-summary.png") });

    await miniProgram.evaluate(() => {
      const page = getCurrentPages()[getCurrentPages().length - 1];
      page.openEventDetailFromSummary();
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const eventDetailReport = await miniProgram.evaluate(() => {
      const page = getCurrentPages()[getCurrentPages().length - 1];
      return page.data.report;
    });
    assert.equal(eventDetailReport.eventDetailOpen, true, "事件详情 sheet 应打开");
    assert.equal(eventDetailReport.eventDetailId, target.item.event.id, "详情应是同一事件");
    assert.equal(eventDetailReport.eventSummaryId, null, "开详情后摘要卡应关闭");
    console.log("[ok] 事件详情 sheet:", eventDetailReport.eventDetailId);
    await miniProgram.screenshot({ path: join(outDir, "map-event-detail.png") });
    await miniProgram.evaluate(() => {
      const page = getCurrentPages()[getCurrentPages().length - 1];
      page.closeEventDetail();
    });
  }
}


// ---------------------------------------------------------------------------
// 5. 校区切换：切到嘉定，装配/视口应整体重置
// ---------------------------------------------------------------------------
const jiading = expected.campuses.find((item) => item.key === "jiading");
assert.ok(jiading, "fixture 应有嘉定校区");
await miniProgram.evaluate(() => {
  const pages = getCurrentPages();
  pages[pages.length - 1].switchCampus({ currentTarget: { dataset: { key: "jiading" } } });
});
await new Promise((resolve) => setTimeout(resolve, 1500));
const jiadingState = await miniProgram.evaluate(() => {
  const pages = getCurrentPages();
  const page = pages[pages.length - 1];
  return { report: page.data.report ?? null, containerSize: page.containerSize ?? null };
});
const jiadingReport = jiadingState.report;
assert.equal(jiadingReport.campusKey, "jiading");
assert.equal(jiadingReport.selectedPoiKey, null, "切校区应清空选中态");
const jiadingViewBox = svgGeometry.parseSvgViewBox(jiading.svgRaw);
const jiadingWindow = viewport.createInitialWindow(
  jiading,
  { width: jiadingViewBox.width, height: jiadingViewBox.height },
  jiadingState.containerSize,
);
assert.deepEqual(
  jiadingReport.window,
  {
    x: round(jiadingWindow.x),
    y: round(jiadingWindow.y),
    width: round(jiadingWindow.width),
    height: round(jiadingWindow.height),
  },
  "嘉定初始窗口应与 createInitialWindow 一致",
);
assert.equal(
  jiadingReport.markerCount,
  markers.buildMarkers(expected.pois, "jiading").length,
  "嘉定图钉数应与装配一致",
);
console.log("[ok] 校区切换:", jiadingReport.campusKey, JSON.stringify(jiadingReport.window));
await miniProgram.screenshot({ path: join(outDir, "map-page-jiading.png") });

// ---------------------------------------------------------------------------
// 5.5 Part 3：搜索面板 → 打开命中 → 详情 sheet
// ---------------------------------------------------------------------------
const searchQuery = "图书馆";
const expectedDocs = search.searchReleaseLocal(expected.manifest, searchQuery);
const expectedHits = search.resolveSearchHits(expectedDocs, expected.pois);
assert.ok(expectedHits.length > 0, "线上数据搜「图书馆」应有命中");

await miniProgram.evaluate((query) => {
  const pages = getCurrentPages();
  const page = pages[pages.length - 1];
  page.openSearchPanel();
  page.performSearch(query);
}, searchQuery);
await new Promise((resolve) => setTimeout(resolve, 400));
const searchReport = await miniProgram.evaluate(() => {
  const pages = getCurrentPages();
  return pages[pages.length - 1].data.report;
});
assert.equal(searchReport.searchQuery, searchQuery);
assert.equal(searchReport.searchHitCount, expectedHits.length, "搜索命中数应与 node 侧一致");
assert.equal(searchReport.searchFirstPoiKey, expectedHits[0].poi.poiKey, "首条命中应与 node 侧一致");
await miniProgram.screenshot({ path: join(outDir, "map-search-panel.png") });
console.log("[ok] 搜索面板:", searchReport.searchHitCount, "条命中，首条", searchReport.searchFirstPoiKey);

await miniProgram.evaluate(() => {
  const pages = getCurrentPages();
  pages[pages.length - 1].openSearchHit(0);
});
await new Promise((resolve) => setTimeout(resolve, 800));
const detailReport = await miniProgram.evaluate(() => {
  const pages = getCurrentPages();
  return pages[pages.length - 1].data.report;
});
assert.equal(detailReport.detailOpen, true, "打开命中后详情 sheet 应打开");
assert.equal(detailReport.detailPoiKey, expectedHits[0].poi.poiKey, "详情应是首条命中的 POI");
assert.equal(
  detailReport.campusKey,
  expectedHits[0].poi.campusKey,
  "跨校区命中应已切到目标校区",
);
assert.equal(detailReport.detailMerchantId, expectedHits[0].merchantId ?? null);
await miniProgram.screenshot({ path: join(outDir, "map-detail-sheet.png") });
console.log("[ok] 详情 sheet:", detailReport.detailPoiKey, "校区", detailReport.campusKey);

// ---------------------------------------------------------------------------
// 6. 截图 + 运行时异常检查
// ---------------------------------------------------------------------------
await miniProgram.screenshot({ path: join(outDir, "map-page.png") });
console.log("[ok] 截图:", join(outDir, "map-page.png"), "与 map-page-jiading.png");

const pageExceptions = exceptions.filter((message) => !message.includes("webview"));
assert.deepEqual(pageExceptions, [], `运行时不应有异常：${pageExceptions.join("; ")}`);

console.log("[ok] 地图页装配/视口/命中链路与后端一致，无运行时异常");
console.log(`[console] 共 ${consoleMessages.length} 条 console 消息`);
await miniProgram.disconnect();
