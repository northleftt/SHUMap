// 地图筛选纯逻辑（移植自 Web 端 src/pages/map/useMapPageState.ts 的 filterMapPois /
// shouldRenderPointPoi）。两处入口共享同一份 activeFilters：
//   - 搜索面板「标签筛选」chips：过滤结果列表 + 过滤图钉；
//   - 图层浮卡「高亮类别」chips：只改图钉显隐，不弹搜索面板。
// 与 Web 端的差异：设施运营状态不用实时接口快照，直接用 release 冻结的
// poi.facilityOperationalStatus（见 AGENTS.md Part 3 的设施状态约定）。

import type { FilterKey, MapPoi } from "./types";

/**
 * 多选 OR：无选中标签 = 全部命中；否则命中任一标签即保留。
 * searchOrder 非空时按搜索顺序输出（结果仅作排序，实体取自 pois）。
 */
export function filterMapPois(
  pois: MapPoi[],
  activeFilters: readonly FilterKey[],
  searchOrder: string[] | null,
): MapPoi[] {
  const matchesFilter = (poi: MapPoi) =>
    activeFilters.length === 0 || activeFilters.some((filter) => poi.filterGroups.includes(filter));
  if (searchOrder === null) return pois.filter(matchesFilter);
  const byKey = new Map(pois.map((poi) => [poi.poiKey, poi]));
  return searchOrder.flatMap((id) => {
    const poi = byKey.get(id);
    return poi && matchesFilter(poi) ? [poi] : [];
  });
}

/**
 * 点状 POI 图钉可见性决策树（与 Web 端逐分支对齐）：
 *   - 无 markerPoint（楼宇）不出图钉；
 *   - 不可用且策略不允许时隐藏；
 *   - 选中态永远显示；
 *   - 有搜索有筛选：searchable && search && filterable && filter && matched；
 *   - 仅搜索：searchable && search && matched；
 *   - 仅筛选：filterable && filter && matched（默认不显示的独立设施被筛选命中时要显示）；
 *   - 无搜索无筛选：按 visibility.default。
 */
export function shouldRenderPointPoi({
  poi,
  selectedPoiKey,
  queryActive,
  activeFilters,
  matched,
}: {
  poi: MapPoi;
  selectedPoiKey: string | null;
  queryActive: boolean;
  activeFilters: readonly FilterKey[];
  matched: boolean;
}): boolean {
  if (!poi.markerPoint) return false;
  if (poi.facilityOperationalStatus === "unavailable" && !poi.visibility.whenUnavailable) return false;
  if (poi.poiKey === selectedPoiKey) return true;
  if (queryActive && activeFilters.length > 0) {
    return poi.visibility.searchable && poi.visibility.search && poi.visibility.filterable && poi.visibility.filter && matched;
  }
  if (queryActive) return poi.visibility.searchable && poi.visibility.search && matched;
  if (activeFilters.length > 0) return poi.visibility.filterable && poi.visibility.filter && matched;
  return poi.visibility.default;
}
