import { useEffect, useMemo, useRef, useState } from "react";
import { MapBottomSheet } from "../components/MapBottomSheet";
import { MapCanvas } from "../components/MapCanvas";
import { campusConfigs, filters, loadRelease } from "../lib/mapData";
import type { LoadedRelease } from "../lib/mapData";
import { search as searchRelease } from "../lib/api/public";
import { ApiError } from "../lib/api/client";
import { scaleDesignY, useViewportMetrics } from "../lib/layout";
import type { CampusKey, FilterKey, MapBuilding, MapSheetMode } from "../lib/types";

type ReleaseState =
  | { status: "loading" }
  | { status: "ready"; release: LoadedRelease }
  | { status: "empty" }
  | { status: "error"; message: string };

const SNAP_TOPS = {
  fullscreen_map: 762,
  default_search: 688,
  partial_results: 472,
  full_results: 130,
  poi_detail: 508,
} satisfies Record<MapSheetMode, number>;

const POI_CLOSE_DRAG_THRESHOLD_PX = 70;

/** Stable empty reference so effects/memos don't re-run while a release loads or is unavailable. */
const EMPTY_BUILDINGS: MapBuilding[] = [];

/** Local campus key -> release campus id (campuses[].id). Used to scope search. */
const CAMPUS_ID_BY_KEY: Record<CampusKey, string> = {
  baoshan: "campus_baoshan",
  jiading: "campus_jiading",
  yanchang: "campus_yanchang",
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getDefaultSearchHeight(metrics: ReturnType<typeof useViewportMetrics>) {
  const topPadding = metrics.isCompactHeight ? 24 : 28;
  const searchHeight = metrics.isCompactHeight ? 38 : 41;
  const gapBelowSearch = metrics.isCompactHeight ? 8 : 12;
  return topPadding + searchHeight + gapBelowSearch;
}

function getSheetVisibleHeights(metrics: ReturnType<typeof useViewportMetrics>, filterOpen: boolean) {
  const bottomInset = metrics.tabBarHeight;
  const maxSheetHeight = metrics.screenHeight - bottomInset - metrics.topInset - 10;
  const baseHeight = getDefaultSearchHeight(metrics);

  const defaultSearchHeight = filterOpen
    ? clamp(baseHeight + 80, 168, 210)
    : clamp(baseHeight + 20, 94, 118);
  const partialResultsHeight = metrics.isShortHeight
    ? 320
    : metrics.isCompactHeight
      ? 324
      : 332;
  const poiDetailHeight = metrics.isShortHeight
    ? 300
    : metrics.isCompactHeight
      ? 304
      : 312;

  return {
    fullscreen_map: 24,
    default_search: defaultSearchHeight,
    partial_results: clamp(partialResultsHeight, 308, 356),
    full_results: clamp(maxSheetHeight, 420, metrics.screenHeight - bottomInset - 72),
    poi_detail: clamp(poiDetailHeight, 294, 336),
  } satisfies Record<MapSheetMode, number>;
}

function recordAnalyticsEvent(payload: Record<string, unknown>) {
  fetch("/api/analytics/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

function nearestMode(
  projectedTop: number,
  modes: MapSheetMode[],
  screenHeight: number,
): MapSheetMode {
  return modes.reduce((closest, current) => {
    const closestDistance = Math.abs(projectedTop - scaleDesignY(SNAP_TOPS[closest], screenHeight));
    const currentDistance = Math.abs(projectedTop - scaleDesignY(SNAP_TOPS[current], screenHeight));
    return currentDistance < closestDistance ? current : closest;
  });
}

export function MapPage() {
  const metrics = useViewportMetrics();
  const [selectedCampus, setSelectedCampus] = useState<CampusKey>("baoshan");
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<FilterKey | null>(null);
  const [sheetMode, setSheetMode] = useState<MapSheetMode>("default_search");
  const [previousSheetMode, setPreviousSheetMode] =
    useState<Exclude<MapSheetMode, "poi_detail">>("default_search");
  const [selectedPoiKey, setSelectedPoiKey] = useState<string | null>(null);
  const [campusMenuOpen, setCampusMenuOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const [releaseState, setReleaseState] = useState<ReleaseState>({ status: "loading" });

  const mapBuildings = releaseState.status === "ready" ? releaseState.release.buildings : EMPTY_BUILDINGS;
  const campus = campusConfigs.find((item) => item.key === selectedCampus) ?? campusConfigs[0];
  const campusBuildings = useMemo(() => mapBuildings.filter((building) => building.campusKey === selectedCampus), [mapBuildings, selectedCampus]);

  useEffect(() => {
    const controller = new AbortController();
    setReleaseState({ status: "loading" });
    loadRelease(controller.signal)
      .then((release) => setReleaseState({ status: "ready", release }))
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.isReleaseUnavailable) {
          setReleaseState({ status: "empty" });
          return;
        }
        setReleaseState({ status: "error", message: error instanceof Error ? error.message : "加载失败" });
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    recordAnalyticsEvent({ eventType: "map_view", campus: campus.label });
  }, [campus.label]);

  // Server-driven search: matching place IDs in ranking order, or null when no
  // query is active. Filter chips still narrow by canonical-derived filterGroups.
  const [searchOrder, setSearchOrder] = useState<string[] | null>(null);

  const buildingById = useMemo(() => {
    const map = new Map<string, MapBuilding>();
    for (const building of campusBuildings) map.set(building.id, building);
    return map;
  }, [campusBuildings]);

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
          if (controller.signal.aborted) return;
          setSearchOrder([]);
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

    if (searchOrder === null) {
      // No text query: show the (optionally filtered) campus building set.
      return campusBuildings.filter(matchesFilter);
    }
    // Text query active: preserve server ranking, restricted to this campus.
    const ordered: MapBuilding[] = [];
    for (const id of searchOrder) {
      const building = buildingById.get(id);
      if (building && matchesFilter(building)) ordered.push(building);
    }
    return ordered;
  }, [activeFilter, campusBuildings, buildingById, searchOrder]);

  const selectedPoi =
    campusBuildings.find((building) => building.poiKey === selectedPoiKey) ?? null;

  const hasResults = filteredResults.length > 0;
  const sheetBottom = metrics.tabBarHeight;
  const floatingTop = metrics.topInset;
  const visibleHeights = getSheetVisibleHeights(metrics, filterOpen);
  const currentTop = Math.min(
    scaleDesignY(SNAP_TOPS[sheetMode], metrics.screenHeight),
    metrics.screenHeight - sheetBottom - visibleHeights[sheetMode],
  );
  const selectionFocusBounds = {
    top: floatingTop + (metrics.isShortHeight ? 52 : metrics.isCompactHeight ? 58 : 64),
    bottom: Math.max(
      floatingTop + (metrics.isShortHeight ? 150 : 168),
      currentTop - (sheetMode === "poi_detail" ? (metrics.isShortHeight ? 34 : 40) : 24),
    ),
  };

  const matchedIds = useMemo(() => {
    if (sheetMode === "poi_detail") {
      return [];
    }
    if (!query.trim() && !activeFilter) {
      return [];
    }
    return filteredResults.map((building) => building.svgElementId);
  }, [activeFilter, filteredResults, query, sheetMode]);

  function resetMapState(nextCampus: CampusKey) {
    setSelectedCampus(nextCampus);
    setQuery("");
    setActiveFilter(null);
    setSheetMode("default_search");
    setPreviousSheetMode("default_search");
    setSelectedPoiKey(null);
    setCampusMenuOpen(false);
    setFilterOpen(false);
    setDragOffset(0);
  }

  function handleQueryChange(nextQuery: string) {
    setQuery(nextQuery);
    setSelectedPoiKey(null);

    if (nextQuery.trim()) {
      setSheetMode("full_results");
      return;
    }

    setSheetMode((current) => (current === "full_results" ? "full_results" : "default_search"));
  }

  function handleQueryFocus() {
    setFilterOpen(true);
    if (!metrics.isDesktopPreview) {
      setSelectedPoiKey(null);
      setSheetMode("full_results");
      return;
    }

    if (query.trim() || activeFilter) {
      setSelectedPoiKey(null);
      setSheetMode("full_results");
    }
  }

  function handleFilterToggle(filterKey: FilterKey) {
    setActiveFilter((current) => (current === filterKey ? null : filterKey));
    if (!query.trim()) {
      setSheetMode((current) => (current === "full_results" ? "full_results" : "default_search"));
    }
  }

  function openPoi(svgElementId: string) {
    const building = campusBuildings.find((item) => item.svgElementId === svgElementId);
    if (!building) return;
    recordAnalyticsEvent({
      eventType: "poi_view",
      campus: campus.label,
      poiId: building.poiKey,
      poiName: building.name,
      meta: { source: "map_object", svgElementId },
    });
    if (sheetMode !== "poi_detail") {
      setPreviousSheetMode(sheetMode as Exclude<MapSheetMode, "poi_detail">);
    }
    setSelectedPoiKey(building.poiKey);
    setSheetMode("poi_detail");
  }

  function blurActiveField() {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }

  function collapseSheetToDefaultSearch() {
    blurActiveField();
    setSelectedPoiKey(null);
    setSheetMode("default_search");
  }

  function closePoi() {
    setSelectedPoiKey(null);
    setSheetMode(previousSheetMode);
  }

  function clearQuery() {
    setQuery("");
    setSheetMode("default_search");
  }

  function handleSheetPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    const startY = event.clientY;
    const startOffset = dragOffset;
    const startTop = currentTop;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      setDragOffset(startOffset + (moveEvent.clientY - startY));
    };

    const handlePointerUp = (upEvent: PointerEvent) => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);

      const totalOffset = startOffset + (upEvent.clientY - startY);
      setDragOffset(0);

      if (sheetMode === "poi_detail") {
        if (totalOffset > POI_CLOSE_DRAG_THRESHOLD_PX) {
          closePoi();
        }
        return;
      }

      const allowedModes = query.trim()
        ? (["full_results"] as MapSheetMode[])
        : (["fullscreen_map", "default_search"] as MapSheetMode[]);

      const nextMode = nearestMode(startTop + totalOffset, allowedModes, metrics.screenHeight);
      setSheetMode(nextMode);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  }

  return (
    <div className="relative h-full w-full overflow-hidden">
      <MapCanvas
        campus={campus}
        currentBuildingIds={campusBuildings.map((building) => building.svgElementId)}
        matchedIds={matchedIds}
        onSelectBuilding={openPoi}
        onTapEmpty={() => {
          setFilterOpen(false);
          if (sheetMode === "full_results" || sheetMode === "poi_detail") {
            collapseSheetToDefaultSearch();
          }
        }}
        selectedId={selectedPoi?.svgElementId ?? null}
        selectionFocusBounds={selectionFocusBounds}
      />

      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-white/22 via-white/10 to-transparent"
        style={{ height: metrics.mapFadeOverlayHeight }}
      />

      {releaseState.status === "empty" || releaseState.status === "error" ? (
        <div className="pointer-events-none absolute inset-x-0 top-1/2 z-20 flex -translate-y-1/2 justify-center px-8">
          <div className="pointer-events-auto max-w-[300px] rounded-[18px] border border-white/80 bg-white/96 px-5 py-4 text-center shadow-[var(--shadow-floating)] backdrop-blur-md">
            <p className="text-[14px] font-medium text-[var(--color-text)]">
              {releaseState.status === "empty" ? "地图内容尚未发布" : "地图内容加载失败"}
            </p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
              {releaseState.status === "empty"
                ? "当前没有已发布的地图版本，请稍后再试或联系管理员发布。"
                : releaseState.message}
            </p>
          </div>
        </div>
      ) : null}

      <div
        className="absolute z-30"
        style={{ left: metrics.sheetSideInset + metrics.campusSwitcherOffsetX, top: floatingTop }}
      >
        <button
          className={`flex items-center gap-2 rounded-full border border-white/80 bg-white/96 font-medium leading-none text-[var(--color-text)] shadow-[var(--shadow-floating)] backdrop-blur-md ${
            metrics.isShortHeight ? "h-8 px-3.5 text-[12px]" : "h-9 px-4 text-[13px]"
          }`}
          onClick={() => setCampusMenuOpen((open) => !open)}
          type="button"
        >
          <span className="translate-y-[0.5px]">{campus.label}</span>
          <svg
            aria-hidden="true"
            className={`size-4 shrink-0 text-[var(--color-text-muted)] transition-transform ${campusMenuOpen ? "rotate-180" : ""}`}
            viewBox="0 0 16 16"
            fill="none"
          >
            <path
              d="M3.5 6L8 10L12.5 6"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.6"
            />
          </svg>
        </button>

        {campusMenuOpen ? (
          <div
            className={`mt-2 overflow-hidden rounded-[18px] border border-white/70 bg-white/96 p-1 shadow-[var(--shadow-floating)] backdrop-blur ${
              metrics.isShortHeight ? "w-[114px]" : "w-[122px]"
            }`}
          >
            {campusConfigs.map((option) => (
              <button
                key={option.key}
                className={`flex w-full items-center rounded-[14px] px-3 text-left ${
                  metrics.isShortHeight ? "h-8 text-[12px]" : "h-9 text-[13px]"
                } ${
                  option.key === selectedCampus ? "bg-[var(--color-primary-soft)] text-[var(--color-primary)]" : "text-[var(--color-text)]"
                }`}
                onClick={() => resetMapState(option.key)}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <MapBottomSheet
        activeFilter={activeFilter}
        bottom={sheetBottom}
        dragOffset={dragOffset}
        filters={filters}
        hasResults={hasResults}
        mode={sheetMode}
        onClearQuery={clearQuery}
        onClosePoi={closePoi}
        onDragPointerDown={handleSheetPointerDown}
        filterOpen={filterOpen}
        onToggleFilterOpen={() => setFilterOpen((v) => !v)}
        onFilterToggle={handleFilterToggle}
        onOpenFullResults={() => setSheetMode("full_results")}
        onQueryChange={handleQueryChange}
        onQueryFocus={handleQueryFocus}
        onResultClick={(poiKey) => {
          const building = campusBuildings.find((item) => item.poiKey === poiKey);
          if (!building) return;
          recordAnalyticsEvent({
            eventType: "poi_view",
            campus: campus.label,
            poiId: building.poiKey,
            poiName: building.name,
            meta: { source: "search_result", svgElementId: building.svgElementId },
          });
          if (sheetMode !== "poi_detail") {
            setPreviousSheetMode(sheetMode as Exclude<MapSheetMode, "poi_detail">);
          }
          setSelectedPoiKey(poiKey);
          setSheetMode("poi_detail");
        }}
        query={query}
        results={filteredResults}
        selectedPoi={selectedPoi}
        sideInset={metrics.sheetSideInset}
        top={currentTop}
        isCompact={metrics.isCompactHeight}
        isShort={metrics.isShortHeight}
        isNarrow={metrics.isNarrowWidth}
      />
    </div>
  );
}
