// 校外 Tab。对标 Web 端 src/pages/offcampus/OffCampusPage.tsx（预留占位，形态待定）。
import { APP_SHARE_TITLE, enableShareMenus, sharePath } from "../../lib/share";

Page({
  onLoad() {
    enableShareMenus();
  },

  /** 自定义 tabBar：回显本 tab 的选中态（app.json tabBar.custom=true）。 */
  onShow() {
    const tabBar = this.getTabBar?.();
    if (tabBar) tabBar.setData({ selected: 2 });
  },

  /** 转发：本页仍是占位，卡片落到地图首页（内容成形后再改成本页深链）。 */
  onShareAppMessage() {
    return {
      title: APP_SHARE_TITLE,
      path: sharePath("/pages/map/map"),
    };
  },

  onShareTimeline() {
    return { title: APP_SHARE_TITLE };
  },
});
