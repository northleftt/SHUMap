// 临时调试页：验证 release 装配流水线（lib/release/loader.ts）。
// 展示 release 版本、三校区与 mapVersionId、POI 总数、设施类型列表。
// 完整的装配摘要同时放进 data.report，供 miniprogram-automator 用 evaluate 读取
// （Skyline 页面没有 webview 层，automator 的 page.data() 不可用）。

import { loadReleaseWithCache, selectCampus } from "../../lib/release/loader";

Page({
  data: {
    // 自定义导航（Skyline 要求 navigationStyle: custom）下的状态栏占位
    statusBarHeight: 20,

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
    const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : { statusBarHeight: 20 };
    this.setData({ statusBarHeight: windowInfo.statusBarHeight ?? 20 });
    this.boot();
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
