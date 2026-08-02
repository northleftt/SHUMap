import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { search as searchRelease } from "../../lib/api/public";
import { recordAnalyticsEvent } from "../../lib/analytics";
import { useRelease } from "../../lib/release/ReleaseContext";
import { useRecents } from "../../lib/storage/recents";
import type { CampusKey, FilterKey, MapBuilding } from "../../lib/types";

export type MapSheetMode = "collapsed" | "home" | "results" | "poi";
export type MapSearchStatus = "idle" | "loading" | "ready" | "error";

function filterMapBuildings(
  buildings: MapBuilding[],
  activeFilter: FilterKey | null,
  searchOrder: string[] | null,
): MapBuilding[] {
  const matchesFilter = (building: MapBuilding) =>
    activeFilter ? building.filterGroups.includes(activeFilter) : true;
  if (searchOrder === null) return buildings.filter(matchesFilter);
  const byId = new Map(buildings.map((building) => [building.id, building]));
  return searchOrder.flatMap((id) => {
    const building = byId.get(id);
    return building && matchesFilter(building) ? [building] : [];
  });
}

/** M1 地图页状态：校区/搜索/筛选/选中 POI/sheet 档位 + ?poi= 深链。 */
export function useMapPageState() {
  const releaseState = useRelease();
  const releaseStatus = releaseState.status;
  const release = releaseState.status === "ready" ? releaseState.release : null;
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedCampus, setSelectedCampus] = useState<CampusKey | null>(null);
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<FilterKey | null>(null);
  const [sheetMode, setSheetMode] = useState<MapSheetMode>("home");
  const [previousSheetMode, setPreviousSheetMode] = useState<Exclude<MapSheetMode, "poi">>("home");
  const [selectedPoiKey, setSelectedPoiKey] = useState<string | null>(null);
  const [selectedMerchantId, setSelectedMerchantId] = useState<string | null>(null);
  const [searchOrder, setSearchOrder] = useState<string[] | null>(null);
  const [searchStatus, setSearchStatus] = useState<MapSearchStatus>("idle");
  const [searchError, setSearchError] = useState("");
  const [searchRequestVersion, setSearchRequestVersion] = useState(0);
  // 搜索命中的商户 → 其所在楼宇（商户不单设页面，落地到楼宇详情内的商户视图）
  const [merchantHitByPlace, setMerchantHitByPlace] = useState<Record<string, string>>({});
  const deepLinkAppliedRef = useRef(false);
  const { addRecent } = useRecents();

  const campuses = release ? release.campuses : null;
  const buildings = release ? release.buildings : null;
  const selectedCampusIndex = release && selectedCampus
    ? release.campuses.findIndex((item) => item.key === selectedCampus)
    : -1;
  const campus = release ? release.campuses[selectedCampusIndex >= 0 ? selectedCampusIndex : 0] : null;
  const activeCampusKey = campus ? campus.key : null;

  const campusBuildings = useMemo(
    () => buildings ? buildings.filter((building) => building.campusKey === activeCampusKey) : null,
    [activeCampusKey, buildings],
  );
  const buildingById = useMemo(() => {
    const map = new Map<string, MapBuilding>();
    if (buildings) for (const building of buildings) map.set(building.id, building);
    return map;
  }, [buildings]);

  useEffect(() => {
    if (campus) recordAnalyticsEvent({ eventType: "map_view", campus: campus.label });
  }, [campus]);

  // 服务端搜索（180ms 防抖）；结果仅作排序，渲染仍走 release 里的 building
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchOrder(null);
      setMerchantHitByPlace({});
      setSearchStatus("idle");
      setSearchError("");
      return;
    }
    const controller = new AbortController();
    if (!campus) {
      setSearchOrder([]);
      setMerchantHitByPlace({});
      setSearchStatus("idle");
      setSearchError("");
      return;
    }
    setSearchOrder([]);
    setMerchantHitByPlace({});
    setSearchStatus("loading");
    setSearchError("");
    const campusId = campus.id;
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
          setSearchStatus("ready");
          setSearchError("");
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            setSearchOrder([]);
            setMerchantHitByPlace({});
            setSearchStatus("error");
            setSearchError(error instanceof Error ? error.message : "搜索服务暂时不可用");
          }
        });
    }, 180);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [campus, query, searchRequestVersion]);

  const filteredResults = useMemo(() => {
    if (!campusBuildings) return null;
    return filterMapBuildings(campusBuildings, activeFilter, searchOrder);
  }, [activeFilter, campusBuildings, searchOrder]);

  const selectedPoi = buildings?.find((building) => building.poiKey === selectedPoiKey) ?? null;

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
    if (building.campusKey !== activeCampusKey) setSelectedCampus(building.campusKey);
    setSelectedPoiKey(poiKey);
    // 搜索命中商户时直接落到该商户视图，否则展示楼宇详情
    const merchant = merchantId === undefined ? merchantHitByPlace[poiKey] ?? null : merchantId;
    setSelectedMerchantId(merchant && building.merchants.some((item) => item.id === merchant) ? merchant : null);
    setSheetMode("poi");
    addRecent(poiKey);
  };

  const openPoiByFeatureId = (featureId: string) => {
    const building = campusBuildings?.find((item) => item.mapFeatureId === featureId);
    if (building) openPoi(building.poiKey, "map_object", null);
  };

  const closePoi = () => {
    setSelectedPoiKey(null);
    setSelectedMerchantId(null);
    setSheetMode(previousSheetMode);
  };

  const handleQueryChange = (next: string) => {
    setQuery(next);
    setSearchOrder(next.trim() ? [] : null);
    setMerchantHitByPlace({});
    setSearchStatus(next.trim() ? "loading" : "idle");
    setSearchError("");
    setSelectedPoiKey(null);
    setSelectedMerchantId(null);
    setSheetMode(next.trim() ? "results" : "home");
  };

  const handleQueryFocus = () => setSheetMode("results");

  const clearQuery = () => {
    setQuery("");
    setSearchOrder(null);
    setMerchantHitByPlace({});
    setSearchStatus("idle");
    setSearchError("");
    setSheetMode("home");
  };

  const retrySearch = () => {
    if (!query.trim()) return;
    setSearchOrder([]);
    setMerchantHitByPlace({});
    setSearchStatus("loading");
    setSearchError("");
    setSearchRequestVersion((version) => version + 1);
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
    setSearchOrder(null);
    setMerchantHitByPlace({});
    setSearchStatus("idle");
    setSearchError("");
    setActiveFilter(null);
    setSelectedPoiKey(null);
    setSelectedMerchantId(null);
    setSheetMode("home");
    setPreviousSheetMode("home");
  };

  // /map?poi=<placeId> 深链（M3 上下车点跳转）
  useEffect(() => {
    if (deepLinkAppliedRef.current || !buildings) return;
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

  const matchedFeatureIds = useMemo(() => {
    if (!filteredResults || sheetMode === "poi" || !searchActive) return [];
    return filteredResults.map((building) => building.mapFeatureId);
  }, [filteredResults, searchActive, sheetMode]);

  const sharedState = {
    query,
    activeFilter,
    sheetMode,
    setSheetMode,
    selectedPoi,
    selectedMerchantId,
    searchActive,
    searchStatus,
    searchError,
    matchedFeatureIds,
    openPoi,
    openPoiByFeatureId,
    closePoi,
    handleQueryChange,
    handleQueryFocus,
    clearQuery,
    retrySearch,
    handleFilterToggle,
    handleFilterHighlight,
    resetForCampus,
  };

  if (releaseState.status !== "ready") {
    return {
      ...sharedState,
      releaseStatus: releaseState.status,
      releaseData: null,
      campuses: null,
      campus: null,
      selectedCampus,
      campusBuildings: null,
      filteredResults: null,
    };
  }

  // 复用上面的 memo，不再重算一份：campusBuildings / filteredResults 会作为
  // MapCanvas 定位 effect 的依赖，每次渲染都换新数组会让该 effect 反复重跑
  // （曾导致 setViewWindow 无限循环，把路由切换一起饿死）。
  if (!campus || !campusBuildings || !filteredResults) {
    throw new Error("Release is ready but campus data is missing");
  }
  return {
    ...sharedState,
    releaseStatus: "ready" as const,
    releaseData: releaseState.release,
    campuses: releaseState.release.campuses,
    campus,
    selectedCampus: campus.key,
    campusBuildings,
    filteredResults,
  };
}
