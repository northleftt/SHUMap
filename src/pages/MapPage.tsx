import { useMemo, useState } from "react";
import { MapBottomSheet } from "../components/MapBottomSheet";
import { MapCanvas } from "../components/MapCanvas";
import { campusConfigs, filters, getBuildingsByCampus } from "../lib/mapData";
import { scaleDesignY, useViewportMetrics } from "../lib/layout";
import type { CampusKey, FilterKey, MapSheetMode } from "../lib/types";

const SNAP_TOPS = {
  fullscreen_map: 762,
  default_search: 638,
  partial_results: 472,
  full_results: 130,
  poi_detail: 508,
} satisfies Record<MapSheetMode, number>;

const POI_CLOSE_DRAG_THRESHOLD_PX = 70;
const FILTER_PILL_MIN_WIDTH_PX = 70;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getFilterRows(metrics: ReturnType<typeof useViewportMetrics>, filterCount: number) {
  const sheetWidth = metrics.shellWidth - metrics.sheetSideInset * 2;
  const horizontalPadding = metrics.isCompactHeight ? 32 : 40;
  const gapX = metrics.isCompactHeight ? 10 : 12;
  const contentWidth = Math.max(0, sheetWidth - horizontalPadding);
  const columnCount = Math.max(
    1,
    Math.floor((contentWidth + gapX) / (FILTER_PILL_MIN_WIDTH_PX + gapX)),
  );
  return Math.ceil(filterCount / columnCount);
}

function getDefaultSearchHeight(
  metrics: ReturnType<typeof useViewportMetrics>,
  filterCount: number,
) {
  const rows = getFilterRows(metrics, filterCount);
  const topPadding = metrics.isCompactHeight ? 24 : 28;
  const bottomPadding = metrics.isCompactHeight ? 12 : 16;
  const searchHeight = metrics.isCompactHeight ? 38 : 41;
  const gapAbovePills = metrics.isCompactHeight ? 12 : 16;
  const pillHeight = metrics.isCompactHeight ? 24 : 26;
  const gapY = metrics.isCompactHeight ? 8 : 10;
  const contentHeight =
    topPadding +
    searchHeight +
    gapAbovePills +
    rows * pillHeight +
    Math.max(0, rows - 1) * gapY +
    bottomPadding;
  const buffer = rows >= 4 ? 12 : rows === 3 ? 8 : 0;

  return clamp(contentHeight + buffer, 156, 208);
}

function getSheetVisibleHeights(
  metrics: ReturnType<typeof useViewportMetrics>,
  filterCount: number,
) {
  const bottomInset = metrics.tabBarHeight;
  const maxSheetHeight = metrics.screenHeight - bottomInset - metrics.topInset - 10;
  const defaultSearchHeight = getDefaultSearchHeight(metrics, filterCount);
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
    default_search: clamp(defaultSearchHeight, 160, 190),
    partial_results: clamp(partialResultsHeight, 308, 356),
    full_results: clamp(maxSheetHeight, 420, metrics.screenHeight - bottomInset - 72),
    poi_detail: clamp(poiDetailHeight, 294, 336),
  } satisfies Record<MapSheetMode, number>;
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
  const [dragOffset, setDragOffset] = useState(0);

  const campus = campusConfigs.find((item) => item.key === selectedCampus) ?? campusConfigs[0];
  const campusBuildings = useMemo(() => getBuildingsByCampus(selectedCampus), [selectedCampus]);

  const filteredResults = useMemo(() => {
    return campusBuildings.filter((building) => {
      const matchesQuery = query.trim()
        ? building.name.toLowerCase().includes(query.trim().toLowerCase())
        : true;
      const matchesFilter = activeFilter ? building.filterGroups.includes(activeFilter) : true;
      return matchesQuery && matchesFilter;
    });
  }, [activeFilter, campusBuildings, query]);

  const selectedPoi =
    campusBuildings.find((building) => building.poiKey === selectedPoiKey) ?? null;

  const hasResults = filteredResults.length > 0;
  const sheetBottom = metrics.tabBarHeight;
  const floatingTop = metrics.topInset;
  const visibleHeights = getSheetVisibleHeights(metrics, filters.length);
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
        onFilterToggle={handleFilterToggle}
        onOpenFullResults={() => setSheetMode("full_results")}
        onQueryChange={handleQueryChange}
        onQueryFocus={handleQueryFocus}
        onResultClick={(poiKey) => {
          const building = campusBuildings.find((item) => item.poiKey === poiKey);
          if (!building) return;
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
