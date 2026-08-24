// 校车乘坐指南（校车页「如何坐车？」的落地页）。
//
// 数据：GET /api/public/guide/shuttle-ride，与返校指南同一套端点、同一条
// 草稿→送审→发布流水线，只是 slug 不同（见 lib/shuttle-guide.ts 顶部注释）。
// 本页只做状态装配：规范化与视图模型全在 lib/shuttle-guide.ts，可在 node 里单测。
//
// 与 pages/guide（返校指南）刻意不共用任何东西：那份是 hubs × campuses × modes
// 的矩阵 + 手势看图 + Skyline 自定义导航，这份是一篇竖排文章。

import {
  buildBlockViews,
  loadShuttleGuide,
  previewUrls,
  type ShuttleGuideBlockView,
} from "../../lib/shuttle-guide";
import type { ApiError } from "../../lib/api";
import { enableShareMenus, sharePath, shareTitle } from "../../lib/share";

/** 后台没填标题时的兜底。与校车页那个入口的文案对齐。 */
const DEFAULT_TITLE = "如何坐车";

Page({
  data: {
    /** loading | ready | unpublished | error */
    state: "loading",
    errorMessage: "",
    title: DEFAULT_TITLE,
    subtitle: "",
    blocks: [] as ShuttleGuideBlockView[],
  },

  onLoad() {
    enableShareMenus();
    this.load();
  },

  /** 转发：标题用内容自己的标题（后台可改），路径无参数。 */
  onShareAppMessage() {
    return {
      title: shareTitle(this.data.title as string, "校车"),
      path: sharePath("/pages/shuttle-guide/shuttle-guide"),
    };
  },

  /** 分享到朋友圈：本页纯内容展示，单页模式下无 tabBar/web-view 依赖。 */
  onShareTimeline() {
    return { title: shareTitle(this.data.title as string, "校车") };
  },

  async load() {
    this.setData({ state: "loading", errorMessage: "" });
    try {
      const payload = await loadShuttleGuide();
      const blocks = buildBlockViews(payload.content);
      // 发布了一份空文档：走「未发布」态而不是渲染一个只有标题的空页。
      // 校车页的入口也按同一条规则隐藏（hasPublishedShuttleGuide 要求有正文）。
      if (blocks.length === 0) {
        this.setData({ state: "unpublished" });
        return;
      }
      // meta.title 优先于文档标题：前者是编辑给读者看的，后者是文档管理用的。
      const title = payload.content.meta.title || payload.title || DEFAULT_TITLE;
      this.setData({
        state: "ready",
        title,
        subtitle: payload.content.meta.subtitle,
        blocks,
      });
      wx.setNavigationBarTitle({ title });
    } catch (err) {
      // 404 = 未发布 / 已下线，不是错误：不给重试按钮，也不报网络问题。
      if ((err as ApiError)?.statusCode === 404) {
        this.setData({ state: "unpublished" });
        return;
      }
      this.setData({
        state: "error",
        errorMessage: (err as Error)?.message || "网络请求失败",
      });
    }
  },

  /** 点图看大图。urls 给全页图片，能左右翻。 */
  previewImage(e: any) {
    const current = String(e.currentTarget.dataset.src ?? "");
    const urls = previewUrls(this.data.blocks as ShuttleGuideBlockView[]);
    if (urls.length === 0) return;
    wx.previewImage({ current: urls.includes(current) ? current : urls[0], urls });
  },
});
