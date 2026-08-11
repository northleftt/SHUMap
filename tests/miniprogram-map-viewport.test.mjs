// 小程序端地图视口纯逻辑自验（不经微信开发者工具，直接在 node 里跑）。
//
// 用 esbuild 把 miniprogram/miniprogram/lib/map/viewport.ts 编成 cjs 后断言：
// 1. 初始视口与 Web 端 MapCanvas 语义一致（fit*scaleMultiplier、focusPoint 居中）；
// 2. focusPointWindow 与 Web 端同式同值（移植 tests/map-canvas-point-focus.test.mjs 用例）；
// 3. zoomWindowAt 锚点世界坐标不动、panWindowBy 受 clampWindow 边距约束；
// 4. windowToTransform / screenToWorld / worldToScreen 换算往返一致。

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
  join(repoRoot, "miniprogram/miniprogram/lib/map/viewport.ts"),
  "--bundle",
  "--format=cjs",
  "--platform=node",
  `--outfile=${join(outDir, "viewport.cjs")}`,
]);

const require = createRequire(import.meta.url);
const viewport = require(join(outDir, "viewport.cjs"));

// 对齐 CAMPUS_DISPLAY.baoshan 的视口参数
const campus = {
  focusPoint: { x: 0.48, y: 0.43 },
  scaleMultiplier: 1.78,
  minScaleMultiplier: 1,
  edgePaddingRatio: 0.18,
  selectionEdgePaddingRatio: 0.3,
  selectionScaleMultiplier: 2.15,
};
const viewBox = { width: 921.6, height: 1019.7 };
const container = { width: 390, height: 700 };

// ---------------------------------------------------------------------------
// 1. 初始视口：fit*scaleMultiplier 缩放、focusPoint 对准容器中心
// ---------------------------------------------------------------------------
{
  const vp = viewport.createInitialViewport(campus, viewBox, container);
  const fitScale = Math.min(container.width / viewBox.width, container.height / viewBox.height);
  assert.ok(Math.abs(vp.scale - fitScale * campus.scaleMultiplier) < 1e-9, "初始缩放应为 fit*scaleMultiplier");
  // focus 世界点应落在容器中心
  const focusWorldX = campus.focusPoint.x * viewBox.width;
  const focusScreenX = focusWorldX * vp.scale + vp.translateX;
  assert.ok(Math.abs(focusScreenX - container.width / 2) < 1e-6, "focusPoint 应居中");

  const win = viewport.createInitialWindow(campus, viewBox, container);
  assert.ok(win.width > 0 && win.height > 0, "初始窗口应为正");
  assert.ok(
    win.x >= -viewBox.width * campus.edgePaddingRatio - 1e-9,
    "初始窗口不越出边缘 padding",
  );
}

// ---------------------------------------------------------------------------
// 2. focusPointWindow：与 Web 端同式同值（移植 map-canvas-point-focus 用例）
// ---------------------------------------------------------------------------
{
  const result = viewport.focusPointWindow({
    point: { x: 500, y: 400 },
    currentWindow: { x: 0, y: 0, width: 1000, height: 800 },
    viewBox: { width: 1000, height: 800 },
    container: { width: 400, height: 800 },
    selectionScaleMultiplier: 2,
    selectionEdgePaddingRatio: 0.3,
    selectionFocusBounds: { top: 80, bottom: 480 },
  });
  assert.deepEqual(result, { x: 250, y: 50, width: 500, height: 1000 });
  const selectedScreenY = ((400 - result.y) / result.height) * 800;
  assert.equal(selectedScreenY, 280);
}
{
  const result = viewport.focusPointWindow({
    point: { x: 5, y: 5 },
    currentWindow: { x: 0, y: 0, width: 500, height: 500 },
    viewBox: { width: 1000, height: 1000 },
    container: { width: 500, height: 500 },
    selectionScaleMultiplier: 2,
    selectionEdgePaddingRatio: 0.1,
  });
  assert.equal(result.x, -100);
  assert.equal(result.y, -100);
  assert.equal(result.width, 500);
  assert.equal(result.height, 500);
}

// ---------------------------------------------------------------------------
// 3. zoomWindowAt：锚点世界坐标在缩放前后保持同一屏幕位置；clamp 生效
// ---------------------------------------------------------------------------
{
  const current = { x: 100, y: 100, width: 400, height: 800 };
  const anchor = { x: 100, y: 200 }; // 容器本地 px
  const next = viewport.zoomWindowAt(current, anchor, 2, container, viewBox, 0.18);
  const before = viewport.screenToWorld(current, container, anchor);
  const after = viewport.screenToWorld(next, container, anchor);
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9,
    "缩放锚点的世界坐标应不变");
  assert.ok(Math.abs(container.width / next.width - 2) < 1e-9, "缩放到指定 scale");

  // 缩得太狠越过右边界时被 clamp 回 padding 内
  const edge = viewport.zoomWindowAt(
    { x: 800, y: 100, width: 400, height: 800 },
    anchor,
    1,
    container,
    viewBox,
    0.18,
  );
  const maxX = Math.max(0, viewBox.width - edge.width) + viewBox.width * 0.18;
  assert.ok(edge.x <= maxX + 1e-9, "窗口右缘不越过 padding 上限");
}

// ---------------------------------------------------------------------------
// 4. panWindowBy：平移按 scale 换算，且受边缘 padding 约束
// ---------------------------------------------------------------------------
{
  const current = { x: 100, y: 100, width: 400, height: 800 };
  const scale = container.width / current.width; // 0.975
  const moved = viewport.panWindowBy(current, 97.5, 0, container, viewBox, 0.18);
  assert.ok(Math.abs(moved.x - 0) < 1e-9, "手指右移 97.5px，窗口左移 97.5/scale=100 世界单位");

  const clamped = viewport.panWindowBy(current, 100000, 0, container, viewBox, 0.18);
  assert.equal(clamped.x, -viewBox.width * 0.18, "向左平移被 clamp 在 -padX");
}

// ---------------------------------------------------------------------------
// 5. 换算往返：screenToWorld/worldToScreen 互逆；windowToTransform 与窗口一致
// ---------------------------------------------------------------------------
{
  const win = { x: 50, y: 80, width: 460.8, height: 509.85 };
  const world = { x: 300, y: 500 };
  const screen = viewport.worldToScreen(win, container, world);
  const back = viewport.screenToWorld(win, container, screen);
  assert.ok(Math.abs(back.x - world.x) < 1e-9 && Math.abs(back.y - world.y) < 1e-9,
    "world→screen→world 应往返一致");

  const t = viewport.windowToTransform(win, container);
  // screen = world * scale + translate
  const sx = world.x * t.scale + t.translateX;
  assert.ok(Math.abs(sx - screen.x) < 1e-9, "transform 与窗口换算应一致");

  const roundTrip = viewport.viewportToWindow(viewport.windowToTransform(win, container), container);
  assert.ok(Math.abs(roundTrip.x - win.x) < 1e-9 && Math.abs(roundTrip.width - win.width) < 1e-9,
    "window→transform→window 应往返一致");
}

// ---------------------------------------------------------------------------
// 6. pinchWindow：锚定「手势起点中点」的世界坐标，捏合后仍落在当前 focal 屏幕位置
//    （修复旧模型锚定当前中点导致：单侧手指快图往快侧拽、双侧都快反向滑）
// ---------------------------------------------------------------------------
{
  const beginWin = { x: 100, y: 100, width: 400, height: 800 };
  const beginScale = container.width / beginWin.width; // 0.975
  const startMid = { x: 195, y: 350 }; // 手势起点中点（容器本地 px）
  const anchorWorld = viewport.screenToWorld(beginWin, container, startMid);

  // 双指均匀张开 2 倍：锚点仍落在（不变的）focal 屏幕位置
  const zoomed = viewport.pinchWindow({
    anchorWorld,
    focal: startMid,
    nextScale: beginScale * 2,
    container,
    viewBox,
    edgePaddingRatio: 0.18,
  });
  const anchorBack = viewport.screenToWorld(zoomed, container, startMid);
  assert.ok(
    Math.abs(anchorBack.x - anchorWorld.x) < 1e-9 && Math.abs(anchorBack.y - anchorWorld.y) < 1e-9,
    "捏合后锚点世界坐标应仍在 focal 屏幕位置",
  );
  assert.ok(Math.abs(container.width / zoomed.width - beginScale * 2) < 1e-9, "捏合到指定 scale");

  // 中点平移（两指同向滑动）：世界锚点 1:1 跟随新 focal
  const movedMid = { x: startMid.x + 60, y: startMid.y - 40 };
  const followed = viewport.pinchWindow({
    anchorWorld,
    focal: movedMid,
    nextScale: beginScale * 2,
    container,
    viewBox,
    edgePaddingRatio: 0.18,
  });
  const anchorFollow = viewport.screenToWorld(followed, container, movedMid);
  assert.ok(
    Math.abs(anchorFollow.x - anchorWorld.x) < 1e-9 && Math.abs(anchorFollow.y - anchorWorld.y) < 1e-9,
    "中点平移时锚点应跟住新 focal 屏幕位置",
  );
  // 窗口位移 = 中点位移 / scale（手指右移 60px → 窗口左移 60/scale 世界单位）
  const scale = container.width / followed.width;
  assert.ok(
    Math.abs(followed.x - zoomed.x + 60 / scale) < 1e-9,
    "中点右移 60px，窗口应左移 60/scale 世界单位",
  );
}

console.log("miniprogram-map-viewport: all assertions passed");
