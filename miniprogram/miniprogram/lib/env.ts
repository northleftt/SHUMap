// 运行环境切换（prod / staging）。
//
// 用途：staging（shumap-staging worker + staging.map.shutf.com）用于验证破坏性/
// 数据依赖的变更（如 release manifest 新字段），不碰生产。切换入口在 debug 页
// （pages/debug/debug，开发者工具/体验版直开）：写入 storage 键 shumap.env 后
// 重启小程序生效——config.ts 在模块加载时同步读 storage 并覆盖 base URL/云服务名。
//
// 纯逻辑与 wx 解耦，可在 node 单测里跑（tests/miniprogram-env-switch.test.mjs）。

export type AppEnv = "prod" | "staging";

/** wx storage 键：debug 页写入，config.ts 模块加载时读取。 */
export const ENV_STORAGE_KEY = "shumap.env";

export interface EnvironmentValues {
  apiBaseUrl: string;
  webBaseUrl: string;
  cloudService: string;
}

export const ENVIRONMENTS: Record<AppEnv, EnvironmentValues> = {
  prod: {
    apiBaseUrl: "https://map.shutf.com",
    webBaseUrl: "https://map.shutf.com",
    cloudService: "shumap-api",
  },
  staging: {
    apiBaseUrl: "https://staging.map.shutf.com",
    webBaseUrl: "https://staging.map.shutf.com",
    cloudService: "shumap-api-staging",
  },
};

/** storage 里任何非 "staging" 的值（含空串/脏数据）都回落 prod，保护现网用户。 */
export function normalizeAppEnv(value: unknown): AppEnv {
  return value === "staging" ? "staging" : "prod";
}

export interface MutableEnvConfig {
  apiBaseUrl: string;
  webBaseUrl: string;
  cloudService: string;
  appEnv: AppEnv;
}

/** 把目标环境的三件套覆盖进 config 对象（原地改，import 方全部读到新值）。 */
export function applyEnvironment(config: MutableEnvConfig, env: AppEnv): void {
  const values = ENVIRONMENTS[env];
  config.apiBaseUrl = values.apiBaseUrl;
  config.webBaseUrl = values.webBaseUrl;
  config.cloudService = values.cloudService;
  config.appEnv = env;
}

/**
 * release 缓存（release-* / map-asset-*）跨环境不复用：staging 与生产可能发布
 * 同名 releaseId 但内容不同。切环境时清掉这些前缀的键，返回清理数量。
 * keys 由调用方从 wx.getStorageInfoSync().keys 传入（保持纯函数可测）。
 */
export function releaseCacheKeysToClear(keys: string[]): string[] {
  return keys.filter(
    (key) => key.startsWith("release-") || key.startsWith("map-asset-"),
  );
}
