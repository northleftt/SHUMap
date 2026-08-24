// 通用 web-view 容器。加载失败时提供复制链接入口。
//
// url 参数来自页面路由（encodeURIComponent 后带进来），webview 页本身无法知道
// 调用者是谁——恶意二维码 / 分享卡片可以构造任意 url 让小程序打开钓鱼页。
// 微信的业务域名白名单会兜底拦截，但那依赖后台配置且报错形态是页面级 error；
// 这里再校验一次协议与域名（纵深防御），不在白名单内直接走降级页。

import { config } from "../../config";
import { APP_SHARE_TITLE, enableShareMenus, sharePath, shareTitle } from "../../lib/share";

/**
 * web-view 允许加载的地址前缀：只有本站网页。
 *
 * 白名单必须是「已配成业务域名的域名」的子集，否则点进来只会看到微信的
 * 「不支持打开非业务域名」原生错误页，而那个错误未必触发 binderror——
 * 用户卡在报错页上，连本页的「复制链接」降级都摸不到。校车预约站
 * vcard.shu.edu.cn 就是这么被移出去的（2026-08-24，原因见 shuttle.ts 顶部注释）。
 */
const ALLOWED_URL_PREFIXES = [
  config.webBaseUrl + "/",
  config.webBaseUrl, // 不带尾斜杠的根地址
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
    // 本页不开朋友圈：朋友圈是单页模式，web-view 组件在该模式下不可用，
    // 分享出去只会得到一个空白容器页，所以只请求「转发」菜单（复制链接随之解锁）。
    enableShareMenus(false);
    const url = options.url ? decodeURIComponent(options.url) : "";
    const title = options.title ? decodeURIComponent(options.title) : "网页";
    // 域名不在白名单：不加载，直接展示「复制链接」降级页（与 web-view 加载失败同形态）。
    this.setData({ url, title, loadFailed: !isAllowedUrl(url) });
    wx.setNavigationBarTitle({ title });
  },

  /**
   * 转发：白名单内的地址原样带过去（接收方 onLoad 会再校验一次），
   * 白名单外（降级页）不外传 url，卡片落回地图首页。
   */
  onShareAppMessage() {
    const url = this.data.url as string;
    if (!url || !isAllowedUrl(url)) {
      return { title: APP_SHARE_TITLE, path: sharePath("/pages/map/map") };
    }
    return {
      title: shareTitle(this.data.title as string, ""),
      path: sharePath("/pages/webview/webview", { url, title: this.data.title as string }),
    };
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
