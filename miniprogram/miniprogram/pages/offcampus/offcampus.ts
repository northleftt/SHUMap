// 校外 Tab。对标 Web 端 src/pages/offcampus/OffCampusPage.tsx（预留占位，形态待定）。
Page({
  /** 自定义 tabBar：回显本 tab 的选中态（app.json tabBar.custom=true）。 */
  onShow() {
    const tabBar = this.getTabBar?.();
    if (tabBar) tabBar.setData({ selected: 2 });
  },
});
