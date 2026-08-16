// 通用 web-view 容器。加载失败时提供复制链接入口。

Page({
  data: {
    url: "",
    title: "网页",
    loadFailed: false,
  },

  onLoad(options: Record<string, string | undefined>) {
    const url = options.url ? decodeURIComponent(options.url) : "";
    const title = options.title ? decodeURIComponent(options.title) : "预约乘车";
    this.setData({ url, title });
    wx.setNavigationBarTitle({ title });
  },

  onWebViewError() {
    this.setData({ loadFailed: true });
  },

  copyLink() {
    wx.setClipboardData({
      data: this.data.url,
      success: () => wx.showToast({ title: "链接已复制", icon: "success" }),
    });
  },
});
