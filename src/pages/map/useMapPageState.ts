import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { search as searchRelease } from "../../lib/api/public";
import { recordAnalyticsEvent } from "../../lib/analytics";
import { campusConfigs } from "../../lib/release/mapData";
import { useRelease } from "../../lib/release/ReleaseContext";
import { useRecents } from "../../lib/storage/recents";
import type { CampusKey, FilterKey, MapBuilding } from "../../lib/types";

export type MapSheetMode = "collapsed" | "home" | "results" | "poi";

const EMPTY_BUILDINGS: MapBuilding[] = [];

const CAMPUS_ID_BY_KEY: Record<CampusKey, string> = {
  baoshan: "campus_baoshan",
  jiading: "campus_jiading",
  yanchang: "campus_yanchang",
};

export { CAMPUS_ID_BY_KEY };

/** M1 地图页状态：校区/搜索/筛选/选中 POI/sheet 档位 + ?poi= 深链。 */
export function useMapPageState() {
  const { status: releaseStatus, release } = useRelease();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedCampus, setSelectedCampus] = useState<CampusKey>("baoshan");
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<FilterKey | null>(null);
  const [sheetMode, setSheetMode] = useState<MapSheetMode>("home");
  const [previousSheetMode, setPreviousSheetMode] = useState<Exclude<MapSheetMode, "poi">>("home");
  const [selectedPoiKey, setSelectedPoiKey] = useState<string | null>(null);
  const [selectedMerchantId, setSelectedMerchantId] = useState<string | null>(null);
  const [searchOrder, setSearchOrder] = useState<string[] | null>(null);
  // 搜索命中的商户 → 其所在楼宇（商户不单设页面，落地到楼宇详情内的商户视图）
  const [merchantHitByPlace, setMerchantHitByPlace] = useState<Record<string, string>>({});
  const deepLinkAppliedRef = useRef(false);
  const { addRecent } = useRecents();

  const buildings = release?.buildings ?? EMPTY_BUILDINGS;
  const campus = campusConfigs.find((item) => item.key === selectedCampus) ?? campusConfigs[0];
  const campusBuildings = useMemo(
    () => buildings.filter((building) => building.campusKey === selectedCampus),
    [buildings, selectedCampus],
  );
  const buildingById = useMemo(() => {
    const map = new Map<string, MapBuilding>();
    for (const building of buildings) map.set(building.id, building);
    return map;
  }, [buildings]);

  useEffect(() => {
    recordAnalyticsEvent({ eventType: "map_view", campus: campus.label });
  }, [campus.label]);

  // 服务端搜索（180ms 防抖）；结果仅作排序，渲染仍走 release 里的 building
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchOrder(null);
      setMerchantHitByPlace({});
      return;
    }
    const controller = new AbortController();
    const campusId = CAMPUS_ID_BY_KEY[selectedCampus];
    const timer = window.setTimeout(() => {
      searchRelease({ q: trimmed, campusId }, controller.signal)
        .then((response) => {
          // 商户 / 设施命中折叠到所在楼宇（buildingPlaceId），楼宇命中用自身 id
          const order: string[] = [];
          const merchantHits: Record<string, string> = {};
          for (const result of response.results) {
            const placeId = result.type === "place" ? result.id : result.buildingPlaceId;
            if (!placeId) continue;
            if (result.type === "merchant_outlet" && !merchantHits[placeId]) merchantHits[placeId] = result.id;
            if (!order.includes(placeId)) order.push(placeId);
          }
          setSearchOrder(order);
          setMerchantHitByPlace(merchantHits);
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setSearchOrder([]);
            setMerchantHitByPlace({});
          }
        });
    }, 180);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, selectedCampus]);

  const filteredResults = useMemo(() => {
    const matchesFilter = (building: MapBuilding) =>
      activeFilter ? building.filterGroups.includes(activeFilter) : true;
    if (searchOrder === null) return campusBuildings.filter(matchesFilter);
    const ordered: MapBuilding[] = [];
    for (const id of searchOrder) {
      const building = campusBuildings.find((item) => item.id === id);
      if (building && matchesFilter(building)) ordered.push(building);
    }
    return ordered;
  }, [activeFilter, campusBuildings, searchOrder]);

  const selectedPoi = buildings.find((building) => building.poiKey === selectedPoiKey) ?? null;

  const openPoi = (
    poiKey: string,
    source: "map_object" | "search_result" | "deep_link" = "search_result",
    merchantId?: string | null,
  ) => {
    const building = buildingById.get(poiKey);
    if (!building) return;
    recordAnalyticsEvent({
      eventType: "poi_view",
      campus: building.campusLabel,
      poiId: building.poiKey,
      poiName: building.name,
      meta: { source },
    });
    if (sheetMode !== "poi") setPreviousSheetMode(sheetMode === "collapsed" ? "home" : sheetMode);
    if (building.campusKey !== selectedCampus) setSelectedCampus(building.campusKey);
    setSelectedPoiKey(poiKey);
    // 搜索命中商户时直接落到该商户视图，否则展示楼宇详情
    const merchant = merchantId === undefined ? merchantHitByPlace[poiKey] ?? null : merchantId;
    setSelectedMerchantId(merchant && building.merchants.some((item) => item.id === merchant) ? merchant : null);
    setSheetMode("poi");
    addRecent(poiKey);
  };

  const openPoiBySvgId = (svgElementId: string) => {
    const building = campusBuildings.find((item) => item.svgElementId === svgElementId);
    if (building) openPoi(building.poiKey, "map_object", null);
  };

  const closePoi = () => {
    setSelectedPoiKey(null);
    setSelectedMerchantId(null);
    setSheetMode(previousSheetMode);
  };

  const handleQueryChange = (next: string) => {
    setQuery(next);
    setSelectedPoiKey(null);
    setSelectedMerchantId(null);
    setSheetMode(next.trim() ? "results" : "home");
  };

  const handleQueryFocus = () => setSheetMode("results");

  const clearQuery = () => {
    setQuery("");
    setSheetMode("home");
  };

  const handleFilterToggle = (filterKey: FilterKey) => {
    const next = activeFilter === filterKey ? null : filterKey;
    setActiveFilter(next);
    if (next || query.trim()) setSheetMode("results");
    else setSheetMode("home");
  };

  // 图层浮卡入口：只切地图高亮，不动搜索抽屉（与搜索 chips 共享 activeFilter）
  const handleFilterHighlight = (filterKey: FilterKey) => {
    setActiveFilter((cur) => (cur === filterKey ? null : filterKey));
  };

  const resetForCampus = (nextCampus: CampusKey) => {
    setSelectedCampus(nextCampus);
    setQuery("");
    setActiveFilter(null);
    setSelectedPoiKey(null);
    setSelectedMerchantId(null);
    setSheetMode("home");
    setPreviousSheetMode("home");
  };

  // /map?poi=<placeId> 深链（M3 上下车点跳转）
  useEffect(() => {
    if (deepLinkAppliedRef.current || buildings.length === 0) return;
    const poiParam = searchParams.get("poi");
    if (!poiParam) return;
    const building = buildingById.get(poiParam);
    deepLinkAppliedRef.current = true;
    if (building) {
      setSelectedCampus(building.campusKey);
      // 直接展开详情（不走 openPoi 的 campus 判断，避免时序问题）
      if (sheetMode !== "poi") setPreviousSheetMode("home");
      setSelectedPoiKey(building.poiKey);
      setSelectedMerchantId(null);
      setSheetMode("poi");
      addRecent(building.poiKey);
    }
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildings, buildingById, searchParams, setSearchParams]);

  const searchActive = Boolean(query.trim()) || Boolean(activeFilter);

  const matchedIds = useMemo(() => {
    if (sheetMode === "poi" || !searchActive) return [];
    return filteredResults.map((building) => building.svgElementId);
  }, [filteredResults, searchActive, sheetMode]);

  return {
    releaseStatus,
    campus,
    selectedCampus,
    campusBuildings,
    query,
    activeFilter,
    sheetMode,
    setSheetMode,
    selectedPoi,
    selectedMerchantId,
    filteredResults,
    searchActive,
    matchedIds,
    openPoi,
    openPoiBySvgId,
    closePoi,
    handleQueryChange,
    handleQueryFocus,
    clearQuery,
    handleFilterToggle,
    handleFilterHighlight,
    resetForCampus,
  };
}
