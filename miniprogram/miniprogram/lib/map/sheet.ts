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
