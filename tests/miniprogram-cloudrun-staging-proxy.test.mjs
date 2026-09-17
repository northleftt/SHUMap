// staging 云托管反代（cloudrun/shumap-api-staging）与生产反代的漂移门禁：
// 1. server.mjs 必须与 shumap-api/server.mjs 逐字节一致（代理逻辑单点维护，
//    staging 只靠 Dockerfile 的 UPSTREAM_BASE 默认值区分上游）；
// 2. staging Dockerfile 默认上游是 staging.map.shutf.com，且不含生产域名；
// 3. 两个服务的 cloudbaserc.json 服务名不同、envId 相同。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const prodDir = join(repoRoot, "miniprogram/cloudrun/shumap-api");
const stagingDir = join(repoRoot, "miniprogram/cloudrun/shumap-api-staging");

// 1. 代理逻辑零漂移
const prodServer = readFileSync(join(prodDir, "server.mjs"), "utf8");
const stagingServer = readFileSync(join(stagingDir, "server.mjs"), "utf8");
assert.equal(stagingServer, prodServer, "shumap-api-staging/server.mjs 与 shumap-api/server.mjs 不一致");

// 2. staging Dockerfile 的默认上游
const stagingDockerfile = readFileSync(join(stagingDir, "Dockerfile"), "utf8");
assert.match(stagingDockerfile, /ENV UPSTREAM_BASE=https:\/\/staging\.map\.shutf\.com/);
assert.ok(
  !stagingDockerfile.includes("ENV UPSTREAM_BASE=https://map.shutf.com"),
  "staging Dockerfile 的默认上游不应是生产域名",
);

// 3. cloudbaserc 服务名
const prodRc = JSON.parse(readFileSync(join(prodDir, "cloudbaserc.json"), "utf8"));
const stagingRc = JSON.parse(readFileSync(join(stagingDir, "cloudbaserc.json"), "utf8"));
assert.equal(prodRc.cloudrun.name, "shumap-api");
assert.equal(stagingRc.cloudrun.name, "shumap-api-staging");
assert.equal(stagingRc.envId, prodRc.envId);

console.log("miniprogram-cloudrun-staging-proxy: all assertions passed");
