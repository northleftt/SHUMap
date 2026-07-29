import { Crosshair, Layers, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MapCanvas, type MapViewWindow } from "../../components/map/MapCanvas";
import { MapEventOverlay, buildEventOverlayItems } from "../../components/map/MapEventOverlay";
import { useSheetDrag } from "../../components/sheet/useSheetDrag";
import { SearchInput } from "../../components/ui/SearchInput";
import { SeverityIcon, severityOf } from "../../components/ui/SeverityBanner";
import { useBreakpoint } from "../../lib/hooks/useBreakpoint";
import { useOperations } from "../../lib/hooks/useOperations";
import { useRelease } from "../../lib/release/ReleaseContext";
import { CampusSwitcher } from "./CampusSwitcher";
import { DesktopMapPanel, PoiMapCard } from "./DesktopMapPanel";
import { LayerPanel } from "./LayerPanel";
import { PoiDetailSheet } from "./PoiDetailSheet";
import { SearchHomeSheet } from "./SearchHomeSheet";
import { useMapPageState, CAMPUS_ID_BY_KEY, type MapSheetMode } from "./useMapPageState";

const TAB_BAR_PX = 64;

/**
 * M1 地图主界面。移动端 = 底部抽屉；桌面端（D1）= 左信息栏 + 地图 + POI 小卡。
 * MapCanvas 保持单一组件树位置，断点切换不重挂载（pan/zoom 状态保留）。
 */
export function MapPage() {
  const state = useMapPageState();
  const { activeEvents } = useOperations();
  const { release } = useRelease();
  const navigate = useNavigate();
  const breakpoint = useBreakpoint();
  const isMobile = breakpoint === "mobile";

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerHeight, setContainerHeight] = useState(760);
  const [viewResetNonce, setViewResetNonce] = useState(0);

  // M8 事件叠加层 + 图层浮卡
  const [layerOn, setLayerOn] = useState(true);
  const [layerPanelOpen, setLayerPanelOpen] = useState(false);
  const [viewWindow, setViewWindow] = useState<MapViewWindow | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  // 几何坐标是各校区的 svg_viewbox，只渲染当前校区的事件（campusId 为空视为通用）
  const overlayItems = useMemo(
    () =>
      buildEventOverlayItems(activeEvents).filter(
        (item) =>
          !item.campusId ||
          item.campusId === CAMPUS_ID_BY_KEY[state.selectedCampus],
      ),
    [activeEvents, state.selectedCampus],
  );
  const selectedEvent = selectedEventId
    ? (overlayItems.find((item) => item.event.id === selectedEventId)?.event ?? null)
    : null;

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setContainerHeight(entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const tabBar = isMobile ? TAB_BAR_PX : 0;
  const visibleHeights: Record<MapSheetMode, number> = {
    collapsed: 78,
    home: Math.min(containerHeight * 0.52, 480),
    results: containerHeight - tabBar - 96,
    poi: Math.min(containerHeight * 0.74, 620),
  };
  const topForMode = (mode: MapSheetMode) => containerHeight - tabBar - visibleHeights[mode];

  const { dragOffset, handlePointerDown } = useSheetDrag<MapSheetMode>({
    mode: state.sheetMode,
    topForMode,
    allowedModes: (mode) => {
      if (mode === "poi") return ["poi"];
      if (state.searchActive) return ["results"];
      return ["collapsed", "home", "results"];
    },
    onModeChange: (mode) => state.setSheetMode(mode),
    onClose: state.sheetMode === "poi" ? state.closePoi : undefined,
  });

  const sheetTop = topForMode(state.sheetMode) + dragOffset;

  // 必须 memo：新对象每次渲染都会触发 MapCanvas 的定位 effect → setViewWindow 死循环
  const selectionFocusBounds = useMemo(
    () =>
      isMobile
        ? { top: 100, bottom: Math.max(160, sheetTop - 24) }
        : { top: 80, bottom: containerHeight - 180 },
    [isMobile, sheetTop, containerHeight],
  );

  return (
    <div ref={containerRef} className="flex h-full w-full overflow-hidden">
      {/* D1 左信息栏（≥768px） */}
      {!isMobile ? <DesktopMapPanel state={state} /> : null}

      <div className="relative min-w-0 flex-1">
        <MapCanvas
          campus={state.campus}
          currentBuildingIds={state.campusBuildings.map((building) => building.svgElementId)}
          matchedIds={state.matchedIds}
          selectedId={state.selectedPoi?.svgElementId ?? null}
          selectionFocusBounds={selectionFocusBounds}
          onSelectBuilding={state.openPoiBySvgId}
          onTapEmpty={() => {
            if (selectedEventId) setSelectedEventId(null);
            else if (layerPanelOpen) setLayerPanelOpen(false);
            else if (state.sheetMode === "poi") state.closePoi();
            else if (state.sheetMode === "results") state.setSheetMode("home");
          }}
          onTapOverlayEvent={(eventId) => {
            setSelectedEventId(eventId);
            setLayerPanelOpen(false);
          }}
          viewResetNonce={viewResetNonce}
          onViewWindowChange={setViewWindow}
          zoomControlPosition={isMobile ? "center-right" : "bottom-right"}
          overlay={
            layerOn ? (
              <MapEventOverlay
                viewWindow={viewWindow}
                items={overlayItems}
                selectedEventId={selectedEventId}
                onSelect={setSelectedEventId}
              />
            ) : null
          }
        />

        {/* 顶部浮层：校区切换（仅移动端） + 图层开关 + 回中 */}
        <div className="absolute inset-x-4 top-4 z-30 flex items-start justify-between">
          {isMobile ? (
            <CampusSwitcher selectedCampus={state.selectedCampus} onSelect={state.resetForCampus} />
          ) : (
            <span />
          )}
          <div className="flex flex-col items-end gap-2">
            <button
              type="button"
              aria-label="回到校区中心"
              className="grid h-11 w-11 place-items-center rounded-full bg-surface text-primary shadow-floating"
              onClick={() => setViewResetNonce((nonce) => nonce + 1)}
            >
              <Crosshair size={19} />
            </button>
            <button
              type="button"
              aria-label="图层"
              aria-pressed={layerPanelOpen}
              className={`relative grid h-11 w-11 place-items-center rounded-full shadow-floating ${
                layerPanelOpen ? "bg-primary text-white" : "bg-surface text-ink"
              }`}
              onClick={() => setLayerPanelOpen((open) => !open)}
            >
              <Layers size={19} />
              {overlayItems.length > 0 ? (
                <span className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-warning px-1 text-[10px] font-bold text-white">
                  {overlayItems.length}
                </span>
              ) : null}
            </button>
          </div>
        </div>

        {/* 图层浮卡：z-40 压过底部抽屉（z-30），移动端可完整滚动 */}
        {layerPanelOpen ? (
          <div className="absolute right-4 top-[120px] z-40">
            <LayerPanel
              eventCount={overlayItems.length}
              eventsOn={layerOn}
              onToggleEvents={() => {
                setLayerOn((on) => !on);
                setSelectedEventId(null);
              }}
              activeFilter={state.activeFilter}
              onToggleFilter={state.handleFilterHighlight}
            />
          </div>
        ) : null}

        {/* M8 事件摘要卡（点选叠加图形后） */}
        {selectedEvent ? (
          <div
            className={`absolute z-30 rounded-2xl bg-surface p-4 shadow-floating ${
              isMobile ? "inset-x-4" : "right-6 w-[320px]"
            }`}
            style={{
              bottom: isMobile
                ? Math.max(tabBar + 16, containerHeight - sheetTop + tabBar + 12)
                : 24,
            }}
          >
            <div className="flex items-center gap-1.5 text-aux font-medium">
              <SeverityIcon severity={severityOf(selectedEvent.severity)} size={15} />
              <span className={
                severityOf(selectedEvent.severity) === "critical"
                  ? "text-error"
                  : severityOf(selectedEvent.severity) === "warning"
                    ? "text-warning"
                    : "text-primary"
              }>
                {selectedEvent.eventType === "closure" ? "关闭" : selectedEvent.eventType === "maintenance" ? "维修" : "通知"}
              </span>
            </div>
            <h3 className="mt-1 text-card">{selectedEvent.title}</h3>
            {selectedEvent.description ? (
              <p className="mt-1 line-clamp-2 text-aux text-sub">{selectedEvent.description}</p>
            ) : null}
            <div className="mt-2.5 flex items-center justify-between">
              <button
                type="button"
                className="text-aux font-medium text-primary"
                onClick={() => {
                  const placeTarget = selectedEvent.targets?.find((t) => t.targetType === "place");
                  if (placeTarget) navigate(`/places/${placeTarget.targetId}/operations`);
                }}
              >
                查看详情 ›
              </button>
              <button
                type="button"
                aria-label="关闭事件摘要"
                className="grid h-7 w-7 place-items-center rounded-full bg-page text-sub"
                onClick={() => setSelectedEventId(null)}
              >
                <X size={14} />
              </button>
            </div>
          </div>
        ) : null}

        {/* release 空态/错误 */}
        {state.releaseStatus === "empty" || state.releaseStatus === "error" ? (
          <div className="pointer-events-none absolute inset-x-0 top-1/2 z-20 flex -translate-y-1/2 justify-center px-8">
            <div className="pointer-events-auto max-w-[300px] rounded-2xl bg-surface px-5 py-4 text-center shadow-floating">
              <p className="text-emphasis">{state.releaseStatus === "empty" ? "地图内容尚未发布" : "地图内容加载失败"}</p>
              <p className="mt-1.5 text-aux leading-relaxed text-sub">
                {state.releaseStatus === "empty" ? "当前没有已发布的地图版本，请稍后再试或联系管理员发布。" : "请检查网络后重试。"}
              </p>
            </div>
          </div>
        ) : null}

        {/* D1 选中 POI 的地图小卡（桌面端） */}
        {!isMobile && state.selectedPoi ? (
          <PoiMapCard building={state.selectedPoi} onClose={state.closePoi} />
        ) : null}

        {/* 底部抽屉（移动端） */}
        {isMobile ? (
          <section className="absolute inset-x-0 z-30" style={{ top: sheetTop, bottom: tabBar }}>
            {/* 拖拽把手 */}
            <div className="pointer-events-none absolute inset-x-0 -top-6 z-40 flex justify-center">
              <div
                className="pointer-events-auto flex h-7 w-24 cursor-grab items-center justify-center touch-none"
                onPointerDown={handlePointerDown}
              >
                <span className="block h-1 w-10 rounded-full bg-white/70 shadow-sm" />
              </div>
            </div>

            {state.sheetMode === "poi" ? (
              <button
                type="button"
                aria-label="关闭详情"
                className="absolute -top-4 right-4 z-40 grid h-9 w-9 place-items-center rounded-full bg-surface text-sub shadow-floating"
                onClick={state.closePoi}
              >
                <X size={16} />
              </button>
            ) : null}

            <div className="h-full overflow-hidden rounded-t-4xl bg-surface shadow-sheet">
              {state.sheetMode === "collapsed" ? (
                <div className="px-4 pt-3">
                  <SearchInput value={state.query} onChange={state.handleQueryChange} onFocus={state.handleQueryFocus} />
                </div>
              ) : state.sheetMode === "poi" && state.selectedPoi ? (
                <div className="h-full overflow-y-auto pt-2">
                  <PoiDetailSheet building={state.selectedPoi} events={activeEvents} />
                </div>
              ) : (
                <div className="h-full pt-2">
                  <SearchHomeSheet
                    query={state.query}
                    activeFilter={state.activeFilter}
                    searchActive={state.searchActive}
                    results={state.filteredResults}
                    onQueryChange={state.handleQueryChange}
                    onQueryFocus={state.handleQueryFocus}
                    onClearQuery={state.clearQuery}
                    onFilterToggle={state.handleFilterToggle}
                    onResultClick={(poiKey) => state.openPoi(poiKey, "search_result")}
                  />
                </div>
              )}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
