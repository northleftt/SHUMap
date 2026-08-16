import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 死锁回归护栏。
//
// 2026-08-12 的 boundMap* 让线上快照过不了客户端 exactObject 校验，地图打不开。
// 修法是「发一版新的把快照重写」——但发布中心自己也读当前快照，走的是会抛的
// getOptionalCurrentRelease，于是整页塌成一条 ErrorBanner，发布表单根本不渲染：
// 唯一的自救入口被它本该修的东西挡住了。
//
// 所以发布中心/总览必须走 getAdminReleaseSummary：坏快照要能进页面，并把契约错误
// 当数据显示出来。这里钉住这条路径，以及两个页面确实用的是它。

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const bundled = await build({
  absWorkingDir: root,
  entryPoints: ["src/lib/api/public.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
  external: ["react", "react-dom", "react-router-dom"],
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`;
const { getAdminReleaseSummary, getOptionalCurrentRelease } = await import(moduleUrl);

/** 线上真实存档：tests/fixtures/release-manifest-live.json 是一份合法快照。 */
const liveManifest = JSON.parse(read("tests/fixtures/release-manifest-live.json"));

/** 把合法快照污染成 2026-08-12 的样子（locations 每行多四个 join 别名）。 */
function pollutedManifest() {
  const manifest = JSON.parse(JSON.stringify(liveManifest));
  manifest.locations = manifest.locations.map((location) => ({
    ...location,
    boundMapVersionLabel: "20260807",
    boundMapCampusId: "campus_baoshan",
    boundMapFloorId: null,
    boundMapCampusName: "宝山校区",
  }));
  return manifest;
}

/** 用一次性的 global.fetch 桩跑 loader，避免真的发请求。 */
async function withFetch(responder, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => responder(String(url));
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("a polluted snapshot still yields a summary, with the reason surfaced as data", async () => {
  const summary = await withFetch(
    () => jsonResponse(pollutedManifest()),
    () => getAdminReleaseSummary(),
  );

  assert.ok(summary, "坏快照也必须返回摘要，否则发布中心进不去");
  assert.match(
    summary.incompatibleReason ?? "",
    /boundMapVersionLabel is not supported/,
    "契约错误要作为数据带出来，页面据此提示「发一版即可恢复」",
  );
  // 展示字段照常可读——这些是发布员判断「要发哪一版」的依据。
  assert.equal(summary.version, liveManifest.release.version);
  assert.equal(summary.createdAt, liveManifest.release.createdAt);
  assert.equal(summary.counts.places, liveManifest.places.length);
  assert.equal(summary.counts.maps, liveManifest.maps.length);
});

test("the throwing path really does reject that same snapshot", async () => {
  // 反向护栏：如果哪天 exactObject 放宽了，上面那条测试就测不到东西了。
  await assert.rejects(
    () => withFetch(() => jsonResponse(pollutedManifest()), () => getOptionalCurrentRelease()),
    /boundMapVersionLabel is not supported/,
    "完整解析必须仍然拒绝坏快照",
  );
});

test("a clean snapshot reports no incompatibility", async () => {
  const summary = await withFetch(
    () => jsonResponse(liveManifest),
    () => getAdminReleaseSummary(),
  );
  assert.equal(summary.incompatibleReason, null, "正常快照不应报不兼容");
  assert.equal(summary.version, liveManifest.release.version);
});

test("no active release stays an empty state, not an error", async () => {
  const summary = await withFetch(
    () => jsonResponse({ error: { code: "release_unavailable", message: "none" } }, 503),
    () => getAdminReleaseSummary(),
  );
  assert.equal(summary, null, "503 release_unavailable 要回落成「尚无已发布版本」");
});

test("a genuinely broken response still throws rather than faking a version", async () => {
  // 500 之类的故障不能被当成「快照不兼容」——那会把服务故障说成内容问题。
  await assert.rejects(
    () => withFetch(() => jsonResponse({ error: { code: "internal", message: "boom" } }, 500), () => getAdminReleaseSummary()),
    /boom|500|internal/,
  );
});

test("both admin surfaces read the resilient loader, not the throwing one", () => {
  for (const file of ["src/admin/pages/ReleasesPage.tsx", "src/admin/pages/OverviewPage.tsx"]) {
    const source = read(file);
    assert.match(source, /getAdminReleaseSummary\(signal\)/, `${file} 必须走容错读取`);
    assert.doesNotMatch(
      source,
      /getOptionalCurrentRelease/,
      `${file} 不能再走会抛的完整解析——坏快照会让整页塌掉，堵死自救入口`,
    );
  }
});

test("the release center tells the operator that publishing is the fix", () => {
  const source = read("src/admin/pages/ReleasesPage.tsx");
  assert.match(source, /release\?\.incompatibleReason \?/, "不兼容时要显式提示");
  assert.match(source, /发一版新的即可重写快照恢复/, "提示必须说明该怎么做，而不只是报错");
});
