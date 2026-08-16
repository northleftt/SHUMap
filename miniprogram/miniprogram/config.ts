// 全局配置：后端 API 的访问方式。
//
// 生产环境：通过云托管代理（wx.cloud.callContainer），需要把 useCloudContainer
// 置为 true 并填好 cloudEnv / cloudService。
// 本地调试：走 wx.request 直连 Worker（配合开发者工具「不校验合法域名」，
// 本工程 project.config.json 已设 urlCheck: false）。

export const config = {
  /** true = 云托管代理；false = wx.request 直连 apiBaseUrl（本地调试）。 */
  useCloudContainer: true,

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
