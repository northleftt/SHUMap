// 校园地图页（Part 2 核心：canvas 引擎）。
//
// 渲染模型（对齐 Web 端 MapCanvas 的 ViewWindow 模型，见 lib/map/viewport.ts）：
//   - ViewWindow = viewBox 坐标系下当前可见矩形；共享变量 winX/winY/winScale
//     （winScale = 屏幕 px / viewBox 单位）是它的运行时表示；
//   - .map-world 容器按 viewBox 尺寸布局，applyAnimatedStyle 驱动
//     translate(-win*scale) scale(scale)，底图与图钉随动不回流布局；
//   - 手势用 JS 线程触摸事件（bindtouchstart/move/end + bindtap 挂在 .map-surface 上）：
//     实测 worklet:ongesture 绑定在本项目（glass-easel + TS）真机上回调零次触发，
//     原因未查明，已放弃 gesture-handler 组件（详见 AGENTS.md 坑 #8）；
//   - 视口数学直接用 lib/map/viewport.ts 纯函数（JS 线程没有序列化限制），
//     同一套公式供手势/缩放按钮/选中定位与单测使用。
//
// automator 自验：装配与视口摘要放 data.report（Skyline 无 webview，page.data() 不可用，
// 用 miniProgram.evaluate 读 getCurrentPages()[0].data.report）。

import { loadReleaseWithCache, selectCampus } from "../../lib/release/loader";
import type { LoadedRelease } from "../../lib/release/mapData";
import type { CampusConfig, MapPoi, MerchantSummary } from "../../lib/release/types";
import { searchReleaseLocal, resolveSearchHits, foldDocPoiKey, type SearchHit } from "../../lib/release/search";
import { facilityStatusLabel } from "../../lib/release/facilityStatus";
import { filterMapPois } from "../../lib/release/filters";
import {
  activeOperations,
  buildEventOverlayItems,
  eventRegionHit,
  eventStatusLabel,
  eventTypeLabel,
  eventsTargetingPoi,
  fetchOperations,
  formatEventDateRange,
  formatEventDay,
  overlayAnchor,
  overlayItemsForCampus,
  resolveEventTargetNames,
  eventColor,
  eventMarkerItems,
  severityLabel,
  type EventOverlayItem,
  type OperationalEvent,
} from "../../lib/release/operations";
import { addRecent, listRecents } from "../../lib/recents";
import { isFavorite, listFavorites, toggleFavorite as toggleFavoriteEntry } from "../../lib/favorites";
import { parseSvgFeatures, parseSvgViewBox } from "../../lib/svg-geometry";
import {
  buildBuildingShapes,
  buildVisibleMarkers,
  hitTest,
  markerPinStyles,
  type BuildingShape,
  type MapMarker,
  type MarkerPinStyles,
} from "../../lib/map/markers";
import {
  clamp,
  createInitialWindow,
  focusPointWindow,
  getMinScale,
  getScale,
  MAX_ZOOM_SCALE,
  panWindowBy,
  pinchWindow,
  screenToWorld,
  zoomWindowAt,
  type Point,
  type Size,
  type ViewWindow,
} from "../../lib/map/viewport";
import { facilityIconName, markerIconName, poiRowIconName } from "../../lib/map/poiIcons";
import { injectSvgHighlight } from "../../lib/map/svg-highlight";
import {
  campusKeyForGcj02Point,
  computeUserLocationMarker,
  type CampusGeoBounds,
  type UserLocationMarker,
} from "../../lib/map/user-location";
import {
  SHEET_ANIMATE_MS_LONG,
  dampSheetTop,
  previousModeBeforePoi,
  queryMode,
  resolveSheetDragOwner,
  sheetAnimateMs,
  sheetDragVelocity,
  sheetGestureOwner,
  sheetHeights,
  sheetToggleShifted,
  sheetToggleTarget,
  shouldClosePoiOnRelease,
  snapSheetModeWithVelocity,
  type SheetGestureOwner,
  type SheetHeights,
  type SheetMode,
} from "../../lib/map/sheet";
import { apiGet, apiGetBinary } from "../../lib/api";
import { recordAnalyticsEvent, type AnalyticsPoiSource } from "../../lib/analytics";
import { requestErrorRetryText } from "../../lib/request-error";
import { enableShareMenus, shareQuery, sharePath, shareTitle } from "../../lib/share";
import {
  GUIDE_DISMISS_KEY,
  GUIDE_SLUG,
  dismissStamp,
  guideAssetUrl,
  parseGuideSummary,
  shouldShowGuideBanner,
  type GuideSummary,
} from "../../lib/guide-entry";
import {
  mediaExtension,
  removeLocalAsset,
  writeLocalBinaryAsset,
  writeLocalTextAsset,
} from "../../lib/local-assets";

const ZOOM_BUTTON_SCALE_FACTOR = 1.18;
const TAP_TOLERANCE_PX = 24;
/** 单指位移超过该值即视为拖动（随后的 bindtap 被抑制，避免拖完地图误开 POI）。 */
const TAP_MOVE_TOLERANCE_PX = 8;
/** 单指「轻触后按住滑动」缩放：与上一次轻触的最大间隔/位移容差。 */
const ONE_FINGER_ZOOM_WINDOW_MS = 350;
const ONE_FINGER_ZOOM_TAP_DISTANCE_PX = 30;
/** 单指滑动缩放的位移→倍率换算：每 128px 一倍（下滑放大、上滑缩小，对齐高德/Google 手感）。 */
const ONE_FINGER_ZOOM_PX_PER_OCTAVE = 128;
/** 底图 <image> 按 3 倍布局再缩回，给高倍缩放留栅格化余量（见 map.wxss .map-svg）。 */
const RASTER_RATIO = 3;
const ANIMATE_MS = 250;
/** 用户定位轮询间隔（wx.onLocationChange 未获批，只能用 getLocation 轮询）。 */
const USER_LOCATION_POLL_INTERVAL_MS = 30 * 1000;
const TAB_BAR_CONTENT_HEIGHT = 64;
const SHEET_TOGGLE_GAP = 56;
/** poi 档关闭圆钮抬到卡片上缘之上的距离（40px 按钮 + 8px 间隙），见 configureSheet。 */
const SHEET_CLOSE_GAP = 48;
/** 延后任务落在动画结束后的小缓冲（动画时长用 sheet.ts 分档长档常量，别写死）。 */
const SHEET_DEFER_BUFFER_MS = 40;
/**
 * 「落点在抽屉内滚动框里」标记的有效时间窗（ms）：同一轮触摸里 scroll-view 的
 * touchstart 与 .sheet-shell 的 touchstart 只隔一次事件派发，200ms 足够宽松；
 * 超期即视为没命中，标记不会粘到下一轮触摸（见 sheetScrollAreaHitAt 注释）。
 */
const SHEET_SCROLL_HIT_WINDOW_MS = 200;

interface SelectedInfo {
  poiKey: string;
  name: string;
  kindName: string;
}

/** 渲染层图钉：MapMarker + 选中态标记（选中样式对齐 Web 端 MapPoiOverlay）。 */
type RenderMarker = MapMarker & MarkerPinStyles & { selected: boolean; iconUrl: string };

interface DetailFactRow {
  key: string;
  label: string;
  value: string;
  isPhone: boolean;
  iconUrl: string;
}

interface DetailMediaRow {
  sourceUrl: string;
  url: string;
  caption: string;
  local: boolean;
}

/** 详情 sheet 的展示数据（打开时在 JS 侧一次性算好，WXML 只负责渲染）。 */
interface DetailSheetData {
  poiKey: string;
  name: string;
  subtitle: string;
  favorite: boolean;
  canNavigate: boolean;
  /** 独立设施非正常运营时的状态条文案；正常/非设施为 ""。 */
  statusBanner: string;
  media: DetailMediaRow[];
  summary: string;
  description: string;
  facts: DetailFactRow[];
  isBuilding: boolean;
  facilities: Array<{ id: string; label: string; iconUrl: string }>;
  merchants: Array<{ id: string; name: string; subtitle: string; stallCode: string }>;
  /** 楼内商户视图（点商户行或搜索命中商户时展开）；null = 楼宇/POI 主视图。 */
  merchant: {
    id: string;
    name: string;
    subtitle: string;
    summary: string;
    media: DetailMediaRow[];
    facts: DetailFactRow[];
    menu: Array<{ key: string; name: string; price: string; description: string }>;
  } | null;
  /** active 事件 targets 命中当前 POI 时的运营横幅（severity 色）；null = 无横幅。 */
  eventBanner: { id: string; title: string; severity: string; iconUrl: string } | null;
}

interface SearchHitRow {
  key: string;
  poiKey: string;
  merchantId: string | null;
  title: string;
  subtitle: string;
  iconUrl: string;
}

/** 筛选 chip 的渲染行（active 在 toggle 时预计算，WXML 不支持 indexOf 调用）。 */
interface FilterChipRow {
  key: string;
  label: string;
  active: boolean;
}

/** 事件 marker（世界坐标 + severity 色）。 */
interface EventMarkerRow {
  key: string;
  eventId: string;
  x: number;
  y: number;
  color: string;
}

/** 点事件 marker 后的底部摘要卡（对齐 Web 端 MapPage 事件摘要卡）。 */
interface EventSummaryData {
  id: string;
  color: string;
  severity: string;
  iconUrl: string;
  typeLabel: string;
  title: string;
  description: string;
}

/** 事件详情 sheet 的展示数据（打开时在 JS 侧一次算好，同详情 sheet 范式）。 */
interface EventDetailData {
  id: string;
  color: string;
  severity: string;
  iconUrl: string;
  typeLabel: string;
  statusLabel: string;
  severityText: string;
  title: string;
  dateRange: string;
  description: string;
  targets: Array<{ key: string; name: string }>;
  updates: Array<{ id: string; day: string; message: string }>;
}

/**
 * 一轮抽屉触摸的状态（beginSheetTouch 建、onSheetTouchEnd 清）。
 * owner = touchstart 时按落点定的初步归属；resolved = 首次位移到达容差后定死的
 * 最终归属（非 null 之后整个手势不再易主）。
 */
interface SheetTouchState {
  fromHandle: boolean;
  owner: SheetGestureOwner;
  resolved: "sheet" | "scroll" | null;
  startX: number;
  startY: number;
  startTop: number;
  lastTop: number;
  /** 速度采样：只留最后两点（全程平均会把中途的犹豫算进去，甩动判不出来）。 */
  prevSample: { y: number; t: number } | null;
  lastSample: { y: number; t: number } | null;
}

function severityIconUrl(severity: string): string {
  const safe = severity === "warning" || severity === "critical" ? severity : "info";
  return `/images/sheet/severity-${safe}.png`;
}

function factIconUrl(label: string, index: number): string {
  if (label.includes("电话")) return "/images/sheet/phone.png";
  if (label.includes("时间") || label.includes("开放") || label.includes("营业")) {
    return "/images/sheet/clock.png";
  }
  return index % 3 === 2 ? "/images/sheet/phone.png" : "/images/sheet/building-2.png";
}

function detailFacts(facts: Array<{ label: string; value: string }>): DetailFactRow[] {
  return facts.map((fact, index) => ({
    key: `${fact.label}:${index}`,
    label: fact.label,
    value: fact.value,
    isPhone: fact.label.includes("电话"),
    iconUrl: factIconUrl(fact.label, index),
  }));
}

function detailMedia(media: MerchantSummary["media"]): DetailMediaRow[] {
  return media
    .filter((item) => item.url.trim() && !item.floorLevelCode)
    .map((item) => ({
      sourceUrl: item.url,
      url: item.url.startsWith("/") ? "" : item.url,
      caption: item.caption ?? "",
      local: false,
    }));
}

Page({
  data: {
    statusBarHeight: 20,
    capsuleTop: 24,
    controlTop: 24,
    /** .map-viewport 实测宽度（图层浮卡内联 left 定位用）。 */
    viewportWidth: 0,

    loading: true,
    ready: false,
    errorMessage: "",

    campuses: [] as Array<{ key: string; label: string }>,
    activeCampusKey: "",
    activeCampusLabel: "",
    campusMenuOpen: false,
    assetUrl: "",
    guideVisible: false,
    guideTitle: "",
    guideSubtitle: "",
    /** 后台配的横幅图标（guide_assets 素材）；空串时用内置字符图标兜底。 */
    guideIconUrl: "",
    worldWidth: 0,
    worldHeight: 0,
    rasterRatio: RASTER_RATIO,
    markers: [] as RenderMarker[],
    selected: null as SelectedInfo | null,
    /** 用户定位 dot（viewBox 坐标 + 精度圈半径）；null = 未定位/不在当前校区。 */
    userLocation: null as UserLocationMarker | null,
    /** 搜索/筛选命中楼宇的高亮覆盖图；详情态按网页端规则暂时隐藏。 */
    filterHighlightUrl: "",
    /** 选中楼宇的高亮覆盖图（本地临时 SVG 文件路径），空串 = 无高亮。 */
    highlightUrl: "",

    // 地图常驻四档抽屉（WXML 只消费这里的派生展示字段）
    sheetMode: "home" as SheetMode,
    sheetTop: 0,
    sheetFullHeight: 0,
    sheetVisibleHeight: 0,
    sheetToggle: null as { top: number; right: number; collapsed: boolean } | null,
    /** poi 档关闭圆钮的 top（configureSheet 算；非 poi 档为 null 不渲染）。 */
    sheetCloseTop: null as number | null,
    eventCardBottom: 80,
    /** 降档时把列表滚回顶部用的 scroll-top（每次 +1 交替 0/1 强制生效，见 resetScrollAreaTop）。 */
    scrollAreaResetTop: 0,

    // 搜索 + POI 详情
    searchOpen: false,
    searchFocus: false,
    searchQuery: "",
    searchActive: false,
    searchStatus: "idle" as "idle" | "loading" | "ready",
    searchHits: [] as SearchHitRow[],
    recents: [] as Array<{ poiKey: string; name: string; kindName: string }>,
    resultRows: [] as SearchHitRow[],
    recentRows: [] as SearchHitRow[],
    detailOpen: false,
    detailSheet: null as DetailSheetData | null,
    detail: null as DetailSheetData | null,
    photoIndex: 0,
    merchantPhotoIndex: 0,

    // 图层筛选（搜索面板 chips 与图层浮卡共享同一份 activeFilters）
    filterChips: [] as FilterChipRow[],
    activeFilters: [] as string[],
    /** 无 query 有筛选时的筛选结果列表（= 被筛选命中的 POI）。 */
    filterRows: [] as Array<{ poiKey: string; title: string; subtitle: string }>,
    layerPanelOpen: false,

    // 运营事件（GET /api/public/operations，拉取失败静默降级为不显示）
    eventsOn: true,
    eventCount: 0,
    eventMarkers: [] as EventMarkerRow[],
    eventOverlayUrl: "",
    eventSummary: null as EventSummaryData | null,
    eventDetailOpen: false,
    eventDetail: null as EventDetailData | null,

    // 装配/视口摘要（纯 JSON），automator evaluate 读取做核对
    report: null as unknown,
  },

  /** 自定义 tabBar：回显本 tab 的选中态（app.json tabBar.custom=true）。 */
  onShow() {
    const tabBar = this.getTabBar?.();
    if (tabBar) tabBar.setData({ selected: 0 });
    const detail = this.data.detail as DetailSheetData | null;
    if (detail) {
      const favorite = isFavorite(detail.poiKey);
      if (favorite !== detail.favorite) {
        const next = { ...detail, favorite };
        this.setData({ detail: next, detailSheet: next });
      }
    }
    this.openPendingPoi();
    this.openPendingMode();
    // 回到页面恢复定位轮询（boot 完成前 ready=false，首次启动由 boot 成功路径负责）
    if (this.data.ready) this.startUserLocationPolling();
  },

  /** 转发：详情开着就分享该地点（带 poi 深链），否则分享当前校区。 */
  onShareAppMessage() {
    const detail = this.data.detail as DetailSheetData | null;
    if (detail) {
      return {
        title: shareTitle(detail.name),
        path: sharePath("/pages/map/map", { poi: detail.poiKey, campus: this.data.activeCampusKey }),
      };
    }
    return {
      title: shareTitle(this.data.activeCampusLabel ? `${this.data.activeCampusLabel}校园地图` : ""),
      path: sharePath("/pages/map/map", { campus: this.data.activeCampusKey }),
    };
  },

  /** 分享到朋友圈：单页模式下自定义 tabBar 不渲染，地图本体不依赖它。 */
  onShareTimeline() {
    const detail = this.data.detail as DetailSheetData | null;
    return {
      title: detail
        ? shareTitle(detail.name)
        : shareTitle(this.data.activeCampusLabel ? `${this.data.activeCampusLabel}校园地图` : ""),
      query: shareQuery(
        detail
          ? { poi: detail.poiKey, campus: this.data.activeCampusKey }
          : { campus: this.data.activeCampusKey },
      ),
    };
  },

  onLoad(options: Record<string, string | undefined>) {
    // 转发卡片/朋友圈进来的深链（?poi=&campus=）：复用其他 tab 那套一次性 storage 通道，
    // boot 完成后由 openPendingPoi 消费。poi 优先——openPoi 会按 poi.campusKey 自己切校区，
    // 所以只在没有 poi 时才用 campus: 前缀单独切校区。
    const sharedPoi = options?.poi ? decodeURIComponent(options.poi) : "";
    const sharedCampus = options?.campus ? decodeURIComponent(options.campus) : "";
    if (sharedPoi || sharedCampus) {
      try {
        wx.setStorageSync("shumap.pending-map-poi", sharedPoi || `campus:${sharedCampus}`);
      } catch {
        // 写不进去只是深链失效，地图仍按默认校区打开。
      }
    }
    enableShareMenus();
    const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : { statusBarHeight: 20 };
    const statusBarHeight = windowInfo.statusBarHeight ?? 20;
    // 底部安全区（与 custom-tab-bar 同口径）：自定义 tabBar 总高 = 64 内容 + safeBottom，
    // 抽屉档位计算必须把安全区也算进 tabBarHeight，否则 collapsed 档搜索框会被压住。
    this.safeBottom = windowInfo.safeArea
      ? Math.max(0, Math.round(windowInfo.screenHeight - windowInfo.safeArea.bottom))
      : 0;
    let capsuleTop = statusBarHeight + 8;
    let controlTop = capsuleTop;
    try {
      const capsule = typeof wx.getMenuButtonBoundingClientRect === "function"
        ? wx.getMenuButtonBoundingClientRect()
        : null;
      if (capsule && Number.isFinite(capsule.top)) {
        capsuleTop = Math.max(statusBarHeight + 4, capsule.top);
        controlTop = Math.max(capsuleTop, capsule.bottom + 8);
      }
    } catch {
      // 胶囊信息不可用时沿用状态栏下方的安全位置。
    }
    this.setData({ statusBarHeight, capsuleTop, controlTop });

    // 视口共享变量：JS 线程触摸处理器直写，UI 线程 applyAnimatedStyle 跟随
    // （worklet:ongesture 绑定在本环境真机上完全不触发，见 AGENTS.md 坑 #7，
    // 手势识别已改为 JS 线程 bindtouchstart/move/end + viewport.ts 纯函数）。
    this.winX = wx.worklet.shared(0);
    this.winY = wx.worklet.shared(0);
    this.winScale = wx.worklet.shared(1);
    this.sheetY = wx.worklet.shared(0);
    // ease-out 曲线（对齐 Web 端常见 easeOutCubic 手感）；老基础库没有 Easing 时降级默认曲线。
    this.easeOut = wx.worklet?.Easing?.bezier
      ? wx.worklet.Easing.bezier(0.22, 1, 0.36, 1)
      : undefined;
    // 抽屉动画同 tick 合并：pendingTop 只保留最新目标，setTimeout(0) 统一赋一次 timing
    // （同 tick 连赋两次 timing 实测会把抽屉停在 translateY(0)，即「弹到顶」）。
    this.sheetPendingTop = null as number | null;
    this.sheetFlushScheduled = false;

    this.loadedRelease = null as LoadedRelease | null;
    this.poiByKey = new Map<string, MapPoi>();
    this.searchDebounceTimer = 0;
    this.currentHits = [] as SearchHit[];
    this.currentHitRows = [] as SearchHitRow[];
    this.displayHits = [] as SearchHit[];
    this.currentFilterPois = [] as MapPoi[];
    this.filterDefs = [] as Array<{ key: string; label: string }>;
    this.activeEvents = [] as OperationalEvent[];
    this.eventItems = [] as EventOverlayItem[];
    this.eventAnchors = [] as Array<{ eventId: string; x: number; y: number }>;
    this.eventOverlayFilePath = null as string | null;
    this.activeCampus = null as CampusConfig | null;
    this.viewBoxSize = { width: 0, height: 0 } as Size;
    this.containerSize = { width: 0, height: 0 } as Size;
    this.containerLeft = 0;
    this.containerTop = 0;
    this.mapMarkers = [] as MapMarker[];
    this.buildingShapes = [] as BuildingShape[];
    this.touch = null;
    /** 上一次单指未拖动点按（tap 时间+位置），用于「轻触后按住滑动」单指缩放判定。 */
    this.lastTap = null as { time: number; x: number; y: number } | null;
    this.sheetTouch = null as SheetTouchState | null;
    /** 拖动/捏合后的 bindtap 抑制标记（onSurfaceTouchEnd 置位，onSurfaceTap 消费）。 */
    this.tapSuppress = false;
    /**
     * 最近一次「落点在抽屉内纵向滚动框里」的时间戳（onScrollAreaTouchStart 置位，
     * beginSheetTouch 读；0 = 从未）。
     * 存时间戳而不是布尔：Skyline 下 scroll-view 的 touchstart 是否冒泡到祖先
     * 未经真机确认（AGENTS.md 坑 #8 系）。若不冒泡，beginSheetTouch 就没有机会
     * 清零，布尔标记会漏到下一轮触摸、把之后每次整卡拖动都误判成列表滚动
     * （功能静默失效）。时间戳只在同一轮触摸的时间窗内有效，最坏情况是本轮
     * 判定失准，不会粘住。
     */
    this.sheetScrollAreaHitAt = 0;
    /** 抽屉内滚动框的实时 scrollTop（bindscroll 更新；results/poi 档「滚到顶继续下拉」判定用）。 */
    this.sheetScrollTop = 0;
    /** 抽屉内滚动框内容是否真的溢出（measureSheetScrollable 实测；不可滚的框不吃手势）。 */
    this.sheetScrollable = false;
    /** 抽屉拖拽抢到手势后置位，被列表行/chip 的 bindtap 消费掉（避免拖完误开 POI）。 */
    this.sheetTapSuppress = false;
    this.sheetMetrics = null as SheetHeights | null;
    /** poi 档实测内容高度（.detail-measure），null = 未测量（回落 heights.poi 上限）。 */
    this.poiContentHeight = null as number | null;
    this.previousSheetMode = "home" as Exclude<SheetMode, "poi">;
    /** 开详情前图层浮卡是否开着（开详情临时收起，关详情原样恢复）。 */
    this.previousLayerPanelOpen = false;
    /** 从其他 tab（校车）深链打开详情时的回跳目标；直接打开详情一律清掉。 */
    this.poiReturnTab = null as string | null;
    this.animatedStyleApplied = false;
    this.filterMatchedSourceElementIds = [] as string[];
    this.filterHighlightFilePath = null as string | null;
    this.filterHighlightSignature = "";
    this.filterHighlightRevision = 0;
    this.highlightFilePath = null as string | null;
    this.baseMapFilePath = null as string | null;
    this.mediaFilePaths = new Set<string>();
    this.guideSummary = null;
    // 用户定位：轮询定时器 + 最近一次定位结果（校区切换后按新校区重算 dot）
    this.userLocationTimer = 0;
    this.lastUserFix = null as { longitude: number; latitude: number; accuracy: number } | null;
    // 三校区地理边界缓存（geoTransform + svgRaw 解析的 viewBox），boot 时装配一次；
    // 「gcj02 → 属于哪个校区」判断用，不做进 30s 轮询路径。
    this.campusGeoBounds = [] as CampusGeoBounds[];
    /** 首次定位自动选校区只做一次（之后的轮询不再自动切，尊重用户手动切校区）。 */
    this.autoCampusSwitchDone = false;
    // analytics 去重状态：map_view 按校区去重（setupCampus 重入不重报），
    // search 按「校区:query」去重（同一 query 不连续重复上报）。
    this.lastMapViewCampusKey = "";
    this.lastSearchReportKey = "";

    this.boot();
    this.loadGuideEntry();
  },

  async boot() {
    this.setData({ loading: true, ready: false, errorMessage: "" });
    try {
      const loaded = await loadReleaseWithCache();
      this.loadedRelease = loaded;
      this.poiByKey = new Map(loaded.pois.map((poi) => [poi.poiKey, poi]));
      // 校区地理边界缓存（首次定位自动选校区 / 定位按钮跨校区切换用）：
      // parseSvgViewBox 只在这里对三份 svgRaw 各解析一次，之后轮询直接复用。
      this.campusGeoBounds = loaded.campuses.map((campus) => ({
        key: campus.key,
        geoTransform: campus.geoTransform,
        viewBox: parseSvgViewBox(campus.svgRaw),
      }));
      this.refreshRecents();
      this.filterDefs = loaded.filters;
      this.setData({
        filterChips: loaded.filters.map((filter) => ({ key: filter.key, label: filter.label, active: false })),
      });
      await this.measureViewport();
      this.configureSheet("home");
      this.setupCampus(loaded.campuses[0].key);
      this.openPendingPoi();
      this.openPendingMode();
      // 运营事件是 live 数据，装配完成后再拉；失败静默降级（不显示事件，不影响地图）
      this.loadOperations();
      // 用户定位轮询：立即取一次 + 之后每 30s（wx.onLocationChange/startLocationUpdate
      // 接口未获批，只能用 getLocation 轮询；onHide 停、onShow 恢复、onUnload 清理）
      this.startUserLocationPolling();
    } catch (error) {
      this.setData({
        loading: false,
        errorMessage: requestErrorRetryText(error),
      });
    }
  },

  /** 其他 tab 用 storage 传一次性深链；地图装配完成前调用会保留到 ready 后处理。 */
  openPendingPoi() {
    if (!this.loadedRelease || !this.data.ready) return;
    let pending = "";
    try {
      const value = wx.getStorageSync("shumap.pending-map-poi");
      pending = typeof value === "string" ? value : "";
    } catch {
      pending = "";
    }
    if (!pending) return;
    try {
      wx.removeStorageSync("shumap.pending-map-poi");
    } catch {
      // 一次性参数清理失败只会在下次回到地图时再次打开同一地点。
    }
    // tab 深链（目前是校车「在地图上查看」）附带的回跳目标：详情关闭后 switchTab 回去。
    // 无论深链类型都先取走并删除，避免 campus: 深链残留污染下一次打开。
    let returnTab = "";
    try {
      const value = wx.getStorageSync("shumap.pending-map-poi-return");
      returnTab = typeof value === "string" ? value : "";
      if (returnTab) wx.removeStorageSync("shumap.pending-map-poi-return");
    } catch {
      returnTab = "";
    }
    if (pending.startsWith("campus:")) {
      // 转发卡片带的是 campus.key（activeCampusKey），原有调用方按 campus.id 写，两者都认。
      const campusRef = pending.slice("campus:".length);
      const campus = this.loadedRelease.campuses.find(
        (item) => item.id === campusRef || item.key === campusRef,
      );
      if (campus) this.setupCampus(campus.key);
      return;
    }
    const poi = this.poiByKey.get(pending) ?? this.poiByKey.get(`place:${pending}`);
    if (poi) this.openPoi(poi, null, "deep_link");
    // campus: 深链没有详情可关，只有真的打开了详情才记录回跳目标；
    // openDetailSheet 已先清掉残留标记，这里在 openPoi 之后再赋值。
    if (poi && returnTab.startsWith("/pages/")) this.poiReturnTab = returnTab;
  },

  openPendingMode() {
    if (!this.loadedRelease || !this.data.ready) return;
    let mode = "";
    try {
      const value = wx.getStorageSync("shumap.pending-map-mode");
      mode = typeof value === "string" ? value : "";
      if (mode) wx.removeStorageSync("shumap.pending-map-mode");
    } catch {
      mode = "";
    }
    if (mode === "recents") {
      this.openSearchPanel();
      return;
    }
    if (mode !== "favorites") return;
    const favoriteKeys = listFavorites();
    const favoritePois = favoriteKeys
      .map((key) => this.poiByKey.get(key))
      .filter((poi): poi is MapPoi => Boolean(poi));
    this.currentFilterPois = favoritePois;
    this.currentHits = [];
    this.currentHitRows = [];
    this.displayHits = favoritePois.map((poi) => ({ poi, merchantId: null }));
    this.setData({
      searchQuery: "",
      searchHits: [],
      activeFilters: [],
      resultRows: favoritePois.map((poi) => ({
        key: poi.poiKey,
        poiKey: poi.poiKey,
        merchantId: null,
        title: poi.name,
        subtitle: `${poi.kindName} · ${poi.campusLabel}`,
        iconUrl: `/images/poi/${poiRowIconName(poi)}.png`,
      })),
      searchActive: true,
      searchStatus: "ready",
    });
    this.syncFilterChips();
    this.setSheetMode("results");
  },

  /** 量出地图视口的屏幕位置与尺寸（手势 absoluteX/Y 换算容器本地坐标用）。 */
  measureViewport(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.createSelectorQuery()
        .select(".map-viewport")
        .boundingClientRect((rect: any) => {
          if (!rect || !rect.width || !rect.height) {
            reject(new Error("地图容器测量失败"));
            return;
          }
          this.containerLeft = rect.left;
          this.containerTop = rect.top;
          this.containerSize = { width: rect.width, height: rect.height };
          this.setData({ viewportWidth: rect.width });
          resolve();
        })
        .exec();
    });
  },

  /**
   * 与动画首帧无关的重活（磁盘 I/O、storage、诊断 setData）延后到动画结束之后：
   * 抽屉/视口动画本身跑在 UI 线程的 worklet timing 上，但同 tick 的 JS 重活会
   * 推迟动画 flush（setTimeout(0) 排在同步块之后）、其 setData 提交还会和动画
   * 头几帧抢渲染——用户感知「卡一下再动」（实测 openPoi 同步块 devtools 宿主机
   * ~40ms，真机更高）。animateHint=false（该次档位切换无动画）时只让出当前 tick。
   */
  deferAfterSheetAnim(work: () => void, animateHint = true) {
    setTimeout(work, animateHint ? SHEET_ANIMATE_MS_LONG + SHEET_DEFER_BUFFER_MS : 0);
  },

  /** 计算四档抽屉位置，并同步所有依赖抽屉顶边的浮层。 */
  configureSheet(mode: SheetMode, animate = false) {
    if (!this.containerSize.height) return;
    const previousMode = this.data.sheetMode as SheetMode;
    // 自定义 tabBar = 64px 内容 + 底部安全区，两者都会盖住抽屉底边（AGENTS.md 实证：
    // fixed bottom:0 参照含 tab 栏的完整窗口），档位计算必须算总高。
    const tabBarHeight = TAB_BAR_CONTENT_HEIGHT + (this.safeBottom || 0);
    const topInset = Math.max(56, this.data.controlTop);
    const heights = sheetHeights(this.containerSize.height, tabBarHeight, topInset);
    const fullHeight = Math.max(0, this.containerSize.height - tabBarHeight);
    // poi 档内容自适应：可见高度 = 实测内容高度（封顶 heights.poi），内容少抽屉
    // 就坐低、不预留空白；未测量到时回落上限。其余档固定公式不变。
    const visibleHeight = mode === "poi" && this.poiContentHeight
      ? Math.min(this.poiContentHeight, heights.poi)
      : heights[mode];
    const top = Math.max(0, fullHeight - visibleHeight);
    this.sheetMetrics = heights;
    if (this.sheetY) {
      if (animate && typeof wx.worklet?.timing === "function") {
        // 同 tick 合并：本 tick 只保留最新目标，setTimeout(0) 从实时值起一次动画。
        // 同 tick 连赋两次 timing 实测会把抽屉停在 translateY(0)（「弹到顶」）。
        this.sheetPendingTop = top;
        if (!this.sheetFlushScheduled) {
          this.sheetFlushScheduled = true;
          setTimeout(() => {
            this.sheetFlushScheduled = false;
            const target = this.sheetPendingTop;
            this.sheetPendingTop = null;
            if (target === null || !this.sheetY || this.sheetTouch) return;
            const live = Number(this.sheetY.value);
            if (!Number.isFinite(live) || Math.abs(live - target) < 0.5) return;
            const duration = sheetAnimateMs(target - live);
            this.sheetY.value = this.easeOut
              ? wx.worklet.timing(target, { duration, easing: this.easeOut })
              : wx.worklet.timing(target, { duration });
          }, 0);
        }
      } else {
        // 无动画直写：同时作废可能排队的动画目标
        this.sheetPendingTop = null;
        this.sheetY.value = top;
      }
    }
    const searchActive = Boolean(this.data.searchQuery.trim()) || this.data.activeFilters.length > 0;
    // results（近全屏）档不出浮动全屏钮：抽屉顶边已贴近胶囊行，浮钮会顶进
    // 微信胶囊；该档改由搜索条行内的收起钮（wxml .search-collapse）承担。
    const target = mode === "poi" || mode === "results" ? null : sheetToggleTarget(mode, searchActive);
    const toggleTop = Math.max(16, top - SHEET_TOGGLE_GAP);
    this.setData({
      sheetMode: mode,
      sheetTop: top,
      sheetFullHeight: fullHeight,
      sheetVisibleHeight: visibleHeight,
      sheetToggle: target
        ? {
          top: toggleTop,
          right: sheetToggleShifted(this.containerSize.height, tabBarHeight, visibleHeight) ? 68 : 16,
          collapsed: mode === "collapsed",
        }
        : null,
      // poi 档关闭圆钮：整体抬到卡片上缘之上（不再半压卡片、挡住收藏/标题）；
      // 抽屉顶边太高放不下时钳到微信胶囊/右侧控件列之下（controlTop = 胶囊底 + 8）。
      sheetCloseTop: mode === "poi" ? Math.max(this.data.controlTop, top - SHEET_CLOSE_GAP) : null,
      eventCardBottom: Math.max(tabBarHeight + 16, this.containerSize.height - top + 12),
    }, () => {
      // 可见带高度变了 → 同一份列表的溢出情况也变（home 档滚得动、results 档未必），
      // 手势归属要用实测值，所以每次档位落定后重测一次。
      this.measureSheetScrollable();
    });
    if (mode === "poi") {
      this.clearFilterHighlight();
    } else if (previousMode === "poi") {
      // 恢复筛选高亮 = injectSvgHighlight（大 SVG 字符串操作）+ 同步写盘，
      // 与动画首帧无关，延后到抽屉回落动画结束后再跑。
      this.deferAfterSheetAnim(() => this.syncFilterHighlight(), animate);
    }
  },

  setSheetMode(mode: SheetMode, animate = true) {
    if (mode !== "collapsed" && mode !== "home" && mode !== "results" && mode !== "poi") return;
    this.configureSheet(mode, animate);
  },

  /**
   * 实测 poi 详情内容高度（.detail-measure 的自然高度，与 scroll-view 裁剪无关）。
   * onMeasured(changed) 在拿到结果后回调；测量失败按 changed=false 处理（调用方回落）。
   */
  measurePoiContentHeight(onMeasured?: (changed: boolean) => void) {
    this.createSelectorQuery()
      .select(".detail-measure")
      .boundingClientRect((rect: any) => {
        const next = rect && rect.height ? Math.ceil(Number(rect.height)) : 0;
        if (next > 0 && next !== this.poiContentHeight) {
          this.poiContentHeight = next;
          onMeasured?.(true);
          return;
        }
        onMeasured?.(false);
      })
      .exec();
  },

  /** 校区装配：底图、图钉、楼宇命中几何、视口参数，一次切完。 */
  setupCampus(campusKey: string) {
    const loaded = this.loadedRelease;
    if (!loaded) return;
    const selection = selectCampus(loaded, campusKey);
    const campus = selection.campus;
    const viewBoxSize: Size = { width: selection.viewBox.width, height: selection.viewBox.height };
    const features = parseSvgFeatures(campus.svgRaw);
    const shapes = buildBuildingShapes(loaded.pois, features, campusKey);

    this.activeCampus = campus;
    this.viewBoxSize = viewBoxSize;
    this.buildingShapes = shapes;

    const initial = createInitialWindow(campus, viewBoxSize, this.containerSize);
    this.winX.value = initial.x;
    this.winY.value = initial.y;
    this.winScale.value = this.containerSize.width / initial.width;
    this.filterMatchedSourceElementIds = [];
    this.clearFilterHighlight();
    this.clearHighlight();

    this.setData({
      loading: false,
      ready: true,
      errorMessage: "",
      campuses: loaded.campuses.map((item) => ({ key: item.key, label: item.label })),
      activeCampusKey: campus.key,
      activeCampusLabel: campus.label,
      assetUrl: this.applyBaseMapAsset(campus),
      worldWidth: viewBoxSize.width,
      worldHeight: viewBoxSize.height,
      selected: null,
    });
    // 图钉按筛选/搜索/选中态重算（无筛选时与 buildMarkers 一致）；事件 overlay 按校区重过滤
    this.recomputeMarkers();
    this.refreshEventOverlay();
    // 校区切换后按新校区 viewBox 重算定位 dot（同一坐标可能不在新校区内 → 隐藏）
    this.applyUserLocationFix(false);

    if (!this.animatedStyleApplied) {
      this.animatedStyleApplied = true;
      this.applyMapAnimatedStyles();
    }
    // 校区每次激活上报一次 map_view（重入同一校区不重复报；对齐 Web 端 campus 变化 effect）。
    if (this.lastMapViewCampusKey !== campus.key) {
      this.lastMapViewCampusKey = campus.key;
      recordAnalyticsEvent({ eventType: "map_view", campus: campus.label });
    }
    this.updateReport();
  },

  /** 底图沿用 release 装配取得的 SVG 原文，落本地后供 Skyline <image> 渲染。 */
  applyBaseMapAsset(campus: CampusConfig): string {
    try {
      const next = writeLocalTextAsset("campus-map", campus.mapVersionId, campus.svgRaw, "svg");
      const previous = this.baseMapFilePath;
      this.baseMapFilePath = next;
      if (previous && previous !== next) removeLocalAsset(previous);
      return next;
    } catch {
      return "";
    }
  },

  /** 指南发布状态直接跟随公开接口；404、离线和坏数据均静默隐藏入口。 */
  async loadGuideEntry() {
    try {
      const summary = parseGuideSummary(
        await apiGet<unknown>(`/api/public/guide/${encodeURIComponent(GUIDE_SLUG)}`),
      );
      let dismissed = "";
      try {
        const stored = wx.getStorageSync(GUIDE_DISMISS_KEY);
        dismissed = typeof stored === "string" ? stored : "";
      } catch {
        dismissed = "";
      }
      this.guideSummary = summary;
      if (shouldShowGuideBanner(summary, dismissed) && summary) {
        this.setData({
          guideVisible: true,
          guideTitle: summary.title,
          guideSubtitle: summary.subtitle,
          // 后台传了图标就用素材端点的位图；没传则由 WXML 回落到内置字符图标。
          // 小程序 <image> 画不了 SVG，所以后台上传的横幅图标必须是位图（icon_png）。
          guideIconUrl: summary.iconAsset ? guideAssetUrl(summary.iconAsset) : "",
        });
      }
    } catch {
      this.guideSummary = null;
      this.setData({ guideVisible: false });
    }
  },

  openGuide() {
    /* 原生指南页（pages/guide/guide）；webview 容器保留给后续本站外链，当前无页内调用方 */
    wx.navigateTo({ url: "/pages/guide/guide" });
  },

  dismissGuide() {
    const guide = this.guideSummary as GuideSummary | null;
    if (guide) {
      try {
        wx.setStorageSync(GUIDE_DISMISS_KEY, dismissStamp(guide.revisionNo));
      } catch {
        // 存储失败时仍允许本次会话关闭。
      }
    }
    this.setData({ guideVisible: false });
  },

  /**
   * 图钉重算：可见性走 lib/map/markers.buildVisibleMarkers（决策树与 Web 端
   * useMapPageState 的 visiblePointPois 一致）。matched 集合：
   *   - 有 query：filterMapPois(campusPois, activeFilters, 搜索命中顺序)；
   *   - 无 query 有筛选：filterMapPois(campusPois, activeFilters, null)；
   *   - 都没有：空集（走 visibility.default）。
   */
  recomputeMarkers() {
    const loaded = this.loadedRelease;
    const campus = this.activeCampus;
    if (!loaded || !campus) return;
    const activeFilters = this.data.activeFilters;
    const queryActive = this.data.searchQuery.trim() !== "";
    const campusPois = loaded.pois.filter((poi) => poi.campusKey === campus.key);
    let matchedPois: MapPoi[];
    if (queryActive) {
      const order = this.currentHits.map((hit) => hit.poi.poiKey);
      matchedPois = filterMapPois(campusPois, activeFilters, order);
    } else if (activeFilters.length > 0) {
      matchedPois = filterMapPois(campusPois, activeFilters, null);
    } else {
      matchedPois = [];
    }
    const matchedKeys = new Set(matchedPois.map((poi) => poi.poiKey));
    this.filterMatchedSourceElementIds = [...new Set(matchedPois.flatMap((poi) =>
      poi.entityType === "building" && poi.sourceElementId ? [poi.sourceElementId] : [],
    ))].sort();
    const selectedPoiKey = this.data.selected ? (this.data.selected as SelectedInfo).poiKey : null;
    this.mapMarkers = buildVisibleMarkers(loaded.pois, campus.key, {
      selectedPoiKey,
      queryActive,
      activeFilters,
      matchedKeys,
    });
    this.setData({
      markers: this.mapMarkers.map((marker) => {
        const selected = marker.poiKey === selectedPoiKey;
        const iconName = markerIconName(marker);
        return {
          ...marker,
          ...markerPinStyles(marker.scale),
          selected,
          iconUrl: `/images/${selected ? "poi-w" : "poi"}/${iconName}.png`,
        };
      }),
    }, () => this.refreshPinAnimatedStyle());
    this.syncFilterHighlight();
  },

  /** 按当前搜索/筛选命中集合刷新楼宇 footprint 覆盖层。 */
  syncFilterHighlight() {
    const searchActive = Boolean(this.data.searchQuery.trim()) || this.data.activeFilters.length > 0;
    if (
      !searchActive
      || this.data.sheetMode === "poi"
      || this.filterMatchedSourceElementIds.length === 0
    ) {
      this.clearFilterHighlight();
      return;
    }
    this.applyFilterHighlight(this.filterMatchedSourceElementIds);
  },

  /**
   * 搜索/筛选楼宇高亮：样式逐项对齐网页端 g[data-match="true"]，并写入唯一
   * 临时 SVG。相同校区与命中集合保持当前文件，减少输入和抽屉切换时的重复写盘。
   */
  applyFilterHighlight(sourceElementIds: string[]) {
    const campus = this.activeCampus;
    if (!campus || sourceElementIds.length === 0) {
      this.clearFilterHighlight();
      return;
    }
    const signature = `${campus.mapVersionId}:${sourceElementIds.join(",")}`;
    if (
      signature === this.filterHighlightSignature
      && this.filterHighlightFilePath
      && this.data.filterHighlightUrl
    ) return;
    try {
      const svg = injectSvgHighlight(campus.svgRaw, sourceElementIds, "match");
      if (!svg) {
        this.clearFilterHighlight();
        return;
      }
      this.filterHighlightRevision += 1;
      const filePath = writeLocalTextAsset(
        "map-filter-highlight",
        `${campus.mapVersionId}-${Date.now()}-${this.filterHighlightRevision}`,
        svg,
        "svg",
      );
      const previous = this.filterHighlightFilePath;
      this.filterHighlightFilePath = filePath;
      this.filterHighlightSignature = signature;
      this.setData({ filterHighlightUrl: filePath });
      if (previous && previous !== filePath) removeLocalAsset(previous);
    } catch {
      this.clearFilterHighlight();
    }
  },

  /** 清除筛选覆盖层及对应临时文件；命中集合保留，离开详情态时可直接恢复。 */
  clearFilterHighlight() {
    const previous = this.filterHighlightFilePath;
    this.filterHighlightFilePath = null;
    this.filterHighlightSignature = "";
    if (this.data.filterHighlightUrl) this.setData({ filterHighlightUrl: "" });
    removeLocalAsset(previous);
  },

  applyMapAnimatedStyles() {
    // world 容器：screen = world * scale - win * scale
    this.applyAnimatedStyle(".map-world", () => {
      "worklet";
      const s = this.winScale.value;
      return {
        transform: `translate(${-this.winX.value * s}px, ${-this.winY.value * s}px) scale(${s})`,
      };
    });
    // 图钉反向缩放，屏幕上保持恒定尺寸（锚点由 wxss transform-origin 固定）
    this.refreshPinAnimatedStyle();
    // 抽屉拖拽只更新 shared 值，避免 touchmove 高频 setData。
    this.applyAnimatedStyle(".sheet", () => {
      "worklet";
      return { transform: `translateY(${this.sheetY.value}px)` };
    });
  },

  /**
   * 图钉反向缩放重注册。WebView 渲染（模拟器降级模式）下 applyAnimatedStyle
   * 只在注册时匹配一次既有节点，markers/eventMarkers/userLocation 的 setData
   * 重建 .poi-pin 节点后新节点吃不到反向缩放（图钉退化为世界固定尺寸、随缩放
   * 变大）；Skyline 下同选择器是覆盖语义，重注册无副作用。因此每处重建图钉
   * 节点的 setData 回调里都调一次。
   */
  refreshPinAnimatedStyle() {
    if (!this.animatedStyleApplied) return;
    this.applyAnimatedStyle(".poi-pin", () => {
      "worklet";
      return { transform: `scale(${1 / this.winScale.value})` };
    });
  },

  // ---------------------------------------------------------------------------
  // 手势（JS 线程触摸事件；视口数学直接用 lib/map/viewport.ts 纯函数）
  // worklet:ongesture 绑定在本环境（glass-easel + TS + 当前基础库）真机上完全
  // 不触发（屏上诊断确认回调零次执行），因此放弃 gesture-handler 组件，
  // 改为 .map-surface 上的 bindtouchstart/move/end/tap。渲染层不变：
  // winX/winY/winScale shared 变量 + applyMapAnimatedStyles。
  // ---------------------------------------------------------------------------

  /** 无动画直写 shared 变量，UI 线程 applyAnimatedStyle 跟随。 */
  setWindowDirect(win: ViewWindow) {
    this.winX.value = win.x;
    this.winY.value = win.y;
    this.winScale.value = this.containerSize.width / win.width;
  },

  onSurfaceTouchStart(e: any) {
    if (!this.data.ready || !this.activeCampus) return;
    // 新一轮手势开始，清掉上一轮的 tap 抑制标记
    this.tapSuppress = false;
    const touches = e.touches;
    if (touches.length >= 2) {
      const a = touches[0];
      const b = touches[1];
      const beginWin = this.currentWindow();
      // 锚定手势起点中点的世界坐标（pinchWindow 让它全程跟住当前中点），
      // 别再锚「起点窗口下的当前中点」——中点一动锚点就换，手感就是单侧手指
      // 快图往快侧拽、双侧都快反向滑（见 viewport.ts pinchWindow 注释）。
      const startMid = {
        x: (a.clientX + b.clientX) / 2 - this.containerLeft,
        y: (a.clientY + b.clientY) / 2 - this.containerTop,
      };
      this.touch = {
        mode: "pinch",
        startDist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        beginWin,
        beginScale: getScale(beginWin, this.containerSize),
        anchorWorld: screenToWorld(beginWin, this.containerSize, startMid),
        moved: true,
      };
      // 双指上手后不再构成「轻触后按住」序列
      this.lastTap = null;
    } else if (touches.length === 1) {
      // 单指「轻触后按住滑动」缩放（高德/Google 同款）：上一次轻触刚结束且
      // 按在附近 → 本轮进入 zoomDrag；否则普通 pan。
      const lastTap = this.lastTap;
      const x = touches[0].clientX;
      const y = touches[0].clientY;
      if (
        lastTap
        && Date.now() - lastTap.time <= ONE_FINGER_ZOOM_WINDOW_MS
        && Math.hypot(x - lastTap.x, y - lastTap.y) <= ONE_FINGER_ZOOM_TAP_DISTANCE_PX
      ) {
        const beginWin = this.currentWindow();
        this.touch = {
          mode: "zoomDrag",
          startY: y,
          focal: { x: x - this.containerLeft, y: y - this.containerTop },
          beginWin,
          beginScale: getScale(beginWin, this.containerSize),
          moved: false,
        };
        this.lastTap = null;
        return;
      }
      this.lastTap = null;
      this.touch = {
        mode: "pan",
        startX: x,
        startY: y,
        beginWin: this.currentWindow(),
        moved: false,
      };
    }
  },

  onSurfaceTouchMove(e: any) {
    if (!this.touch || !this.activeCampus) return;
    const campus = this.activeCampus;
    const touches = e.touches;
    if (this.touch.mode === "pan" && touches.length === 1) {
      const deltaX = touches[0].clientX - this.touch.startX;
      const deltaY = touches[0].clientY - this.touch.startY;
      if (
        Math.abs(deltaX) > TAP_MOVE_TOLERANCE_PX
        || Math.abs(deltaY) > TAP_MOVE_TOLERANCE_PX
      ) {
        this.touch.moved = true;
      }
      this.setWindowDirect(panWindowBy(
        this.touch.beginWin,
        deltaX,
        deltaY,
        this.containerSize,
        this.viewBoxSize,
        campus.edgePaddingRatio,
      ));
      return;
    }
    if (this.touch.mode === "zoomDrag" && touches.length === 1) {
      const deltaY = touches[0].clientY - this.touch.startY;
      if (Math.abs(deltaY) > TAP_MOVE_TOLERANCE_PX) this.touch.moved = true;
      // 下滑放大、上滑缩小（对齐高德/Google 单指缩放方向），锚点 = 按住点。
      const nextScale = clamp(
        this.touch.beginScale * Math.pow(2, deltaY / ONE_FINGER_ZOOM_PX_PER_OCTAVE),
        getMinScale(campus, this.viewBoxSize, this.containerSize),
        MAX_ZOOM_SCALE,
      );
      this.setWindowDirect(zoomWindowAt(
        this.touch.beginWin,
        this.touch.focal,
        nextScale,
        this.containerSize,
        this.viewBoxSize,
        campus.edgePaddingRatio,
      ));
      return;
    }
    if (this.touch.mode === "pinch" && touches.length >= 2 && this.touch.startDist > 0) {
      const a = touches[0];
      const b = touches[1];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const nextScale = clamp(
        this.touch.beginScale * dist / this.touch.startDist,
        getMinScale(campus, this.viewBoxSize, this.containerSize),
        MAX_ZOOM_SCALE,
      );
      const focal = {
        x: (a.clientX + b.clientX) / 2 - this.containerLeft,
        y: (a.clientY + b.clientY) / 2 - this.containerTop,
      };
      this.setWindowDirect(pinchWindow({
        anchorWorld: this.touch.anchorWorld,
        focal,
        nextScale,
        container: this.containerSize,
        viewBox: this.viewBoxSize,
        edgePaddingRatio: campus.edgePaddingRatio,
      }));
    }
  },

  onSurfaceTouchEnd(e: any) {
    if (!e.touches || e.touches.length === 0) {
      // 拖动/捏合过的手势随后不该触发 bindtap（拖完地图误开 POI/误关详情）；
      // bindtap 在 touchend 之后派发，标记由 onSurfaceTap 消费。
      this.tapSuppress = Boolean(this.touch && this.touch.moved);
      // zoomDrag 不论有没有拖动都吃掉随后的 tap（否则快速点两下会误触发两次命中）。
      if (this.touch && this.touch.mode === "zoomDrag") this.tapSuppress = true;
      // 未拖动的单指 pan = 一次轻触：记下来，下一段「按住滑动」进入单指缩放。
      if (this.touch && this.touch.mode === "pan" && !this.touch.moved) {
        const touch = e.changedTouches?.[0];
        this.lastTap = touch
          ? { time: Date.now(), x: Number(touch.clientX), y: Number(touch.clientY) }
          : null;
      } else {
        this.lastTap = null;
      }
      this.touch = null;
      return;
    }
    // 双指抬起一指：以剩余手指重新起 pan，避免视口跳变
    if (this.touch && this.touch.mode === "pinch" && e.touches.length === 1) {
      this.touch = {
        mode: "pan",
        startX: e.touches[0].clientX,
        startY: e.touches[0].clientY,
        beginWin: this.currentWindow(),
        moved: true,
      };
    }
  },

  /** bindtap：e.detail.x/y 是相对页面的坐标，换算成容器本地坐标走原命中链路。 */
  onSurfaceTap(e: any) {
    if (this.tapSuppress) {
      this.tapSuppress = false;
      return;
    }
    if (!this.data.ready || !this.activeCampus) return;
    this.handleTapAt(
      Number(e.detail.x) - this.containerLeft,
      Number(e.detail.y) - this.containerTop,
      this.winX.value,
      this.winY.value,
      this.winScale.value,
    );
  },

  // ---------------------------------------------------------------------------
  // 逻辑层交互
  // ---------------------------------------------------------------------------

  currentWindow(): ViewWindow {
    return {
      x: this.winX.value,
      y: this.winY.value,
      width: this.containerSize.width / this.winScale.value,
      height: this.containerSize.height / this.winScale.value,
    };
  },

  animateToWindow(target: ViewWindow) {
    // 与抽屉同一套 ease-out 曲线（守卫降级默认曲线），聚焦/缩放不再"慢半拍"。
    const options = this.easeOut
      ? { duration: ANIMATE_MS, easing: this.easeOut }
      : { duration: ANIMATE_MS };
    this.winX.value = wx.worklet.timing(target.x, options);
    this.winY.value = wx.worklet.timing(target.y, options);
    this.winScale.value = wx.worklet.timing(this.containerSize.width / target.width, options);
  },

  handleTapAt(localX: number, localY: number, winX: number, winY: number, scale: number) {
    if (!this.data.ready || !this.activeCampus) return;
    const world: Point = { x: winX + localX / scale, y: winY + localY / scale };
    const tolerance = TAP_TOLERANCE_PX / scale;
    // 优先级与 Web 端一致：POI 图钉在事件 overlay 之上 → 图钉 → 事件锚点 → 楼宇。
    const markerHit = hitTest(this.mapMarkers, [], world, tolerance);
    if (markerHit && markerHit.kind === "marker") {
      this.closeEventSummary();
      this.selectAt(
        { x: markerHit.marker.x, y: markerHit.marker.y },
        { poiKey: markerHit.marker.poiKey, name: markerHit.marker.name, kindName: markerHit.marker.kindName },
        null,
      );
      this.openDetailByKey(markerHit.marker.poiKey, null);
      return;
    }
    // 事件锚点：点中出摘要卡（同 Web 端 overlay 点击）
    if (this.data.eventsOn && this.eventAnchors.length > 0) {
      let nearestEventId: string | null = null;
      let nearestDistance = tolerance;
      for (const anchor of this.eventAnchors) {
        const distance = Math.hypot(anchor.x - world.x, anchor.y - world.y);
        if (distance <= nearestDistance) {
          nearestEventId = anchor.eventId;
          nearestDistance = distance;
        }
      }
      if (nearestEventId) {
        this.selectEvent(nearestEventId);
        return;
      }
    }
    // 事件区域：多边形/线整个图形可点（对齐 Web 端 MapEventOverlay 的 pointer-events；
    // 小程序 overlay 是栅格图不接收手势，命中在这里手动算）。压在楼宇上方。
    if (this.data.eventsOn && this.eventItems.length > 0) {
      const regionEventId = eventRegionHit(this.eventItems, [world.x, world.y], tolerance);
      if (regionEventId) {
        this.selectEvent(regionEventId);
        return;
      }
    }
    const hit = hitTest([], this.buildingShapes, world, tolerance);
    if (!hit) {
      if (this.data.eventSummary) {
        this.closeEventSummary();
      } else if (this.data.layerPanelOpen) {
        this.setData({ layerPanelOpen: false });
      } else if (this.data.sheetMode === "poi") {
        this.closePoi();
      } else if (this.data.sheetMode === "results") {
        this.setSheetMode("home");
      } else {
        this.clearSelection();
      }
      return;
    }
    if (hit.kind !== "building") return;
    this.closeEventSummary();
    this.selectAt(
      hit.building.center,
      { poiKey: hit.building.poiKey, name: hit.building.name, kindName: hit.building.kindName },
      hit.building.sourceElementId,
    );
    this.openDetailByKey(hit.building.poiKey, null);
  },

  /**
   * 选中并定位（对齐 Web 端点选 POI 的 focus 行为）。
   * 选中态分两类（对齐 Web 端 MapCanvas/MapPoiOverlay，取代原大蓝圈 select-ring）：
   *   - 楼宇（sourceElementId 非空）：底图 SVG 注入高亮 CSS 写临时文件做 <image> 覆盖层，
   *     footprint 变浅蓝填充 + 蓝描边；
   *   - 点状 POI（sourceElementId 为 null）：图钉加 selected 样式（浅蓝光晕 + 实心蓝点）。
   */
  selectAt(point: Point, info: { poiKey: string; name: string; kindName: string }, sourceElementId: string | null) {
    const campus = this.activeCampus;
    if (!campus) return;
    const target = focusPointWindow({
      point,
      currentWindow: this.currentWindow(),
      viewBox: this.viewBoxSize,
      container: this.containerSize,
      selectionScaleMultiplier: campus.selectionScaleMultiplier,
      selectionEdgePaddingRatio: campus.selectionEdgePaddingRatio,
    });
    this.animateToWindow(target);
    this.setData({
      selected: { ...info },
    });
    // 选中态永远出图钉（决策树 selected 分支）：重算保证被筛选隐藏的 POI 选中后仍可见。
    // 保持同步：this.mapMarkers 是 hitTest 的输入，动画窗口内再点图钉不能读到旧集合。
    this.recomputeMarkers();
    if (sourceElementId) {
      // 楼宇高亮 = 大 SVG 注入 + 同步写盘，延后到聚焦/抽屉动画结束之后；
      // 守卫：延后窗口内改选/清选中了别的 POI，这次高亮作废。
      this.deferAfterSheetAnim(() => {
        const current = this.data.selected as SelectedInfo | null;
        if (current && current.poiKey === info.poiKey) this.applyHighlight(sourceElementId);
      });
    } else {
      this.clearHighlight();
    }
    this.deferAfterSheetAnim(() => this.updateReport());
  },

  /**
   * 楼宇 footprint 高亮：小程序底图是整张 SVG <image> 改不了元素样式，等效做法是
   * 往 svgRaw 的 </svg> 前注入与 Web 端逐字一致的选中 CSS（g[id] 下基本图形
   * 浅蓝填充 + #1e80c1 描边），写成唯一文件名的本地临时 SVG，用同尺寸同定位的
   * 第二张 <image> 盖在底图上。任何一步失败就静默放弃高亮（容错，不影响选中链路）。
   */
  applyHighlight(sourceElementId: string) {
    const campus = this.activeCampus;
    const svgRaw = campus ? campus.svgRaw : "";
    if (!svgRaw) {
      this.clearHighlight();
      return;
    }
    try {
      const svg = injectSvgHighlight(svgRaw, [sourceElementId], "selected");
      if (!svg) {
        this.clearHighlight();
        return;
      }
      const fs = wx.getFileSystemManager();
      // 每次写唯一文件名：同路径复用 <image> 可能不刷新
      const filePath = `${wx.env.USER_DATA_PATH}/map-highlight-${sourceElementId}-${Date.now()}.svg`;
      fs.writeFileSync(filePath, svg, "utf8");
      const previous = this.highlightFilePath;
      this.highlightFilePath = filePath;
      this.setData({ highlightUrl: filePath });
      if (previous && previous !== filePath) {
        try {
          fs.unlink({ filePath: previous, fail: () => {} });
        } catch {
          // 删除旧临时文件失败不影响功能
        }
      }
    } catch {
      this.clearHighlight();
    }
  },

  /** 清除高亮覆盖层并异步删掉临时文件（选中点状 POI / 清除选中 / 重装配时调用）。 */
  clearHighlight() {
    const previous = this.highlightFilePath;
    this.highlightFilePath = null;
    if (this.data.highlightUrl) this.setData({ highlightUrl: "" });
    if (previous) {
      try {
        wx.getFileSystemManager().unlink({ filePath: previous, fail: () => {} });
      } catch {
        // 删除旧临时文件失败不影响功能
      }
    }
  },

  clearSelection() {
    if (!this.data.selected && !this.data.detailOpen && !this.data.detail) return;
    const wasPoi = this.data.sheetMode === "poi";
    // 关详情上报 popup_close：只在确实开过 POI 详情时报（点空白清选中等其他路径不报），
    // poi 信息在清空前取（对齐 Web 端 closePoi）。
    const closingDetail = wasPoi ? (this.data.detail as DetailSheetData | null) : null;
    const closingPoi = closingDetail ? this.poiByKey.get(closingDetail.poiKey) : undefined;
    if (closingPoi) {
      recordAnalyticsEvent({
        eventType: "popup_close",
        campus: closingPoi.campusLabel,
        poiId: closingPoi.entityId,
        poiName: closingPoi.name,
        meta: { popup: "poi_detail" },
      });
    }
    this.setData({
      selected: null,
      detailOpen: false,
      detailSheet: null,
      detail: null,
      photoIndex: 0,
      merchantPhotoIndex: 0,
      // 图层浮卡：开详情时临时收起的，关详情原样恢复（「是筛选，回退到筛选」）。
      layerPanelOpen: this.previousLayerPanelOpen,
    });
    this.previousLayerPanelOpen = false;
    // 回退到打开详情前的档位：全屏回全屏（collapsed）、搜索/筛选回 results、默认回 home。
    if (wasPoi) this.setSheetMode(this.previousSheetMode);
    this.recomputeMarkers();
    this.clearHighlight();
    // 从校车 tab 深链打开的详情：关闭后跳回来源 tab（只认 poi 档的关闭，
    // 点空白清选中等其他 clearSelection 路径不跳）。
    const returnTab = wasPoi ? this.poiReturnTab : null;
    this.poiReturnTab = null;
    if (returnTab) {
      wx.switchTab({ url: returnTab });
    }
    this.deferAfterSheetAnim(() => this.updateReport());
  },

  /** 关闭 POI 详情并回到打开前的搜索档位。 */
  closePoi() {
    this.clearSelection();
  },

  toggleSheet() {
    const mode = this.data.sheetMode as SheetMode;
    if (mode === "poi") return;
    const searchActive = Boolean(this.data.searchQuery.trim()) || this.data.activeFilters.length > 0;
    this.setSheetMode(sheetToggleTarget(mode, searchActive));
  },

  /**
   * 抽屉内纵向滚动框的 touchstart（同一节点的 bind 先于 .sheet-shell 的同名事件
   * 冒泡到达）：只打「本轮落点在滚动框内」的时间戳，由 beginSheetTouch 读取。
   * 同一时刻抽屉内只渲染一个 .sheet-scroll（poi / 结果 / 最近查看三选一），
   * 所以标记与 scrollTop 都存单值，不需要按区分 key。
   *
   * 记时间戳而不是布尔：万一 Skyline 下 scroll-view 的 touchstart 不冒泡到
   * .sheet-shell（待真机确认），布尔标记就没人消费、会漏到下一轮触摸，把之后
   * 落在搜索行的整卡拖动误判成列表滚动。时间戳自愈——过期即视为没命中。
   */
  onScrollAreaTouchStart() {
    this.sheetScrollAreaHitAt = Date.now();
  },

  /** 滚动框位置（results/poi 档「滚到顶继续下拉」判定用）。 */
  onScrollAreaScroll(e: any) {
    const top = Number(e.detail?.scrollTop);
    if (Number.isFinite(top)) this.sheetScrollTop = top;
  },

  /**
   * 实测抽屉内滚动框是否真的能滚（内容溢出）。不能滚的框（最近查看只一两条）
   * 不该吃掉手势——此时整卡可拖。异步无妨：只在内容/档位变化后跑，
   * 早于用户下一次触摸。
   */
  measureSheetScrollable() {
    this.createSelectorQuery()
      .select(".sheet-scroll")
      .boundingClientRect()
      .select(".sheet-scroll")
      .scrollOffset()
      .exec((res: any[]) => {
        const rect = res?.[0];
        const offset = res?.[1];
        if (!rect || !offset) {
          this.sheetScrollable = false;
          this.sheetScrollTop = 0;
          return;
        }
        this.sheetScrollable = Number(offset.scrollHeight) - Number(rect.height) > 1;
        this.sheetScrollTop = Number(offset.scrollTop) || 0;
      });
  },

  /**
   * 降档时把列表滚回顶部：可见带缩短而列表还停在中间，看起来像坏了。
   * scroll-top 传相同值不会重新滚动，所以在 0 / 0.5 之间交替（视觉等同顶部）。
   */
  resetSheetScroll() {
    this.sheetScrollTop = 0;
    this.setData({ scrollAreaResetTop: this.data.scrollAreaResetTop === 0 ? 0.5 : 0 });
  },

  /** 抽屉拖拽抢到手势后，本轮的列表行/chip tap 作废（照抄地图面 tapSuppress 范式）。 */
  consumeSheetTap(): boolean {
    if (!this.sheetTapSuppress) return false;
    this.sheetTapSuppress = false;
    return true;
  },

  /** 把手上的 touchstart：无条件归抽屉（不看档位、不看落点）。 */
  onSheetHandleTouchStart(e: any) {
    this.beginSheetTouch(e, true);
  },

  /** 整卡（.sheet-shell）上的 touchstart：归属按落点判定，见 sheetGestureOwner。 */
  onSheetTouchStart(e: any) {
    this.beginSheetTouch(e, false);
  },

  beginSheetTouch(e: any, fromHandle: boolean) {
    const touch = e.touches?.[0];
    // 落点标记按「同一轮触摸」的时间窗判定，不靠消费清零：Skyline 下 scroll-view 的
    // touch 事件是否冒泡到祖先未经真机确认，万一不冒泡，消费式标记就会漏到下一轮触摸
    // （把整卡拖动误判成列表滚动，且此后永久错位）。时间窗最坏只影响本轮。
    const hitAt = Number(this.sheetScrollAreaHitAt);
    const inScrollArea = Number.isFinite(hitAt)
      && Date.now() - hitAt <= SHEET_SCROLL_HIT_WINDOW_MS;
    this.sheetScrollAreaHitAt = 0;
    // 上一轮没被 tap 消费掉的抑制标记在这里清零：同一手势的 tap 在 touchend 之后
    // 才派发，所以这里清不会误清本轮的。
    this.sheetTapSuppress = false;
    if (!touch || !this.sheetMetrics) return;
    // 用 sheetY 的实时值作起点而不是 data.sheetTop：吸附动画进行中再次抓住
    // 卡片时，data.sheetTop 已是目标值，从它起拖会跳变；同时直写当前值覆盖掉
    // 进行中的 timing，并作废同 tick 合并队列里的动画目标。
    this.sheetPendingTop = null;
    const liveTop = Number(this.sheetY?.value);
    const startTop = Number.isFinite(liveTop) ? liveTop : Number(this.data.sheetTop);
    if (this.sheetY) this.sheetY.value = startTop;
    const owner = sheetGestureOwner({
      mode: this.data.sheetMode as SheetMode,
      fromHandle,
      inScrollArea,
      scrollable: this.sheetScrollable,
    });
    this.sheetTouch = {
      fromHandle,
      owner,
      // 归属在首次位移到达容差时定死（owner=scroll 已经没有悬念，直接定）；
      // 之后整个手势不再易主。
      resolved: owner === "scroll" ? "scroll" : null,
      startX: Number(touch.clientX),
      startY: Number(touch.clientY),
      startTop,
      lastTop: startTop,
      prevSample: null,
      lastSample: { y: Number(touch.clientY), t: Date.now() },
    };
  },

  onSheetTouchMove(e: any) {
    const touch = e.touches?.[0];
    const state = this.sheetTouch;
    if (!touch || !state || !this.sheetMetrics) return;
    const x = Number(touch.clientX);
    const y = Number(touch.clientY);
    // 速度只取最后两个采样点（全程平均会把中途的犹豫算进去，甩动判不出来）
    state.prevSample = state.lastSample;
    state.lastSample = { y, t: Date.now() };

    if (!state.resolved) {
      const resolved = resolveSheetDragOwner({
        owner: state.owner,
        fromHandle: state.fromHandle,
        deltaX: x - state.startX,
        deltaY: y - state.startY,
        scrollTop: this.sheetScrollTop,
      });
      if (!resolved) return;
      state.resolved = resolved;
      if (resolved === "sheet") {
        // 抢到手势：抑制随后的列表行/chip tap，收键盘（results 档带着键盘拖卡片
        // 会错位——adjust-position=false 只是躲开了自动顶起），并把起点重置到
        // 当前位置：判定用掉的那 8px 不该算进位移，否则松手落档会偏。
        this.sheetTapSuppress = true;
        if (typeof wx.hideKeyboard === "function") wx.hideKeyboard({});
        state.startX = x;
        state.startY = y;
      }
    }
    if (state.resolved !== "sheet") return;

    const mode = this.data.sheetMode as SheetMode;
    const delta = y - state.startY;
    const fullHeight = Number(this.data.sheetFullHeight);
    const minTop = Math.max(0, fullHeight - this.sheetMetrics.results);
    const maxTop = Math.max(minTop, fullHeight - this.sheetMetrics.collapsed);
    // 越界给阻尼而不是硬停（手感上更像「到底了」，松手仍由吸附拉回）；
    // poi 档只允许下拉（内容矮于上限时不该能往上拽出空白）。
    const projected = mode === "poi"
      ? state.startTop + Math.max(0, delta)
      : dampSheetTop(state.startTop + delta, minTop, maxTop);
    state.lastTop = projected;
    this.sheetY.value = projected;
  },

  onSheetTouchEnd(e: any = {}) {
    const state = this.sheetTouch;
    this.sheetTouch = null;
    if (!state || !this.sheetMetrics) return;
    // 让给列表滚动的手势：抽屉不动（也不吸附，避免把列表滚动误判成拖拽）
    if (state.resolved !== "sheet") return;
    const mode = this.data.sheetMode as SheetMode;
    const endY = e.changedTouches?.[0]?.clientY;
    const delta = Number.isFinite(endY)
      ? Number(endY) - state.startY
      : state.lastTop - state.startTop;
    const velocity = sheetDragVelocity(state.prevSample, state.lastSample);
    if (mode === "poi") {
      if (shouldClosePoiOnRelease(delta, velocity)) this.closePoi();
      else this.configureSheet("poi", true);
      return;
    }
    const releasedHeight = Number(this.data.sheetFullHeight) - (state.startTop + delta);
    const next = snapSheetModeWithVelocity(releasedHeight, velocity, this.sheetMetrics, mode);
    // 降档（可见带变短）时列表回顶，否则列表停在中间看起来像坏了
    if (this.sheetMetrics[next] < this.sheetMetrics[mode]) this.resetSheetScroll();
    this.setSheetMode(next);
  },

  onHide() {
    // 离开页面（切 tab/跳详情页）停定位轮询，onShow 恢复
    this.stopUserLocationPolling();
  },

  onUnload() {
    this.stopUserLocationPolling();
    if (this.searchDebounceTimer) clearTimeout(this.searchDebounceTimer);
    this.filterMatchedSourceElementIds = [];
    this.clearFilterHighlight();
    this.clearHighlight();
    this.clearEventOverlayImage();
    removeLocalAsset(this.baseMapFilePath);
    this.baseMapFilePath = null;
    for (const path of this.mediaFilePaths) removeLocalAsset(path);
    this.mediaFilePaths.clear();
  },

  zoomBy(multiplier: number) {
    const campus = this.activeCampus;
    if (!campus || !this.data.ready) return;
    const current = this.currentWindow();
    const nextScale = clamp(
      this.containerSize.width / current.width * multiplier,
      getMinScale(campus, this.viewBoxSize, this.containerSize),
      MAX_ZOOM_SCALE,
    );
    const target = zoomWindowAt(
      current,
      { x: this.containerSize.width / 2, y: this.containerSize.height / 2 },
      nextScale,
      this.containerSize,
      this.viewBoxSize,
      campus.edgePaddingRatio,
    );
    this.animateToWindow(target);
    this.updateReport();
  },

  zoomIn() {
    this.zoomBy(ZOOM_BUTTON_SCALE_FACTOR);
  },

  zoomOut() {
    this.zoomBy(1 / ZOOM_BUTTON_SCALE_FACTOR);
  },

  resetView() {
    const campus = this.activeCampus;
    if (!campus || !this.data.ready) return;
    this.animateToWindow(createInitialWindow(campus, this.viewBoxSize, this.containerSize));
    this.updateReport();
  },

  // ---------------------------------------------------------------------------
  // 用户定位（dot + 精度圈 + 定位按钮）
  // wx.onLocationChange/startLocationUpdate 未获批，只能用 wx.getLocation(gcj02)
  // 轮询：boot 成功后立即一次 + 每 30s，onHide 停、onShow 恢复、onUnload 清理。
  // 轮询失败（含用户未授权）一律静默，只有用户主动点定位按钮才 toast 反馈。
  // ---------------------------------------------------------------------------

  startUserLocationPolling() {
    this.stopUserLocationPolling();
    this.refreshUserLocation(false);
    this.userLocationTimer = setInterval(() => {
      this.refreshUserLocation(false);
    }, USER_LOCATION_POLL_INTERVAL_MS);
  },

  stopUserLocationPolling() {
    if (this.userLocationTimer) {
      clearInterval(this.userLocationTimer);
      this.userLocationTimer = 0;
    }
  },

  /** 取一次定位并更新 dot；focusAfter=true（定位按钮）时把视口动画居中到用户位置。 */
  refreshUserLocation(focusAfter: boolean) {
    wx.getLocation({
      type: "gcj02",
      success: (res: any) => {
        this.lastUserFix = {
          longitude: Number(res.longitude),
          latitude: Number(res.latitude),
          accuracy: Number(res.accuracy),
        };
        // 进入后的首次定位：落在非当前校区则自动切过去（只做一次；之后的
        // 30s 轮询不再自动切，尊重用户手动切校区）。定位按钮不受此限——
        // 每次点击都按当前位置切校区再居中（见下）。
        if (!this.autoCampusSwitchDone) {
          this.autoCampusSwitchDone = true;
          this.switchCampusForUserFix();
        } else if (focusAfter) {
          this.switchCampusForUserFix();
        }
        this.applyUserLocationFix(focusAfter);
      },
      fail: () => {
        if (focusAfter) {
          wx.showToast({ title: "无法获取位置，请检查定位权限", icon: "none" });
        }
        // 轮询中的失败（含未授权）静默：dot 保持不显示
      },
    });
  },

  /** 定位落在另一个校区的 viewBox 内时切过去（不在任何校区/已在该校区则不动）。 */
  switchCampusForUserFix() {
    const fix = this.lastUserFix;
    if (!fix || this.campusGeoBounds.length === 0) return;
    const campusKey = campusKeyForGcj02Point(this.campusGeoBounds, fix.longitude, fix.latitude);
    if (campusKey && campusKey !== this.data.activeCampusKey) {
      this.setupCampus(campusKey);
    }
  },

  /** 按当前校区重算 dot（不在当前校区 viewBox 内 → null 隐藏）；focusAfter 时居中。 */
  applyUserLocationFix(focusAfter: boolean) {
    const campus = this.activeCampus;
    const fix = this.lastUserFix;
    if (!campus || !fix) return;
    const marker = computeUserLocationMarker({
      transform: campus.geoTransform,
      longitude: fix.longitude,
      latitude: fix.latitude,
      accuracyMeters: fix.accuracy,
      viewBox: this.viewBoxSize,
    });
    this.setData({ userLocation: marker }, () => this.refreshPinAnimatedStyle());
    if (!focusAfter) return;
    if (!marker) {
      // 定位不在任何校区内（switchCampusForUserFix 已先尝试过跨校区切换）：
      // dot 不显示，也不居中（focusPointWindow 会被 clamp 到校区边缘，体验跳变），toast 告知。
      wx.showToast({ title: "当前位置不在校区范围内", icon: "none" });
      return;
    }
    // 仿选中 POI 的聚焦效果（selectAt 同参数：campus 的 selection* 缩放/边距）
    this.animateToWindow(focusPointWindow({
      point: { x: marker.x, y: marker.y },
      currentWindow: this.currentWindow(),
      viewBox: this.viewBoxSize,
      container: this.containerSize,
      selectionScaleMultiplier: campus.selectionScaleMultiplier,
      selectionEdgePaddingRatio: campus.selectionEdgePaddingRatio,
    }));
  },

  /** 右侧控件列定位按钮：立即刷新一次定位并居中到用户位置。 */
  locateUser() {
    if (!this.data.ready) return;
    this.refreshUserLocation(true);
  },

  /**
   * 校区切换（浮动 pill 下拉项 bindtap / automator evaluate 直调）。
   * 手动切换 = 全量重置（对齐 Web 端 resetForCampus）：清选中/详情、关搜索面板、
   * 收起下拉；视口回校区预设焦点（setupCampus 的 createInitialWindow）。
   * 从搜索结果跨校区打开 POI 的 openPoi 路径不走这里（保留选中与详情）。
   */
  switchCampus(e: any) {
    const key = String(e.currentTarget.dataset.key);
    if (!key || key === this.data.activeCampusKey || !this.loadedRelease) {
      this.setData({ campusMenuOpen: false });
      return;
    }
    if (this.searchDebounceTimer) clearTimeout(this.searchDebounceTimer);
    this.currentHits = [];
    this.currentHitRows = [];
    this.displayHits = [];
    this.currentFilterPois = [];
    this.setData({
      campusMenuOpen: false,
      selected: null,
      detailOpen: false,
      detailSheet: null,
      detail: null,
      searchOpen: false,
      searchFocus: false,
      searchQuery: "",
      searchHits: [],
      activeFilters: [],
      filterRows: [],
      layerPanelOpen: false,
      eventSummary: null,
      eventDetailOpen: false,
      eventDetail: null,
    });
    this.previousSheetMode = "home";
    // 手动切校区 = 留在地图继续逛，清掉 tab 深链回跳标记（否则切校区后关详情会误跳回校车）。
    this.poiReturnTab = null;
    this.setSheetMode("home", false);
    this.syncFilterChips();
    this.setupCampus(key);
  },

  /** 浮动 pill：展开/收起校区下拉（再点一次收起，不做全局点击关闭）。 */
  toggleCampusMenu() {
    if (!this.data.ready) return;
    this.setData({ campusMenuOpen: !this.data.campusMenuOpen });
  },

  // ---------------------------------------------------------------------------
  // Part 3：搜索面板
  // ---------------------------------------------------------------------------

  openSearchPanel() {
    this.refreshRecents();
    this.setData({
      searchOpen: true,
      searchFocus: true,
      searchQuery: "",
      searchHits: [],
      searchActive: this.data.activeFilters.length > 0,
      searchStatus: "idle",
    });
    this.currentHits = [];
    this.currentHitRows = [];
    this.displayHits = [];
    // query 被清空（openPoi 路径关面板时 query 还在）→ 图钉从搜索过滤恢复
    this.recomputeMarkers();
    this.refreshSearchRows();
    this.setSheetMode(this.data.activeFilters.length > 0 ? "results" : "home");
    this.updateReport();
  },

  /** 取消 = 放弃本次搜索：清 query/命中，图钉从搜索过滤恢复（筛选保留）。 */
  closeSearchPanel() {
    if (this.searchDebounceTimer) clearTimeout(this.searchDebounceTimer);
    this.currentHits = [];
    this.currentHitRows = [];
    this.displayHits = [];
    this.setData({
      searchOpen: false,
      searchFocus: false,
      searchQuery: "",
      searchHits: [],
      searchActive: this.data.activeFilters.length > 0,
      searchStatus: "idle",
    });
    this.recomputeMarkers();
    this.refreshSearchRows();
    this.setSheetMode(this.data.activeFilters.length > 0 ? "results" : "home");
  },

  /** 最近查看前 6 条；poi 已不存在的条目跳过。 */
  refreshRecents() {
    const recents = listRecents()
      .map((entry) => {
        const poi = this.poiByKey.get(entry.poiKey);
        return poi ? { poiKey: poi.poiKey, name: poi.name, kindName: poi.kindName } : null;
      })
      .filter((row): row is { poiKey: string; name: string; kindName: string } => row !== null)
      .slice(0, 6);
    const recentRows = recents.map((row) => {
      const poi = this.poiByKey.get(row.poiKey)!;
      return {
        key: row.poiKey,
        poiKey: row.poiKey,
        merchantId: null,
        title: row.name,
        subtitle: poi.kindName ? `${poi.kindName} · ${poi.campusLabel}` : poi.campusLabel,
        iconUrl: `/images/poi/${poiRowIconName(poi)}.png`,
      };
    });
    // 列表条数变了 → 溢出情况变（最近查看只一两条时不可滚，此时整卡可拖）
    this.setData({ recents, recentRows }, () => this.measureSheetScrollable());
  },

  onSearchInput(e: any) {
    const query = String(e.detail.value ?? "");
    this.setData({
      searchQuery: query,
      searchOpen: true,
      searchActive: Boolean(query.trim()) || this.data.activeFilters.length > 0,
      searchStatus: query.trim() ? "loading" : "idle",
    });
    this.setSheetMode(queryMode(query, this.data.activeFilters.length));
    if (this.searchDebounceTimer) clearTimeout(this.searchDebounceTimer);
    this.searchDebounceTimer = setTimeout(() => this.runSearch(query), 180);
  },

  onSearchFocus() {
    this.setData({ searchOpen: true, searchFocus: true });
    this.refreshRecents();
    // 聚焦不强制全屏（真机上键盘弹出会把 results 档的输入框顶错位）；
    // 仅 collapsed 档抬到 home，让最近查看/结果区可见。全屏只在输入搜索或主动点全屏浮钮时发生。
    if (this.data.sheetMode === "collapsed") this.setSheetMode("home");
  },

  onSearchConfirm(e: any) {
    if (this.searchDebounceTimer) clearTimeout(this.searchDebounceTimer);
    this.runSearch(String(e.detail.value ?? ""));
  },

  /** 立即执行搜索（不防抖），automator 直调。 */
  performSearch(query: string) {
    if (this.searchDebounceTimer) clearTimeout(this.searchDebounceTimer);
    this.setData({
      searchQuery: query,
      searchOpen: true,
      searchActive: Boolean(query.trim()) || this.data.activeFilters.length > 0,
      searchStatus: query.trim() ? "loading" : "idle",
    });
    this.setSheetMode(queryMode(query, this.data.activeFilters.length));
    this.runSearch(query);
  },

  runSearch(query: string) {
    const loaded = this.loadedRelease;
    if (!loaded) return;
    const trimmed = query.trim();
    if (!trimmed) {
      // 清空 query 时重置上报去重，再次输入同一 query 仍算新一轮搜索。
      this.lastSearchReportKey = "";
      this.currentHits = [];
      this.currentHitRows = [];
      this.displayHits = [];
      this.setData({
        searchQuery: query,
        searchHits: [],
        searchStatus: "idle",
        searchActive: this.data.activeFilters.length > 0,
      });
      this.recomputeMarkers();
      this.refreshSearchRows();
      this.updateReport();
      return;
    }
    const docs = searchReleaseLocal(loaded.manifest, query);
    const hits = resolveSearchHits(docs, loaded.pois);
    // 行副标题：优先用搜索文档自带 subtitle（折叠后同一 poiKey 取先命中的那条）。
    const subtitleByKey = new Map<string, string>();
    for (const doc of docs) {
      if (!doc.subtitle) continue;
      const key = foldDocPoiKey(doc, new Set(loaded.pois.map((poi) => poi.poiKey)));
      if (!subtitleByKey.has(key)) subtitleByKey.set(key, doc.subtitle);
    }
    this.currentHits = hits;
    this.displayHits = hits;
    this.currentHitRows = hits.map((hit) => ({
      key: `${hit.poi.poiKey}:${hit.merchantId ?? ""}`,
      poiKey: hit.poi.poiKey,
      merchantId: hit.merchantId,
      title: hit.poi.name,
      subtitle:
        subtitleByKey.get(hit.poi.poiKey)
        ?? (hit.poi.kindName ? `${hit.poi.kindName} · ${hit.poi.campusLabel}` : hit.poi.campusLabel),
      iconUrl: `/images/poi/${poiRowIconName(hit.poi)}.png`,
    }));
    this.setData({ searchStatus: "ready", searchActive: true });
    // 防抖搜索出结果即报 search（同一「校区:query」不连续重复上报，对齐 Web 端去重）。
    const searchReportKey = `${this.data.activeCampusKey}:${trimmed}`;
    if (this.lastSearchReportKey !== searchReportKey) {
      this.lastSearchReportKey = searchReportKey;
      recordAnalyticsEvent({
        eventType: "search",
        campus: this.activeCampus?.label,
        meta: { q: trimmed.slice(0, 100), resultCount: hits.length },
      });
    }
    // 命中集合变化 → 图钉 matched 重算 + 面板行按 activeFilters 过滤
    this.recomputeMarkers();
    this.refreshSearchRows();
    this.updateReport();
  },

  /**
   * 搜索面板行重算（对齐 Web 端 filteredResults）：
   *   - 有 query：搜索命中按 activeFilters 多选 OR 过滤（设施还要求 filterable）；
   *   - 无 query 有筛选：结果 = filterMapPois 命中的本校区 POI 列表；
   *   - 都没有：空（面板显示最近查看）。
   */
  refreshSearchRows() {
    const loaded = this.loadedRelease;
    const campus = this.activeCampus;
    const filters = this.data.activeFilters;
    const query = this.data.searchQuery.trim();
    if (query) {
      const keep = (poi: MapPoi) =>
        filters.length === 0
        || (poi.filterGroups.some((filter) => filters.includes(filter))
          && (poi.entityType !== "facility" || poi.visibility.filterable));
      const pairs = this.currentHits
        .map((hit, index) => ({ hit, row: this.currentHitRows[index] }))
        .filter((pair) => pair.row && keep(pair.hit.poi));
      this.displayHits = pairs.map((pair) => pair.hit);
      const resultRows = pairs.map((pair) => pair.row);
      this.setData(
        { searchHits: resultRows, resultRows, filterRows: [], searchActive: true },
        () => this.measureSheetScrollable(),
      );
      return;
    }
    if (filters.length > 0 && loaded && campus) {
      const campusPois = loaded.pois.filter((poi) => poi.campusKey === campus.key);
      const rows = filterMapPois(campusPois, filters, null)
        .filter((poi) => poi.entityType !== "facility" || poi.visibility.filterable);
      this.currentFilterPois = rows;
      const filterRows = rows.map((poi) => ({
        poiKey: poi.poiKey,
        title: poi.name,
        subtitle: poi.kindName ? `${poi.kindName} · ${poi.campusLabel}` : poi.campusLabel,
      }));
      const resultRows = rows.map((poi) => ({
        key: poi.poiKey,
        poiKey: poi.poiKey,
        merchantId: null,
        title: poi.name,
        subtitle: poi.kindName ? `${poi.kindName} · ${poi.campusLabel}` : poi.campusLabel,
        iconUrl: `/images/poi/${poiRowIconName(poi)}.png`,
      }));
      this.setData(
        {
          searchHits: [],
          filterRows,
          resultRows,
          searchActive: true,
        },
        () => this.measureSheetScrollable(),
      );
      return;
    }
    this.currentFilterPois = [];
    this.setData(
      { filterRows: [], resultRows: [], searchActive: false },
      () => this.measureSheetScrollable(),
    );
  },

  // ---------------------------------------------------------------------------
  // 图层筛选（搜索面板 chips / 图层浮卡共用 activeFilters 与这套 toggle）
  // ---------------------------------------------------------------------------

  /** chip 选中态预计算（WXML 表达式不支持 indexOf 调用）。 */
  syncFilterChips() {
    const active = this.data.activeFilters;
    this.setData({
      filterChips: this.filterDefs.map((filter) => ({
        key: filter.key,
        label: filter.label,
        active: active.includes(filter.key),
      })),
    });
  },

  toggleFilter(key: string) {
    if (!key) return;
    const current = this.data.activeFilters;
    const next = current.includes(key)
      ? current.filter((filter) => filter !== key)
      : [...current, key];
    this.setData({ activeFilters: next });
    this.syncFilterChips();
    this.recomputeMarkers();
    this.refreshSearchRows();
    // chip 只改筛选/高亮，不改抽屉档位——全屏（results）只在用户输入搜索或主动点全屏浮钮时发生。
    this.updateReport();
  },

  /** 搜索面板「标签筛选」chip：只改筛选/高亮（联动结果列表），不改抽屉档位。 */
  onSearchFilterTap(e: any) {
    // 整卡拖拽抢到手势时本轮 tap 作废（chip 行落在可拖区，拖完抽屉不该顺手切筛选）
    if (this.consumeSheetTap()) return;
    this.toggleFilter(String(e.currentTarget.dataset.key));
  },

  /** 图层浮卡「高亮类别」chip：只改筛选/高亮，不弹搜索面板（对齐 handleFilterHighlight）。 */
  onLayerFilterTap(e: any) {
    this.toggleFilter(String(e.currentTarget.dataset.key));
  },

  resetFilters() {
    if (this.data.activeFilters.length === 0) return;
    this.setData({ activeFilters: [] });
    this.syncFilterChips();
    this.recomputeMarkers();
    this.refreshSearchRows();
    this.updateReport();
  },

  clearQuery() {
    if (this.searchDebounceTimer) clearTimeout(this.searchDebounceTimer);
    this.currentHits = [];
    this.currentHitRows = [];
    this.displayHits = [];
    this.setData({ searchQuery: "", searchHits: [], searchStatus: "idle" });
    this.recomputeMarkers();
    this.refreshSearchRows();
    this.setSheetMode(queryMode("", this.data.activeFilters.length));
    this.updateReport();
  },

  resetSearch() {
    if (this.searchDebounceTimer) clearTimeout(this.searchDebounceTimer);
    this.currentHits = [];
    this.currentHitRows = [];
    this.displayHits = [];
    this.currentFilterPois = [];
    this.setData({
      searchQuery: "",
      searchHits: [],
      resultRows: [],
      filterRows: [],
      activeFilters: [],
      searchStatus: "idle",
      searchActive: false,
    });
    this.syncFilterChips();
    this.recomputeMarkers();
    this.refreshRecents();
    this.setSheetMode("home");
    this.updateReport();
  },

  openAllFilters() {
    this.setData({ layerPanelOpen: true });
    this.updateReport();
  },

  openResultRow(e: any) {
    // 拖完卡片松手会在同一手势里派发 tap，抢到手势的那轮要作废（同地图面 tapSuppress）
    if (this.consumeSheetTap()) return;
    const index = Number(e.currentTarget.dataset.index);
    const row = this.data.resultRows[index] as SearchHitRow | undefined;
    const poi = row ? this.poiByKey.get(row.poiKey) : undefined;
    if (poi) this.openPoi(poi, row?.merchantId ?? null);
  },

  /** 图层浮钮/浮卡。 */
  toggleLayerPanel() {
    if (!this.data.ready) return;
    this.setData({ layerPanelOpen: !this.data.layerPanelOpen });
    this.updateReport();
  },

  /** 「运营事件」开关：控制事件 overlay 显隐，关掉时同时清掉摘要卡。 */
  toggleEvents() {
    const next = !this.data.eventsOn;
    this.setData({ eventsOn: next, eventSummary: null });
    this.refreshEventOverlay();
    this.updateReport();
  },

  /**
   * 摘要卡「暂时关闭」：本次不再显示运营事件 overlay（eventsOn 不持久化，
   * 下次进页面自动恢复），toast 提示重新打开的位置（图层浮卡开关）。
   */
  dismissEvents() {
    if (!this.data.eventsOn) return;
    this.setData({ eventsOn: false, eventSummary: null });
    this.refreshEventOverlay();
    this.updateReport();
    wx.showToast({ title: "已暂时关闭，可在「图层」重新打开", icon: "none" });
  },

  // ---------------------------------------------------------------------------
  // 运营事件（GET /api/public/operations → overlay marker + 摘要卡 + 详情 sheet）
  // ---------------------------------------------------------------------------

  /** 拉取事件（onLoad 后 fire-and-forget）；任何失败静默降级为不显示事件。 */
  async loadOperations() {
    try {
      const events = await fetchOperations();
      this.activeEvents = activeOperations(events);
    } catch {
      this.activeEvents = [];
    }
    this.refreshEventOverlay();
    this.updateReport();
  },

  /** 按当前校区过滤 overlay items 并刷新事件 marker（eventsOn 关闭时 marker 清空）。 */
  refreshEventOverlay() {
    const campus = this.activeCampus;
    if (!campus) return;
    let items: EventOverlayItem[] = [];
    try {
      items = overlayItemsForCampus(buildEventOverlayItems(this.activeEvents), campus.id);
    } catch {
      // live 数据防御：单条几何违约整批降级，不影响地图
      items = [];
    }
    this.eventItems = items;
    // 图钉/锚点只给点状「事件位置」；区域/路径靠轮廓 + eventRegionHit 命中（对齐 Web 端）
    const pinItems = eventMarkerItems(items);
    this.eventAnchors = pinItems.map((item) => {
      const [x, y] = overlayAnchor(item.geometry);
      return { eventId: item.event.id, x, y };
    });
    const markers: EventMarkerRow[] = this.data.eventsOn
      ? pinItems.map((item) => {
        const [x, y] = overlayAnchor(item.geometry);
        return {
          key: item.locationId,
          eventId: item.event.id,
          x,
          y,
          color: eventColor(item.event),
        };
      })
      : [];
    this.setData({ eventMarkers: markers, eventCount: items.length }, () => this.refreshPinAnimatedStyle());
    this.applyEventOverlayImage(items);
  },

  /**
   * 面/线事件的真实轮廓：与楼宇高亮同一招——把 overlay 几何画进一张透明 SVG
   * 写本地临时文件，同尺寸同定位 <image> 盖在底图上（描边随缩放一起变粗，
   * 不同于 Web 端的屏幕恒定描边，可接受）。失败静默降级为只有 marker。
   */
  applyEventOverlayImage(items: EventOverlayItem[]) {
    if (!this.data.eventsOn || !this.activeCampus) {
      this.clearEventOverlayImage();
      return;
    }
    const shapes: string[] = [];
    const strokeWidth = Math.max(1.5, this.viewBoxSize.width / 500);
    for (const item of items) {
      const color = eventColor(item.event);
      const geometry = item.geometry;
      if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") {
        const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
        for (const polygon of polygons) {
          for (const ring of polygon) {
            const points = ring.map(([x, y]) => `${x},${y}`).join(" ");
            shapes.push(
              `<polygon points="${points}" fill="${color}" fill-opacity="0.15" stroke="${color}"` +
              ` stroke-width="${strokeWidth}" stroke-dasharray="${strokeWidth * 3} ${strokeWidth * 2}"/>`,
            );
          }
        }
      } else if (geometry.type === "LineString") {
        const points = geometry.coordinates.map(([x, y]) => `${x},${y}`).join(" ");
        shapes.push(
          `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="${strokeWidth}"` +
          ` stroke-dasharray="${strokeWidth * 3} ${strokeWidth * 2}" stroke-linecap="round"/>`,
        );
      }
    }
    if (shapes.length === 0) {
      this.clearEventOverlayImage();
      return;
    }
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${this.viewBoxSize.width} ${this.viewBoxSize.height}"` +
      ` width="${this.viewBoxSize.width}" height="${this.viewBoxSize.height}">${shapes.join("")}</svg>`;
    try {
      const fs = wx.getFileSystemManager();
      const filePath = `${wx.env.USER_DATA_PATH}/map-event-overlay-${this.activeCampus.mapVersionId}-${Date.now()}.svg`;
      fs.writeFileSync(filePath, svg, "utf8");
      const previous = this.eventOverlayFilePath;
      this.eventOverlayFilePath = filePath;
      this.setData({ eventOverlayUrl: filePath });
      if (previous && previous !== filePath) {
        try {
          fs.unlink({ filePath: previous, fail: () => {} });
        } catch {
          // 删除旧临时文件失败不影响功能
        }
      }
    } catch {
      this.clearEventOverlayImage();
    }
  },

  clearEventOverlayImage() {
    const previous = this.eventOverlayFilePath;
    this.eventOverlayFilePath = null;
    if (this.data.eventOverlayUrl) this.setData({ eventOverlayUrl: "" });
    if (previous) {
      try {
        wx.getFileSystemManager().unlink({ filePath: previous, fail: () => {} });
      } catch {
        // 删除旧临时文件失败不影响功能
      }
    }
  },

  /** 点中事件 marker → 底部摘要卡。 */
  selectEvent(eventId: string) {
    const item = this.eventItems.find((entry) => entry.event.id === eventId);
    if (!item) return;
    const event = item.event;
    this.setData({
      eventSummary: {
        id: event.id,
        color: eventColor(event),
        severity: event.severity,
        iconUrl: severityIconUrl(event.severity),
        typeLabel: eventTypeLabel(event.eventType),
        title: event.title,
        description: event.description ?? "",
      },
    });
    this.updateReport();
  },

  closeEventSummary() {
    if (!this.data.eventSummary) return;
    this.setData({ eventSummary: null });
    this.updateReport();
  },

  /** 摘要卡「查看详情 ›」/ POI 横幅点按 → 事件详情 sheet。 */
  openEventDetailById(eventId: string) {
    const event = this.activeEvents.find((entry) => entry.id === eventId);
    if (!event) return;
    const loaded = this.loadedRelease;
    this.setData({
      eventSummary: null,
      eventDetailOpen: true,
      eventDetail: {
        id: event.id,
        color: eventColor(event),
        severity: event.severity,
        iconUrl: severityIconUrl(event.severity),
        typeLabel: eventTypeLabel(event.eventType),
        statusLabel: eventStatusLabel(event.operationalStatus),
        severityText: severityLabel(event.severity),
        title: event.title,
        dateRange: formatEventDateRange(event),
        description: event.description ?? "",
        targets: loaded ? resolveEventTargetNames(event.targets, loaded.pois) : [],
        updates: event.updates.map((update) => ({
          id: update.id,
          day: formatEventDay(update.createdAt),
          message: update.message,
        })),
      },
    });
    this.updateReport();
  },

  openEventDetailFromSummary() {
    const summary = this.data.eventSummary as EventSummaryData | null;
    if (summary) this.openEventDetailById(summary.id);
  },

  /** POI 详情 sheet 的运营横幅点按 → 对应事件详情。 */
  openEventBanner() {
    const sheet = this.data.detailSheet as DetailSheetData | null;
    if (sheet && sheet.eventBanner) this.openEventDetailById(sheet.eventBanner.id);
  },

  closeEventDetail() {
    this.setData({ eventDetailOpen: false, eventDetail: null });
    this.updateReport();
  },

  /** 打开当前结果第 N 条（automator 直调；WXML 点行也走这里）。 */
  openSearchHit(index: number) {
    const hit = this.displayHits[index];
    if (!hit) return;
    this.openPoi(hit.poi, hit.merchantId);
  },

  openSearchHitRow(e: any) {
    this.openSearchHit(Number(e.currentTarget.dataset.index));
  },

  /** 无 query 有筛选时的筛选结果行（filterRows ↔ currentFilterPois 同序）。 */
  openFilterRow(e: any) {
    const poi = this.currentFilterPois[Number(e.currentTarget.dataset.index)];
    if (poi) this.openPoi(poi, null);
  },

  openRecentRow(e: any) {
    if (this.consumeSheetTap()) return;
    const poi = this.poiByKey.get(String(e.currentTarget.dataset.poiKey));
    if (poi) this.openPoi(poi, null);
  },

  // ---------------------------------------------------------------------------
  // Part 3：POI 详情 sheet
  // ---------------------------------------------------------------------------

  /** 搜索/最近查看打开 POI：切校区 → 聚焦动画 → 详情 sheet → 记最近查看。 */
  openPoi(poi: MapPoi, merchantId: string | null, source: AnalyticsPoiSource = "search_result") {
    this.setData({ searchOpen: false, searchFocus: false });
    if (poi.campusKey !== this.data.activeCampusKey && this.loadedRelease) {
      this.setupCampus(poi.campusKey);
    }
    const shape = this.buildingShapes.find((item) => item.poiKey === poi.poiKey);
    const point = poi.markerPoint ?? (shape ? shape.center : null);
    if (point) {
      this.selectAt(point, { poiKey: poi.poiKey, name: poi.name, kindName: poi.kindName }, poi.sourceElementId);
    }
    this.openDetailSheet(poi, merchantId, source);
  },

  openDetailByKey(poiKey: string, merchantId: string | null, source: AnalyticsPoiSource = "map_object") {
    const poi = this.poiByKey.get(poiKey);
    if (poi) this.openDetailSheet(poi, merchantId, source);
  },

  openDetailSheet(poi: MapPoi, merchantId: string | null, source: AnalyticsPoiSource = "search_result") {
    // 详情打开即报 poi_view（对齐 Web 端 openPoi；所有入口都汇到这里，只此一处）。
    recordAnalyticsEvent({
      eventType: "poi_view",
      campus: poi.campusLabel,
      poiId: poi.entityId,
      poiName: poi.name,
      meta: { source },
    });
    const media = detailMedia(poi.detail.media);
    const facts = detailFacts(poi.detail.facts);
    const statusBanner =
      poi.entityType === "facility" ? facilityStatusLabel(poi.facilityOperationalStatus) : "";
    const initialMerchant = merchantId
      ? poi.merchants.find((merchant) => merchant.id === merchantId) ?? null
      : null;
    // 运营横幅：active 事件 targets 命中当前 POI（含楼内设施/商户/站点），取第一条
    const bannerEvent = eventsTargetingPoi(this.activeEvents, poi)[0] ?? null;
    const detail: DetailSheetData = {
      poiKey: poi.poiKey,
      name: poi.name,
      subtitle: poi.kindName ? `${poi.kindName} · ${poi.campusLabel}` : poi.campusLabel,
      favorite: isFavorite(poi.poiKey),
      canNavigate: poi.navigationPoint !== null,
      statusBanner,
      media,
      summary: poi.detail.summary,
      description: poi.detail.description,
      facts,
      isBuilding: poi.entityType === "building",
      facilities: poi.facilities.map((facility) => {
        const label = facilityStatusLabel(facility.operationalStatus);
        return {
          id: facility.id,
          label: label ? `${facility.displayName} · ${label}` : facility.displayName,
          iconUrl: `/images/poi/${facilityIconName(facility.typeCode)}.png`,
        };
      }),
      merchants: poi.merchants.map((merchant) => ({
        id: merchant.id,
        name: merchant.name,
        stallCode: merchant.stallCode,
        subtitle: [merchant.businessType, merchant.openingHours].filter(Boolean).join(" · ") || "营业信息完善中",
      })),
      merchant: initialMerchant ? this.merchantView(initialMerchant) : null,
      eventBanner: bannerEvent
        ? {
          id: bannerEvent.id,
          title: bannerEvent.title,
          severity: bannerEvent.severity,
          iconUrl: severityIconUrl(bannerEvent.severity),
        }
        : null,
    };
    if (this.data.sheetMode !== "poi") {
      this.previousSheetMode = previousModeBeforePoi(this.data.sheetMode as SheetMode);
      // 图层浮卡开着时开详情会临时收起（下方 setData），关详情时原样恢复；
      // 详情之间切换不覆盖最初记录（与 previousSheetMode 同一个守卫）。
      this.previousLayerPanelOpen = Boolean(this.data.layerPanelOpen);
    }
    // 直接打开详情（点图钉/搜索结果/楼宇）不属于 tab 深链回跳，清掉残留标记。
    this.poiReturnTab = null;
    this.poiContentHeight = null;
    // 内容自适应分两步：先把 sheetMode 直置 poi（抽屉物理位置不动，只是让
    // .detail-measure 节点上树——wx:if 门控 sheetMode==='poi'，从别的档位
    // 直接量量不到节点），在 setData 回调里实测内容高度，再由
    // configureSheet("poi") 把抽屉动画到内容自适应目标；测量失败回落
    // heights.poi 上限（measurePoiContentHeight 失败也会触发回调）。
    this.setData(
      {
        detailOpen: true,
        detailSheet: detail,
        detail,
        layerPanelOpen: false,
        photoIndex: 0,
        merchantPhotoIndex: 0,
        sheetMode: "poi",
      },
      () => {
        this.measurePoiContentHeight(() => this.configureSheet("poi", true));
      },
    );
    // storage 写入 / 最近查看 / 诊断 report 与动画首帧无关，延后到抽屉动画结束后
    // （recents 只在搜索面板可见，poi 档看不到，晚到 ~280ms 无感）。
    this.deferAfterSheetAnim(() => {
      addRecent(poi.poiKey);
      this.refreshRecents();
      this.updateReport();
    });
    this.localizeDetailMedia(poi.poiKey, null);
    if (initialMerchant) this.localizeDetailMedia(poi.poiKey, initialMerchant.id);
  },

  async localizeMediaRows(rows: DetailMediaRow[], identity: string): Promise<DetailMediaRow[]> {
    return Promise.all(rows.map(async (row, index) => {
      if (!row.sourceUrl.startsWith("/")) return row;
      try {
        const result = await apiGetBinary(row.sourceUrl);
        const path = writeLocalBinaryAsset(
          "public-media",
          `${identity}-${index}`,
          result.data,
          mediaExtension(result.contentType),
        );
        this.mediaFilePaths.add(path);
        return { ...row, url: path, local: true };
      } catch {
        return { ...row, url: "", local: false };
      }
    }));
  },

  /** 详情先展示结构，云托管媒体到达后原位替换；过期详情的异步结果直接丢弃。 */
  async localizeDetailMedia(poiKey: string, merchantId: string | null) {
    const snapshot = this.data.detail as DetailSheetData | null;
    if (!snapshot || snapshot.poiKey !== poiKey) return;
    if (merchantId) {
      if (!snapshot.merchant || snapshot.merchant.id !== merchantId) return;
      const media = await this.localizeMediaRows(snapshot.merchant.media, `${poiKey}-${merchantId}`);
      const current = this.data.detail as DetailSheetData | null;
      if (!current?.merchant || current.poiKey !== poiKey || current.merchant.id !== merchantId) return;
      const next = { ...current, merchant: { ...current.merchant, media: media.filter((item) => item.url) } };
      this.setData({ detail: next, detailSheet: next });
      return;
    }
    const media = await this.localizeMediaRows(snapshot.media, poiKey);
    const current = this.data.detail as DetailSheetData | null;
    if (!current || current.poiKey !== poiKey) return;
    const next = { ...current, media: media.filter((item) => item.url) };
    this.setData({ detail: next, detailSheet: next });
  },

  merchantView(merchant: MerchantSummary): DetailSheetData["merchant"] {
    const facts = [
      merchant.openingHours ? { label: "营业时间", value: merchant.openingHours } : null,
      merchant.stallCode ? { label: "档口号", value: merchant.stallCode } : null,
      merchant.avgPrice ? { label: "人均", value: merchant.avgPrice } : null,
      merchant.phone ? { label: "联系电话", value: merchant.phone } : null,
    ]
      .filter((fact): fact is { label: string; value: string } => fact !== null)
      .map((fact, index) => ({
        key: `${fact.label}:${index}`,
        ...fact,
        isPhone: fact.label.includes("电话"),
        iconUrl: factIconUrl(fact.label, index),
      }));
    return {
      id: merchant.id,
      name: merchant.name,
      subtitle: [merchant.businessType, merchant.openingHours].filter(Boolean).join(" · ") || "营业信息完善中",
      summary: merchant.summary,
      media: detailMedia(merchant.media),
      facts,
      menu: merchant.menu.map((item, index) => ({
        key: `${item.name}:${index}`,
        name: item.name,
        price: item.price,
        description: item.description,
      })),
    };
  },

  openMerchantRow(e: any) {
    const sheet = this.data.detailSheet as DetailSheetData | null;
    if (!sheet) return;
    const poi = this.poiByKey.get(sheet.poiKey);
    const merchant = poi?.merchants.find((item) => item.id === String(e.currentTarget.dataset.id));
    if (!merchant) return;
    const next = { ...sheet, merchant: this.merchantView(merchant) };
    // 商户子视图内容量不同，重测高度并按需动画调整抽屉（poi 档内容自适应）。
    this.setData({ detailSheet: next, detail: next, merchantPhotoIndex: 0 }, () => {
      this.measurePoiContentHeight((changed) => {
        if (changed && this.data.sheetMode === "poi") this.configureSheet("poi", true);
      });
    });
    this.updateReport();
    this.localizeDetailMedia(next.poiKey, next.merchant?.id ?? null);
  },

  backFromMerchant() {
    const sheet = this.data.detailSheet as DetailSheetData | null;
    if (!sheet || !sheet.merchant) return;
    const next = { ...sheet, merchant: null };
    this.setData({ detailSheet: next, detail: next, merchantPhotoIndex: 0 }, () => {
      this.measurePoiContentHeight((changed) => {
        if (changed && this.data.sheetMode === "poi") this.configureSheet("poi", true);
      });
    });
    this.updateReport();
  },

  closeDetail() {
    this.closePoi();
  },

  toggleFavorite() {
    const detail = this.data.detail as DetailSheetData | null;
    if (!detail) return;
    const favorites = toggleFavoriteEntry(detail.poiKey);
    const next = { ...detail, favorite: favorites.includes(detail.poiKey) };
    this.setData({ detail: next, detailSheet: next });
    wx.showToast({ title: next.favorite ? "已收藏" : "已取消收藏", icon: "none" });
    this.updateReport();
  },

  onPhotoChange(e: any) {
    this.setData({ photoIndex: Number(e.detail.current) || 0 });
  },

  onMerchantPhotoChange(e: any) {
    this.setData({ merchantPhotoIndex: Number(e.detail.current) || 0 });
  },

  previewPhoto(e: any) {
    const detail = this.data.detail as DetailSheetData | null;
    if (!detail) return;
    const scope = String(e.currentTarget.dataset.scope ?? "poi");
    const media = scope === "merchant" && detail.merchant ? detail.merchant.media : detail.media;
    const requested = String(e.currentTarget.dataset.url ?? "");
    const previewable = media.filter((item) => item.url);
    const previewUrls = previewable.map((item) => item.url);
    if (previewUrls.length) {
      wx.previewImage({ current: previewUrls.includes(requested) ? requested : previewUrls[0], urls: previewUrls });
    }
  },

  noop() {},

  callPhone(e: any) {
    const value = String(e.currentTarget.dataset.value ?? "");
    const phoneNumber = value.replace(/[^\d+()-]/g, "");
    if (phoneNumber) wx.makePhoneCall({ phoneNumber });
  },

  /** 导航：GCJ-02 坐标直接给 wx.openLocation。 */
  navigateToPoi() {
    const sheet = this.data.detailSheet as DetailSheetData | null;
    const poi = sheet ? this.poiByKey.get(sheet.poiKey) : undefined;
    const point = poi?.navigationPoint;
    if (!point) return;
    wx.openLocation({
      latitude: point.latitude,
      longitude: point.longitude,
      name: point.displayName,
      scale: 18,
    });
  },

  openFloors() {
    const sheet = this.data.detailSheet as DetailSheetData | null;
    const poi = sheet ? this.poiByKey.get(sheet.poiKey) : undefined;
    if (!poi || poi.entityType !== "building") return;
    wx.navigateTo({ url: `/pages/floors/floors?placeId=${encodeURIComponent(poi.entityId)}` });
  },

  /** automator 核对用摘要。window 从共享变量读，手势拖动后也是实时值。 */
  updateReport() {
    const loaded = this.loadedRelease;
    const campus = this.activeCampus;
    if (!loaded || !campus) return;
    const win = this.currentWindow();
    const round = (value: number) => Math.round(value * 100) / 100;
    this.setData({
      report: {
        releaseId: loaded.releaseId,
        version: loaded.version,
        campusKey: campus.key,
        mapVersionId: campus.mapVersionId,
        viewBox: `0 0 ${this.viewBoxSize.width} ${this.viewBoxSize.height}`,
        markerCount: this.mapMarkers.length,
        buildingShapeCount: this.buildingShapes.length,
        window: {
          x: round(win.x),
          y: round(win.y),
          width: round(win.width),
          height: round(win.height),
        },
        selectedPoiKey: this.data.selected ? this.data.selected.poiKey : null,
        userLocation: this.data.userLocation
          ? {
            x: round(this.data.userLocation.x),
            y: round(this.data.userLocation.y),
            radius: round(this.data.userLocation.radius),
          }
          : null,
        filterHighlightActive: Boolean(this.data.filterHighlightUrl),
        filterHighlightedBuildingCount: this.data.filterHighlightUrl
          ? this.filterMatchedSourceElementIds.length
          : 0,
        highlightActive: Boolean(this.data.highlightUrl),
        selectedMarkerPoiKey: this.data.markers.find((marker) => marker.selected)?.poiKey ?? null,
        searchQuery: this.data.searchQuery,
        searchHitCount: this.currentHits.length,
        searchFirstPoiKey: this.currentHits[0] ? this.currentHits[0].poi.poiKey : null,
        detailOpen: this.data.detailOpen,
        detailPoiKey: this.data.detailSheet ? (this.data.detailSheet as DetailSheetData).poiKey : null,
        detailMerchantId: this.data.detailSheet && (this.data.detailSheet as DetailSheetData).merchant
          ? (this.data.detailSheet as DetailSheetData).merchant!.id
          : null,
        detailEventBannerId: this.data.detailSheet && (this.data.detailSheet as DetailSheetData).eventBanner
          ? (this.data.detailSheet as DetailSheetData).eventBanner!.id
          : null,
        activeFilters: [...this.data.activeFilters],
        filterRowCount: this.data.filterRows.length,
        layerPanelOpen: this.data.layerPanelOpen,
        eventsOn: this.data.eventsOn,
        eventCount: this.data.eventCount,
        eventMarkerCount: this.data.eventMarkers.length,
        eventSummaryId: this.data.eventSummary ? (this.data.eventSummary as EventSummaryData).id : null,
        eventDetailOpen: this.data.eventDetailOpen,
        eventDetailId: this.data.eventDetail ? (this.data.eventDetail as EventDetailData).id : null,
      },
    });
  },
});
