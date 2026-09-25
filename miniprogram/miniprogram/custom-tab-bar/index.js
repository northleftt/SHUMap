// 自定义底部 Tab 栏（对齐 Web 端 src/components/layout/BottomTabBar.tsx）。
// app.json tabBar.custom=true 后生效；list 保留作兜底。
// 视觉规格：64px 内容高度 + 底部安全区 padding；
// 白底 96% + backdrop-blur（Skyline 不支持 backdrop-filter 时静默降级为近实色，
// 不报错）；顶部 1px #e8ebef 边框；4 列均分；图标 26px（Web 22px 基础上按真机
// 反馈上调一档）；文字 12px/16px/500；
// 激活 #1e80c1，未激活 #94a3b8。
// 选中态由各 tab 页 onShow 里 this.getTabBar().setData({ selected }) 同步。
Component({
  data: {
    selected: 0,
    /** 底部安全区高度（px）。CSS env() 之外再用 JS 算一份，双保险。 */
    safeBottom: 0,
    list: [
      {
        pagePath: "/pages/map/map",
        text: "地图",
        icon: "/images/tabs/map.png",
        activeIcon: "/images/tabs/map-active.png",
      },
      {
        pagePath: "/pages/shuttle/shuttle",
        text: "校车",
        icon: "/images/tabs/bus.png",
        activeIcon: "/images/tabs/bus-active.png",
      },
      {
        pagePath: "/pages/offcampus/offcampus",
        text: "就餐",
        icon: "/images/tabs/utensils.png",
        activeIcon: "/images/tabs/utensils-active.png",
      },
      {
        pagePath: "/pages/profile/profile",
        text: "我的",
        icon: "/images/tabs/user-round.png",
        activeIcon: "/images/tabs/user-round-active.png",
      },
    ],
  },

  lifetimes: {
    attached() {
      try {
        const info = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : null;
        const bottom =
          info && info.safeArea ? Math.max(0, Math.round(info.screenHeight - info.safeArea.bottom)) : 0;
        if (bottom !== this.data.safeBottom) this.setData({ safeBottom: bottom });
      } catch {
        // 取不到窗口信息就保持 0，由 CSS env() 兜底
      }
    },
  },

  methods: {
    switchTab(e) {
      const url = e.currentTarget.dataset.path;
      if (!url) return;
      wx.switchTab({ url });
    },
  },
});
