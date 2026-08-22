// 我的 Tab。收藏、最近查看、匿名反馈与本机提交记录均复用地图页的数据通路。
import { listRecents } from "../../lib/recents";
import { listFavorites } from "../../lib/favorites";
import { loadReleaseWithCache } from "../../lib/release/loader";
import { readSubmissions, type LocalSubmission } from "../../lib/submissions-log";
import { APP_SHARE_TITLE, enableShareMenus, sharePath } from "../../lib/share";

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function submissionRows(entries: LocalSubmission[]) {
  return entries.slice(0, 3).map((entry) => ({
    id: entry.id,
    title: entry.title,
    meta: `${entry.targetName ? `${entry.targetName} · ` : ""}${formatDate(entry.createdAt)} 提交`,
    statusLabel: "已提交",
  }));
}

Page({
  data: {
    recentCount: 0,
    favoriteCount: 0,
    submissionCount: 0,
    submissionRows: [] as ReturnType<typeof submissionRows>,
    releaseVersion: "—",
  },

  onLoad() {
    enableShareMenus();
    loadReleaseWithCache()
      .then((loaded) => this.setData({ releaseVersion: loaded.version }))
      .catch(() => {});
  },

  /** 转发：本页是个人数据（收藏/最近查看都存本机），卡片一律落到地图首页。 */
  onShareAppMessage() {
    return {
      title: APP_SHARE_TITLE,
      path: sharePath("/pages/map/map"),
    };
  },

  onShareTimeline() {
    return { title: APP_SHARE_TITLE };
  },

  onShow() {
    const tabBar = this.getTabBar?.();
    if (tabBar) tabBar.setData({ selected: 3 });
    const submissions = readSubmissions();
    this.setData({
      recentCount: listRecents().length,
      favoriteCount: listFavorites().length,
      submissionCount: submissions.length,
      submissionRows: submissionRows(submissions),
    });
  },

  openFavorites() {
    try {
      wx.setStorageSync("shumap.pending-map-mode", "favorites");
    } catch {
      // 无法写入时仍可进入地图，用户可自行搜索收藏地点。
    }
    wx.switchTab({ url: "/pages/map/map" });
  },

  openRecents() {
    try {
      wx.setStorageSync("shumap.pending-map-mode", "recents");
    } catch {
      // 同上。
    }
    wx.switchTab({ url: "/pages/map/map" });
  },

  openDebug() {
    wx.navigateTo({ url: "/pages/debug/debug" });
  },

  openFeedback() {
    wx.navigateTo({ url: "/pages/feedback/feedback" });
  },

  openAbout() {
    wx.showModal({
      title: "关于 SHUMap",
      content: "上海大学校园地图与出行信息服务\n版本 v2.0",
      showCancel: false,
      confirmText: "知道了",
    });
  },
});
