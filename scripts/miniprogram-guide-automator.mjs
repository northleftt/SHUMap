// 返校指南原生页（Part 5）的模拟器巡检（miniprogram-automator）。
//
// 前置：微信开发者工具已打开本项目并开启「服务端口」，且已执行：
//   /Applications/wechatwebdevtools.app/Contents/MacOS/cli \
//     auto --project /Users/wangyixuan/SHUMap/miniprogram --auto-port 9420
// 数据走云托管代理（线上已发布内容），不依赖本地 D1。
//
// 巡检点（截图都在 tmp/guide-autotest/）：
//   1. 初始正常态（首个枢纽 × 首个有卡校区）：双列选择器、route 卡时间线/
//      计量 chips/图标字段；
//   2. 虹桥枢纽→嘉定校区：figure 图示卡（-png 副本应直接渲染，imgFailed 不为真）、
//      热点弹层开关；
//   3. 枢纽指引/实况指引/备注三区块数据与滚动截图；
//   4. 多组枢纽×校区切换：选择器过滤、无卡置灰、校区回落、无卡枢纽空态；
//   5. 全程 console/exception 监听，结束断言无异常（console error 只预警）。
//
// Skyline 页面 automator 的 page.data()/元素选择不可用，全部走 evaluate 读
// page.data + 直调事件处理器（构造 { currentTarget: { dataset } }）。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "tmp/guide-autotest");
mkdirSync(outDir, { recursive: true });

// node 侧用同一份 lib/guide.ts 打线上接口算期望值
execFileSync(join(repoRoot, "node_modules/.bin/esbuild"), [
  join(repoRoot, "miniprogram/miniprogram/lib/guide.ts"),
  "--bundle",
  "--format=cjs",
  "--platform=node",
  `--outfile=${join(outDir, "guide.cjs")}`,
]);

const require = createRequire(import.meta.url);
const guide = require(join(outDir, "guide.cjs"));
const automator = require("miniprogram-automator");

const API_BASE = process.env.SHUMAN_API_BASE ?? "https://map.shutf.com";
const WS_ENDPOINT = process.env.AUTOMATOR_WS ?? "ws://localhost:9420";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 1. 期望值：线上发布稿 + 同一份纯函数
// ---------------------------------------------------------------------------
const payloadRaw = await fetch(`${API_BASE}/api/public/guide/freshman-transit`).then((res) => {
  if (!res.ok) throw new Error(`guide fetch ${res.status}`);
  return res.json();
});
const payload = guide.parseGuidePayload(payloadRaw);
assert.ok(payload, "线上指南响应应通过校验");
const content = guide.normalizeGuideContent(payload.content);
const hubs = guide.sortedHubs(content);
console.log(
  "[expect] revisionNo:", payload.revisionNo,
  "hubs:", hubs.length,
  "campuses:", content.campuses.map((c) => c.id).join(","),
);
const firstHub = hubs[0].id;
const firstCampus = guide.validCampus(content, firstHub, null);
const jdCards = guide.cardsFor(content, "hongqiao", "jiading");
console.log("[expect] default:", `${firstHub}×${firstCampus}`, "hongqiao×jiading cards:", jdCards.length);

// ---------------------------------------------------------------------------
// 2. 连接 + reLaunch 指南页
// ---------------------------------------------------------------------------
const miniProgram = await automator.connect({ wsEndpoint: WS_ENDPOINT });
const consoleMessages = [];
const exceptions = [];
miniProgram.on("console", (msg) =>
  consoleMessages.push(`${msg.type}: ${msg.args?.map(String).join(" ")}`),
);
miniProgram.on("exception", (err) => exceptions.push(String(err?.message ?? err)));

await miniProgram.reLaunch("/pages/guide/guide");

function readState() {
  return miniProgram.evaluate(() => {
    const pages = getCurrentPages();
    const page = pages[pages.length - 1];
    if (!page || !page.route.includes("guide")) return null;
    return {
      route: page.route,
      state: page.data.state,
      title: page.data.title,
      edition: page.data.edition,
      hubOptions: page.data.hubOptions ?? [],
      campusOptions: page.data.campusOptions ?? [],
      showModeBar: page.data.showModeBar,
      modeChips: page.data.modeChips ?? [],
      cards: page.data.cards ?? [],
      emptyText: page.data.emptyText ?? "",
      hubGuide: page.data.hubGuide ?? null,
      sceneGuide: page.data.sceneGuide ?? null,
      videoEntries: page.data.videoEntries ?? [],
      remarkHtml: page.data.remarkHtml ?? "",
      hotspotPop: page.data.hotspotPop ?? null,
    };
  });
}

let state = null;
{
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    state = await readState();
    if (state && state.state !== "loading") break;
    await sleep(1000);
  }
}
if (!state || state.state !== "ready") {
  await miniProgram.screenshot({ path: join(outDir, "00-failed.png") }).catch(() => {});
  console.error("[fail] 指南页未进入 ready:", state?.state, "exceptions:", exceptions);
  process.exit(1);
}
console.log("[actual] title:", state.title, "edition:", state.edition);

// 直调辅助：构造事件对象调页面处理器
function callHandler(name, dataset) {
  return miniProgram.evaluate(
    ({ name: n, dataset: d }) =>
      getCurrentPages()[getCurrentPages().length - 1][n]({ currentTarget: { dataset: d } }),
    { name, dataset },
  );
}
function scrollTo(id) {
  return miniProgram.evaluate((target) => {
    const page = getCurrentPages()[getCurrentPages().length - 1];
    page.setData({ scrollToCard: target });
    setTimeout(() => page.setData({ scrollToCard: "" }), 800);
  }, id);
}

// ---------------------------------------------------------------------------
// 3. 初始正常态：选择器 + route 卡
// ---------------------------------------------------------------------------
assert.equal(state.hubOptions.length, hubs.length, "枢纽数应与线上一致");
assert.equal(state.campusOptions.length, content.campuses.length, "校区数应与线上一致");
assert.equal(
  state.hubOptions.find((h) => h.active)?.id,
  firstHub,
  "默认应选第一个枢纽",
);
assert.equal(
  state.campusOptions.find((c) => c.active)?.id,
  firstCampus,
  "默认应回落到首个有卡校区",
);
const expectedInitialCards = guide
  .cardsFor(content, firstHub, firstCampus)
  .map((c) => ({ id: c.id, kind: c.kind }));
assert.deepEqual(
  state.cards.map((c) => ({ id: c.id, kind: c.kind })),
  expectedInitialCards,
  "初始卡片集合应与 cardsFor 一致",
);
const routeCard = state.cards.find((c) => c.kind === "route");
assert.ok(routeCard, "初始组合应有 route 卡");
assert.ok(routeCard.legs.length >= 2, "route 卡应有多段时间线");
assert.ok(routeCard.durationText || routeCard.fareText, "route 卡应有计量 chips");
// 线路图标：与 node 侧 lineIcon 对拍——有 uri/png 的图标应渲染 <image>
// （src 为 data URI），没有的（bus/svg-only/plain）应为 null
const expectedRouteCards = guide
  .cardsFor(content, firstHub, firstCampus)
  .filter((c) => c.kind === "route");
let iconImageCount = 0;
state.cards
  .filter((c) => c.kind === "route")
  .forEach((view, ci) => {
    const raw = expectedRouteCards[ci];
    view.legs.forEach((leg, li) => {
      leg.rideLines.forEach((ln, ni) => {
        const expectIcon = guide.lineIcon(content, raw.legs[li].lines[ni]);
        if (expectIcon) {
          assert.ok(ln.icon, `卡片 ${view.id} 第 ${li} 段应有位图图标`);
          assert.ok(ln.icon.src.startsWith("data:"), "图标 src 应为 data URI");
          iconImageCount += 1;
        } else {
          assert.equal(ln.icon, null, `卡片 ${view.id} 第 ${li} 段不应有图标`);
        }
      });
    });
  });
console.log("[ok] 线路图标对拍，位图图标条数:", iconImageCount);
await sleep(500);
await miniProgram.screenshot({ path: join(outDir, "01-initial-route.png") });
console.log("[ok] 初始正常态:", `${firstHub}×${firstCampus}`, "cards:", state.cards.length);

// ---------------------------------------------------------------------------
// 4. 虹桥→嘉定：figure 图示卡 + 热点弹层
// ---------------------------------------------------------------------------
await callHandler("pickCampus", { id: "jiading" });
await sleep(800);
state = await readState();
assert.equal(state.campusOptions.find((c) => c.active)?.id, "jiading");
assert.deepEqual(
  state.cards.map((c) => ({ id: c.id, kind: c.kind })),
  jdCards.map((c) => ({ id: c.id, kind: c.kind })),
  "嘉定卡片集合应与 cardsFor 一致",
);
assert.equal(state.showModeBar, true, "metro+bus 两种出行方式应显示筛选 chips");
assert.deepEqual(
  state.modeChips.map((m) => ({ mode: m.mode, on: m.on })),
  [
    { mode: "metro", on: true },
    { mode: "bus", on: true },
  ],
);

// figure 卡：-png 应直接渲染（binderror 会把 imgFailed 置真或换 fallbackSrc）
const figureView = state.cards.find((c) => c.kind === "figure" && c.id === "hq-jd-fig-route");
assert.ok(figureView, "应有 route-hongqiao-jiading 图示卡");
assert.match(figureView.src, /route-hongqiao-jiading-png$/, "应优先用 -png 副本键");
await scrollTo("card-hq-jd-fig-route");
// 等图片解码完成（bindload 置 imgLoaded；binderror 会换 fallbackSrc 或置 imgFailed）
{
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    state = await readState();
    const a = state.cards.find((c) => c.id === "hq-jd-fig-route");
    const b = state.cards.find((c) => c.id === "hq-jd-fig-hub");
    if ((a?.imgLoaded || a?.imgFailed) && (b?.imgLoaded || b?.imgFailed)) break;
    await sleep(500);
  }
}
state = await readState();
const figureAfter = state.cards.find((c) => c.id === "hq-jd-fig-route");
assert.equal(figureAfter.imgLoaded ?? false, true, "图示应触发 bindload 加载完成");
assert.equal(
  figureAfter.imgFailed ?? false,
  false,
  `图示应渲染成功而不是占位（src=${figureAfter.src}）`,
);
assert.match(
  figureAfter.src,
  /-png$/,
  "-png 加载不应触发 binderror 回落（触发则 src 被换成原键）",
);
await miniProgram.screenshot({ path: join(outDir, "02-figure-card.png") });

// 热点弹层：开一个带 #card: 链接的热点
await callHandler("openHotspot", { cardId: "hq-jd-fig-route", hotId: "h-nmgj" });
state = await readState();
assert.ok(state.hotspotPop, "热点弹层应打开");
assert.equal(state.hotspotPop.title, "南门公交站");
assert.equal(state.hotspotPop.links[0].kind, "card");
await miniProgram.screenshot({ path: join(outDir, "03-hotspot-pop.png") });
await callHandler("closeHotspot", {});
state = await readState();
assert.equal(state.hotspotPop, null, "弹层应关闭");
console.log("[ok] figure 图示卡 + 热点弹层");

// 出行方式筛选：关掉 metro 后 route 卡只剩公交（figure 不受筛选）
await callHandler("toggleMode", { mode: "metro" });
state = await readState();
assert.equal(
  state.cards.filter((c) => c.kind === "route").every((c) => c.modeBadgeText !== "地铁"),
  true,
  "关掉 metro 后不应剩地铁路线卡",
);
assert.equal(
  state.cards.filter((c) => c.kind === "figure").length,
  2,
  "figure 卡不受方式筛选影响",
);
await callHandler("toggleMode", { mode: "metro" });
console.log("[ok] 出行方式筛选 chips");

// ---------------------------------------------------------------------------
// 5. 枢纽指引 / 实况指引 / 备注区块
// ---------------------------------------------------------------------------
state = await readState();
assert.equal(state.hubGuide?.placeholder, "枢纽指引图待上传", "虹桥无指引图应出占位");
await scrollTo("hub-guide-sec");
await sleep(800);
await miniProgram.screenshot({ path: join(outDir, "04-hub-guide-placeholder.png") });

assert.ok(state.sceneGuide, "虹桥应有实况指引");
assert.equal(state.sceneGuide.sections.length, 2, "sceneGuide 应有 2 个小节");
assert.equal(state.sceneGuide.sections[0].steps.length, 4);
await scrollTo("scene-guide-sec");
await sleep(800);
await miniProgram.screenshot({ path: join(outDir, "05-scene-guide.png") });

assert.equal(state.remarkHtml, "测试", "虹桥备注应预处理后渲染");
await scrollTo("remark-sec");
await sleep(800);
await miniProgram.screenshot({ path: join(outDir, "06-remark.png") });
console.log("[ok] 枢纽指引/实况指引/备注区块");

// ---------------------------------------------------------------------------
// 6. 选择器组合：回落 / 置灰 / 无卡枢纽空态
// ---------------------------------------------------------------------------
// 松江站：所有卡都是 campus=all → 校区应回落 all，其余置灰
await callHandler("pickHub", { id: "songjiang" });
await sleep(500);
state = await readState();
assert.equal(state.campusOptions.find((c) => c.active)?.id, "all", "松江站应回落到 all 校区");
assert.equal(
  state.campusOptions.filter((c) => c.disabled).length,
  state.campusOptions.length - 1,
  "其余校区应全部置灰",
);
assert.ok(state.cards.length > 0, "松江×通用应有卡");
await miniProgram.screenshot({ path: join(outDir, "07-songjiang-fallback.png") });

// 换到 appendix（无任何卡）：全部置灰 + 空态文案
await callHandler("pickHub", { id: "appendix" });
await sleep(500);
state = await readState();
assert.equal(
  state.campusOptions.every((c) => c.disabled),
  true,
  "appendix 下所有校区应置灰",
);
assert.equal(state.cards.length, 0);
assert.match(state.emptyText, /没有卡片/, "无卡组合应出空态文案");
await miniProgram.screenshot({ path: join(outDir, "08-appendix-empty.png") });

// 回到虹桥：校区保持逻辑（appendix→hongqiao，当前校区无卡则回落首个有卡校区）
await callHandler("pickHub", { id: "hongqiao" });
await sleep(500);
state = await readState();
assert.equal(
  state.campusOptions.find((c) => c.active)?.id,
  guide.validCampus(content, "hongqiao", null),
  "回到虹桥应回落首个有卡校区",
);
console.log("[ok] 选择器组合：回落/置灰/空态");

// ---------------------------------------------------------------------------
// 7. 异常断言与收尾
// ---------------------------------------------------------------------------
await miniProgram.screenshot({ path: join(outDir, "09-final.png") });
const consoleErrors = consoleMessages.filter((m) => m.startsWith("error"));
if (consoleErrors.length) console.warn("[warn] console error:\n" + consoleErrors.join("\n"));
assert.deepEqual(exceptions, [], `运行时不应有异常：\n${exceptions.join("\n")}`);
await miniProgram.disconnect();
console.log("[done] 指南页巡检完成，截图在 tmp/guide-autotest/");
