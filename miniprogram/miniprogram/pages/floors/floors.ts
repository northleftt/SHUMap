// 楼层图页（Part 3）：楼宇楼层 pills + 列表/平面图双视图。
//
// 平面图是楼层级位图（release manifest floors[].imageUrl，站内相对路径
// /api/public/media/…，null = 该层无图纸，强制列表视图）：
//   - <image> 直连全 URL（imageUrl 拼 config.apiBaseUrl，与 lib/guide.ts 的
//     站内媒体解析同口径）；位图不再走 SVG asset / 本地写盘那套；
//   - 捏合缩放与拖动由 movable-area + movable-view（scale，1~5 倍）原生实现，
//     替代旧的 JS 线程手势 + viewport.ts 方案（该方案为校区地图保留）；
//   - movable-view 尺寸按图片宽高比实测（bindload 的 natural size × 容器宽），
//     竖长图纸在 1 倍下也能拖到底部。
//
// data.report 供 automator evaluate 核对；switchFloor/setView 可直调。

import { loadReleaseWithCache } from "../../lib/release/loader";
import type { LoadedRelease } from "../../lib/release/mapData";
import { facilityStatusLabel } from "../../lib/release/facilityStatus";
import type { MapPoi, ReleaseFloor } from "../../lib/release/types";
import { apiGetBinary } from "../../lib/api";
import { requestErrorRetryText } from "../../lib/request-error";
import { recordPageView } from "../../lib/analytics";
import { enableShareMenus, shareQuery, sharePath, shareTitle } from "../../lib/share";
import { config } from "../../config";
import {
  mediaExtension,
  removeLocalAsset,
  writeLocalBinaryAsset,
} from "../../lib/local-assets";

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

/** imageUrl 是站内相对路径（/api/public/media/…），拼 apiBaseUrl 成全 URL 供 <image> 直连。 */
function resolvePlanImageUrl(imageUrl: string | null): string {
  if (!imageUrl || !imageUrl.trim()) return "";
  return imageUrl.startsWith("/") ? `${config.apiBaseUrl}${imageUrl}` : imageUrl;
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

    planImageUrl: "",
    planLoading: false,
    planError: false,
    /** movable-view 高度（px，按图片宽高比实测）；0 = 未测出，先用 100% 高度兜底。 */
    planViewHeight: 0,

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

    this.loadedRelease = null as LoadedRelease | null;
    this.poi = null as MapPoi | null;
    this.floorRows = [] as ReleaseFloor[];
    this.planAreaWidth = 0;
    this.mediaFilePaths = new Set<string>();

    this.boot();
  },

  onUnload() {
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
      const floorRows = loaded.manifest.floors
        .filter((floor) => floor.buildingPlaceId === poi.entityId && floor.isPublic !== 0)
        .sort((left, right) => left.levelOrder - right.levelOrder);
      if (!floorRows.length) throw new Error("该楼宇暂无公开的楼层信息");

      this.loadedRelease = loaded;
      this.poi = poi;
      this.floorRows = floorRows;
      this.setData({
        buildingName: poi.name,
        floors: floorRows.map((floor) => ({
          id: floor.id,
          levelCode: floor.levelCode,
          levelOrder: floor.levelOrder,
          displayName: floor.displayName,
          hasPlan: resolvePlanImageUrl(floor.imageUrl) !== "",
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

  /** 切层装配：图纸 URL（如有）、列表数据，一次切完。 */
  async setupFloor(floorId: string) {
    const poi = this.poi;
    const floor = this.floorRows.find((item) => item.id === floorId);
    if (!poi || !floor) return;

    const planImageUrl = resolvePlanImageUrl(floor.imageUrl);
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

    this.setData({
      loading: false,
      ready: true,
      errorMessage: "",
      activeFloorId: floor.id,
      hasPlan: planImageUrl !== "",
      // 无图纸强制列表；有图纸默认平面图
      view: planImageUrl ? "plan" : "list",
      planImageUrl,
      planLoading: planImageUrl !== "",
      planError: false,
      planViewHeight: 0,
      floorNote,
      floorMedia,
      floorFacilities,
    });
    this.localizeFloorMedia(floor.id, floorMedia);
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

  /**
   * 平面图加载完成：movable-view 高度按图片宽高比实测（宽 = 容器宽），
   * 否则竖长图纸的拖动边界会按容器高算，1 倍下拖不到底部。
   */
  onPlanImageLoad(e: any) {
    const detail = e?.detail ?? {};
    const apply = (areaWidth: number) => {
      const height = typeof detail.width === "number" && detail.width > 0
        ? Math.round(areaWidth * detail.height / detail.width)
        : 0;
      this.setData({ planLoading: false, planError: false, planViewHeight: height });
      this.updateReport();
    };
    if (this.planAreaWidth > 0) {
      apply(this.planAreaWidth);
      return;
    }
    this.createSelectorQuery()
      .select(".plan-area")
      .boundingClientRect((rect: any) => {
        if (rect && rect.width) {
          this.planAreaWidth = rect.width;
          apply(rect.width);
        } else {
          // 量不到容器就只清 loading，movable-view 高度走 100% 兜底。
          this.setData({ planLoading: false });
          this.updateReport();
        }
      })
      .exec();
  },

  onPlanImageError() {
    this.setData({ planLoading: false, planError: true });
    this.updateReport();
  },

  /** 加载失败重试：清 src 再置回，强制 <image> 重新拉取。 */
  retryPlanImage() {
    const url = this.data.planImageUrl;
    if (!url) return;
    this.setData({ planImageUrl: "", planLoading: true, planError: false }, () => {
      this.setData({ planImageUrl: url });
    });
    this.updateReport();
  },

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

  planState(): string {
    if (!this.data.hasPlan) return "none";
    if (this.data.planLoading) return "loading";
    if (this.data.planError) return "error";
    return "ready";
  },

  updateReport() {
    this.setData({
      report: {
        placeId: this.data.placeId,
        floorCount: this.floorRows.length,
        activeFloorId: this.data.activeFloorId,
        hasPlan: this.data.hasPlan,
        view: this.data.view,
        planState: this.planState(),
      },
    });
  },
});
