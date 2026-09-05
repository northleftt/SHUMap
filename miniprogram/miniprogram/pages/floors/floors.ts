// 楼层图页（Part 3）：楼宇楼层 pills + 列表/平面图双视图。
//
// 平面图视图渲染架构与地图页一致：
//   - winX/winY/winScale 共享变量 + applyAnimatedStyle 驱动 .floor-world transform；
//   - 设施徽章反向 scale(1/s) 保持屏幕尺寸；
//   - 底图 <image> 直连 /api/public/maps/<floorMapVersionId>/asset，RASTER_RATIO=3 栅格余量。
// 手势识别：JS 线程 bindtouchstart/move/end/tap + lib/map/viewport.ts 纯函数
// （worklet:ongesture 在本环境真机不触发，见 AGENTS.md 坑 #8）；
// fit 整图 = focus 中心、scaleMultiplier=1 的 createInitialWindow 同式。
// 徽章 tap：onSurfaceTap 换算世界坐标后找最近徽章（容差 24px/scale），不用徽章 bindtap。
//
// data.report 供 automator evaluate 核对；switchFloor/setView 可直调。

import { loadReleaseWithCache, mapAssetCacheKey } from "../../lib/release/loader";
import type { LoadedRelease } from "../../lib/release/mapData";
import {
  facilityAnchorsForFloor,
  floorMapVersionsByFloor,
  type FacilityAnchorPoint,
} from "../../lib/release/floorPlans";
import { facilityStatusLabel } from "../../lib/release/facilityStatus";
import type { MapPoi, ReleaseFloor, ReleaseMapVersion } from "../../lib/release/types";
import { parseSvgViewBox } from "../../lib/svg-geometry";
import {
  clamp,
  getScale,
  panWindowBy,
  zoomWindowAt,
  type Size,
  type ViewWindow,
} from "../../lib/map/viewport";
import { apiGetBinary, apiGetText } from "../../lib/api";
import { requestErrorRetryText } from "../../lib/request-error";
import { recordPageView } from "../../lib/analytics";
import { enableShareMenus, shareQuery, sharePath, shareTitle } from "../../lib/share";
import {
  mediaExtension,
  removeLocalAsset,
  writeLocalBinaryAsset,
  writeLocalTextAsset,
} from "../../lib/local-assets";

const RASTER_RATIO = 3;
const TAP_TOLERANCE_PX = 24;
/** 平面图边缘留白（对齐校区图 edgePaddingRatio 的语义，取一个较小值）。 */
const EDGE_PAD_RATIO = 0.1;
const MAX_SCALE = 6;

interface FloorRow {
  id: string;
  levelCode: string;
  levelOrder: number;
  displayName: string;
  hasPlan: boolean;
}

interface FacilityRow {
  id: string;
  name: string;
  typeName: string;
  location: string;
  statusLabel: string;
}

Page({
  data: {
    statusBarHeight: 20,

    loading: true,
    ready: false,
    errorMessage: "",

    placeId: "",
    buildingName: "",

    floors: [] as FloorRow[],
    activeFloorId: "",
    view: "list" as "list" | "plan",
    hasPlan: false,

    assetUrl: "",
    worldWidth: 0,
    worldHeight: 0,
    rasterRatio: RASTER_RATIO,
    anchors: [] as FacilityAnchorPoint[],
    selectedFacility: null as FacilityRow | null,

    floorNote: "",
    floorMedia: [] as Array<{ sourceUrl: string; url: string }>,
    floorFacilities: [] as FacilityRow[],

    // 摘要（纯 JSON），automator evaluate 读取做核对
    report: null as unknown,
  },

  onLoad(options: Record<string, string | undefined>) {
    enableShareMenus();
    recordPageView("floors");
    const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : { statusBarHeight: 20 };
    this.setData({
      statusBarHeight: windowInfo.statusBarHeight ?? 20,
      placeId: options.placeId ?? "",
    });
    // 转发深链带的楼层（?floor=）：boot 里优先选它，匹配不上回落最低层。
    this.pendingFloorId = options.floor ? decodeURIComponent(options.floor) : "";

    // 视口共享变量：JS 线程触摸处理器直写，UI 线程 applyAnimatedStyle 跟随
    // （worklet:ongesture 真机不触发，手势识别在 JS 线程，见 AGENTS.md 坑 #7）。
    this.winX = wx.worklet.shared(0);
    this.winY = wx.worklet.shared(0);
    this.winScale = wx.worklet.shared(1);

    this.loadedRelease = null as LoadedRelease | null;
    this.poi = null as MapPoi | null;
    this.floorRows = [] as ReleaseFloor[];
    this.plansByFloor = new Map<string, ReleaseMapVersion>();
    this.containerSize = { width: 0, height: 0 } as Size;
    this.containerLeft = 0;
    this.containerTop = 0;
    this.viewBoxSize = { width: 0, height: 0 } as Size;
    this.planMinScale = 0;
    this.touch = null;
    this.animatedStyleApplied = false;
    this.planFilePath = null as string | null;
    this.mediaFilePaths = new Set<string>();

    this.boot();
  },

  onUnload() {
    removeLocalAsset(this.planFilePath);
    this.planFilePath = null;
    for (const path of this.mediaFilePaths) removeLocalAsset(path);
    this.mediaFilePaths.clear();
  },

  /** 转发：标题带楼宇 + 当前层，路径带 placeId/floor 还原到同一层。 */
  onShareAppMessage() {
    return {
      title: shareTitle(this.floorShareSubject(), "楼层图"),
      path: sharePath("/pages/floors/floors", this.floorShareParams()),
    };
  },

  /** 分享到朋友圈：本页只读 release 数据，单页模式下无 tabBar/web-view 依赖。 */
  onShareTimeline() {
    return {
      title: shareTitle(this.floorShareSubject(), "楼层图"),
      query: shareQuery(this.floorShareParams()),
    };
  },

  /** 卡片主题：「HA 楼 3F」；楼宇名未就绪时空串走 App 名兜底。 */
  floorShareSubject(): string {
    const name = this.data.buildingName;
    if (!name) return "";
    const floor = (this.data.floors as FloorRow[]).find((item) => item.id === this.data.activeFloorId);
    return floor ? `${name} ${floor.displayName}` : name;
  },

  floorShareParams(): Record<string, string> {
    return { placeId: this.data.placeId, floor: this.data.activeFloorId };
  },

  async boot() {
    this.setData({ loading: true, ready: false, errorMessage: "" });
    try {
      if (!this.data.placeId) throw new Error("缺少 placeId 参数");
      const loaded = await loadReleaseWithCache();
      const poi = loaded.pois.find(
        (item) => item.entityType === "building" && item.entityId === this.data.placeId,
      );
      if (!poi) throw new Error("当前版本里找不到该楼宇");
      const plansByFloor = floorMapVersionsByFloor(loaded.manifest);
      const floorRows = loaded.manifest.floors
        .filter((floor) => floor.buildingPlaceId === poi.entityId && floor.isPublic !== 0)
        .sort((left, right) => left.levelOrder - right.levelOrder);
      if (!floorRows.length) throw new Error("该楼宇暂无公开的楼层信息");

      this.loadedRelease = loaded;
      this.poi = poi;
      this.floorRows = floorRows;
      this.plansByFloor = plansByFloor;
      await this.measureViewport();
      this.setData({
        buildingName: poi.name,
        floors: floorRows.map((floor) => ({
          id: floor.id,
          levelCode: floor.levelCode,
          levelOrder: floor.levelOrder,
          displayName: floor.displayName,
          hasPlan: plansByFloor.has(floor.id),
        })),
      });
      // 深链指定的楼层优先（转发卡片带 ?floor=），匹配不上回落 levelOrder 最小的层
      const pendingFloor = this.pendingFloorId;
      this.pendingFloorId = "";
      const target = pendingFloor && floorRows.some((floor) => floor.id === pendingFloor)
        ? pendingFloor
        : floorRows[0].id;
      await this.setupFloor(target);
    } catch (error) {
      this.setData({
        loading: false,
        errorMessage: requestErrorRetryText(error),
      });
    }
  },

  measureViewport(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.createSelectorQuery()
        .select(".floor-viewport")
        .boundingClientRect((rect: any) => {
          if (!rect || !rect.width || !rect.height) {
            reject(new Error("楼层图容器测量失败"));
            return;
          }
          this.containerLeft = rect.left;
          this.containerTop = rect.top;
          this.containerSize = { width: rect.width, height: rect.height };
          resolve();
        })
        .exec();
    });
  },

  /** 楼层图 SVG：与校区底图同缓存通道（map-asset-<mapVersionId>，跨 release 复用）。 */
  async fetchFloorSvg(mapVersionId: string): Promise<string> {
    const key = mapAssetCacheKey(mapVersionId);
    try {
      const cached = wx.getStorageSync(key);
      if (typeof cached === "string" && cached !== "") return cached;
    } catch {
      // 读取失败当作未命中，走网络。
    }
    const svg = await apiGetText(`/api/public/maps/${encodeURIComponent(mapVersionId)}/asset`);
    try {
      wx.setStorageSync(key, svg);
    } catch {
      // 超容量等写入失败：静默降级为不缓存（同 loader 约定）。
    }
    return svg;
  },

  /** 切层装配：图纸（如有）、设施锚点、列表数据、视口参数，一次切完。 */
  async setupFloor(floorId: string) {
    const loaded = this.loadedRelease;
    const poi = this.poi;
    const floor = this.floorRows.find((item) => item.id === floorId);
    if (!loaded || !poi || !floor) return;

    const plan = this.plansByFloor.get(floorId) ?? null;
    const floorFacilities: FacilityRow[] = poi.facilities
      .filter((facility) => facility.floorId === floor.id)
      .map((facility) => ({
        id: facility.id,
        name: facility.displayName,
        typeName: facility.typeName,
        location: typeof facility.content.locationDescription === "string"
          ? facility.content.locationDescription
          : "",
        statusLabel: facilityStatusLabel(facility.operationalStatus),
      }));
    const floorNote = poi.detail.facts.find((fact) => fact.label === "楼层说明")?.value ?? "";
    const floorMedia = poi.detail.media
      .filter((item) => item.floorLevelCode === floor.levelCode && item.url.trim())
      .map((item) => ({
        sourceUrl: item.url,
        url: item.url,
      }));

    let assetUrl = "";
    let worldWidth = 0;
    let worldHeight = 0;
    let anchors: FacilityAnchorPoint[] = [];
    if (plan) {
      const svgRaw = await this.fetchFloorSvg(plan.id);
      const viewBox = parseSvgViewBox(svgRaw);
      worldWidth = viewBox.width;
      worldHeight = viewBox.height;
      try {
        const next = writeLocalTextAsset("floor-map", plan.id, svgRaw, "svg");
        const previous = this.planFilePath;
        this.planFilePath = next;
        if (previous && previous !== next) removeLocalAsset(previous);
        assetUrl = next;
      } catch {
        assetUrl = "";
      }
      anchors = facilityAnchorsForFloor(loaded.manifest, floor.id, plan.id).map((anchor) => ({
        ...anchor,
        // 徽章坐标与 viewBox 同系；<image> 从 (0,0) 布局，减去 viewBox 原点偏移。
        x: anchor.x - viewBox.x,
        y: anchor.y - viewBox.y,
      }));

      const fitScale = Math.min(
        this.containerSize.width / viewBox.width,
        this.containerSize.height / viewBox.height,
      );
      this.viewBoxSize = { width: viewBox.width, height: viewBox.height };
      this.planMinScale = fitScale;
      // fit 整图：createInitialWindow（focusPoint 中心、scaleMultiplier=1）+ clampWindow 同式
      const winW = this.containerSize.width / fitScale;
      const winH = this.containerSize.height / fitScale;
      const padX = viewBox.width * EDGE_PAD_RATIO;
      const padY = viewBox.height * EDGE_PAD_RATIO;
      this.winX.value = Math.min(
        Math.max(viewBox.width / 2 - winW / 2, -padX),
        Math.max(0, viewBox.width - winW) + padX,
      );
      this.winY.value = Math.min(
        Math.max(viewBox.height / 2 - winH / 2, -padY),
        Math.max(0, viewBox.height - winH) + padY,
      );
      this.winScale.value = fitScale;
    } else {
      this.planMinScale = 0; // 无图纸：手势整体停用（事件处理器按 view/hasPlan 守卫）
    }

    this.setData({
      loading: false,
      ready: true,
      errorMessage: "",
      activeFloorId: floor.id,
      hasPlan: plan !== null,
      // 无图纸强制列表；有图纸默认平面图
      view: plan ? "plan" : "list",
      assetUrl,
      worldWidth,
      worldHeight,
      anchors,
      selectedFacility: null,
      floorNote,
      floorMedia,
      floorFacilities,
    });
    this.localizeFloorMedia(floor.id, floorMedia);

    if (!this.animatedStyleApplied) {
      this.animatedStyleApplied = true;
      this.applyFloorAnimatedStyles();
    }
    this.updateReport();
  },

  async localizeFloorMedia(floorId: string, rows: Array<{ sourceUrl: string; url: string }>) {
    const localized = await Promise.all(rows.map(async (row, index) => {
      if (!row.sourceUrl.startsWith("/")) return row;
      try {
        const response = await apiGetBinary(row.sourceUrl);
        const path = writeLocalBinaryAsset(
          "floor-media",
          `${floorId}-${index}`,
          response.data,
          mediaExtension(response.contentType),
        );
        this.mediaFilePaths.add(path);
        return { ...row, url: path };
      } catch {
        return { ...row, url: "" };
      }
    }));
    if (this.data.activeFloorId !== floorId) return;
    this.setData({ floorMedia: localized.filter((item) => item.url) });
  },

  applyFloorAnimatedStyles() {
    // world 容器：screen = world * scale - win * scale（与地图页同式）
    this.applyAnimatedStyle(".floor-world", () => {
      "worklet";
      const s = this.winScale.value;
      return {
        transform: `translate(${-this.winX.value * s}px, ${-this.winY.value * s}px) scale(${s})`,
      };
    });
    // 徽章反向缩放，屏幕上保持恒定尺寸
    this.applyAnimatedStyle(".floor-badge-inner", () => {
      "worklet";
      return { transform: `scale(${1 / this.winScale.value})` };
    });
  },

  // ---------------------------------------------------------------------------
  // 手势（JS 线程触摸事件；视口数学直接用 lib/map/viewport.ts 纯函数）
  // worklet:ongesture 绑定在本环境真机上完全不触发（与地图页同一结论），
  // 改为 .floor-surface 上的 bindtouchstart/move/end/tap。
  // ---------------------------------------------------------------------------

  planGestureActive(): boolean {
    return this.data.view === "plan" && this.data.hasPlan && this.data.ready;
  },

  /** 无动画直写 shared 变量，UI 线程 applyAnimatedStyle 跟随。 */
  setWindowDirect(win: ViewWindow) {
    this.winX.value = win.x;
    this.winY.value = win.y;
    this.winScale.value = this.containerSize.width / win.width;
  },

  currentWindow(): ViewWindow {
    return {
      x: this.winX.value,
      y: this.winY.value,
      width: this.containerSize.width / this.winScale.value,
      height: this.containerSize.height / this.winScale.value,
    };
  },

  onSurfaceTouchStart(e: any) {
    if (!this.planGestureActive()) return;
    const touches = e.touches;
    if (touches.length >= 2) {
      const a = touches[0];
      const b = touches[1];
      const beginWin = this.currentWindow();
      this.touch = {
        mode: "pinch",
        startDist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        beginWin,
        beginScale: getScale(beginWin, this.containerSize),
      };
    } else if (touches.length === 1) {
      this.touch = {
        mode: "pan",
        startX: touches[0].clientX,
        startY: touches[0].clientY,
        beginWin: this.currentWindow(),
      };
    }
  },

  onSurfaceTouchMove(e: any) {
    if (!this.planGestureActive() || !this.touch) return;
    const touches = e.touches;
    if (this.touch.mode === "pan" && touches.length === 1) {
      this.setWindowDirect(panWindowBy(
        this.touch.beginWin,
        touches[0].clientX - this.touch.startX,
        touches[0].clientY - this.touch.startY,
        this.containerSize,
        this.viewBoxSize,
        EDGE_PAD_RATIO,
      ));
      return;
    }
    if (this.touch.mode === "pinch" && touches.length >= 2 && this.touch.startDist > 0) {
      const a = touches[0];
      const b = touches[1];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const nextScale = clamp(
        this.touch.beginScale * dist / this.touch.startDist,
        this.planMinScale,
        MAX_SCALE,
      );
      const focal = {
        x: (a.clientX + b.clientX) / 2 - this.containerLeft,
        y: (a.clientY + b.clientY) / 2 - this.containerTop,
      };
      this.setWindowDirect(zoomWindowAt(
        this.touch.beginWin,
        focal,
        nextScale,
        this.containerSize,
        this.viewBoxSize,
        EDGE_PAD_RATIO,
      ));
    }
  },

  onSurfaceTouchEnd(e: any) {
    if (!e.touches || e.touches.length === 0) {
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
      };
    }
  },

  /** bindtap：e.detail.x/y 是相对页面的坐标，换算容器本地坐标走徽章命中。 */
  onSurfaceTap(e: any) {
    if (!this.planGestureActive()) return;
    this.handlePlanTap(
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

  /** 平面图 tap：换算世界坐标找最近徽章（容差 24px/scale，与地图页 hitTest 同思路）。 */
  handlePlanTap(localX: number, localY: number, winX: number, winY: number, scale: number) {
    if (this.data.view !== "plan" || !this.data.hasPlan) return;
    const worldX = winX + localX / scale;
    const worldY = winY + localY / scale;
    const tolerance = TAP_TOLERANCE_PX / scale;
    let nearest: FacilityAnchorPoint | null = null;
    let nearestDistance = tolerance;
    for (const anchor of this.data.anchors as FacilityAnchorPoint[]) {
      const distance = Math.hypot(anchor.x - worldX, anchor.y - worldY);
      if (distance <= nearestDistance) {
        nearest = anchor;
        nearestDistance = distance;
      }
    }
    if (!nearest) {
      if (this.data.selectedFacility) {
        this.setData({ selectedFacility: null });
        this.updateReport();
      }
      return;
    }
    this.selectFacility(nearest.facilityId);
  },

  /** 选中设施（徽章 tap / 列表行 tap 共用）：元数据从楼宇 poi.facilities 按 id 回查。 */
  selectFacility(facilityId: string) {
    const facility = this.poi?.facilities.find((item) => item.id === facilityId);
    if (!facility) return;
    this.setData({
      selectedFacility: {
        id: facility.id,
        name: facility.displayName,
        typeName: facility.typeName,
        location: typeof facility.content.locationDescription === "string"
          ? facility.content.locationDescription
          : "",
        statusLabel: facilityStatusLabel(facility.operationalStatus),
      },
    });
    this.updateReport();
  },

  closeFacilityCard() {
    this.setData({ selectedFacility: null });
    this.updateReport();
  },

  noop() {},

  /** automator 可直调。 */
  switchFloor(floorId: string) {
    if (!floorId || floorId === this.data.activeFloorId) return;
    this.setupFloor(String(floorId));
  },

  switchFloorRow(e: any) {
    this.switchFloor(String(e.currentTarget.dataset.id));
  },

  /** automator 可直调。 */
  setView(view: string) {
    if (view !== "list" && view !== "plan") return;
    if (view === "plan" && !this.data.hasPlan) return; // 无图纸强制列表
    this.setData({ view: view as "list" | "plan" });
    this.updateReport();
  },

  setViewRow(e: any) {
    this.setView(String(e.currentTarget.dataset.view));
  },

  goBack() {
    wx.navigateBack();
  },

  updateReport() {
    this.setData({
      report: {
        placeId: this.data.placeId,
        floorCount: this.floorRows.length,
        activeFloorId: this.data.activeFloorId,
        hasPlan: this.data.hasPlan,
        anchorCount: (this.data.anchors as FacilityAnchorPoint[]).length,
        view: this.data.view,
        selectedFacilityId: this.data.selectedFacility
          ? (this.data.selectedFacility as FacilityRow).id
          : null,
      },
    });
  },
});
