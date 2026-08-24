// Web 端底部抽屉「整卡可拖」的手势归属与落档规则自验（src/components/sheet/sheetGesture.ts）。
//
// 与小程序端 tests/miniprogram-map-sheet.test.mjs 的第 5～8 节是**同一组用例**：
// 两端各有一份实现（Web 用 top/px、小程序用可见高度），规则必须逐条一致，
// 否则会出现「网页能滑小程序不能」的分裂。改任一端都要同时跑这两个文件。
//
// 覆盖：
// 1. sheetGestureOwner：按落点的空间归属（把手优先 / 非滚动区整卡可拖 /
//    不可滚的框不吃手势 / home 档列表照常滚 / results·poi 档记 pending）；
// 2. resolveSheetDragOwner：容差、轴锁、pending 的「滚到顶继续下拉」接管；
// 3. sheetDragVelocity / snapModeWithVelocity / shouldClosePoiOnRelease：
//    甩动落档与 poi 关闭条件；
// 4. dampSheetTop：越界阻尼；
// 5. 三处接线断言（MapPage 挂 sheetRef/整卡监听、两个滚动框都标了
//    data-sheet-scroll、把手带 data-sheet-handle）——缺其一功能会静默退化
//    成「只有把手能拖」或「列表吃掉全部手势」，且不会报错。

import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const bundled = await build({
  absWorkingDir: root,
  entryPoints: ["src/components/sheet/sheetGesture.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`;
const {
  PULL_DOWN_EXIT_MODES,
  SHEET_CLOSE_THRESHOLD_PX,
  SHEET_DRAG_TOLERANCE_PX,
  SHEET_FLING_VELOCITY,
  SHEET_OVERSCROLL_FACTOR,
  SHEET_VELOCITY_PROJECTION_MS,
  dampSheetTop,
  resolveSheetDragOwner,
  sheetDragVelocity,
  sheetGestureOwner,
  shouldClosePoiOnRelease,
  snapModeWithVelocity,
} = await import(moduleUrl);

// 移动端典型档位（390×844，tab 栏 64+34）下各档 sheet 顶边 px：
// top 越大 = 抽屉越矮。数值与 MapPage 的 visibleHeights 同源。
const FULL = 844 - 98;
const TOPS = {
  collapsed: FULL - 78,
  home: FULL - Math.min(844 * 0.52, 480),
  results: FULL - (844 - 98 - 56),
};
const topForMode = (mode) => TOPS[mode];
const SNAPPABLE = ["collapsed", "home", "results"];

test("sheetGestureOwner: 手势归属按落点判定（空间规则）", () => {
  const owner = (over) => sheetGestureOwner({
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

  // 落点不在滚动框内（搜索行 / 标签筛选 / 标题行）→ 整卡可拖，这就是本次需求
  for (const mode of ["collapsed", "home", "results", "poi"]) {
    assert.equal(owner({ mode, inScrollArea: false, scrollable: true }), "sheet", `${mode} 档非滚动区归抽屉`);
  }

  // 落在滚动框内但内容没溢出（最近查看只一两条）→ 不吃手势
  for (const mode of ["home", "results", "poi"]) {
    assert.equal(owner({ mode, inScrollArea: true, scrollable: false }), "sheet", `${mode} 档不可滚的框归抽屉`);
  }

  // 用户定的规则：home 档列表照常滚（抬档得抓上半部分或点全屏钮）
  assert.equal(owner({ mode: "home", inScrollArea: true, scrollable: true }), "scroll", "home 档滚动框归列表");

  // results / poi 档列表占九成面积，保留「滚到顶继续下拉」的出口 → 先记 pending
  assert.equal(owner({ mode: "results", inScrollArea: true, scrollable: true }), "pending");
  assert.equal(owner({ mode: "poi", inScrollArea: true, scrollable: true }), "pending");
  assert.deepEqual([...PULL_DOWN_EXIT_MODES], ["results", "poi"], "下拉出口档位与小程序端一致");
});

test("resolveSheetDragOwner: 首次位移到达容差时定死归属（轴锁 + pending 接管）", () => {
  const resolve = (over) => resolveSheetDragOwner({
    owner: "sheet",
    fromHandle: false,
    deltaX: 0,
    deltaY: 0,
    scrollTop: 0,
    ...over,
  });
  const tol = SHEET_DRAG_TOLERANCE_PX;
  assert.equal(tol, 8, "容差与小程序端地图面 tap 容差同口径");

  // 位移未到容差 → 继续等（null），别过早定归属
  assert.equal(resolve({ deltaY: tol - 1 }), null, "位移未到容差返回 null");
  assert.equal(resolve({ deltaX: tol - 1 }), null);
  assert.equal(resolve({ deltaY: tol }), "sheet", "边界值即判定");

  // owner=scroll 不看位移直接让位
  assert.equal(resolve({ owner: "scroll", deltaY: 0 }), "scroll");
  assert.equal(resolve({ owner: "scroll", deltaY: 100 }), "scroll");

  // 轴锁：横向意图让给 chip 行 / 商户图轮播，不拖抽屉
  assert.equal(resolve({ deltaX: 40, deltaY: 10 }), "scroll", "横向位移更大 → 让位");
  assert.equal(resolve({ deltaX: -40, deltaY: 10 }), "scroll", "轴锁取绝对值");
  assert.equal(resolve({ deltaX: 10, deltaY: 40 }), "sheet", "纵向位移更大 → 拖抽屉");
  assert.equal(resolve({ fromHandle: true, deltaX: 40, deltaY: 10 }), "sheet", "把手横滑仍拖抽屉");

  // pending（results / poi 档滚动框内）：列表在顶部且下滑才接管
  const pending = (over) => resolve({ owner: "pending", ...over });
  assert.equal(pending({ deltaY: 40, scrollTop: 0 }), "sheet", "滚到顶继续下拉 → 抽屉接管");
  assert.equal(pending({ deltaY: 40, scrollTop: -2 }), "sheet", "scrollTop 负值（回弹）也算到顶");
  assert.equal(pending({ deltaY: 40, scrollTop: 120 }), "scroll", "列表不在顶部 → 让列表滚");
  assert.equal(pending({ deltaY: -40, scrollTop: 0 }), "scroll", "在顶部但上滑 → 让列表滚");
  assert.equal(pending({ deltaY: tol - 1, scrollTop: 0 }), null, "pending 也要等位移到容差");
});

test("sheetDragVelocity: 只取最后两个采样点，正 = 向下", () => {
  assert.equal(sheetDragVelocity({ y: 100, t: 1000 }, { y: 160, t: 1060 }), 1, "下滑 60px/60ms = 1px/ms");
  assert.equal(sheetDragVelocity({ y: 160, t: 1000 }, { y: 100, t: 1060 }), -1, "上滑为负");
  assert.equal(sheetDragVelocity(null, { y: 100, t: 1000 }), 0, "采样不足按 0");
  assert.equal(sheetDragVelocity({ y: 100, t: 1000 }, null), 0);
  assert.equal(sheetDragVelocity({ y: 100, t: 1000 }, { y: 160, t: 1000 }), 0, "dt=0 不除零");
});

test("snapModeWithVelocity: 甩动走相邻档，慢速按速度外推取最近档", () => {
  const snap = (over) => snapModeWithVelocity({
    releasedTop: TOPS.home,
    velocity: 0,
    candidates: SNAPPABLE,
    topForMode,
    currentMode: "home",
    ...over,
  });
  const fling = SHEET_FLING_VELOCITY;

  // 甩动：不看位移，无条件走该方向的相邻档（整卡可拖后手势变短变快的补偿）
  assert.equal(snap({ velocity: fling + 0.1 }), "collapsed", "向下甩 → 降一档");
  assert.equal(snap({ velocity: -(fling + 0.1) }), "results", "向上甩 → 升一档");

  // 端点档甩到底不越界
  assert.equal(
    snap({ releasedTop: TOPS.collapsed, velocity: fling + 1, currentMode: "collapsed" }),
    "collapsed",
  );
  assert.equal(
    snap({ releasedTop: TOPS.results, velocity: -(fling + 1), currentMode: "results" }),
    "results",
  );
  // 甩动只跳一档：results 向下甩到 home，不直接到 collapsed
  assert.equal(
    snap({ releasedTop: TOPS.results, velocity: fling + 2, currentMode: "results" }),
    "home",
    "甩动一次只跳一档",
  );

  // 慢速：按速度外推后取最近档
  assert.equal(snap({ velocity: 0 }), "home", "零速停在原档");
  const midCollapsedHome = (TOPS.collapsed + TOPS.home) / 2;
  // 松手位置偏 home 一侧，但缓慢向下移动（top 增大）→ 外推后落 collapsed
  assert.equal(
    snap({ releasedTop: midCollapsedHome - 10, velocity: 0.4 }),
    "collapsed",
    "慢速下滑的外推把落档拉低一档",
  );
  assert.equal(
    snap({ releasedTop: midCollapsedHome - 10, velocity: 0 }),
    "home",
    "同一位置零速则留在 home（证明上一条是外推起的作用）",
  );
  // 外推时长与小程序端一致，否则两端落档边界不同
  assert.equal(SHEET_VELOCITY_PROJECTION_MS, 150);
  assert.equal(snap({ candidates: [] }), null, "无候选档返回 null");
});

test("shouldClosePoiOnRelease: 下拉超阈值或向下甩超速度阈值才关详情", () => {
  const fling = SHEET_FLING_VELOCITY;
  assert.equal(shouldClosePoiOnRelease(SHEET_CLOSE_THRESHOLD_PX + 1, 0), true, "下拉超阈值 → 关");
  assert.equal(shouldClosePoiOnRelease(SHEET_CLOSE_THRESHOLD_PX, 0), false, "边界值不关");
  assert.equal(shouldClosePoiOnRelease(20, fling + 0.1), true, "小位移快甩 → 关");
  assert.equal(shouldClosePoiOnRelease(20, 0.1), false, "小位移慢放 → 不关");
  assert.equal(shouldClosePoiOnRelease(-100, -(fling + 1)), false, "上甩不关");
});

test("dampSheetTop: 越界阻尼（比硬 clamp 更像「到底了」）", () => {
  const minTop = 100;
  const maxTop = 500;
  const f = SHEET_OVERSCROLL_FACTOR;
  assert.ok(f > 0 && f < 1, "阻尼系数在 (0,1) 之间");
  assert.equal(dampSheetTop(300, minTop, maxTop), 300, "界内原样跟手");
  assert.equal(dampSheetTop(minTop, minTop, maxTop), minTop);
  assert.equal(dampSheetTop(maxTop, minTop, maxTop), maxTop);
  assert.equal(dampSheetTop(minTop - 100, minTop, maxTop), minTop - 100 * f, "上界外只生效 f 倍");
  assert.equal(dampSheetTop(maxTop + 100, minTop, maxTop), maxTop + 100 * f, "下界外只生效 f 倍");
  const a = dampSheetTop(minTop - 50, minTop, maxTop);
  const b = dampSheetTop(minTop - 200, minTop, maxTop);
  assert.ok(b < a && a < minTop, "越界位移单调且不穿回界内");
});

test("两端规则常量一致（改一端必须改另一端）", () => {
  const mp = read("miniprogram/miniprogram/lib/map/sheet.ts");
  const pairs = [
    ["SHEET_DRAG_TOLERANCE_PX", SHEET_DRAG_TOLERANCE_PX],
    ["SHEET_FLING_VELOCITY", SHEET_FLING_VELOCITY],
    ["SHEET_VELOCITY_PROJECTION_MS", SHEET_VELOCITY_PROJECTION_MS],
    ["SHEET_OVERSCROLL_FACTOR", SHEET_OVERSCROLL_FACTOR],
    ["SHEET_CLOSE_THRESHOLD_PX", SHEET_CLOSE_THRESHOLD_PX],
  ];
  for (const [name, webValue] of pairs) {
    const match = mp.match(new RegExp(`${name}\\s*=\\s*([-\\d.]+)`));
    assert.ok(match, `小程序端应有 ${name}`);
    assert.equal(Number(match[1]), webValue, `${name} 两端取值必须一致`);
  }
});

test("接线：整卡监听 + 滚动框标记 + 把手标记都在（缺一功能静默退化）", () => {
  const mapPage = read("src/pages/map/MapPage.tsx");
  const searchSheet = read("src/pages/map/SearchHomeSheet.tsx");
  const hook = read("src/components/sheet/useSheetDrag.ts");

  // 1. 手势监听挂在整张卡片上（sheetRef 落在抽屉 section 上），不再只挂把手
  assert.match(mapPage, /ref=\{sheetRef\}/, "抽屉 section 必须挂 sheetRef（否则只有把手能拖）");
  assert.match(hook, /addEventListener\("touchmove",\s*onTouchMove,\s*\{\s*passive:\s*false\s*\}\)/,
    "touchmove 必须 passive:false，否则 preventDefault 被忽略、抢不到原生滚动");

  // 2. 把手保留但只作视觉提示 + 无条件归抽屉的命中区
  assert.match(mapPage, /data-sheet-handle/, "把手必须带 data-sheet-handle");
  assert.match(hook, /SHEET_HANDLE_ATTR = "data-sheet-handle"/);

  // 3. 三个纵向滚动框都要标记：poi 详情 + 搜索结果 + 最近查看。
  //    漏标 = 该列表被当成可拖区，用户滚不动列表。
  assert.match(mapPage, /data-sheet-scroll/, "poi 详情滚动容器必须标 data-sheet-scroll");
  const scrollMarks = searchSheet.match(/SHEET_SCROLL_ATTR/g) ?? [];
  assert.ok(
    scrollMarks.length >= 3,
    `SearchHomeSheet 的搜索结果与最近查看两个滚动框都要标记（含 import 至少 3 处，实际 ${scrollMarks.length}）`,
  );

  // 4. 滚动链隔断：results 档滚到顶继续下拉不该带动页面/父级滚动
  assert.match(searchSheet, /overscroll-contain/, "滚动框需 overscroll-behavior: contain");
  assert.match(mapPage, /overscrollBehavior: "contain"/, "poi 滚动容器同样需要");

  // 5. 拖拽期间 touch-action 置 none（否则浏览器原生滚动与我们抢同一手势）
  assert.match(mapPage, /touchAction: dragging \? "none" : "pan-y"/);

  // 6. 抢到手势后抑制列表行点击 + 降档时列表回顶（两条手感修正的接线）
  assert.match(mapPage, /consumeSheetDragClick\(\)/, "列表行点击需要 claim 守卫");
  assert.match(mapPage, /onDropToLowerMode/, "降档需把列表滚回顶部");
});
