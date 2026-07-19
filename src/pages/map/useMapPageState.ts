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
  const [searchOrder, setSearchOrder] = useState<string[] | null>(null);
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
      return;
    }
    const controller = new AbortController();
    const campusId = CAMPUS_ID_BY_KEY[selectedCampus];
    const timer = window.setTimeout(() => {
      searchRelease({ q: trimmed, campusId }, controller.signal)
        .then((response) => setSearchOrder(response.results.map((result) => result.id)))
        .catch(() => {
          if (!controller.signal.aborted) setSearchOrder([]);
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

  const openPoi = (poiKey: string, source: "map_object" | "search_result" | "deep_link" = "search_result") => {
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
    setSheetMode("poi");
    addRecent(poiKey);
  };

  const openPoiBySvgId = (svgElementId: string) => {
    const building = campusBuildings.find((item) => item.svgElementId === svgElementId);
    if (building) openPoi(building.poiKey, "map_object");
  };

  const closePoi = () => {
    setSelectedPoiKey(null);
    setSheetMode(previousSheetMode);
  };

  const handleQueryChange = (next: string) => {
    setQuery(next);
    setSelectedPoiKey(null);
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

  const resetForCampus = (nextCampus: CampusKey) => {
    setSelectedCampus(nextCampus);
    setQuery("");
    setActiveFilter(null);
    setSelectedPoiKey(null);
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
    resetForCampus,
  };
}
