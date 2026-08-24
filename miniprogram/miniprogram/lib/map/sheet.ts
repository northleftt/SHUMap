// 地图页底部抽屉状态机（对齐 Web 端 useMapPageState + useSheetDrag + MapPage）。
// 四个档位：collapsed（78px，只有搜索框）/ home（搜索框+标签筛选+最近查看）/
// results（近全屏，搜索结果或筛选结果）/ poi（详情卡，不参与吸附，下拉超阈值=关闭；
// poi 可见高度 = 实测内容高度封顶 heights.poi，内容少抽屉坐低、不预留空白）。
// 纯函数，node 单测直接跑；页面侧用 shared 变量 + applyAnimatedStyle 驱动高度。

export type SheetMode = "collapsed" | "home" | "results" | "poi";

export interface SheetHeights {
  collapsed: number;
  home: number;
  results: number;
  poi: number;
}

/** poi 档下拉超过该值 = 关闭详情（对齐 useSheetDrag 的 closeThresholdPx）。 */
export const SHEET_CLOSE_THRESHOLD_PX = 70;

/** 档位切换动画时长分档：短距离（相邻档）快、跨档/POI 开合慢一档（ease-out 曲线在页面侧加）。 */
export const SHEET_ANIMATE_MS_SHORT = 160;
export const SHEET_ANIMATE_MS_LONG = 240;
/** 位移不超过该值算短距离（相邻档切换，如 home↔collapsed ≈ 220px / home↔results ≈ 200px）。 */
export const SHEET_ANIMATE_SHORT_DISTANCE_PX = 260;

/** 吸附/档位切换动画时长：按位移分档，别一刀切（近档跟手、跨档不仓促）。 */
export function sheetAnimateMs(distancePx: number): number {
  return Math.abs(distancePx) <= SHEET_ANIMATE_SHORT_DISTANCE_PX
    ? SHEET_ANIMATE_MS_SHORT
    : SHEET_ANIMATE_MS_LONG;
}

/** 吸附只在这三档之间进行（poi 档不参与）。 */
export const SNAPPABLE_MODES: readonly SheetMode[] = ["collapsed", "home", "results"];

/**
 * 各档位抽屉可见高度（px）。containerHeight = 地图视口高（含 tab 栏条带，
 * 抽屉 bottom 贴 tab 栏顶）；tabBarHeight 必须是自定义 tabBar 的**总高**
 * （64px 内容 + 底部安全区 safe-area-inset-bottom），否则 collapsed 档的
 * 搜索框会被 tab 栏压住一截。对齐 Web 端 visibleHeights：
 * collapsed 78 / home min(h×0.52, 480) / results h−tabBar−56 / poi 上限
 * min(h×0.74, 620)（poi 实际可见高度按内容实测值封顶于此，见 map.ts
 * measurePoiContentHeight 与 MapPage.tsx 的 poiContentHeight）。
 */
export function sheetHeights(
  containerHeight: number,
  tabBarHeight: number,
  topInset = 56,
): SheetHeights {
  return {
    collapsed: 78,
    home: Math.min(containerHeight * 0.52, 480),
    // results 顶边留出 topInset：Web 端固定 56px，小程序要多让出微信胶囊那一行，
    // 否则近全屏的卡片上缘会压到「…／⊙」胶囊底下（拖拽把手也点不到）。
    results: containerHeight - tabBarHeight - topInset,
    poi: Math.min(containerHeight * 0.74, 620),
  };
}

/** 松手吸附：投影高度最近的档位（只吸附 collapsed/home/results）。 */
export function snapSheetMode(projectedHeight: number, heights: SheetHeights): SheetMode {
  let best: SheetMode = "collapsed";
  for (const mode of SNAPPABLE_MODES) {
    if (Math.abs(projectedHeight - heights[mode]) < Math.abs(projectedHeight - heights[best])) {
      best = mode;
    }
  }
  return best;
}

/**
 * 甩动阈值（px/ms）：整卡可拖之后手势变短变快（用户不再瞄准把手），只看位移
 * 投影会「甩了一下没换档」。超过该速度无条件走该方向的相邻档。
 */
export const SHEET_FLING_VELOCITY = 0.5;
/** 松手位置向速度方向的外推时长：投影高度 = 松手高度 + v×该值，再取最近档。 */
export const SHEET_VELOCITY_PROJECTION_MS = 150;
/** 越界阻尼系数：results 档继续上拉 / collapsed 档继续下拉，超界位移只按此比例生效。 */
export const SHEET_OVERSCROLL_FACTOR = 0.3;

/** 按可见高度从小到大排的可吸附档位（甩动找相邻档用）。 */
const SNAP_ORDER: readonly Exclude<SheetMode, "poi">[] = ["collapsed", "home", "results"];

/**
 * 松手落档（带速度）。velocity = 手指纵向速度 px/ms（**正 = 向下**，抽屉变矮）。
 * - |v| 超过甩动阈值：无条件走该方向的相邻档（不看位移，快速小幅甩动也换档）。
 * - 否则：把松手高度按速度外推 SHEET_VELOCITY_PROJECTION_MS 再取最近档。
 */
export function snapSheetModeWithVelocity(
  releasedHeight: number,
  velocity: number,
  heights: SheetHeights,
  currentMode: SheetMode,
): SheetMode {
  if (Math.abs(velocity) > SHEET_FLING_VELOCITY) {
    const from = SNAP_ORDER.indexOf(currentMode as Exclude<SheetMode, "poi">);
    if (from >= 0) {
      // 向下甩（velocity > 0）= 降一档；向上甩 = 升一档。
      const next = clampIndex(from + (velocity > 0 ? -1 : 1), SNAP_ORDER.length);
      return SNAP_ORDER[next];
    }
  }
  // 向下甩使抽屉变矮，故投影高度减去 v×t。
  return snapSheetMode(releasedHeight - velocity * SHEET_VELOCITY_PROJECTION_MS, heights);
}

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(length - 1, index));
}

/** poi 档松手是否关闭详情：下拉超阈值，或向下甩动超速度阈值。 */
export function shouldClosePoiOnRelease(deltaY: number, velocity: number): boolean {
  return deltaY > SHEET_CLOSE_THRESHOLD_PX || velocity > SHEET_FLING_VELOCITY;
}

/**
 * 越界阻尼：[minTop, maxTop] 内原样跟手，超出部分按 SHEET_OVERSCROLL_FACTOR 折算。
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

/* ---------------------------------------------------------------------------
   整卡拖拽的手势归属（2026-08-24：拖拽命中区从 28px 把手扩到整张卡片）。
   判定是**空间的**：手指落点在纵向滚动框里 → 归列表，落在别处 → 归卡片。
   不看 scrollTop、不看时序，两端同一套规则，跨线程也不需要读滚动状态。
   例外只有一条：results / poi 档列表占了九成面积，保留「滚到顶继续下拉 = 降档 /
   关详情」的出口（iOS 习惯），所以这两档在滚动框内先记 pending，
   由 resolveSheetDragOwner 在首次位移到达容差时决定是否接管。
   --------------------------------------------------------------------------- */

/** 手势归属：sheet = 拖抽屉，scroll = 让列表滚，pending = 待定（见 resolveSheetDragOwner）。 */
export type SheetGestureOwner = "sheet" | "scroll" | "pending";

/** 首次位移超过该值才判定方向（复用地图面的 tap 容差口径）。 */
export const SHEET_DRAG_TOLERANCE_PX = 8;

/**
 * 按手指落点判定手势归属。
 * - fromHandle：把手永远归抽屉（不看档位、不看落点）。
 * - 落点不在纵向滚动框内，或该框内容没溢出（不可滚）→ 归抽屉，整卡可拖。
 * - 落在可滚的框内：results / poi 档记 pending（留下拉出口），其余档归列表。
 */
export function sheetGestureOwner({
  mode,
  fromHandle,
  inScrollArea,
  scrollable,
}: {
  mode: SheetMode;
  fromHandle: boolean;
  inScrollArea: boolean;
  scrollable: boolean;
}): SheetGestureOwner {
  if (fromHandle) return "sheet";
  if (!inScrollArea || !scrollable) return "sheet";
  return mode === "results" || mode === "poi" ? "pending" : "scroll";
}

/**
 * 首次位移到达容差时的最终归属（touchstart 的 owner + 本次位移一起定）。
 * 一旦返回非 null，整个手势期间不再易主（不做同手势内的链式接管——小程序侧
 * scroll-view 滚动是原生的，中途接管只能靠 setData 写 scroll-top，必然掉帧；
 * 为两端手感一致，Web 端也不单独加）。
 * - 位移未到容差 → null，继续等下一帧。
 * - 横向意图（|dx| > |dy|，标签筛选 chip 行 / 商户图 swiper）→ 让位，不拖抽屉。
 * - owner=sheet → 拖抽屉；owner=scroll → 让列表滚。
 * - owner=pending（results / poi 档的滚动框内）→ 列表在顶部且下滑才接管。
 */
export function resolveSheetDragOwner({
  owner,
  fromHandle,
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
  // 把手上的横滑没有别的语义，不做轴锁（其余区域横滑要让给 chip 行 / swiper）。
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

/** 输入/清空 query 后的落档（handleQueryChange/clearQuery）：有 query 或有筛选 → results。 */
export function queryMode(query: string, activeFilterCount: number): "results" | "home" {
  return query.trim() || activeFilterCount > 0 ? "results" : "home";
}

/** 搜索面板内 toggle 筛选 chip 后的落档（handleFilterToggle）。 */
export function filterToggleMode(activeFilterCount: number, query: string): "results" | "home" {
  return activeFilterCount > 0 || query.trim() ? "results" : "home";
}

/** openPoi 时记录的回落档：原样保留（collapsed 也回 collapsed——2026-08-10 修订：
 *  关详情回退到上一个状态，全屏回全屏、搜索回搜索、默认回默认，Web 端同步；
 *  poi 档实际调不到（页面侧有守卫），兜底记 home）。 */
export function previousModeBeforePoi(mode: SheetMode): "collapsed" | "home" | "results" {
  return mode === "poi" ? "home" : mode;
}

/** 全屏/恢复浮钮目标档：collapsed → 恢复（searchActive 回 results，否则 home）；其余 → collapsed。 */
export function sheetToggleTarget(mode: SheetMode, searchActive: boolean): SheetMode {
  if (mode === "collapsed") return searchActive ? "results" : "home";
  return "collapsed";
}

/** 全屏/恢复浮钮横向避让：抽屉顶边距视口顶 < 120px 时左移避让右侧控件列。 */
export function sheetToggleShifted(containerHeight: number, tabBarHeight: number, sheetHeight: number): boolean {
  return containerHeight - tabBarHeight - sheetHeight < 120;
}
