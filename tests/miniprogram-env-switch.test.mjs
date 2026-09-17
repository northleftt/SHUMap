// 小程序运行环境切换（lib/env.ts）自验，直接在 node 里跑。
//
// 用 esbuild 把 miniprogram/miniprogram/lib/env.ts 编成 cjs 后断言：
// 1. 两套环境的 URL/云服务名与线上资源一一对应（staging 指向 shumap-staging 链路）；
// 2. normalizeAppEnv 只认 "staging"，空串/脏数据/undefined 一律回落 prod（保护现网）；
// 3. applyEnvironment 原地覆盖 config 三件套 + appEnv，且可来回切换；
// 4. releaseCacheKeysToClear 只清 release-*/map-asset-* 前缀，不动其他 storage 键。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "tmp/env-switch-test");
mkdirSync(outDir, { recursive: true });

execFileSync(join(repoRoot, "node_modules/.bin/esbuild"), [
  join(repoRoot, "miniprogram/miniprogram/lib/env.ts"),
  "--bundle",
  "--format=cjs",
  "--platform=node",
  `--outfile=${join(outDir, "env.cjs")}`,
]);

const require = createRequire(import.meta.url);
const env = require(join(outDir, "env.cjs"));

// 1. 两套环境的目标资源
assert.equal(env.ENVIRONMENTS.prod.apiBaseUrl, "https://map.shutf.com");
assert.equal(env.ENVIRONMENTS.prod.webBaseUrl, "https://map.shutf.com");
assert.equal(env.ENVIRONMENTS.prod.cloudService, "shumap-api");
assert.equal(env.ENVIRONMENTS.staging.apiBaseUrl, "https://staging.map.shutf.com");
assert.equal(env.ENVIRONMENTS.staging.webBaseUrl, "https://staging.map.shutf.com");
assert.equal(env.ENVIRONMENTS.staging.cloudService, "shumap-api-staging");
assert.equal(env.ENV_STORAGE_KEY, "shumap.env");

// 2. normalizeAppEnv 的回落语义
assert.equal(env.normalizeAppEnv("staging"), "staging");
for (const dirty of ["prod", "", "STAGING", "Staging", null, undefined, 0, {}, ["staging"]]) {
  assert.equal(env.normalizeAppEnv(dirty), "prod", `dirty value ${String(dirty)} 应回落 prod`);
}

// 3. applyEnvironment 原地覆盖 + 来回切换
const config = {
  apiBaseUrl: "https://map.shutf.com",
  webBaseUrl: "https://map.shutf.com",
  cloudService: "shumap-api",
  appEnv: "prod",
  useCloudContainer: true,
  cloudEnv: "cloudbase-d1gse9nsp7630b4e7",
};
env.applyEnvironment(config, "staging");
assert.equal(config.apiBaseUrl, "https://staging.map.shutf.com");
assert.equal(config.webBaseUrl, "https://staging.map.shutf.com");
assert.equal(config.cloudService, "shumap-api-staging");
assert.equal(config.appEnv, "staging");
// 与通道无关的字段不动
assert.equal(config.useCloudContainer, true);
assert.equal(config.cloudEnv, "cloudbase-d1gse9nsp7630b4e7");
env.applyEnvironment(config, "prod");
assert.equal(config.apiBaseUrl, "https://map.shutf.com");
assert.equal(config.cloudService, "shumap-api");
assert.equal(config.appEnv, "prod");

// 4. 切环境时只清 release 缓存前缀
const keys = [
  "release-current-id",
  "release-rel_123",
  "map-asset-mapver_abc",
  "shumap.env",
  "shumap.recents",
  "shumap.favorites",
  "shumap.pending-map-poi-return",
  "logs",
];
assert.deepEqual(env.releaseCacheKeysToClear(keys).sort(), [
  "map-asset-mapver_abc",
  "release-current-id",
  "release-rel_123",
]);

console.log("miniprogram-env-switch: all assertions passed");
