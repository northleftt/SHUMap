import { Layers, LocateFixed, Maximize2, Minimize2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { applyGeoTransform, wgs84ToGcj02 } from "../../../shared/geo-transform.mjs";
import { parseSvgViewBox } from "../../../shared/svg-geometry.mjs";
import { campusKeyForGcj02Point, type CampusGeoEntry } from "../../../shared/user-location.mjs";
import { MapCanvas, type MapViewWindow } from "../../components/map/MapCanvas";
import { MapEventOverlay, buildEventOverlayItems } from "../../components/map/MapEventOverlay";
import { MapPoiOverlay } from "../../components/map/MapPoiOverlay";
import {
  MapUserLocationOverlay,
  type UserLocationPosition,
} from "../../components/map/MapUserLocationOverlay";
import { GuideBanner } from "../../components/layout/GuideBanner";
import { useSheetDrag } from "../../components/sheet/useSheetDrag";
import { SearchInput } from "../../components/ui/SearchInput";
import { LoadingState } from "../../components/ui/EmptyState";
import { SeverityIcon, severityOf } from "../../components/ui/SeverityBanner";
import { useBreakpoint } from "../../lib/hooks/useBreakpoint";
import { useOperations } from "../../lib/hooks/useOperations";
import { recordAnalyticsEvent } from "../../lib/analytics";
import { facilityIconKeyMap } from "../../lib/facilityIcons";
import { markerScaleValue, useMarkerScale } from "../../lib/map/markerScale";
import type { CampusKey } from "../../lib/types";
import { CampusSwitcher } from "./CampusSwitcher";
import { DesktopMapPanel, PoiMapCard } from "./DesktopMapPanel";
import { LayerPanel } from "./LayerPanel";
import { OperationDetailSheet } from "./OperationDetailSheet";
import { PoiDetailSheet } from "./PoiDetailSheet";
import { SearchHomeSheet } from "./SearchHomeSheet";
import { useMapPageState, type MapSheetMode } from "./useMapPageState";

const TAB_BAR_PX = 64;

/**
 * M1 地图主界面。移动端 = 底部抽屉；桌面端（D1）= 左信息栏 + 地图 + POI 小卡。
 * MapCanvas 保持单一组件树位置，断点切换不重挂载（pan/zoom 状态保留）。
 */
export function MapPage() {
  const state = useMapPageState();
  const operations = useOperations();
  const breakpoint = useBreakpoint();
  const isMobile = breakpoint === "mobile";

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerHeight, setContainerHeight] = useState(760);
  const [mobileTabBarHeight, setMobileTabBarHeight] = useState(TAB_BAR_PX);

  // D1 桌面端详情面板（移动端走底部抽屉）
  const [desktopDetailOpen, setDesktopDetailOpen] = useState(false);
  // 换 POI 时收起；搜索直接命中商户时自动展开到该商户
  useEffect(() => {
    setDesktopDetailOpen(Boolean(state.selectedPoi && state.selectedMerchantId));
  }, [state.selectedPoi?.poiKey, state.selectedMerchantId]);

  // M8 事件叠加层 + 图层浮卡
  const [layerOn, setLayerOn] = useState(true);
  const [layerPanelOpen, setLayerPanelOpen] = useState(false);
  // 楼外图钉大小档位（localStorage 持久化，图层浮卡里调）
  const [markerScale, setMarkerScale] = useMarkerScale();
  const [viewWindow, setViewWindow] = useState<MapViewWindow | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  // 用户定位 dot：watchPosition 持续更新；定位按钮点击后的居中请求（nonce 递增触发）
  const [userPosition, setUserPosition] = useState<UserLocationPosition | null>(null);
  const [locationFocusRequest, setLocationFocusRequest] = useState<{
    point: { x: number; y: number };
    nonce: number;
  } | null>(null);
  // 定位失败的用户可见提示（数秒后自动消失）
  const [locationHint, setLocationHint] = useState<string | null>(null);
  // 事件详情卡（摘要卡「查看详情」入口）；存 id 而非布尔，换事件后不会残留展开态
  const [detailEventId, setDetailEventId] = useState<string | null>(null);
  // 几何坐标是各校区的 svg_viewbox，只渲染当前校区的事件（campusId 为空视为通用）
  const overlayItems = useMemo(
    () => operations.status === "ready"
      ? buildEventOverlayItems(operations.activeEvents).filter(
        (item) => !item.campusId || item.campusId === state.campus?.id,
      )
      : [],
    [operations, state.campus?.id],
  );
  /* 楼内设施的图标要以管理员在后台选的 icon_key 为准。设施数据里只有 typeCode，
     所以从 manifest 的 facilityTypes 建一张编码 → iconKey 的表传给详情卡。
     不传的话详情卡只能「按编码猜」，那只对出厂九类成立（见 facilityIcons 的
     FACILITY_TYPE_CODE_ICON_KEYS），后台新建的类型一律掉到通用图钉。 */
  const facilityIconKeys = useMemo(
    () => (state.releaseData ? facilityIconKeyMap(state.releaseData.manifest.facilityTypes) : null),
    [state.releaseData],
  );
  const eventById = (id: string | null) =>
    id ? (overlayItems.find((item) => item.event.id === id)?.event ?? null) : null;
  const selectedEvent = eventById(selectedEventId);
  const detailEvent = eventById(detailEventId);

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

  useEffect(() => {
    if (!isMobile) return;
    const tabBarElement = document.querySelector<HTMLElement>("[data-bottom-tab-bar]");
    if (!tabBarElement) return;
    const updateHeight = () => setMobileTabBarHeight(tabBarElement.getBoundingClientRect().height || TAB_BAR_PX);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(tabBarElement);
    return () => observer.disconnect();
  }, [isMobile]);

  const tabBar = isMobile ? mobileTabBarHeight : 0;

  // poi 档抽屉内容自适应：实测 PoiDetailSheet 自然内容高度（封顶 maxPoiHeight），
  // 内容少抽屉坐低、不预留空白；商户子视图切换/图片加载等高度变化由 ResizeObserver
  // 跟踪。useLayoutEffect 在绘制前完成首测，看不到「先按上限撑满再缩回」的一帧。
  const [poiContentHeight, setPoiContentHeight] = useState<number | null>(null);
  const poiMeasureRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!isMobile || state.sheetMode !== "poi") {
      setPoiContentHeight(null);
      return;
    }
    const element = poiMeasureRef.current;
    if (!element) return;
    const measure = () => {
      const next = Math.ceil(element.getBoundingClientRect().height);
      setPoiContentHeight((current) => (current === next ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [isMobile, state.sheetMode, state.selectedPoi?.poiKey, state.selectedMerchantId]);

  const maxPoiHeight = Math.min(containerHeight * 0.74, 620);
  const visibleHeights: Record<MapSheetMode, number> = {
    collapsed: 78,
    home: Math.min(containerHeight * 0.52, 480),
    results: containerHeight - tabBar - 56,
    // poi 档可见高度 = 实测内容高度封顶 maxPoiHeight；未量到时先按上限（首帧前会被校正）
    poi: Math.min(poiContentHeight ?? maxPoiHeight, maxPoiHeight),
  };
  const topForMode = (mode: MapSheetMode) => containerHeight - tabBar - visibleHeights[mode];

  // 抽屉抢到手势后抑制随后的列表行点击（拖完卡片不该误开 POI），松手下一帧解除。
  const sheetDragClaimedRef = useRef(false);
  // 降档时把列表滚回顶部：可见带缩短而列表还停在中间，看起来像坏了。
  const sheetScrollResetRef = useRef<(() => void) | null>(null);

  const { dragOffset, dragging, sheetRef, handlePointerDown, handleKeyDown } = useSheetDrag<MapSheetMode>({
    mode: state.sheetMode,
    topForMode,
    allowedModes: (mode) => {
      if (mode === "poi") return ["poi"];
      return ["collapsed", "home", "results"];
    },
    onModeChange: (mode) => state.setSheetMode(mode),
    onClose: state.sheetMode === "poi" ? state.closePoi : undefined,
    onClaim: () => {
      sheetDragClaimedRef.current = true;
      // results 档带着键盘拖卡片会错位，抢到手势就收键盘
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    },
    onDropToLowerMode: () => sheetScrollResetRef.current?.(),
  });

  /** 列表行点击守卫：本轮手势被抽屉拖拽吃掉时作废（对齐小程序端 consumeSheetTap）。 */
  const consumeSheetDragClick = () => {
    if (!sheetDragClaimedRef.current) return false;
    sheetDragClaimedRef.current = false;
    return true;
  };
  useEffect(() => {
    if (dragging) return;
    // 松手后下一帧解除抑制（click 在 touchend 之后派发，同帧解除会漏放行）
    const timer = window.setTimeout(() => {
      sheetDragClaimedRef.current = false;
    }, 0);
    return () => window.clearTimeout(timer);
  }, [dragging]);

  const sheetTop = topForMode(state.sheetMode) + dragOffset;

  // 全屏/恢复浮钮：复用 sheetMode 档位，收起 = 最小态（地图全屏）。
  // poi 详情态不提供（该位置是关闭按钮）；搜索/筛选生效时恢复回 results 档。
  const restoreMode: MapSheetMode = state.searchActive ? "results" : "home";
  const sheetToggle =
    state.sheetMode === "poi"
      ? null
      : state.sheetMode === "collapsed"
        ? { collapsed: true, target: restoreMode, label: "恢复卡片" }
        : { collapsed: false, target: "collapsed" as MapSheetMode, label: "全屏地图" };
  // 贴在卡片上缘之上。results 档卡片顶边很高，此时上方只剩右侧控件列的空间，
  // 于是横向左移一格避让回中/图层，而不是压到卡片里挡住搜索框。
  const sheetToggleTop = Math.max(16, sheetTop - 56);
  const sheetToggleRight = sheetToggleTop < 120 ? 68 : 16;

  // poi 档关闭钮：整体抬到卡片上缘之上（不再半压卡片上缘、遮挡收藏/标题），
  // 钳制与 sheetToggle 同一套（顶边上方 52px；顶边太高时左移避让右侧控件列）。
  const poiCloseTop = Math.max(16, sheetTop - 52);
  const poiCloseRight = poiCloseTop < 120 ? 68 : 16;

  // 必须 memo：新对象每次渲染都会触发 MapCanvas 的定位 effect → setViewWindow 死循环
  const selectionFocusBounds = useMemo(
    () =>
      isMobile
        ? { top: 100, bottom: Math.max(160, sheetTop - 24) }
        : { top: 80, bottom: containerHeight - 180 },
    [isMobile, sheetTop, containerHeight],
  );

  // 同理必须 memo（在提前 return 之前，保证 hook 顺序稳定）
  const featureBindings = useMemo(
    () =>
      (state.campusPois ?? []).flatMap((poi) =>
        poi.mapFeatureId && poi.sourceElementId
          ? [{ id: poi.mapFeatureId, sourceElementId: poi.sourceElementId }]
          : [],
      ),
    [state.campusPois],
  );

  // 三校区 geoTransform + viewBox 索引（viewBox 解析在此缓存，定位回调不重复解析 SVG）
  const campusGeoIndex = useMemo<CampusGeoEntry[]>(
    () =>
      (state.campuses ?? []).map((campus) => ({
        key: campus.key,
        geoTransform: campus.geoTransform,
        viewBox: parseSvgViewBox(campus.svgRaw),
      })),
    [state.campuses],
  );
  // 首次自动选校区需要读最新的当前校区与切校区动作，走 ref 避免依赖不稳定函数。
  const activeCampusKeyRef = useRef<string | null>(null);
  const resetForCampusRef = useRef(state.resetForCampus);
  useEffect(() => {
    activeCampusKeyRef.current = state.campus?.key ?? null;
  }, [state.campus?.key]);
  useEffect(() => {
    resetForCampusRef.current = state.resetForCampus;
  });

  // 持续定位：挂载即 watchPosition，卸载 clearWatch。非 secure context / 用户拒绝
  // 授权时 error 回调静默处理——只是不显示 dot。maximumAge 允许先拿缓存位置，
  // 随后 watchPosition 再用高精度位置覆盖，避免首次定位等 GPS 冷启动太久。
  useEffect(() => {
    if (!("geolocation" in navigator)) return;
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        setUserPosition({
          longitude: position.coords.longitude,
          latitude: position.coords.latitude,
          accuracy: position.coords.accuracy,
        });
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 30000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  // 首次自动选校区：等「位置」和「校区数据」都就绪后触发一次，与两者到达顺序无关。
  // （watchPosition 可能先于 release 数据返回，若把判定塞进回调、且回调只触发一次，
  // 就会错过这次机会，永远停在默认宝山校区。）之后不再自动切，尊重用户手动切校区。
  const autoCampusDoneRef = useRef(false);
  useEffect(() => {
    if (autoCampusDoneRef.current) return;
    if (!userPosition || campusGeoIndex.length === 0) return;
    autoCampusDoneRef.current = true;
    const gcj = wgs84ToGcj02(userPosition.longitude, userPosition.latitude);
    const campusKey = campusKeyForGcj02Point(campusGeoIndex, gcj.longitude, gcj.latitude);
    if (campusKey && campusKey !== activeCampusKeyRef.current) {
      resetForCampusRef.current(campusKey as CampusKey);
    }
  }, [userPosition, campusGeoIndex]);

  // 定位提示自动消失
  useEffect(() => {
    if (!locationHint) return;
    const timer = setTimeout(() => setLocationHint(null), 4000);
    return () => clearTimeout(timer);
  }, [locationHint]);

  // 定位按钮：立即取一次当前位置；落在哪个校区就切到哪个校区并居中聚焦 dot
  // （缩放档位同 POI 选中聚焦）；不在任何校区内给出提示。
  function handleLocate() {
    if (!("geolocation" in navigator)) {
      setLocationHint("当前环境不支持定位");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setUserPosition({
          longitude: position.coords.longitude,
          latitude: position.coords.latitude,
          accuracy: position.coords.accuracy,
        });
        const gcj = wgs84ToGcj02(position.coords.longitude, position.coords.latitude);
        const campusKey = campusKeyForGcj02Point(campusGeoIndex, gcj.longitude, gcj.latitude);
        if (!campusKey) {
          setLocationHint("当前位置不在校区范围内");
          return;
        }
        if (campusKey !== state.campus?.key) {
          // 先切校区；同一次渲染里 MapCanvas 拿到新 campus + 新 focusRequest
          state.resetForCampus(campusKey as CampusKey);
        }
        const target = campusGeoIndex.find((campus) => campus.key === campusKey);
        if (!target) return;
        const point = applyGeoTransform(target.geoTransform, gcj.longitude, gcj.latitude);
        setLocationFocusRequest((current) => ({ point, nonce: (current?.nonce ?? 0) + 1 }));
        setLocationHint(null);
      },
      () => setLocationHint("定位失败，请检查浏览器定位权限后重试"),
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 10000 },
    );
  }

  if (state.releaseStatus === "loading") {
    return (
      <div className="h-full bg-map-ground">
        <LoadingState label="正在加载校园地图…" />
      </div>
    );
  }

  if (state.releaseStatus !== "ready") {
    return (
      <div className="grid h-full place-items-center bg-map-ground px-8 text-center text-body text-sub">
        {state.releaseStatus === "empty" ? "地图内容暂未上线" : "地图内容加载失败，请稍后重试"}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex h-full w-full overflow-hidden">
      {/* D1 左信息栏（≥768px） */}
      {!isMobile ? <DesktopMapPanel state={state} /> : null}

      <div className="relative min-w-0 flex-1">
        <MapCanvas
          campus={state.campus}
          featureBindings={featureBindings}
          matchedFeatureIds={state.matchedFeatureIds}
          selectedFeatureId={state.selectedPoi?.mapFeatureId ?? null}
          selectedPoint={state.selectedPoi?.markerPoint ?? null}
          selectionFocusBounds={selectionFocusBounds}
          onSelectFeature={state.openPoiByFeatureId}
          onTapOverlayPoi={state.openPointPoi}
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
          onViewWindowChange={setViewWindow}
          focusRequest={locationFocusRequest}
          zoomControlPosition={isMobile ? "center-right" : "bottom-right"}
          overlay={
            <>
              <MapPoiOverlay
                viewWindow={viewWindow}
                pois={state.visiblePointPois}
                scale={markerScaleValue(markerScale)}
                selectedPoiKey={state.selectedPoi?.poiKey ?? null}
                onSelect={state.openPointPoi}
              />
              {layerOn ? (
                <MapEventOverlay
                  viewWindow={viewWindow}
                  items={overlayItems}
                  selectedEventId={selectedEventId}
                  onSelect={setSelectedEventId}
                />
              ) : null}
              <MapUserLocationOverlay
                viewWindow={viewWindow}
                campus={state.campus}
                position={userPosition}
              />
            </>
          }
        />

        {/* 顶部浮层：校区切换（仅移动端） + 返校指南入口 + 图层开关 + 回中 */}
        <div className="absolute inset-x-4 top-4 z-30 flex items-start justify-between gap-3">
          {/* 左列纵向排：校区切换在上，指南入口在下。限宽避免和右侧圆按钮撞上。
              指南未发布时 GuideBanner 返回 null，这一列就只剩校区切换。 */}
          <div className="flex min-w-0 max-w-[min(23rem,calc(100%-5.5rem))] flex-col items-start gap-2">
            {isMobile ? (
              <CampusSwitcher campuses={state.campuses} selectedCampus={state.selectedCampus} onSelect={state.resetForCampus} />
            ) : null}
            <GuideBanner />
          </div>
          <div className="flex flex-col items-end gap-2">
            <button
              type="button"
              aria-label="定位到我的位置"
              className="grid h-11 w-11 place-items-center rounded-full bg-surface text-primary shadow-floating"
              onClick={handleLocate}
            >
              <LocateFixed size={19} />
            </button>
            {locationHint ? (
              <div
                role="status"
                className="max-w-44 rounded-xl bg-surface px-3 py-2 text-center text-aux text-ink shadow-floating"
              >
                {locationHint}
              </div>
            ) : null}
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
              eventStatus={operations.status}
              eventError={operations.status === "error" ? operations.message : null}
              onRetryEvents={operations.reload}
              eventsOn={layerOn}
              onToggleEvents={() => {
                setLayerOn((on) => !on);
                setSelectedEventId(null);
              }}
              markerScale={markerScale}
              onSelectMarkerScale={setMarkerScale}
              activeFilters={state.activeFilters}
              filters={state.releaseData.filters}
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
                  setDetailEventId(selectedEvent.id);
                  recordAnalyticsEvent({
                    eventType: "popup_open",
                    campus: state.campus?.label,
                    meta: { popup: "operation_detail", eventId: selectedEvent.id },
                  });
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

        {/* D1 选中 POI 的地图小卡（桌面端） */}
        {!isMobile && state.selectedPoi ? (
          <PoiMapCard
            building={state.selectedPoi}
            onClose={state.closePoi}
            onOpenMerchants={() => setDesktopDetailOpen(true)}
          />
        ) : null}

        {/* D1 桌面端详情浮层：复用 M2 版式（商户区块 + 内嵌商户详情） */}
        {!isMobile && desktopDetailOpen && state.selectedPoi ? (
          <div className="absolute right-6 top-6 z-40 flex max-h-[calc(100%-3rem)] w-[380px] flex-col overflow-hidden rounded-2xl bg-surface shadow-floating">
            <button
              type="button"
              aria-label="关闭详情"
              className="absolute right-3 top-3 z-10 grid h-8 w-8 place-items-center rounded-full bg-page text-sub"
              onClick={() => setDesktopDetailOpen(false)}
            >
              <X size={15} />
            </button>
            <div className="min-h-0 flex-1 overflow-y-auto pt-4">
              <PoiDetailSheet
                building={state.selectedPoi}
                events={operations.status === "ready" ? operations.activeEvents : null}
                facilityStatus={state.facilityStatus}
                iconKeyByTypeCode={facilityIconKeys}
                initialMerchantId={state.selectedMerchantId}
              />
            </div>
          </div>
        ) : null}

        {/* poi 档关闭钮：抬到卡片上缘之上（移出抽屉容器，位置随 sheetTop 算） */}
        {isMobile && state.sheetMode === "poi" ? (
          <button
            type="button"
            aria-label="关闭详情"
            className="absolute z-40 grid h-9 w-9 place-items-center rounded-full bg-surface text-sub shadow-floating"
            style={{ top: poiCloseTop, right: poiCloseRight }}
            onClick={state.closePoi}
          >
            <X size={16} />
          </button>
        ) : null}

        {/* 全屏/恢复浮钮：贴在卡片上缘右侧，跟随卡片顶边移动 */}
        {isMobile && sheetToggle ? (
          <button
            type="button"
            aria-label={sheetToggle.label}
            className="absolute z-40 grid h-11 w-11 place-items-center rounded-full bg-surface text-ink shadow-floating"
            style={{ top: sheetToggleTop, right: sheetToggleRight }}
            onClick={() => state.setSheetMode(sheetToggle.target)}
          >
            {sheetToggle.collapsed ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          </button>
        ) : null}

        {/* 底部抽屉（移动端）。2026-08-24：整卡可拖——手势监听挂在 section 上
            （sheetRef），归属按落点判定：落在标了 data-sheet-scroll 的纵向滚动框里
            归列表，落在搜索行/标签筛选/标题行等处归卡片，见 useSheetDrag。
            拖拽期间 touch-action 置 none，避免原生滚动与我们抢同一手势。 */}
        {isMobile ? (
          <section
            ref={sheetRef}
            className="absolute inset-x-0 z-30"
            style={{ top: sheetTop, bottom: tabBar, touchAction: dragging ? "none" : "pan-y" }}
          >
            {/* 拖拽把手：整卡可拖之后它只是视觉提示 + 无条件归抽屉的命中区
                （data-sheet-handle）；键盘可用上下方向键换档（a11y）。 */}
            <div className="pointer-events-none absolute inset-x-0 -top-6 z-40 flex justify-center">
              <div
                data-sheet-handle
                role="slider"
                tabIndex={0}
                aria-label="调整卡片高度"
                aria-valuetext={
                  state.sheetMode === "collapsed"
                    ? "已收起"
                    : state.sheetMode === "results"
                      ? "已展开到全屏"
                      : state.sheetMode === "poi"
                        ? "地点详情"
                        : "默认高度"
                }
                className="pointer-events-auto flex h-7 w-24 cursor-grab items-center justify-center touch-none"
                onPointerDown={handlePointerDown}
                onKeyDown={handleKeyDown}
              >
                <span className="block h-1 w-10 rounded-full bg-white/70 shadow-sm" />
              </div>
            </div>

            <div className="h-full overflow-hidden rounded-t-4xl bg-surface shadow-sheet">
              {state.sheetMode === "collapsed" ? (
                <div className="px-4 pt-3">
                  <SearchInput value={state.query} onChange={state.handleQueryChange} onFocus={state.handleQueryFocus} />
                </div>
              ) : state.sheetMode === "poi" && state.selectedPoi ? (
                <div
                  data-sheet-scroll
                  className="h-full overflow-y-auto"
                  style={{ overscrollBehavior: "contain" }}
                  ref={(node) => {
                    sheetScrollResetRef.current = node ? () => { node.scrollTop = 0; } : null;
                  }}
                >
                  {/* 内容自适应测量容器：高度 = 自然内容高度，poi 档抽屉按它定可见高度 */}
                  <div ref={poiMeasureRef} className="pt-2">
                    <PoiDetailSheet
                      building={state.selectedPoi}
                      events={operations.status === "ready" ? operations.activeEvents : null}
                      facilityStatus={state.facilityStatus}
                      iconKeyByTypeCode={facilityIconKeys}
                      initialMerchantId={state.selectedMerchantId}
                    />
                  </div>
                </div>
              ) : (
                <div className="h-full pt-2">
                  <SearchHomeSheet
                    query={state.query}
                    activeFilters={state.activeFilters}
                    searchActive={state.searchActive}
                    searchStatus={state.searchStatus}
                    searchError={state.searchError}
                    results={state.filteredResults}
                    pois={state.releaseData.pois}
                    filters={state.releaseData.filters}
                    onQueryChange={state.handleQueryChange}
                    onQueryFocus={state.handleQueryFocus}
                    onClearQuery={state.clearQuery}
                    onRetrySearch={state.retrySearch}
                    onFilterToggle={state.handleFilterToggle}
                    onClearFilters={state.clearFilters}
                    onOpenAllFilters={() => setLayerPanelOpen(true)}
                    onResultClick={(poiKey) => {
                      // 本轮手势被抽屉拖拽吃掉时作废（拖完卡片不该误开 POI）
                      if (consumeSheetDragClick()) return;
                      state.openPoi(poiKey, "search_result");
                    }}
                    scrollAreaRef={(node) => {
                      sheetScrollResetRef.current = node ? () => { node.scrollTop = 0; } : null;
                    }}
                  />
                </div>
              )}
            </div>
          </section>
        ) : null}

        {/* 事件详情卡：摘要卡「查看详情」的落地面板，数据取自已选中的事件 */}
        <OperationDetailSheet
          event={detailEvent}
          buildings={state.releaseData.buildings}
          variant={isMobile ? "sheet" : "panel"}
          onClose={() => {
            if (detailEventId) {
              recordAnalyticsEvent({
                eventType: "popup_close",
                campus: state.campus?.label,
                meta: { popup: "operation_detail", eventId: detailEventId },
              });
            }
            setDetailEventId(null);
          }}
        />
      </div>
    </div>
  );
}
