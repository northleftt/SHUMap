// 临时调试页：验证 release 装配流水线（lib/release/loader.ts）。
// 展示 release 版本、三校区与 mapVersionId、POI 总数、设施类型列表。
// 完整的装配摘要同时放进 data.report，供 miniprogram-automator 用 evaluate 读取
// （Skyline 页面没有 webview 层，automator 的 page.data() 不可用）。

import { loadReleaseWithCache, selectCampus } from "../../lib/release/loader";
import { APP_SHARE_TITLE, enableShareMenus, sharePath } from "../../lib/share";
import { config } from "../../config";
import {
  ENV_STORAGE_KEY,
  ENVIRONMENTS,
  releaseCacheKeysToClear,
  type AppEnv,
} from "../../lib/env";

Page({
  data: {
    // 自定义导航（Skyline 要求 navigationStyle: custom）下的状态栏占位
    statusBarHeight: 20,

    // 运行环境切换（prod / staging），见 lib/env.ts
    appEnv: config.appEnv as AppEnv,
    apiBaseUrl: config.apiBaseUrl,
    cloudService: config.cloudService,
    envOptions: Object.keys(ENVIRONMENTS) as AppEnv[],

    loading: true,
    errorMessage: "",
    version: "",
    releaseId: "",
    campuses: [] as Array<{
      id: string;
      key: string;
      name: string;
      mapVersionId: string;
      viewBox: string;
    }>,
    poiCount: 0,
    buildingCount: 0,
    facilityTypes: [] as Array<{ code: string; name: string }>,
    filters: [] as Array<{ key: string; label: string }>,

    // 装配结果摘要（纯 JSON），automator evaluate 直接读这个字段做核对
    report: null as unknown,
  },

  onLoad() {
    enableShareMenus();
    const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : { statusBarHeight: 20 };
    this.setData({ statusBarHeight: windowInfo.statusBarHeight ?? 20 });
    this.boot();
  },

  /** 转发：调试页对外没有意义，卡片落到地图首页（只为解锁菜单里的复制链接）。 */
  onShareAppMessage() {
    return {
      title: APP_SHARE_TITLE,
      path: sharePath("/pages/map/map"),
    };
  },

  onShareTimeline() {
    return { title: APP_SHARE_TITLE };
  },

  /**
   * 切换运行环境：清 release 缓存（staging 与生产可能有同 id 不同内容的
   * release/manifest/底图），写 storage 后重启小程序，config.ts 在启动时读回。
   */
  switchEnv(event: WechatMiniprogram.TouchEvent) {
    const target = (event.currentTarget.dataset as { env?: string }).env;
    if (target !== "prod" && target !== "staging") return;
    if (target === this.data.appEnv) return;
    const targetName = target === "staging" ? "Staging（预发）" : "生产";
    wx.showModal({
      title: `切换到${targetName}`,
      content: "将清除本机的 release/底图缓存并重启小程序。仅用于开发调试。",
      confirmText: "切换并重启",
      success: (res) => {
        if (!res.confirm) return;
        try {
          const info = wx.getStorageInfoSync();
          for (const key of releaseCacheKeysToClear(info.keys || [])) {
            wx.removeStorageSync(key);
          }
          wx.setStorageSync(ENV_STORAGE_KEY, target);
        } catch {
          // 清缓存失败不阻断切换
        }
        if (typeof wx.restartMiniProgram === "function") {
          wx.restartMiniProgram({});
        } else {
          wx.showToast({ title: "已切换，请手动关闭小程序重新进入", icon: "none" });
        }
      },
    });
  },

  async boot() {
    this.setData({ loading: true, errorMessage: "" });
    try {
      const loaded = await loadReleaseWithCache();
      const campuses = loaded.campuses.map((campus) => {
        const selection = selectCampus(loaded, campus.key);
        const { x, y, width, height } = selection.viewBox;
        return {
          id: campus.id,
          key: campus.key,
          name: campus.label,
          mapVersionId: campus.mapVersionId,
          viewBox: `${x} ${y} ${width} ${height}`,
        };
      });
      const facilityTypes = loaded.manifest.facilityTypes.map((type) => ({
        code: type.code,
        name: type.name,
      }));
      const report = {
        releaseId: loaded.releaseId,
        version: loaded.version,
        campuses: campuses.map((campus) => ({
          code: campus.key,
          name: campus.name,
          mapVersionId: campus.mapVersionId,
          viewBox: campus.viewBox,
        })),
        poiCount: loaded.pois.length,
        buildingCount: loaded.buildings.length,
        facilityTypeCount: facilityTypes.length,
      };
      this.setData({
        loading: false,
        version: loaded.version,
        releaseId: loaded.releaseId,
        campuses,
        poiCount: loaded.pois.length,
        buildingCount: loaded.buildings.length,
        facilityTypes,
        filters: loaded.filters,
        report,
      });
    } catch (error) {
      this.setData({
        loading: false,
        errorMessage: error instanceof Error ? error.message : "release 装配失败",
        report: null,
      });
    }
  },
});
