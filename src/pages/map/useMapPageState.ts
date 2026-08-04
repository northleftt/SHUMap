import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { search as searchRelease } from "../../lib/api/public";
import { recordAnalyticsEvent } from "../../lib/analytics";
import { resolveFacilityStatus, useFacilityStatus } from "../../lib/hooks/useFacilityStatus";
import { useRelease } from "../../lib/release/ReleaseContext";
import { useRecents } from "../../lib/storage/recents";
import type { CampusKey, FilterKey, MapPoi } from "../../lib/types";

export type MapSheetMode = "collapsed" | "home" | "results" | "poi";
export type MapSearchStatus = "idle" | "loading" | "ready" | "error";

type FacilityStatusState = ReturnType<typeof useFacilityStatus>;

export function poiKeyForSearchResult(
  result: { type: string; id: string; buildingPlaceId: string | null },
  availablePoiKeys: ReadonlySet<string>,
): string {
  if (result.buildingPlaceId) return result.buildingPlaceId;
  if (result.type === "place") return availablePoiKeys.has(result.id) ? result.id : `place:${result.id}`;
  return `${result.type === "facility" ? "facility" : "merchant"}:${result.id}`;
}

function filterMapPois(
  pois: MapPoi[],
  activeFilter: FilterKey | null,
  searchOrder: string[] | null,
): MapPoi[] {
  const matchesFilter = (poi: MapPoi) => activeFilter ? poi.filterGroups.includes(activeFilter) : true;
  if (searchOrder === null) return pois.filter(matchesFilter);
  const byKey = new Map(pois.map((poi) => [poi.poiKey, poi]));
  return searchOrder.flatMap((id) => {
    const poi = byKey.get(id);
    return poi && matchesFilter(poi) ? [poi] : [];
  });
}

export function shouldRenderPointPoi({
  poi,
  selectedPoiKey,
  queryActive,
  activeFilter,
  matched,
  facilityStatus,
}: {
  poi: MapPoi;
  selectedPoiKey: string | null;
  queryActive: boolean;
  activeFilter: FilterKey | null;
  matched: boolean;
  facilityStatus: FacilityStatusState;
}): boolean {
  if (!poi.markerPoint) return false;
  const operationalStatus = poi.entityType === "facility" && facilityStatus.status === "ready"
    ? resolveFacilityStatus(facilityStatus.statuses, poi.entityId)
    : poi.facilityOperationalStatus;
  if (operationalStatus === "unavailable" && !poi.visibility.whenUnavailable) return false;
  if (poi.poiKey === selectedPoiKey) return true;
  if (queryActive) return poi.visibility.searchable && poi.visibility.search && matched;
  if (activeFilter) return poi.visibility.filterable && poi.visibility.filter && matched;
  return poi.visibility.default;
}

/** M1 地图页状态：校区/搜索/筛选/选中 POI/sheet 档位 + ?poi= 深链。 */
export function useMapPageState() {
  const releaseState = useRelease();
  const facilityStatus = useFacilityStatus();
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

  const pois = release ? release.pois : null;
  const selectedCampusIndex = release && selectedCampus
    ? release.campuses.findIndex((item) => item.key === selectedCampus)
    : -1;
  const campus = release ? release.campuses[selectedCampusIndex >= 0 ? selectedCampusIndex : 0] : null;
  const activeCampusKey = campus ? campus.key : null;

  const campusPois = useMemo(
    () => pois ? pois.filter((poi) => poi.campusKey === activeCampusKey) : null,
    [activeCampusKey, pois],
  );
  const poiByKey = useMemo(() => {
    const map = new Map<string, MapPoi>();
    if (pois) for (const poi of pois) map.set(poi.poiKey, poi);
    return map;
  }, [pois]);
  const availablePoiKeys = useMemo(() => new Set(poiByKey.keys()), [poiByKey]);

  useEffect(() => {
    if (campus) recordAnalyticsEvent({ eventType: "map_view", campus: campus.label });
  }, [campus]);

  // 服务端搜索（180ms 防抖）；结果仅作排序，渲染实体仍取自 release。
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
          // 有楼宇宿主的商户 / 设施折叠到楼宇；独立实体命中自己的小图标。
          const order: string[] = [];
          const merchantHits: Record<string, string> = {};
          for (const result of response.results) {
            const poiKey = poiKeyForSearchResult(result, availablePoiKeys);
            const poi = poiByKey.get(poiKey);
            if (!poi || (result.type === "facility" && !poi.visibility.searchable)) continue;
            if (result.type === "merchant_outlet" && result.buildingPlaceId && !merchantHits[poiKey]) {
              merchantHits[poiKey] = result.id;
            }
            if (!order.includes(poiKey)) order.push(poiKey);
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
  }, [availablePoiKeys, campus, poiByKey, query, searchRequestVersion]);

  const filteredResults = useMemo(() => {
    if (!campusPois) return null;
    return filterMapPois(campusPois, activeFilter, searchOrder).filter((poi) =>
      !activeFilter || poi.entityType !== "facility" || poi.visibility.filterable,
    );
  }, [activeFilter, campusPois, searchOrder]);

  const selectedPoi = selectedPoiKey ? poiByKey.get(selectedPoiKey) ?? null : null;

  const openPoi = (
    poiKey: string,
    source: "map_object" | "search_result" | "deep_link" = "search_result",
    merchantId?: string | null,
  ) => {
    const poi = poiByKey.get(poiKey);
    if (!poi) return;
    recordAnalyticsEvent({
      eventType: "poi_view",
      campus: poi.campusLabel,
      poiId: poi.entityId,
      poiName: poi.name,
      meta: { source },
    });
    if (sheetMode !== "poi") setPreviousSheetMode(sheetMode === "collapsed" ? "home" : sheetMode);
    if (poi.campusKey !== activeCampusKey) setSelectedCampus(poi.campusKey);
    setSelectedPoiKey(poiKey);
    // 搜索命中商户时直接落到该商户视图，否则展示楼宇详情
    const merchant = merchantId === undefined ? merchantHitByPlace[poiKey] ?? null : merchantId;
    setSelectedMerchantId(merchant && poi.merchants.some((item) => item.id === merchant) ? merchant : null);
    setSheetMode("poi");
    addRecent(poiKey);
  };

  const openPoiByFeatureId = (featureId: string) => {
    const poi = campusPois?.find((item) => item.mapFeatureId === featureId);
    if (poi) openPoi(poi.poiKey, "map_object", null);
  };

  const openPointPoi = (poiKey: string) => openPoi(poiKey, "map_object", null);

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
    if (deepLinkAppliedRef.current || !pois) return;
    const poiParam = searchParams.get("poi");
    if (!poiParam) return;
    const poi = poiByKey.get(poiParam) ?? poiByKey.get(`place:${poiParam}`);
    deepLinkAppliedRef.current = true;
    if (poi) {
      setSelectedCampus(poi.campusKey);
      // 直接展开详情（不走 openPoi 的 campus 判断，避免时序问题）
      if (sheetMode !== "poi") setPreviousSheetMode("home");
      setSelectedPoiKey(poi.poiKey);
      setSelectedMerchantId(null);
      setSheetMode("poi");
      addRecent(poi.poiKey);
    }
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pois, poiByKey, searchParams, setSearchParams]);

  const searchActive = Boolean(query.trim()) || Boolean(activeFilter);

  const matchedFeatureIds = useMemo(() => {
    if (!filteredResults || sheetMode === "poi" || !searchActive) return [];
    return filteredResults.flatMap((poi) => poi.mapFeatureId ? [poi.mapFeatureId] : []);
  }, [filteredResults, searchActive, sheetMode]);

  const visiblePointPois = useMemo(() => {
    if (!campusPois) return null;
    const matched = new Set(filteredResults?.map((poi) => poi.poiKey) ?? []);
    return campusPois.filter((poi) => shouldRenderPointPoi({
      poi,
      selectedPoiKey: selectedPoi?.poiKey ?? null,
      queryActive: Boolean(query.trim()),
      activeFilter,
      matched: matched.has(poi.poiKey),
      facilityStatus,
    }));
  }, [activeFilter, campusPois, facilityStatus, filteredResults, query, selectedPoi?.poiKey]);

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
    facilityStatus,
    matchedFeatureIds,
    openPoi,
    openPoiByFeatureId,
    openPointPoi,
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
      campusPois: null,
      filteredResults: null,
      visiblePointPois: null,
    };
  }

  // 复用上面的 memo，不再重算一份：campusPois / filteredResults 会作为
  // MapCanvas 定位 effect 的依赖，每次渲染都换新数组会让该 effect 反复重跑
  // （曾导致 setViewWindow 无限循环，把路由切换一起饿死）。
  if (!campus || !campusPois || !filteredResults || !visiblePointPois) {
    throw new Error("Release is ready but campus data is missing");
  }
  return {
    ...sharedState,
    releaseStatus: "ready" as const,
    releaseData: releaseState.release,
    campuses: releaseState.release.campuses,
    campus,
    selectedCampus: campus.key,
    campusPois,
    filteredResults,
    visiblePointPois,
  };
}
