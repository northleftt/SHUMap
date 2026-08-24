// 底部抽屉整卡拖拽的手势归属与落档规则（Web 端；与小程序端
// miniprogram/miniprogram/lib/map/sheet.ts 同一套判定，用例也同一组）。
//
// 2026-08-24：拖拽命中区从 28px 把手扩到整张卡片。判定是**空间的**——手指落点
// 在纵向滚动框里 → 归列表，落在别处（搜索行 / 标签筛选 / 标题行）→ 归卡片。
// 不看时序、不看 scrollTop，所以两端都不需要跨线程读滚动状态。
// 例外只有一条：results / poi 档列表占了九成面积，保留「滚到顶继续下拉 = 降档 /
// 关详情」的出口（iOS 习惯），这两档在滚动框内先记 pending，由
// resolveSheetDragOwner 在首次位移到达容差时决定是否接管。

/** poi 档下拉超过该值 = 关闭详情。 */
export const SHEET_CLOSE_THRESHOLD_PX = 70;

/** 首次位移超过该值才判定归属（与小程序端地图面 tap 容差同口径）。 */
export const SHEET_DRAG_TOLERANCE_PX = 8;

/**
 * 甩动阈值（px/ms）：整卡可拖之后手势变短变快（用户不再瞄准把手），只看位移
 * 投影会「甩了一下没换档」。超过该速度无条件走该方向的相邻档。
 */
export const SHEET_FLING_VELOCITY = 0.5;
/** 松手位置向速度方向的外推时长：投影位置 = 松手位置 + v×该值，再取最近档。 */
export const SHEET_VELOCITY_PROJECTION_MS = 150;
/** 越界阻尼系数：最高档继续上拉 / 最低档继续下拉，超界位移只按此比例生效。 */
export const SHEET_OVERSCROLL_FACTOR = 0.3;

/** 默认保留「滚到顶继续下拉」出口的档位（列表占满卡片的那两档）。 */
export const PULL_DOWN_EXIT_MODES: readonly string[] = ["results", "poi"];

/** 手势归属：sheet = 拖抽屉，scroll = 让列表滚，pending = 待定。 */
export type SheetGestureOwner = "sheet" | "scroll" | "pending";

/**
 * 按手指落点判定手势归属。
 * - fromHandle：把手永远归抽屉（不看档位、不看落点）。
 * - 落点不在纵向滚动框内，或该框内容没溢出（不可滚）→ 归抽屉，整卡可拖。
 * - 落在可滚的框内：results / poi 档记 pending（留下拉出口），其余档归列表
 *   （home 档列表照常滚，抬档得抓上半部分或点全屏钮）。
 */
export function sheetGestureOwner({
  mode,
  fromHandle,
  inScrollArea,
  scrollable,
  pullDownExitModes = PULL_DOWN_EXIT_MODES,
}: {
  mode: string;
  fromHandle: boolean;
  inScrollArea: boolean;
  scrollable: boolean;
  pullDownExitModes?: readonly string[];
}): SheetGestureOwner {
  if (fromHandle) return "sheet";
  if (!inScrollArea || !scrollable) return "sheet";
  return pullDownExitModes.includes(mode) ? "pending" : "scroll";
}

/**
 * 首次位移到达容差时的最终归属（touchstart 的 owner + 本次位移一起定）。
 * 一旦返回非 null，整个手势期间不再易主（不做同手势内的链式接管——小程序侧
 * scroll-view 滚动是原生的，中途接管只能靠写 scroll-top，必然掉帧；为两端
 * 手感一致，Web 端也不单独加）。
 * - 位移未到容差 → null，继续等下一帧。
 * - 横向意图（|dx| > |dy|，标签筛选 chip 行 / 商户图轮播）→ 让位，不拖抽屉。
 * - owner=sheet → 拖抽屉；owner=scroll → 让列表滚。
 * - owner=pending → 列表在顶部且下滑才接管。
 */
export function resolveSheetDragOwner({
  owner,
  fromHandle = false,
  deltaX,
  deltaY,
  scrollTop,
  tolerance = SHEET_DRAG_TOLERANCE_PX,
}: {
  owner: SheetGestureOwner;
  fromHandle?: boolean;
  deltaX: number;
  deltaY: number;
  scrollTop: number;
  tolerance?: number;
}): "sheet" | "scroll" | null {
  if (owner === "scroll") return "scroll";
  if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < tolerance) return null;
  // 把手上的横滑没有别的语义，不做轴锁（其余区域横滑要让给 chip 行 / 轮播）。
  if (!fromHandle && Math.abs(deltaX) > Math.abs(deltaY)) return "scroll";
  if (owner === "sheet") return "sheet";
  return deltaY > 0 && scrollTop <= 0 ? "sheet" : "scroll";
}

/**
 * 松手速度（px/ms，正 = 向下）：只取最后两个采样点，别用全程平均——
 * 全程平均会把中途的犹豫算进去，甩动判不出来。
 */
export function sheetDragVelocity(
  previous: { y: number; t: number } | null,
  last: { y: number; t: number } | null,
): number {
  if (!previous || !last) return 0;
  const dt = last.t - previous.t;
  if (!Number.isFinite(dt) || dt <= 0) return 0;
  return (last.y - previous.y) / dt;
}

/**
 * 越界阻尼：[minTop, maxTop] 内原样跟手，超出部分按 factor 折算。
 * 比硬 clamp 更像「到底了」，松手仍由吸附拉回。
 */
export function dampSheetTop(
  rawTop: number,
  minTop: number,
  maxTop: number,
  factor = SHEET_OVERSCROLL_FACTOR,
): number {
  if (rawTop < minTop) return minTop - (minTop - rawTop) * factor;
  if (rawTop > maxTop) return maxTop + (rawTop - maxTop) * factor;
  return rawTop;
}

/** poi 档松手是否关闭详情：下拉超阈值，或向下甩动超速度阈值。 */
export function shouldClosePoiOnRelease(
  deltaY: number,
  velocity: number,
  closeThresholdPx = SHEET_CLOSE_THRESHOLD_PX,
): boolean {
  return deltaY > closeThresholdPx || velocity > SHEET_FLING_VELOCITY;
}

/**
 * 松手落档（带速度）。top 越大 = 抽屉越矮；velocity 正 = 向下。
 * - |v| 超过甩动阈值：无条件走该方向的相邻档（不看位移，快速小幅甩动也换档）。
 * - 否则：把松手位置按速度外推 SHEET_VELOCITY_PROJECTION_MS 再取最近档。
 */
export function snapModeWithVelocity<TMode extends string>({
  releasedTop,
  velocity,
  candidates,
  topForMode,
  currentMode,
}: {
  releasedTop: number;
  velocity: number;
  candidates: readonly TMode[];
  topForMode: (mode: TMode) => number;
  currentMode: TMode;
}): TMode | null {
  if (candidates.length === 0) return null;
  if (Math.abs(velocity) > SHEET_FLING_VELOCITY) {
    // top 降序 = 抽屉由矮到高（对齐小程序端 SNAP_ORDER 的 collapsed→results）
    const ordered = [...candidates].sort((a, b) => topForMode(b) - topForMode(a));
    const from = ordered.indexOf(currentMode);
    if (from >= 0) {
      // 向下甩（velocity > 0）= 降一档；向上甩 = 升一档。
      const next = Math.max(0, Math.min(ordered.length - 1, from + (velocity > 0 ? -1 : 1)));
      return ordered[next];
    }
  }
  const projectedTop = releasedTop + velocity * SHEET_VELOCITY_PROJECTION_MS;
  return candidates.reduce((closest, current) =>
    Math.abs(projectedTop - topForMode(current)) < Math.abs(projectedTop - topForMode(closest))
      ? current
      : closest,
  );
}
