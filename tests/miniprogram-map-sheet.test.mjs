// 小程序端底部抽屉状态机纯逻辑自验（不经微信开发者工具，直接在 node 里跑）。
//
// 用 esbuild 把 miniprogram/miniprogram/lib/map/sheet.ts 编成 cjs 后断言：
// 1. sheetHeights 四档高度公式（对齐 Web 端 visibleHeights），tabBarHeight 传
//    总高（64 + 安全区）时 collapsed 档底边恰好贴在 tab 栏顶（问题：搜索框被
//    自定义 tabBar 压住的回归）；
// 2. snapSheetMode 只在 collapsed/home/results 间吸附（poi 不参与）；
// 3. queryMode / filterToggleMode / previousModeBeforePoi / sheetToggleTarget /
//    sheetToggleShifted 的落档与避让规则；
// 4. sheetAnimateMs 动画时长分档；
// 5. 整卡拖拽（2026-08-24）：sheetGestureOwner 空间归属 + resolveSheetDragOwner
//    轴锁/接管 + snapSheetModeWithVelocity 甩动落档 + dampSheetTop 越界阻尼 +
//    shouldClosePoiOnRelease / sheetDragVelocity。

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

// ---------------------------------------------------------------------------
// 5. sheetGestureOwner：整卡拖拽的手势归属（按落点的空间判定）
// ---------------------------------------------------------------------------
{
  const owner = (over) => sheet.sheetGestureOwner({
    mode: "home",
    fromHandle: false,
    inScrollArea: false,
    scrollable: false,
    ...over,
  });

  // 把手无条件归抽屉：不看档位、不看落点、不看列表能不能滚
  for (const mode of ["collapsed", "home", "results", "poi"]) {
    assert.equal(
      owner({ mode, fromHandle: true, inScrollArea: true, scrollable: true }),
      "sheet",
      `把手在 ${mode} 档也归抽屉`,
    );
  }

  // 落点不在滚动框内（搜索行/标签筛选/标题行）→ 整卡可拖
  for (const mode of ["collapsed", "home", "results", "poi"]) {
    assert.equal(owner({ mode, inScrollArea: false, scrollable: true }), "sheet", `${mode} 档非滚动区归抽屉`);
  }

  // 落在滚动框内但内容没溢出（最近查看只一两条）→ 不吃手势，整卡可拖
  for (const mode of ["home", "results", "poi"]) {
    assert.equal(owner({ mode, inScrollArea: true, scrollable: false }), "sheet", `${mode} 档不可滚的框归抽屉`);
  }

  // 用户定的规则：home 档列表照常滚（抬档得抓上半部分或点全屏钮）
  assert.equal(owner({ mode: "home", inScrollArea: true, scrollable: true }), "scroll", "home 档滚动框归列表");
  assert.equal(
    owner({ mode: "collapsed", inScrollArea: true, scrollable: true }),
    "scroll",
    "collapsed 档（理论上不渲染列表）滚动框也归列表",
  );

  // results / poi 档列表占九成面积，保留「滚到顶继续下拉」的出口 → 先记 pending
  assert.equal(owner({ mode: "results", inScrollArea: true, scrollable: true }), "pending");
  assert.equal(owner({ mode: "poi", inScrollArea: true, scrollable: true }), "pending");
}

// ---------------------------------------------------------------------------
// 6. resolveSheetDragOwner：首次位移到达容差时定死归属（轴锁 + pending 接管）
// ---------------------------------------------------------------------------
{
  const resolve = (over) => sheet.resolveSheetDragOwner({
    owner: "sheet",
    fromHandle: false,
    deltaX: 0,
    deltaY: 0,
    scrollTop: 0,
    ...over,
  });
  const tol = sheet.SHEET_DRAG_TOLERANCE_PX;

  // 位移未到容差 → 继续等（null），别过早定归属
  assert.equal(resolve({ deltaY: tol - 1 }), null, "位移未到容差返回 null");
  assert.equal(resolve({ deltaX: tol - 1 }), null);
  assert.equal(resolve({ deltaY: tol }), "sheet", "边界值即判定");

  // owner=scroll 不看位移直接让位（省掉每帧算）
  assert.equal(resolve({ owner: "scroll", deltaY: 0 }), "scroll");
  assert.equal(resolve({ owner: "scroll", deltaY: 100 }), "scroll");

  // 轴锁：横向意图让给 chip 行 / 商户图 swiper，不拖抽屉
  assert.equal(resolve({ deltaX: 40, deltaY: 10 }), "scroll", "横向位移更大 → 让位");
  assert.equal(resolve({ deltaX: -40, deltaY: 10 }), "scroll", "轴锁取绝对值");
  assert.equal(resolve({ deltaX: 10, deltaY: 40 }), "sheet", "纵向位移更大 → 拖抽屉");
  // 把手上的横滑没有别的语义，不做轴锁
  assert.equal(resolve({ fromHandle: true, deltaX: 40, deltaY: 10 }), "sheet", "把手横滑仍拖抽屉");

  // pending（results / poi 档滚动框内）：列表在顶部且下滑才接管
  const pending = (over) => resolve({ owner: "pending", ...over });
  assert.equal(pending({ deltaY: 40, scrollTop: 0 }), "sheet", "滚到顶继续下拉 → 抽屉接管");
  assert.equal(pending({ deltaY: 40, scrollTop: -2 }), "sheet", "scrollTop 负值（回弹）也算到顶");
  assert.equal(pending({ deltaY: 40, scrollTop: 120 }), "scroll", "列表不在顶部 → 让列表滚");
  assert.equal(pending({ deltaY: -40, scrollTop: 0 }), "scroll", "在顶部但上滑 → 让列表滚");
  assert.equal(pending({ deltaY: tol - 1, scrollTop: 0 }), null, "pending 也要等位移到容差");
}

// ---------------------------------------------------------------------------
// 7. sheetDragVelocity / snapSheetModeWithVelocity / shouldClosePoiOnRelease
// ---------------------------------------------------------------------------
{
  // 速度只取最后两点，正 = 向下
  assert.equal(sheet.sheetDragVelocity({ y: 100, t: 1000 }, { y: 160, t: 1060 }), 1, "下滑 60px/60ms = 1px/ms");
  assert.equal(sheet.sheetDragVelocity({ y: 160, t: 1000 }, { y: 100, t: 1060 }), -1, "上滑为负");
  assert.equal(sheet.sheetDragVelocity(null, { y: 100, t: 1000 }), 0, "采样不足按 0");
  assert.equal(sheet.sheetDragVelocity({ y: 100, t: 1000 }, null), 0);
  assert.equal(sheet.sheetDragVelocity({ y: 100, t: 1000 }, { y: 160, t: 1000 }), 0, "dt=0 不除零");

  const heights = sheet.sheetHeights(H, TAB_CONTENT + SAFE_BOTTOM);
  const fling = sheet.SHEET_FLING_VELOCITY;

  // 甩动：不看位移，无条件走该方向的相邻档（整卡可拖后手势变短变快的补偿）
  assert.equal(
    sheet.snapSheetModeWithVelocity(heights.home, fling + 0.1, heights, "home"),
    "collapsed",
    "向下甩 → 降一档",
  );
  assert.equal(
    sheet.snapSheetModeWithVelocity(heights.home, -(fling + 0.1), heights, "home"),
    "results",
    "向上甩 → 升一档",
  );
  // 端点档甩到底不越界
  assert.equal(sheet.snapSheetModeWithVelocity(heights.collapsed, fling + 1, heights, "collapsed"), "collapsed");
  assert.equal(sheet.snapSheetModeWithVelocity(heights.results, -(fling + 1), heights, "results"), "results");
  // 甩动只跳一档：results 向下甩到 home，不直接到 collapsed
  assert.equal(sheet.snapSheetModeWithVelocity(heights.results, fling + 2, heights, "results"), "home");

  // 慢速：按速度外推后取最近档（外推方向与「向下=变矮」一致）
  assert.equal(
    sheet.snapSheetModeWithVelocity(heights.home, 0, heights, "home"),
    "home",
    "零速停在原档",
  );
  const midCollapsedHome = (heights.collapsed + heights.home) / 2;
  // 松手位置刚过中点偏 home 一侧，但缓慢向下移动 → 外推后落 collapsed
  assert.equal(
    sheet.snapSheetModeWithVelocity(midCollapsedHome + 10, 0.4, heights, "home"),
    "collapsed",
    "慢速下滑的外推把落档拉低一档",
  );
  assert.equal(
    sheet.snapSheetModeWithVelocity(midCollapsedHome + 10, 0, heights, "home"),
    "home",
    "同一位置零速则留在 home（证明上一条是外推起的作用）",
  );
  // poi 档不在吸附序列里，走位移投影而不是甩动相邻档
  assert.notEqual(sheet.snapSheetModeWithVelocity(heights.poi, fling + 1, heights, "poi"), "poi");

  // poi 档关闭：下拉超阈值 或 向下甩超速度阈值
  assert.equal(sheet.shouldClosePoiOnRelease(sheet.SHEET_CLOSE_THRESHOLD_PX + 1, 0), true, "下拉超阈值 → 关");
  assert.equal(sheet.shouldClosePoiOnRelease(sheet.SHEET_CLOSE_THRESHOLD_PX, 0), false, "边界值不关");
  assert.equal(sheet.shouldClosePoiOnRelease(20, fling + 0.1), true, "小位移快甩 → 关");
  assert.equal(sheet.shouldClosePoiOnRelease(20, 0.1), false, "小位移慢放 → 不关");
  assert.equal(sheet.shouldClosePoiOnRelease(-100, -(fling + 1)), false, "上甩不关");
}

// ---------------------------------------------------------------------------
// 8. dampSheetTop：越界阻尼（比硬 clamp 更像「到底了」）
// ---------------------------------------------------------------------------
{
  const minTop = 100;
  const maxTop = 500;
  const f = sheet.SHEET_OVERSCROLL_FACTOR;
  assert.equal(sheet.dampSheetTop(300, minTop, maxTop), 300, "界内原样跟手");
  assert.equal(sheet.dampSheetTop(minTop, minTop, maxTop), minTop);
  assert.equal(sheet.dampSheetTop(maxTop, minTop, maxTop), maxTop);
  // 上界外（继续上拉）：超出 100px 只生效 100×f
  assert.equal(sheet.dampSheetTop(minTop - 100, minTop, maxTop), minTop - 100 * f);
  // 下界外（继续下拉）
  assert.equal(sheet.dampSheetTop(maxTop + 100, minTop, maxTop), maxTop + 100 * f);
  // 阻尼后仍单调（越拉越远，只是变慢），且永远不会反向穿回界内
  const a = sheet.dampSheetTop(minTop - 50, minTop, maxTop);
  const b = sheet.dampSheetTop(minTop - 200, minTop, maxTop);
  assert.ok(b < a && a < minTop, "越界位移单调且不穿回界内");
  assert.ok(f > 0 && f < 1, "阻尼系数在 (0,1) 之间");
}

console.log("[ok] miniprogram 抽屉状态机（sheet.ts）全部断言通过");
