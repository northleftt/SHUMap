import { apiGet, apiGetBinary } from "../api";
import { recordPageView } from "../analytics";
import { loadReleaseWithCache } from "../release/loader";
import { parseSvgViewBox } from "../svg-geometry";
import { campusKeyForGcj02Point } from "../map/user-location";
import { mediaExtension, removeLocalAsset, writeLocalBinaryAsset } from "../local-assets";
import { APP_SHARE_TITLE, enableShareMenus, sharePath } from "../share";
import { DAY_TYPE_LABELS, parseDiningScheduleResponse, parseMerchantStatusResponse, periodBarText, shanghaiMinutes, shanghaiToday } from "./schedule";
import { diningFacilities } from "./facilities";
import { fetchFacilityStatuses } from "./live";
import { facilityIconName } from "../map/poiIcons";
import { canteensOf, diningView } from "./view";

/** 列表与详情共享刷新、错误降级和页面生命周期，实时状态不落 release 缓存。 */
export function diningPage(detail: boolean): any {
  return {
    data: {
      statusBarHeight: 0, loading: true, error: "", scheduleError: "", merchantError: "",
      periodText: "正在加载就餐时段…", arrangementText: "", groups: [], canteen: null,
      floor: null, floorTabs: [], noArrangement: false, wholeDayRest: false, alternatives: [],
      facilities: [], facilityError: "", photos: [], merchantPhotos: [], mediaError: false, openMerchantId: "",
    },
    onLoad(query: Record<string, string>) {
      enableShareMenus();
      this.placeId = query.placeId || "";
      this.floorId = query.floor || "";
      this.canteens = [];
      this.schedule = null;
      this.statuses = {};
      this.located = null;
      this.facilities = [];
      this.facilityStatuses = null;
      this.assetCache = new Map();
      this.mediaFiles = new Set();
      this.assetPrefix = `dining-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.generation = 0;
      this.setData({ statusBarHeight: wx.getWindowInfo().statusBarHeight || 0 });
    },
    onShow() {
      this.visible = true;
      if (!detail) this.getTabBar?.()?.setData({ selected: 2 });
      recordPageView(detail ? "canteen_dining" : "dining");
      void this.load();
      clearInterval(this.timer);
      this.timer = setInterval(() => { this.render(); void this.refreshLive(); this.locate(); }, 30000);
    },
    onHide() { this.visible = false; this.generation++; clearInterval(this.timer); },
    onUnload() {
      this.onHide();
      this.destroyed = true;
      for (const file of this.mediaFiles) removeLocalAsset(file);
    },
    async load() {
      const generation = ++this.generation;
      this.setData({ loading: !this.canteens.length, error: "" });
      void this.refreshLive(generation);
      try {
        const release = await loadReleaseWithCache();
        if (!this.visible || generation !== this.generation) return;
        this.canteens = canteensOf(release);
        this.facilities = release.pois.find(p => p.entityType === "building" && p.entityId === this.placeId)?.facilities || [];
        this.geoBounds = release.campuses.map(c => ({ key: c.key, geoTransform: c.geoTransform, viewBox: parseSvgViewBox(c.svgRaw) }));
        this.setData({ loading: false });
        this.render();
        if (!detail) this.locate();
      } catch (err) {
        if (generation === this.generation && this.visible) this.setData({ loading: false, error: err instanceof Error ? err.message : "就餐信息加载失败" });
      }
    },
    async refreshLive(generation = this.generation) {
      const date = shanghaiToday();
      // 跨午夜立即清掉昨天的安排；新请求失败也不能继续显示旧日状态。
      if (this.schedule && this.schedule.date !== date) { this.schedule = null; this.render(); }
      const current = () => this.visible && generation === this.generation;
      await Promise.all([
        ...(detail ? [fetchFacilityStatuses().then(statuses => {
          if (!current()) return;
          this.facilityStatuses = statuses;
          this.setData({ facilityError: "" }); this.render();
        }).catch(() => {
          if (!current()) return;
          this.facilityStatuses = null;
          this.setData({ facilityError: "设施状态加载失败，点击重试" }); this.render();
        })] : []),
        apiGet("/api/public/dining/schedule", { date }).then(parseDiningScheduleResponse).then(schedule => {
          if (!current()) return;
          this.schedule = schedule;
          this.setData({ scheduleError: "" });
          this.render();
        }).catch(() => {
          if (!current()) return;
          this.schedule = null;
          this.setData({ scheduleError: "就餐时段与开放安排加载失败，请点击重试" });
          this.render();
        }),
        apiGet("/api/public/merchant-status").then(parseMerchantStatusResponse).then(result => {
          if (!current()) return;
          this.statuses = result.statuses;
          this.setData({ merchantError: "" });
          this.render();
        }).catch(() => {
          if (!current()) return;
          this.statuses = {};
          this.setData({ merchantError: "商家营业状态加载失败，请点击重试" });
          this.render();
        }),
      ]);
    },
    locate() {
      if (detail || !this.geoBounds) return;
      wx.getLocation({ type: "gcj02", success: (position: any) => {
        if (!this.visible) return;
        this.located = campusKeyForGcj02Point(this.geoBounds, position.longitude, position.latitude);
        this.render();
      }, fail: () => {} });
    },
    render() {
      const view = diningView(this.canteens, this.schedule, this.statuses, shanghaiMinutes(), this.located, this.placeId, this.floorId);
      this.setData({ ...view,
        facilities: view.floor ? diningFacilities(this.facilities || [], view.canteen?.floors || [], this.facilityStatuses, view.floor.floorId).map(row => ({ ...row, icon: facilityIconName(row.typeCode) })) : [],
        periodText: this.schedule ? periodBarText(this.schedule, shanghaiMinutes()) : "",
        arrangementText: this.schedule?.arrangement && !view.wholeDayRest ? `${DAY_TYPE_LABELS[this.schedule.dayType]}仅部分楼层开放，请以各楼层标注为准` : "",
      });
      if (detail && view.canteen) {
        wx.setNavigationBarTitle({ title: view.canteen.name });
        this.floorId = view.floor?.floorId || "";
        void this.loadImages();
      }
    },
    retry() { void this.load(); },
    switchFloor(e: any) {
      this.floorId = e.currentTarget.dataset.id;
      this.setData({ openMerchantId: "", photos: [], merchantPhotos: [] });
      this.render();
    },
    toggleMerchant(e: any) {
      const id = e.currentTarget.dataset.id;
      this.setData({ openMerchantId: this.data.openMerchantId === id ? "" : id, merchantPhotos: [] });
      void this.loadImages();
    },
    async localImage(sourceUrl: string): Promise<string> {
      if (!sourceUrl.startsWith("/")) return sourceUrl;
      if (this.assetCache.has(sourceUrl)) return this.assetCache.get(sourceUrl);
      const pending = apiGetBinary(sourceUrl).then(response => {
        if (this.destroyed) return "";
        const file = writeLocalBinaryAsset(this.assetPrefix, String(this.mediaFiles.size), response.data, mediaExtension(response.contentType));
        this.mediaFiles.add(file);
        return file;
      }).catch(() => { this.assetCache.delete(sourceUrl); return ""; });
      this.assetCache.set(sourceUrl, pending);
      return pending;
    },
    async loadImages() {
      const floor = this.data.floor;
      const merchantId = this.data.openMerchantId;
      if (!floor) return;
      const merchant = floor.merchants.find((m: any) => m.id === merchantId);
      const [photos, merchantPhotos] = await Promise.all([
        Promise.all(floor.photos.map(async (p: any) => ({ ...p, url: await this.localImage(p.sourceUrl) }))),
        Promise.all((merchant?.media || []).map(async (p: any) => ({ ...p, url: await this.localImage(p.url) }))),
      ]);
      if (!this.visible || this.data.floor?.floorId !== floor.floorId || this.data.openMerchantId !== merchantId) return;
      this.setData({ photos, merchantPhotos, mediaError: [...photos, ...merchantPhotos].some(p => !p.url) });
    },
    previewImage(e: any) {
      const rows = e.currentTarget.dataset.merchant ? this.data.merchantPhotos : this.data.photos;
      const urls = rows.map((row: any) => row.url).filter(Boolean);
      if (urls.length) wx.previewImage({ current: e.currentTarget.dataset.url, urls });
    },
    openFloorPlan() {
      if (this.data.floor?.imageUrl) wx.navigateTo({ url: `/pages/floors/floors?placeId=${encodeURIComponent(this.placeId)}&floor=${encodeURIComponent(this.floorId)}` });
    },
    callPhone(e: any) {
      if (e.currentTarget.dataset.label === "联系电话") wx.makePhoneCall({ phoneNumber: e.currentTarget.dataset.value.replace(/[^\d-]/g, "") });
    },
    openDetail(e: any) {
      const { place, floor } = e.currentTarget.dataset;
      wx.navigateTo({ url: `/pages/dining/dining?placeId=${encodeURIComponent(place)}${floor ? `&floor=${encodeURIComponent(floor)}` : ""}` });
    },
    openMap(e: any) {
      wx.setStorageSync("shumap.pending-map-poi", e.currentTarget.dataset.place);
      wx.setStorageSync("shumap.pending-map-poi-return", "/pages/offcampus/offcampus");
      wx.switchTab({ url: "/pages/map/map" });
    },
    onShareAppMessage() {
      return { title: detail ? this.data.canteen?.name || APP_SHARE_TITLE : "校内就餐 · SHUMap", path: detail ? sharePath(`/pages/dining/dining?placeId=${encodeURIComponent(this.placeId)}&floor=${encodeURIComponent(this.floorId)}`) : sharePath("/pages/offcampus/offcampus") };
    },
    onShareTimeline() { return { title: detail ? this.data.canteen?.name || APP_SHARE_TITLE : "校内就餐 · SHUMap", query: detail ? `placeId=${encodeURIComponent(this.placeId)}&floor=${encodeURIComponent(this.floorId)}` : "" }; },
  };
}
