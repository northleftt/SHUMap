// 小程序端返校指南页数据层自验（不经微信开发者工具，直接在 node 里跑）。
//
// 用 esbuild 把 miniprogram/miniprogram/lib/guide.ts 编成 cjs 后断言：
// 1. 响应校验 parseGuidePayload；
// 2. 规范化 normalizeGuideContent：steps 卡摘进 hub.sceneGuide、scene 校区清理
//    （对齐网页版 normalizeData/liftSceneGuides）；
// 3. 枢纽排序 sortedHubs、有效校区回落 validCampus、卡片过滤 cardsFor、
//    出行方式集合 modesFor、线路色 lineColor、深链 parseGuideQuery；
// 4. route 卡视图模型 buildCardView（时间线/方式徽标/计量 chips/步行段）；
// 5. 源码断言：app.json 注册 pages/guide/guide、地图页 openGuide 改跳原生页。
//
// 夹具 tests/fixtures/guide-live.json 是线上 GET /api/public/guide/freshman-transit
// 的真实响应快照（2026-08-12 抓取，revisionNo 3）。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "tmp/guide-test");
mkdirSync(outDir, { recursive: true });

execFileSync(join(repoRoot, "node_modules/.bin/esbuild"), [
  join(repoRoot, "miniprogram/miniprogram/lib/guide.ts"),
  "--bundle",
  "--format=cjs",
  "--platform=node",
  `--outfile=${join(outDir, "guide.cjs")}`,
]);

const require = createRequire(import.meta.url);
const guide = require(join(outDir, "guide.cjs"));
const fixture = JSON.parse(readFileSync(join(repoRoot, "tests/fixtures/guide-live.json"), "utf8"));

// ---------------------------------------------------------------------------
// 1. parseGuidePayload
// ---------------------------------------------------------------------------
{
  const payload = guide.parseGuidePayload(fixture);
  assert.ok(payload, "真实响应应通过校验");
  assert.equal(payload.title, "上海大学");
  assert.equal(payload.edition, "2026 版");
  assert.equal(payload.revisionNo, 3);
  assert.ok(Array.isArray(payload.content.cards));

  assert.equal(guide.parseGuidePayload(null), null);
  assert.equal(guide.parseGuidePayload({}), null, "缺 content 应拒绝");
  assert.equal(guide.parseGuidePayload({ content: {} }), null, "缺 cards 应拒绝");
}

// ---------------------------------------------------------------------------
// 2. normalizeGuideContent：steps 卡摘进 hub.sceneGuide，scene 校区清理
// ---------------------------------------------------------------------------
const content = guide.normalizeGuideContent(fixture.content);
{
  assert.equal(content.cards.length, 28, "33 张卡摘出 5 张 steps 后应剩 28 张");
  assert.ok(!content.cards.some((c) => c.kind === "steps"), "cards 里不应再有 steps 卡");

  const hongqiao = guide.hubById(content, "hongqiao");
  assert.equal(hongqiao.sceneGuide.sections.length, 2, "虹桥枢纽应摘入 2 个小节");
  const songjiang = guide.hubById(content, "songjiang");
  assert.equal(songjiang.sceneGuide.sections.length, 2);
  assert.equal(songjiang.sceneGuide.intro.length > 0, true, "松江站 steps 卡的 intro 应保留");
  const appendix = guide.hubById(content, "appendix");
  assert.equal(appendix.sceneGuide, null, "没有 steps 卡的枢纽 sceneGuide 应为 null");

  assert.ok(
    !content.campuses.some((c) => c.id === "scene"),
    "steps 摘完后 scene 校区应被清理（剩余卡没有 campus=scene）",
  );
  assert.deepEqual(
    content.campuses.map((c) => c.id),
    ["baoshan", "jiading", "yanchang", "all"],
  );
}

// ---------------------------------------------------------------------------
// 3. 查询纯函数：排序 / 回落 / 过滤 / 方式集合 / 色值 / 深链
// ---------------------------------------------------------------------------
{
  // sortedHubs 按 order 升序
  assert.deepEqual(
    guide.sortedHubs(content).map((h) => h.id),
    ["hongqiao", "shanghai-railway", "shanghai-south", "pudong-airport", "songjiang", "appendix"],
  );

  // validCampus：当前校区在该枢纽下有卡 → 保留
  assert.equal(guide.validCampus(content, "hongqiao", "baoshan"), "baoshan");
  // 无卡 → 回落第一个有卡校区（松江站所有卡都是 campus=all）
  assert.equal(guide.validCampus(content, "songjiang", "baoshan"), "all");
  assert.equal(guide.validCampus(content, "songjiang", null), "all");
  // campus id 不在数据里 → 回落
  assert.equal(guide.validCampus(content, "hongqiao", "scene"), "baoshan");
  // 枢纽下完全无卡（appendix）→ 第一个校区
  assert.equal(guide.validCampus(content, "appendix", null), "baoshan");

  // cardCount / cardsFor
  assert.equal(guide.cardCount(content, "hongqiao", "jiading"), 5);
  assert.equal(guide.cardCount(content, "songjiang", "baoshan"), 0);
  const jdCards = guide.cardsFor(content, "hongqiao", "jiading");
  assert.equal(jdCards.length, 5);
  assert.equal(
    jdCards.filter((c) => c.kind === "figure").length,
    2,
    "虹桥→嘉定应有 2 张 figure 卡",
  );
  // modeFilter 只筛路线卡，figure 不受影响（对齐 renderPairView）
  const metroOnly = guide.cardsFor(content, "hongqiao", "jiading", new Set(["metro"]));
  assert.equal(metroOnly.length, 3, "metro 1 张路线卡 + 2 张 figure 卡");
  assert.equal(
    metroOnly.filter((c) => c.kind === "route").every((c) => c.mode === "metro"),
    true,
  );

  // modesFor：按卡片顺序去重，只数 route 卡
  assert.deepEqual(guide.modesFor(content, "hongqiao", "jiading"), [
    { mode: "metro", label: "地铁" },
    { mode: "bus", label: "公交" },
  ]);
  // 松江站数据的 modeLabel 写的是目的地名（线上真实数据如此），label 优先 modeLabel
  assert.deepEqual(guide.modesFor(content, "songjiang", "all"), [
    { mode: "metro", label: "宝山" },
  ]);
  // modeLabel 缺失时回 MODE_LABEL 映射
  assert.equal(guide.GUIDE_MODE_LABEL.airport, "市域线");

  // lineColor
  assert.equal(guide.lineColor("l2", content), "#8cc63e");
  assert.equal(guide.lineColor("l1", content), "#e4002b");
  assert.equal(guide.lineColor(null, content), "#8f98a3", "空 key 应回 neutral");
  assert.equal(guide.lineColor("#123456", content), "#123456", "未知 key 原样透传");

  // parseGuideQuery
  assert.deepEqual(guide.parseGuideQuery({ h: "pudong-airport", c: "jiading" }), {
    hub: "pudong-airport",
    campus: "jiading",
  });
  assert.deepEqual(guide.parseGuideQuery({}), { hub: null, campus: null });
}

// ---------------------------------------------------------------------------
// 4. buildCardView：route 卡视图模型（夹具第一张 route 卡 hq-bs-metro-a）
// ---------------------------------------------------------------------------
{
  const raw = fixture.content.cards.find((c) => c.id === "hq-bs-metro-a");
  const view = guide.buildCardView(raw, content);
  assert.equal(view.kind, "route");
  assert.equal(view.originName, "虹桥枢纽");
  assert.equal(view.originNote, "（铁路上海虹桥站 虹桥机场）");
  assert.equal(view.toward, "去往 宝山校区");
  assert.equal(view.modeBadgeText, "地铁");
  assert.equal(view.modeBadgeClass, "mode-badge mode-metro");
  assert.equal(view.durationText, "约 75 分钟");
  assert.equal(view.fareText, "6 元");
  assert.deepEqual(view.flags, []);
  assert.equal(view.note, "");
  assert.deepEqual(view.schedule, []);

  // 时间线：7 段（stop/ride 交替 + walk + 终点 stop）
  assert.equal(view.legs.length, 7);
  const [l0, l1, l2, , l4, l5, l6] = view.legs;
  assert.equal(l0.type, "stop");
  assert.equal(l0.stopName, "虹桥火车站");
  assert.equal(l0.dotClass, "dot");
  assert.equal(l0.topRails.length, 0, "首段无上半轨道");
  assert.equal(l0.bottomRails.length, 1);
  assert.match(l0.bottomRails[0].style, /#8cc63e/, "2 号线色带应取 lineColors.l2");

  assert.equal(l1.type, "ride");
  assert.equal(l1.fullRails.length, 1, "ride 段用整段轨道");
  assert.equal(l1.dotClass, "", "ride 段无站点圆点");
  assert.equal(l1.rideLines.length, 1);
  assert.equal(l1.rideLines[0].isBus, false);
  assert.match(l1.rideLines[0].noStyle, /background: #8cc63e/);
  assert.equal(l1.rideLines[0].no, "2");
  assert.equal(l1.rideLines[0].suffix, "号线");
  assert.equal(l1.rideLines[0].toward, "往浦东1号2号航站楼方向");

  assert.equal(l2.dotClass, "cx", "transfer 标记应渲染换乘椭圆");
  assert.equal(l4.stopExit, "（2号口出站）");

  assert.equal(l5.type, "walk");
  assert.equal(l5.walkText, "步行45米");
  assert.equal(l5.fullRails.length, 1, "walk 段走 rails 色带");
  assert.match(l5.fullRails[0].style, /#b9bfc7/, "步行段应取 walk 色");

  assert.equal(l6.terminal, true);
  assert.equal(l6.stopName, "宝山校区北门");
  assert.equal(l6.bottomRails.length, 0, "终点无下半轨道");

  // 公交徽标：bus kind 走 busline 类不带底色
  const busCard = fixture.content.cards.find((c) => c.id === "hq-jd-bus-east");
  const busView = guide.buildCardView(busCard, content);
  const busLine = busView.legs.flatMap((leg) => leg.rideLines)[0];
  assert.equal(busLine.isBus, true);
  assert.equal(busLine.noStyle, "");
  assert.equal(busView.modeBadgeClass, "mode-badge mode-bus");

  // 非 route 卡：占位视图，页面跳过渲染（留给 figure/steps 切片）
  const figure = fixture.content.cards.find((c) => c.kind === "figure");
  assert.deepEqual(guide.buildCardView(figure, content), {
    kind: "figure",
    id: figure.id,
  });
}

// ---------------------------------------------------------------------------
// 5. 源码断言：app.json 注册 + openGuide 改跳原生页（webview 保留给预约乘车）
// ---------------------------------------------------------------------------
{
  const app = JSON.parse(readFileSync(join(repoRoot, "miniprogram/miniprogram/app.json"), "utf8"));
  assert.ok(app.pages.includes("pages/guide/guide"), "app.json 应注册 pages/guide/guide");

  const mapSource = readFileSync(join(repoRoot, "miniprogram/miniprogram/pages/map/map.ts"), "utf8");
  const openGuideBody = /openGuide\(\)\s*\{([\s\S]*?)\n\s*\}/.exec(mapSource);
  assert.ok(openGuideBody, "map.ts 应有 openGuide()");
  assert.match(openGuideBody[1], /wx\.navigateTo\(\{ url: "\/pages\/guide\/guide" \}\)/);
  assert.doesNotMatch(openGuideBody[1], /pages\/webview\/webview/, "openGuide 不应再跳 webview");

  // 页面源码钉住关键结构与处理器（同 miniprogram-client-alignment 的风格）
  const guideWxml = readFileSync(
    join(repoRoot, "miniprogram/miniprogram/pages/guide/guide.wxml"),
    "utf8",
  );
  const guideSource = readFileSync(
    join(repoRoot, "miniprogram/miniprogram/pages/guide/guide.ts"),
    "utf8",
  );
  const bindings = [...guideWxml.matchAll(/(?:bind|catch)[a-zA-Z-]*="([a-zA-Z_$][\w$]*)"/g)].map(
    (match) => match[1],
  );
  const missing = [...new Set(bindings)].filter(
    (name) => !new RegExp(`\\b${name}\\s*\\(`).test(guideSource),
  );
  assert.deepEqual(missing, [], `指南 WXML 事件缺少处理器：${missing.join(", ")}`);
  assert.match(guideWxml, /该指南暂未发布或已下线/);
  assert.match(guideSource, /statusCode === 404/);
}

console.log("miniprogram-guide-page: all assertions passed");
