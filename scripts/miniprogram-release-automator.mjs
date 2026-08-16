// release 装配流水线的小程序端回归（miniprogram-automator）。
//
// 前置：
//   1. 微信开发者工具已打开本项目并开启「服务端口」，
//      且已执行：/Applications/wechatwebdevtools.app/Contents/MacOS/cli \
//        auto --project /Users/wangyixuan/SHUMap/miniprogram --auto-port 9420
//
// 做什么：
//   - 在 node 侧用同一份 loader 代码（esbuild 现编）打真实后端，算出期望值
//     （三校区 code/name/mapVersionId + POI 总数）；
//   - 连上开发者工具，reLaunch 到 pages/debug/debug，监听 console/exception；
//   - 轮询 evaluate 读页面 data.report（Skyline 页面 automator 的 page.data() 不可用，
//     逻辑层 evaluate 可以）；
//   - 两端对比并输出结论，有运行时异常则非零退出。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "tmp/release-test");
mkdirSync(outDir, { recursive: true });

execFileSync(join(repoRoot, "node_modules/.bin/esbuild"), [
  join(repoRoot, "miniprogram/miniprogram/lib/release/loader.ts"),
  "--bundle",
  "--format=cjs",
  "--platform=node",
  `--outfile=${join(outDir, "loader.cjs")}`,
]);

const require = createRequire(import.meta.url);
const loader = require(join(outDir, "loader.cjs"));
const automator = require("miniprogram-automator");

const API_BASE = process.env.SHUMAN_API_BASE ?? "https://map.shutf.com";
const WS_ENDPOINT = process.env.AUTOMATOR_WS ?? "ws://localhost:9420";

// ---------------------------------------------------------------------------
// 1. 期望值：node 侧跑同一份装配代码，直打真实后端
// ---------------------------------------------------------------------------
const expected = await loader.loadReleaseWithCache({
  storage: (() => {
    const map = new Map();
    return {
      get: (key) => (map.has(key) ? map.get(key) : null),
      set: (key, value) => map.set(key, value),
      remove: (key) => map.delete(key),
    };
  })(),
  fetchManifestRaw: async () => {
    const res = await fetch(`${API_BASE}/api/public/releases/current`);
    if (!res.ok) throw new Error(`releases/current ${res.status}`);
    return res.json();
  },
  fetchSvg: async (mapVersionId) => {
    const res = await fetch(`${API_BASE}/api/public/maps/${encodeURIComponent(mapVersionId)}/asset`);
    if (!res.ok) throw new Error(`map asset ${mapVersionId} ${res.status}`);
    return res.text();
  },
});
const expectedCampuses = expected.campuses.map((campus) => ({
  code: campus.key,
  name: campus.label,
  mapVersionId: campus.mapVersionId,
}));
console.log("[expect] release:", expected.releaseId, expected.version);
console.log("[expect] campuses:", JSON.stringify(expectedCampuses));
console.log("[expect] poiCount:", expected.pois.length, "buildings:", expected.buildings.length);

// ---------------------------------------------------------------------------
// 2. 小程序侧：读 debug 页 report
// ---------------------------------------------------------------------------
const miniProgram = await automator.connect({ wsEndpoint: WS_ENDPOINT });
const consoleMessages = [];
const exceptions = [];
miniProgram.on("console", (msg) => consoleMessages.push(`${msg.type}: ${msg.args?.map(String).join(" ")}`));
miniProgram.on("exception", (err) => exceptions.push(String(err?.message ?? err)));

// 清掉模拟器里的 release/SVG 缓存，强制走冷启动路径（缓存正确性由单测覆盖）。
await miniProgram.evaluate(() => wx.clearStorageSync());

await miniProgram.reLaunch("/pages/debug/debug");

let report = null;
let errorMessage = "";
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  const state = await miniProgram.evaluate(() => {
    const pages = getCurrentPages();
    const page = pages[pages.length - 1];
    return page ? { report: page.data.report ?? null, errorMessage: page.data.errorMessage ?? "" } : null;
  });
  if (state?.report) {
    report = state.report;
    break;
  }
  if (state?.errorMessage) {
    errorMessage = state.errorMessage;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

if (!report) {
  console.error("[actual] 装配失败或超时:", errorMessage || "(timeout)");
  console.error("[exceptions]", exceptions);
  process.exit(1);
}
console.log("[actual] release:", report.releaseId, report.version);
console.log("[actual] campuses:", JSON.stringify(report.campuses.map(({ code, name, mapVersionId }) => ({ code, name, mapVersionId }))));
console.log("[actual] poiCount:", report.poiCount, "buildings:", report.buildingCount);

// ---------------------------------------------------------------------------
// 3. 对比 + 运行时异常检查
// ---------------------------------------------------------------------------
assert.equal(report.releaseId, expected.releaseId);
assert.equal(report.version, expected.version);
assert.equal(report.campuses.length, 3, "校区数应为 3");
assert.deepEqual(
  report.campuses.map(({ code, name, mapVersionId }) => ({ code, name, mapVersionId })),
  expectedCampuses,
  "三校区 code/name/mapVersionId 应与后端一致",
);
assert.equal(report.poiCount, expected.pois.length, "POI 总数应一致");
assert.equal(report.buildingCount, expected.buildings.length);
for (const campus of report.campuses) {
  const parts = String(campus.viewBox).split(" ").map(Number);
  assert.equal(parts.length, 4, `viewBox 应为四元数：${campus.viewBox}`);
  assert.ok(parts.every((n) => Number.isFinite(n)), `viewBox 含非数值：${campus.viewBox}`);
  assert.ok(parts[2] > 0 && parts[3] > 0, `viewBox 宽高应为正：${campus.viewBox}`);
}

const pageExceptions = exceptions.filter((message) => !message.includes("webview"));
assert.deepEqual(pageExceptions, [], `运行时不应有异常：${pageExceptions.join("; ")}`);

console.log("[ok] 小程序装配结果与后端一致，无运行时异常");
console.log(`[console] 共 ${consoleMessages.length} 条 console 消息`);
await miniProgram.disconnect();
