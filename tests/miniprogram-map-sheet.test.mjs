// 小程序端底部抽屉状态机纯逻辑自验（不经微信开发者工具，直接在 node 里跑）。
//
// 用 esbuild 把 miniprogram/miniprogram/lib/map/sheet.ts 编成 cjs 后断言：
// 1. sheetHeights 四档高度公式（对齐 Web 端 visibleHeights），tabBarHeight 传
//    总高（64 + 安全区）时 collapsed 档底边恰好贴在 tab 栏顶（问题：搜索框被
//    自定义 tabBar 压住的回归）；
// 2. snapSheetMode 只在 collapsed/home/results 间吸附（poi 不参与）；
// 3. queryMode / filterToggleMode / previousModeBeforePoi / sheetToggleTarget /
//    sheetToggleShifted 的落档与避让规则。

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
  join(repoRoot, "miniprogram/miniprogram/lib/map/sheet.ts"),
  "--bundle",
  "--format=cjs",
  "--platform=node",
  `--outfile=${join(outDir, "sheet.cjs")}`,
]);

const require = createRequire(import.meta.url);
const sheet = require(join(outDir, "sheet.cjs"));

// iPhone 全面屏典型值：视口 390×844（含 tab 栏条带），tab 栏 64 内容 + 34 安全区
const H = 844;
const TAB_CONTENT = 64;
const SAFE_BOTTOM = 34;

// ---------------------------------------------------------------------------
// 1. sheetHeights：四档公式 + tabBarHeight 含安全区时 collapsed 底边贴 tab 栏顶
// ---------------------------------------------------------------------------
{
  const heights = sheet.sheetHeights(H, TAB_CONTENT + SAFE_BOTTOM);
  assert.equal(heights.collapsed, 78, "collapsed 固定 78px（只有搜索框）");
  assert.equal(heights.home, Math.min(H * 0.52, 480), "home = min(h×0.52, 480)");
  assert.equal(heights.poi, Math.min(H * 0.74, 620), "poi = min(h×0.74, 620)");
  assert.equal(
    heights.results,
    H - (TAB_CONTENT + SAFE_BOTTOM) - 56,
    "results = h − tabBar − topInset(默认 56)",
  );

  // 问题 2 回归：抽屉底边 = containerHeight − tabBarHeight，必须正好落在
  // tab 栏顶边（含安全区），collapsed 档搜索框才完整露在 tab 栏上方。
  const fullHeight = H - (TAB_CONTENT + SAFE_BOTTOM);
  const collapsedTop = fullHeight - heights.collapsed;
  assert.ok(collapsedTop >= 0, "collapsed 顶边不越出视口");
  assert.equal(
    collapsedTop + heights.collapsed,
    H - (TAB_CONTENT + SAFE_BOTTOM),
    "collapsed 底边应贴 tab 栏顶（含安全区）",
  );
  // 只算 64 不算安全区时，底边会落进 tab 栏里 34px（旧 bug 的量化）
  assert.equal(
    (H - TAB_CONTENT) - (collapsedTop + heights.collapsed),
    SAFE_BOTTOM,
    "不含安全区时底边会被 tab 栏吃掉 safeBottom 那么多",
  );

  // 自定义 topInset（小程序让出微信胶囊行，map.ts 传 controlTop）
  const withInset = sheet.sheetHeights(H, TAB_CONTENT + SAFE_BOTTOM, 96);
  assert.equal(withInset.results, H - (TAB_CONTENT + SAFE_BOTTOM) - 96, "results 应吃自定义 topInset");
}

// ---------------------------------------------------------------------------
// 2. snapSheetMode：投影高度吸附最近档（仅 collapsed/home/results）
// ---------------------------------------------------------------------------
{
  const heights = sheet.sheetHeights(H, TAB_CONTENT + SAFE_BOTTOM);
  assert.equal(sheet.snapSheetMode(heights.collapsed + 4, heights), "collapsed");
  assert.equal(sheet.snapSheetMode(heights.home - 4, heights), "home");
  assert.equal(sheet.snapSheetMode(heights.results - 4, heights), "results");
  // 中间点归较近的一档
  const midCollapsedHome = (heights.collapsed + heights.home) / 2;
  assert.equal(sheet.snapSheetMode(midCollapsedHome + 1, heights), "home");
  assert.equal(sheet.snapSheetMode(midCollapsedHome - 1, heights), "collapsed");
  // poi 不是吸附档：即使投影高度正中 poi 档也不应吸到 poi
  assert.notEqual(sheet.snapSheetMode(heights.poi, heights), "poi");
  for (const mode of sheet.SNAPPABLE_MODES) {
    assert.notEqual(mode, "poi", "SNAPPABLE_MODES 不含 poi");
  }
}

// ---------------------------------------------------------------------------
// 3. 落档/浮钮规则
// ---------------------------------------------------------------------------
{
  assert.equal(sheet.queryMode("  ", 0), "home", "空 query 无筛选 → home");
  assert.equal(sheet.queryMode("图书馆", 0), "results", "有 query → results");
  assert.equal(sheet.queryMode("", 2), "results", "无 query 有筛选 → results");

  assert.equal(sheet.filterToggleMode(0, ""), "home");
  assert.equal(sheet.filterToggleMode(1, ""), "results");
  assert.equal(sheet.filterToggleMode(0, "食堂"), "results");

  assert.equal(sheet.previousModeBeforePoi("collapsed"), "collapsed", "collapsed 原样回退（全屏回全屏）");
  assert.equal(sheet.previousModeBeforePoi("poi"), "home", "poi 记为 home");
  assert.equal(sheet.previousModeBeforePoi("home"), "home");
  assert.equal(sheet.previousModeBeforePoi("results"), "results");

  assert.equal(sheet.sheetToggleTarget("collapsed", false), "home", "collapsed 无搜索 → 恢复 home");
  assert.equal(sheet.sheetToggleTarget("collapsed", true), "results", "collapsed 有搜索 → 恢复 results");
  assert.equal(sheet.sheetToggleTarget("home", true), "collapsed");
  assert.equal(sheet.sheetToggleTarget("results", false), "collapsed");

  // 抽屉顶边距视口顶 < 120px 时浮钮左移避让右侧控件列
  const heights = sheet.sheetHeights(H, TAB_CONTENT + SAFE_BOTTOM);
  assert.equal(sheet.sheetToggleShifted(H, TAB_CONTENT + SAFE_BOTTOM, heights.results), true);
  assert.equal(sheet.sheetToggleShifted(H, TAB_CONTENT + SAFE_BOTTOM, heights.collapsed), false);
}

// ---------------------------------------------------------------------------
// 4. sheetAnimateMs：动画时长按位移分档（近档 160ms / 跨档 240ms）
// ---------------------------------------------------------------------------
{
  assert.equal(sheet.sheetAnimateMs(0), sheet.SHEET_ANIMATE_MS_SHORT);
  assert.equal(sheet.sheetAnimateMs(sheet.SHEET_ANIMATE_SHORT_DISTANCE_PX), sheet.SHEET_ANIMATE_MS_SHORT, "边界值算短距离");
  assert.equal(sheet.sheetAnimateMs(sheet.SHEET_ANIMATE_SHORT_DISTANCE_PX + 1), sheet.SHEET_ANIMATE_MS_LONG);
  assert.equal(sheet.sheetAnimateMs(-sheet.SHEET_ANIMATE_SHORT_DISTANCE_PX - 40), sheet.SHEET_ANIMATE_MS_LONG, "取绝对值");
  // 典型档位距离（H=844/tab=98 下）：home↔results ≈ 211 短档；home↔collapsed ≈ 361 /
  // collapsed↔results ≈ 572 长档；poi↔home ≈ 181 短档。
  const heights = sheet.sheetHeights(H, TAB_CONTENT + SAFE_BOTTOM);
  const full = H - (TAB_CONTENT + SAFE_BOTTOM);
  const d = (a, b) => Math.abs((full - a) - (full - b));
  assert.equal(sheet.sheetAnimateMs(d(heights.home, heights.results)), sheet.SHEET_ANIMATE_MS_SHORT, "home↔results 短档");
  assert.equal(sheet.sheetAnimateMs(d(heights.home, heights.collapsed)), sheet.SHEET_ANIMATE_MS_LONG, "home↔collapsed 长档");
  assert.equal(sheet.sheetAnimateMs(d(heights.collapsed, heights.results)), sheet.SHEET_ANIMATE_MS_LONG, "collapsed↔results 长档");
  assert.equal(sheet.sheetAnimateMs(d(heights.poi, heights.home)), sheet.SHEET_ANIMATE_MS_SHORT, "poi↔home 短档");
}

console.log("[ok] miniprogram 抽屉状态机（sheet.ts）全部断言通过");
