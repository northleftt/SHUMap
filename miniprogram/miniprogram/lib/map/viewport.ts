// 地图视口纯函数。移植自 Web 端 src/components/map/MapCanvas.tsx 的视口数学
// （createInitialViewport/viewportToWindow/clampWindow/focusPointWindow/zoomAt/pinch），
// 模型完全一致：ViewWindow 是 viewBox 坐标系下当前可见的矩形。
// 差异：渲染侧通过容器 transform（windowToTransform）模拟 SVG viewBox 变化，
// 供 Skyline worklet 驱动底图/标记层平移缩放。纯函数，node 单测可直接跑。

import type { CampusConfig } from "../release/types";

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** viewBox 坐标系下的可见窗口（Web 端 MapCanvas 的 ViewWindow）。 */
export interface ViewWindow {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 容器 transform：screen = world * scale + (translateX, translateY)。 */
export interface ViewTransform {
  scale: number;
  translateX: number;
  translateY: number;
}

export const MAX_ZOOM_SCALE = 6;
export const DRAG_THRESHOLD_PX = 2;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function createInitialViewport(
  campus: CampusConfig,
  viewBox: Size,
  container: Size,
): ViewTransform {
  const fitScale = Math.min(container.width / viewBox.width, container.height / viewBox.height);
  const scale = fitScale * campus.scaleMultiplier;
  const focusX = campus.focusPoint.x * viewBox.width;
  const focusY = campus.focusPoint.y * viewBox.height;
  return {
    scale,
    translateX: container.width / 2 - focusX * scale,
    translateY: container.height / 2 - focusY * scale,
  };
}

export function viewportToWindow(viewport: ViewTransform, container: Size): ViewWindow {
  return {
    x: -viewport.translateX / viewport.scale,
    y: -viewport.translateY / viewport.scale,
    width: container.width / viewport.scale,
    height: container.height / viewport.scale,
  };
}

export function windowToTransform(window: ViewWindow, container: Size): ViewTransform {
  const scale = container.width / window.width;
  return {
    scale,
    translateX: -window.x * scale,
    translateY: -window.y * scale,
  };
}

/**
 * 单轴平移约束：允许区间以「viewBox 在该轴居中」为中心，两侧各留同样的余量。
 *
 * 窗口比 viewBox 小（放大态）时，这与旧式 [-pad, viewBox-window+pad] 完全等价 ——
 * 那个区间本来就对称于 (viewBox-window)/2。
 *
 * 窗口比 viewBox 大（最小缩放档，短轴装不满容器）时才有区别：旧式把上界写成
 * max(0, viewBox-window)+pad = pad，区间 [-pad, pad] 的中心是 0，也就是把
 * viewBox 顶边钉在容器顶边，于是空白全被挤到下方 —— 延长/宝山最小缩放时下面
 * 那一大片可拖动空白、上面却没有，就是这么来的。现在中心取 (viewBox-window)/2
 * （真正的居中），上下左右留白相等。与 Web 端 MapCanvas.tsx 同式。
 */
function clampAxis(value: number, windowSize: number, viewBoxSize: number, pad: number): number {
  // 放大态：保持老式 [-pad, 余量+pad] 的**原样算式**。它已经对称于余量/2，改写成
  // 「中心 ± 半余量」在数学上等价，但浮点上会差出 1e-14（-165.888 变
  // -165.88799999999998），把钉住边界值的测试搞坏。
  if (windowSize <= viewBoxSize) {
    return clamp(value, -pad, viewBoxSize - windowSize + pad);
  }
  // 最小缩放态（窗口比 viewBox 大）：viewBox 在该轴居中，两侧各留 pad。
  const center = (viewBoxSize - windowSize) / 2;
  return clamp(value, center - pad, center + pad);
}

export function clampWindow(window: ViewWindow, viewBox: Size, edgePaddingRatio: number): ViewWindow {
  return {
    ...window,
    x: clampAxis(window.x, window.width, viewBox.width, viewBox.width * edgePaddingRatio),
    y: clampAxis(window.y, window.height, viewBox.height, viewBox.height * edgePaddingRatio),
  };
}

export function getScale(window: ViewWindow, container: Size): number {
  return container.width / window.width;
}

export function getFitScale(viewBox: Size, container: Size): number {
  return Math.min(container.width / viewBox.width, container.height / viewBox.height);
}

export function getMinScale(campus: CampusConfig, viewBox: Size, container: Size): number {
  return getFitScale(viewBox, container) * campus.minScaleMultiplier;
}

export function createInitialWindow(
  campus: CampusConfig,
  viewBox: Size,
  container: Size,
): ViewWindow {
  return clampWindow(
    viewportToWindow(createInitialViewport(campus, viewBox, container), container),
    viewBox,
    campus.edgePaddingRatio,
  );
}

export function focusPointWindow({
  point,
  currentWindow,
  viewBox,
  container,
  selectionScaleMultiplier,
  selectionEdgePaddingRatio,
  selectionFocusBounds,
}: {
  point: Point;
  currentWindow: ViewWindow;
  viewBox: Size;
  container: Size;
  selectionScaleMultiplier: number;
  selectionEdgePaddingRatio: number;
  selectionFocusBounds?: { top: number; bottom: number };
}): ViewWindow {
  const fitScale = getFitScale(viewBox, container);
  const currentScale = getScale(currentWindow, container);
  const nextScale = Math.max(currentScale, fitScale * selectionScaleMultiplier);
  const nextWidth = container.width / nextScale;
  const nextHeight = container.height / nextScale;
  const safeTop = clamp(selectionFocusBounds?.top ?? 72, 0, container.height - 1);
  const safeBottom = clamp(
    selectionFocusBounds?.bottom ?? container.height - 120,
    safeTop + 40,
    container.height,
  );
  const targetScreenY = safeTop + (safeBottom - safeTop) * 0.5;
  return clampWindow(
    {
      x: point.x - nextWidth / 2,
      y: point.y - (targetScreenY / container.height) * nextHeight,
      width: nextWidth,
      height: nextHeight,
    },
    viewBox,
    selectionEdgePaddingRatio,
  );
}

/**
 * 以屏幕上一点为锚缩放（zoomAt / pinch 共用）：锚点对应的世界坐标在缩放前后
 * 保持在同一屏幕比例位置。point 是容器本地坐标（px）。
 */
export function zoomWindowAt(
  current: ViewWindow,
  point: Point,
  nextScale: number,
  container: Size,
  viewBox: Size,
  edgePaddingRatio: number,
): ViewWindow {
  const ratioX = point.x / container.width;
  const ratioY = point.y / container.height;
  const worldX = current.x + current.width * ratioX;
  const worldY = current.y + current.height * ratioY;
  const nextWidth = container.width / nextScale;
  const nextHeight = container.height / nextScale;
  return clampWindow(
    {
      x: worldX - nextWidth * ratioX,
      y: worldY - nextHeight * ratioY,
      width: nextWidth,
      height: nextHeight,
    },
    viewBox,
    edgePaddingRatio,
  );
}

/**
 * 双指捏合：锚定**手势起点中点**的世界坐标，让它在捏合全程保持在**当前双指中点**
 * 的屏幕位置——缩放绕中点进行、双指同向移动 = 1:1 平移，与单指速度无关。
 * （旧实现 zoomWindowAt(beginWin, 当前中点, …) 锚的是「起点窗口下当前中点位置」的
 * 世界点，中点一动锚点就换，单侧手指快会把图往快侧拽、双侧都快会反向滑。）
 * anchorWorld = screenToWorld(beginWin, container, 起点中点)，focal = 当前中点
 * （均为容器本地 px），nextScale 由调用方 clamp。
 */
export function pinchWindow({
  anchorWorld,
  focal,
  nextScale,
  container,
  viewBox,
  edgePaddingRatio,
}: {
  anchorWorld: Point;
  focal: Point;
  nextScale: number;
  container: Size;
  viewBox: Size;
  edgePaddingRatio: number;
}): ViewWindow {
  const nextWidth = container.width / nextScale;
  const nextHeight = container.height / nextScale;
  return clampWindow(
    {
      x: anchorWorld.x - nextWidth * (focal.x / container.width),
      y: anchorWorld.y - nextHeight * (focal.y / container.height),
      width: nextWidth,
      height: nextHeight,
    },
    viewBox,
    edgePaddingRatio,
  );
}

/** 拖动平移：delta 是屏幕 px 位移（手指移动方向与地图移动方向一致）。 */
export function panWindowBy(
  current: ViewWindow,
  deltaX: number,
  deltaY: number,
  container: Size,
  viewBox: Size,
  edgePaddingRatio: number,
): ViewWindow {
  const scale = getScale(current, container);
  return clampWindow(
    {
      ...current,
      x: current.x - deltaX / scale,
      y: current.y - deltaY / scale,
    },
    viewBox,
    edgePaddingRatio,
  );
}

/** 屏幕（容器本地 px）→ viewBox 世界坐标。 */
export function screenToWorld(window: ViewWindow, container: Size, point: Point): Point {
  return {
    x: window.x + (point.x / container.width) * window.width,
    y: window.y + (point.y / container.height) * window.height,
  };
}

/** viewBox 世界坐标 → 屏幕（容器本地 px）。 */
export function worldToScreen(window: ViewWindow, container: Size, point: Point): Point {
  return {
    x: ((point.x - window.x) / window.width) * container.width,
    y: ((point.y - window.y) / window.height) * container.height,
  };
}
