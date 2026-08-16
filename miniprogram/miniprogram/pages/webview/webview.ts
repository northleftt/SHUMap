// 通用 web-view 容器。加载失败时提供复制链接入口。
//
// url 参数来自页面路由（encodeURIComponent 后带进来），webview 页本身无法知道
// 调用者是谁——恶意二维码 / 分享卡片可以构造任意 url 让小程序打开钓鱼页。
// 微信的业务域名白名单会兜底拦截，但那依赖后台配置且报错形态是页面级 error；
// 这里再校验一次协议与域名（纵深防御），不在白名单内直接走降级页。

import { config } from "../../config";

/** web-view 允许加载的地址前缀：本站网页 + 校车预约系统（含 API 下发的 bookingUrl）。 */
const ALLOWED_URL_PREFIXES = [
  config.webBaseUrl + "/",
  config.webBaseUrl, // 不带尾斜杠的根地址
  "https://vcard.shu.edu.cn/",
];

function isAllowedUrl(url: string): boolean {
  return url.startsWith("https://") && ALLOWED_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

Page({
  data: {
    url: "",
    title: "网页",
    loadFailed: false,
  },

  onLoad(options: Record<string, string | undefined>) {
    const url = options.url ? decodeURIComponent(options.url) : "";
    const title = options.title ? decodeURIComponent(options.title) : "预约乘车";
    // 域名不在白名单：不加载，直接展示「复制链接」降级页（与 web-view 加载失败同形态）。
    this.setData({ url, title, loadFailed: !isAllowedUrl(url) });
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
