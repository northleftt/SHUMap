// 全局配置：后端 API 的访问方式。
//
// 生产环境：通过云托管代理（wx.cloud.callContainer），需要把 useCloudContainer
// 置为 true 并填好 cloudEnv / cloudService。
// 本地调试：走 wx.request 直连 Worker（配合开发者工具「不校验合法域名」，
// 本工程 project.config.json 已设 urlCheck: false）。
// staging：debug 页可切换（写 storage 键 shumap.env 后重启小程序），
// 模块加载时下方 applyEnvironment 同步覆盖 apiBaseUrl / webBaseUrl / cloudService。

import { applyEnvironment, normalizeAppEnv, ENV_STORAGE_KEY, type AppEnv } from "./lib/env";

export const config = {
  /** true = 云托管代理；false = wx.request 直连 apiBaseUrl（本地调试）。 */
  useCloudContainer: true,

  /** 当前生效环境（prod / staging），初始为 prod，模块末尾按 storage 覆盖。 */
  appEnv: "prod" as AppEnv,

  /** 开发调试的 API base URL：直连线上 Worker（方案 B，免本地 D1 维护）。
   *  开发者工具已设 urlCheck: false，本地开发可直接请求；
   *  真机/上线必须走云托管代理（useCloudContainer=true），不要直连 workers.dev。 */
  apiBaseUrl: "https://map.shutf.com",

  /** web-view 使用的公开网页根地址。返校指南是静态页面，不走云托管 API 通道。 */
  webBaseUrl: "https://map.shutf.com",

  /** 云托管环境 ID 与服务名（useCloudContainer=true 时生效）。 */
  cloudEnv: "cloudbase-d1gse9nsp7630b4e7",
  cloudService: "shumap-api",
};

// 环境覆盖必须在模块加载时同步完成：之后 import config 的模块（api.ts / guide.ts /
// floors 页 / webview 页白名单等）读到的都是覆盖后的值。node 单测环境没有 wx，跳过。
try {
  if (typeof wx !== "undefined" && typeof wx.getStorageSync === "function") {
    applyEnvironment(config, normalizeAppEnv(wx.getStorageSync(ENV_STORAGE_KEY)));
  }
} catch {
  // 读 storage 失败一律保持 prod，不影响现网。
}
