// 楼层图页（Part 3）的小程序端回归（miniprogram-automator）。
//
// 前置：微信开发者工具已打开本项目并开启「服务端口」，且已执行：
//   /Applications/wechatwebdevtools.app/Contents/MacOS/cli \
//     auto --project /Users/wangyixuan/SHUMap/miniprogram --auto-port 9420
// 期望数据从云托管上游的 Worker 自定义域名读取，不依赖本地 D1。
//
// 做什么：
//   - node 侧用同一份 loader 代码打线上后端，选目标楼宇并算期望值：
//     优先「有楼层 + 平面图」的楼宇（验证 plan 视图与图片加载）；没有则退到
//     「有楼层且有设施」的楼宇（验证列表视图强制、设施行、选中链路）；
//   - 连开发者工具 reLaunch 到 pages/floors/floors?placeId=...，轮询 report 对比；
//   - evaluate 直调 switchFloor / setView 验证可直调方法；
//   - 截图 tmp/floors-test/ 供人工核对；监听 console/exception，结束断言无异常。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "tmp/floors-test");
mkdirSync(outDir, { recursive: true });

for (const [entry, out] of [
  ["miniprogram/miniprogram/lib/release/loader.ts", "loader.cjs"],
]) {
  execFileSync(join(repoRoot, "node_modules/.bin/esbuild"), [
    join(repoRoot, entry),
    "--bundle",
    "--format=cjs",
    "--platform=node",
    `--outfile=${join(outDir, out)}`,
  ]);
}

const require = createRequire(import.meta.url);
const loader = require(join(outDir, "loader.cjs"));
const automator = require("miniprogram-automator");

const API_BASE = process.env.SHUMAN_API_BASE ?? "https://map.shutf.com";
const WS_ENDPOINT = process.env.AUTOMATOR_WS ?? "ws://localhost:9420";

// ---------------------------------------------------------------------------
// 1. 期望值：node 侧跑同一份装配代码，直打线上后端，选目标楼宇
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

const plansByFloor = new Map(expected.manifest.floors.filter(floor => floor.imageUrl).map(floor => [floor.id, floor.imageUrl]));
const publicFloors = expected.manifest.floors.filter((floor) => floor.isPublic !== 0);
const buildingById = new Map(expected.buildings.map((building) => [building.entityId, building]));

function floorsOf(buildingPlaceId) {
  return publicFloors
    .filter((floor) => floor.buildingPlaceId === buildingPlaceId)
    .sort((left, right) => left.levelOrder - right.levelOrder);
}

// 优先有楼层 + 平面图的楼宇；否则退到有楼层且有本层设施的楼宇；再退到任意有楼层的楼宇。
const buildingIds = [...new Set(publicFloors.map((floor) => floor.buildingPlaceId))];
const targetId =
  buildingIds.find((id) => floorsOf(id).some((floor) => plansByFloor.has(floor.id)))
  ?? buildingIds.find((id) =>
    floorsOf(id).some((floor) =>
      (buildingById.get(id)?.facilities ?? []).some((facility) => facility.floorId === floor.id),
    ))
  ?? buildingIds[0];
assert.ok(targetId, "release 里应至少有一栋带楼层的楼宇");

const target = buildingById.get(targetId);
const targetFloors = floorsOf(targetId);
const firstFloor = targetFloors[0];
const firstPlan = plansByFloor.get(firstFloor.id) ?? null;
const expectedFloorFacilities = target.facilities.filter((facility) => facility.floorId === firstFloor.id);
const expectedFloorMedia = target.detail.media.filter(
  (item) => item.floorLevelCode === firstFloor.levelCode && item.url.trim(),
);
console.log(
  "[expect] building:", target.name, targetId,
  "floors:", targetFloors.length, "hasPlan:", firstPlan !== null,
  "floorFacilities:", expectedFloorFacilities.length,
);

// ---------------------------------------------------------------------------
// 2. 小程序侧：reLaunch 楼层图页，读 report
// ---------------------------------------------------------------------------
const miniProgram = await automator.connect({ wsEndpoint: WS_ENDPOINT });
const consoleMessages = [];
const exceptions = [];
miniProgram.on("console", (msg) => consoleMessages.push(`${msg.type}: ${msg.args?.map(String).join(" ")}`));
miniProgram.on("exception", (err) => exceptions.push(String(err?.message ?? err)));

// 保留所选环境与用户偏好。
await miniProgram.reLaunch(`/pages/floors/floors?placeId=${encodeURIComponent(targetId)}`);

function readState() {
  return miniProgram.evaluate(() => {
    const pages = getCurrentPages();
    const page = pages[pages.length - 1];
    if (!page) return null;
    return {
      route: page.route,
      report: page.data.report ?? null,
      errorMessage: page.data.errorMessage ?? "",
      floorFacilities: page.data.floorFacilities ?? [],
      floorMedia: page.data.floorMedia ?? [],
      selectedFacility: page.data.selectedFacility ?? null,
    };
  });
}

let state = null;
const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  state = await readState();
  if (state?.report || state?.errorMessage) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

if (!state?.report) {
  console.error("[actual] 楼层图页加载失败或超时:", state?.errorMessage || "(timeout)");
  console.error("[exceptions]", exceptions);
  process.exit(1);
}
const report = state.report;
console.log("[actual]", JSON.stringify(report));

// ---------------------------------------------------------------------------
// 3. 对比装配结果
// ---------------------------------------------------------------------------
assert.equal(report.placeId, targetId);
assert.equal(report.floorCount, targetFloors.length, "楼层数应与 release 一致");
assert.equal(report.activeFloorId, firstFloor.id, "默认应选 levelOrder 最小的层");
assert.equal(report.hasPlan, firstPlan !== null, "有无平面图应与 floor.imageUrl 一致");
if (report.hasPlan) {
  const readAsset = () => miniProgram.evaluate(() => {
    const assetUrl = getCurrentPages()[getCurrentPages().length - 1].data.planImageUrl;
    let assetExists = false;
    try {
      assetExists = Boolean(assetUrl) && Boolean(wx.getFileSystemManager().statSync(assetUrl));
    } catch {
      assetExists = false;
    }
    return { assetUrl, assetExists };
  });
  let assetState = await readAsset();
  const imageDeadline = Date.now() + 20000;
  while (!assetState.assetExists && Date.now() < imageDeadline) {
    await new Promise(resolve => setTimeout(resolve, 500));
    assetState = await readAsset();
  }
  assert.ok(assetState.assetUrl, "楼层图应有本地资源路径");
  assert.equal(assetState.assetExists, true, "楼层图本地文件应存在");
}
assert.equal(
  report.view,
  firstPlan ? "plan" : "list",
  firstPlan ? "有图纸应默认平面图视图" : "无图纸应强制列表视图",
);
assert.equal(state.floorFacilities.length, expectedFloorFacilities.length, "本层设施行数应一致");
if (expectedFloorMedia.length > 0) {
  const readMediaState = () => miniProgram.evaluate(() => {
    const rows = getCurrentPages()[getCurrentPages().length - 1].data.floorMedia ?? [];
    const fs = wx.getFileSystemManager();
    return rows.map((row) => {
      try {
        return { url: row.url, exists: Boolean(fs.statSync(row.url)) };
      } catch {
        return { url: row.url, exists: false };
      }
    });
  });
  const mediaDeadline = Date.now() + 20_000;
  let mediaState = [];
  while (Date.now() < mediaDeadline) {
    state = await readState();
    mediaState = await readMediaState();
    if (
      state.floorMedia.length === expectedFloorMedia.length
      && mediaState.every((item) => item.url && item.exists)
    ) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(state.floorMedia.length, expectedFloorMedia.length, "本层媒体数应与 release 一致");
  assert.ok(mediaState.every((item) => item.url && item.exists), "楼层媒体应全部写入本地文件");
  console.log("[ok] 楼层媒体本地化:", mediaState.length, "张");
}
await miniProgram.screenshot({ path: join(outDir, "floors-initial.png") });

// ---------------------------------------------------------------------------
// 4. 可直调方法：switchFloor / setView
// ---------------------------------------------------------------------------
if (firstPlan) {
  // 有图纸：列表/平面图来回切一次
  await miniProgram.evaluate(() => getCurrentPages()[getCurrentPages().length - 1].setView("list"));
  let after = await readState();
  assert.equal(after.report.view, "list");
  await miniProgram.evaluate(() => getCurrentPages()[getCurrentPages().length - 1].setView("plan"));
  after = await readState();
  assert.equal(after.report.view, "plan");
  console.log("[ok] setView list/plan 往返");
} else {
  // 无图纸：setView("plan") 应被拒绝，保持列表
  await miniProgram.evaluate(() => getCurrentPages()[getCurrentPages().length - 1].setView("plan"));
  const after = await readState();
  assert.equal(after.report.view, "list", "无图纸时 setView(plan) 应保持列表");
  console.log("[ok] 无图纸强制列表视图");
}

if (targetFloors.length > 1) {
  const second = targetFloors[1];
  await miniProgram.evaluate(
    (floorId) => getCurrentPages()[getCurrentPages().length - 1].switchFloor(floorId),
    second.id,
  );
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const after = await readState();
  assert.equal(after.report.activeFloorId, second.id, "switchFloor 应切到目标层");
  await miniProgram.evaluate(
    (floorId) => getCurrentPages()[getCurrentPages().length - 1].switchFloor(floorId),
    firstFloor.id,
  );
  await new Promise((resolve) => setTimeout(resolve, 1200));
  console.log("[ok] switchFloor 往返");
}

// 位图捏合与拖动由 movable-view 负责，手感留待真机验证。

// ---------------------------------------------------------------------------
// 5. 截图 + 运行时异常检查
// ---------------------------------------------------------------------------
await miniProgram.screenshot({ path: join(outDir, "floors-final.png") });
console.log("[ok] 截图:", join(outDir, "floors-initial.png"), "与 floors-final.png");

const pageExceptions = exceptions.filter((message) => !message.includes("webview"));
assert.deepEqual(pageExceptions, [], `运行时不应有异常：${pageExceptions.join("; ")}`);

console.log("[ok] 楼层图页装配/视图切换与后端一致，无运行时异常");
console.log(`[console] 共 ${consoleMessages.length} 条 console 消息`);
await miniProgram.disconnect();
