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

  // lineColor / lineInk（线上夹具仍是旧稿字符串色号）
  assert.equal(guide.lineColor("l2", content), "#8cc63e");
  assert.equal(guide.lineColor("l1", content), "#e4002b");
  assert.equal(guide.lineColor(null, content), "#8f98a3", "空 key 应回 neutral");
  assert.equal(guide.lineColor("#123456", content), "#123456", "未知 key 原样透传");
  assert.equal(guide.lineInk("l2", content), "#111111", "2 号线默认黑字");
  assert.equal(guide.lineInk("l7", content), "#111111", "7 号线默认黑字");
  assert.equal(guide.lineInk("l1", content), "#ffffff", "1 号线默认白字");
  assert.equal(guide.lineColor("l2", {
    lineColors: { l2: { fill: "#82BF25", text: "#111111", label: "2号线" } },
  }), "#82BF25", "对象色库取 fill");
  assert.equal(guide.lineInk("custom", {
    lineColors: { custom: { fill: "#000000", text: "#ffee00" } },
  }), "#ffee00", "色库显式字色优先");

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
  assert.match(l1.rideLines[0].noStyle, /color: #111111/, "2 号线徽标应是黑字");
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

  // 非 route 卡：figure 完整构建（第 7 节详测），其余 kind 占位跳过
  const figure = fixture.content.cards.find((c) => c.kind === "figure");
  assert.equal(guide.buildCardView(figure, content).kind, "figure");
}

// ---------------------------------------------------------------------------
// 5. 图标注册表：asset 优先 / 内联 png|uri 回落 / svg-only 与缺省映射按无图标
//
// asset 是图标位图迁进素材库后的现行写法（内容里只留 icon-<id> 键，位图在 R2）。
// png / uri 是迁移前的内联 data URI —— 线上仍有旧修订，回落分支必须留着。
// ---------------------------------------------------------------------------
{
  // 夹具图标只有 svg（小程序用不了）→ 线路图标一律 null，不造出厂种子
  assert.equal(guide.lineIcon(content, { kind: "metro" }), null);
  const raw = fixture.content.cards.find((c) => c.id === "hq-bs-metro-a");
  const view = guide.buildCardView(raw, content);
  assert.equal(view.legs[1].rideLines[0].icon, null, "svg-only 图标应渲染为无图标");

  const withIcons = {
    ...content,
    icons: [
      { id: "metro-sh", name: "上海地铁", asset: "icon-metro-sh", ratio: 1.5 },
      { id: "rail-sh", name: "市域铁路", uri: "data:image/gif;base64,BBB" },
      { id: "custom", name: "自定义", png: "data:image/png;base64,CCC", ratio: 0.8 },
      { id: "svg-only", name: "矢量", svg: "<svg/>" },
      /* 迁移期的中间态：asset 已补上、内联还没清掉。素材键必须赢，
         否则搬完了前台仍在下发 base64。 */
      { id: "both", name: "都有", asset: "icon-both", uri: "data:image/png;base64,DDD" },
    ],
  };
  // asset → 素材端点（图标素材本身就是 PNG，不套 figure 那套 -png 派生）
  const metroIcon = guide.lineIcon(withIcons, { kind: "metro" });
  assert.match(metroIcon.src, /\/api\/public\/guide-assets\/icon-metro-sh$/);
  assert.doesNotMatch(metroIcon.src, /-png$/, "图标素材再拼 -png 会 404");
  assert.equal(metroIcon.ratio, 1.5);
  // 内联 uri / png 回落（迁移前的旧修订）
  assert.equal(guide.lineIcon(withIcons, { kind: "rail" }).src, "data:image/gif;base64,BBB");
  assert.equal(
    guide.lineIcon(withIcons, { kind: "metro", icon: "custom" }).src,
    "data:image/png;base64,CCC",
    "ln.icon 指定优先于 KIND_ICON 映射",
  );
  // asset 与内联并存时素材键赢
  assert.match(
    guide.lineIcon(withIcons, { kind: "metro", icon: "both" }).src,
    /\/api\/public\/guide-assets\/icon-both$/,
  );
  // bus 无默认图标；svg-only 视为无图标；未知 id 为 null
  assert.equal(guide.lineIcon(withIcons, { kind: "bus" }), null);
  assert.equal(guide.lineIcon(withIcons, { kind: "metro", icon: "svg-only" }), null);
  assert.equal(guide.lineIcon(withIcons, { kind: "metro", icon: "missing" }), null);

  // buildCardView rideLines.icon 宽度 = round(30 × ratio)
  const iconCardView = guide.buildCardView(raw, withIcons);
  assert.equal(iconCardView.legs[1].rideLines[0].icon.width, 45);
  assert.match(
    iconCardView.legs[1].rideLines[0].icon.src,
    /\/api\/public\/guide-assets\/icon-metro-sh$/,
  );
}

// ---------------------------------------------------------------------------
// 6. figure 图示卡：-png 键规则 + 热区透传与链接分类
// ---------------------------------------------------------------------------
{
  // guideAssetImage：assetKey → -png 优先、原键回落；http/data: 透传；"/" 拼 base
  const img = guide.guideAssetImage("route-hongqiao-jiading");
  assert.match(img.src, /\/api\/public\/guide-assets\/route-hongqiao-jiading-png$/);
  assert.match(img.fallbackSrc, /\/api\/public\/guide-assets\/route-hongqiao-jiading$/);
  assert.equal(img.src, `${img.fallbackSrc}-png`);
  assert.deepEqual(guide.guideAssetImage("https://a.b/c.png"), {
    src: "https://a.b/c.png",
    fallbackSrc: "https://a.b/c.png",
  });
  assert.match(guide.guideAssetImage("/x/y.svg").src, /\/x\/y\.svg$/);

  const figCard = fixture.content.cards.find((c) => c.id === "hq-jd-fig-route");
  const figView = guide.buildCardView(figCard, content);
  assert.equal(figView.kind, "figure");
  assert.equal(figView.title, "示意图");
  assert.ok(figView.caption.length > 0);
  assert.match(figView.src, /guide-assets\/route-hongqiao-jiading-png$/);
  assert.ok(figView.hotspots.length >= 5);

  // 热区坐标：x/y 直接百分比；w/h 按 HOT_REF=728 换算（78/728 → 10.714%）
  const first = figView.hotspots.find((h) => h.id === "h-jdb");
  assert.match(first.style, /left: 29%; top: 13%;/);
  assert.match(first.style, /width: 10\.714%;/);
  assert.equal(first.title, "嘉定北站");
  assert.ok(first.body.length > 0);
  // 链接分类：#shumap / https / #card / #wechat
  assert.equal(first.links[0].kind, "shumap");
  assert.equal(first.links[1].kind, "external");
  const nm = figView.hotspots.find((h) => h.id === "h-nmgj");
  assert.deepEqual(
    { kind: nm.links[0].kind, cardId: nm.links[0].cardId },
    { kind: "card", cardId: "hq-jd-bus-west" },
  );
  const hubFig = guide.buildCardView(
    fixture.content.cards.find((c) => c.id === "hq-jd-fig-hub"),
    content,
  );
  const wechatHot = hubFig.hotspots.find((h) => h.id === "h-bus1");
  assert.equal(wechatHot.links[0].kind, "wechat");
}

// ---------------------------------------------------------------------------
// 7. sceneGuide 实景指引：校区过滤 / pending / 图文混排标记 / 占位
// ---------------------------------------------------------------------------
{
  // 夹具：虹桥枢纽 2 个小节（无 campuses 声明 → 通用）
  const hongqiao = guide.hubById(content, "hongqiao");
  const sgView = guide.buildSceneGuideView(hongqiao, "baoshan");
  assert.equal(sgView.placeholder, "");
  assert.equal(sgView.sections.length, 2);
  assert.equal(sgView.sections[0].accent, "#d6417f");
  assert.equal(sgView.sections[0].numbered, true, "非 bare 应显示序号");
  assert.equal(sgView.sections[0].grid, false, "无配图不切网格");
  assert.equal(sgView.sections[0].steps.length, 4);
  assert.equal(sgView.pending, null);

  // 枢纽什么内容都没有 → 占位文案（对齐网页版「实况指引待补充」）
  const appendix = guide.hubById(content, "appendix");
  assert.equal(guide.buildSceneGuideView(appendix, "baoshan").placeholder, "实况指引待补充");

  // 构造：校区过滤 + 全部不适用返回 null + pending + bare/网格 + 配图 -png 键
  const constructedHub = {
    id: "t",
    name: "测试枢纽",
    sceneGuide: {
      intro: "先读我",
      sections: [
        { title: "嘉定专用", campuses: ["jiading"], steps: [{ text: "A" }] },
        { title: "通用 bare", bare: true, steps: [{ text: "B", note: "注" }] },
        {
          title: "带图小节",
          campuses: ["jiading"],
          steps: [{ text: "C", figure: ["photo-1", "photo-2"] }],
          figures: [{ src: "sec-photo", caption: "指示牌" }],
        },
      ],
      pending: { label: "待补充", detail: "原稿还没录" },
    },
  };
  const forJiading = guide.buildSceneGuideView(constructedHub, "jiading");
  assert.equal(forJiading.intro, "先读我");
  assert.deepEqual(forJiading.sections.map((s) => s.title), ["嘉定专用", "通用 bare", "带图小节"]);
  assert.equal(forJiading.sections[1].numbered, false, "bare 无图不显示序号");
  assert.deepEqual(forJiading.pending, { label: "待补充", detail: "原稿还没录" });
  const gridSec = forJiading.sections[2];
  assert.equal(gridSec.grid, true, "有步骤配图应切双列网格");
  assert.equal(gridSec.numbered, true, "有图时 bare 也显示序号");
  assert.equal(gridSec.steps[0].figures.length, 2);
  assert.match(gridSec.steps[0].figures[0].src, /guide-assets\/photo-1-png$/);
  assert.equal(gridSec.figures[0].caption, "指示牌");
  assert.match(gridSec.figures[0].src, /guide-assets\/sec-photo-png$/);

  // 校区过滤：宝山只剩通用小节
  const forBaoshan = guide.buildSceneGuideView(constructedHub, "baoshan");
  assert.deepEqual(forBaoshan.sections.map((s) => s.title), ["通用 bare"]);

  // 有内容但都不适用当前方向 → null（整块不显示，对齐 renderHubVideo）
  const jiadingOnly = {
    id: "t2",
    name: "测试枢纽2",
    sceneGuide: { sections: [{ title: "嘉定专用", campuses: ["jiading"], steps: [{ text: "A" }] }] },
  };
  assert.equal(guide.buildSceneGuideView(jiadingOnly, "baoshan"), null);
  assert.ok(guide.buildSceneGuideView(jiadingOnly, "jiading") !== null);
}

// ---------------------------------------------------------------------------
// 8. 枢纽级区块：guideFigures / guideVideos / remark 预处理
// ---------------------------------------------------------------------------
{
  // hubFigures：数组优先；数组缺失/全空时旧单图字段 guideFigure 兜底
  assert.equal(guide.hubFigures(null).length, 0);
  assert.deepEqual(guide.hubFigures({ id: "h", guideFigure: "old-single" }), [
    { src: "old-single" },
  ]);
  assert.deepEqual(
    guide.hubFigures({ id: "h", guideFigure: "old-single", guideFigures: [] }),
    [{ src: "old-single" }],
    "空数组应回落单图字段",
  );
  assert.deepEqual(
    guide.hubFigures({ id: "h", guideFigure: "old-single", guideFigures: [{ src: "new-1" }] }).map((f) => f.src),
    ["new-1"],
    "有数组时不用单图字段",
  );

  // buildHubGuideView：校区过滤；都不适用 → null；无图 → 占位；-png 键
  const guideHub = {
    id: "h",
    name: "测试枢纽",
    guideFigures: [
      { src: "hub-map-a", caption: "全向图" },
      { src: "hub-map-jd", campuses: ["jiading"] },
    ],
  };
  const bsGuide = guide.buildHubGuideView(guideHub, "baoshan");
  assert.equal(bsGuide.placeholder, "");
  assert.deepEqual(bsGuide.figures.map((f) => f.caption), ["全向图"]);
  assert.match(bsGuide.figures[0].src, /guide-assets\/hub-map-a-png$/);
  assert.equal(bsGuide.figures[0].fallbackSrc.endsWith("/hub-map-a"), true);
  assert.equal(guide.buildHubGuideView(guideHub, "jiading").figures.length, 2);
  const jdOnly = { id: "h", guideFigures: [{ src: "x", campuses: ["jiading"] }] };
  assert.equal(guide.buildHubGuideView(jdOnly, "baoshan"), null, "有图但都不适用应隐藏整块");
  assert.equal(
    guide.buildHubGuideView({ id: "h" }, "baoshan").placeholder,
    "枢纽指引图待上传",
  );

  // hubVideos / buildHubVideosView：数组优先、旧单条兜底、校区过滤、默认不播放
  assert.equal(guide.hubVideos(null).length, 0);
  assert.equal(guide.hubVideos({ id: "h", guideVideo: { url: "https://v.example/old.mp4" } })[0].url, "https://v.example/old.mp4");
  const videoHub = {
    id: "h",
    guideVideos: [
      { url: "https://v.example/a.mp4", note: "3 分钟" },
      { url: "https://v.example/jd.mp4", campuses: ["jiading"] },
    ],
  };
  const bsVideos = guide.buildHubVideosView(videoHub, "baoshan");
  assert.equal(bsVideos.length, 1);
  assert.deepEqual(bsVideos[0], {
    url: "https://v.example/a.mp4",
    note: "3 分钟",
    poster: "",
    playing: false,
  });
  assert.equal(guide.buildHubVideosView(videoHub, "jiading").length, 2);
  assert.equal(guide.buildHubVideosView({ id: "h" }, "baoshan").length, 0);

  // preprocessRemarkHtml：空 → ""；img 站内路径补 base；<a> 剥壳留文本
  assert.equal(guide.preprocessRemarkHtml(""), "");
  assert.equal(guide.preprocessRemarkHtml(null), "");
  assert.equal(guide.preprocessRemarkHtml("   "), "");
  const remarked = guide.preprocessRemarkHtml(
    '<p>看<b>这里</b>，<a href="https://example.com">链接文字</a>。' +
      '<img src="/api/public/guide-assets/remark-photo" alt="照片">' +
      "<img src='https://cdn.example/x.png'>" +
      '<img src="data:image/png;base64,AAA"></p>',
  );
  assert.match(remarked, /<b>这里<\/b>/, "白名单标签应保留");
  assert.ok(!/<\/?a\b/.test(remarked), "<a> 应剥壳");
  assert.match(remarked, /链接文字/, "链接文字应保留");
  assert.match(remarked, /src="https:\/\/[^"]*\/api\/public\/guide-assets\/remark-photo"/, "站内 img 应补全 base");
  assert.match(remarked, /src='https:\/\/cdn\.example\/x\.png'/, "外链 img 不动");
  assert.match(remarked, /src="data:image\/png;base64,AAA"/, "data URI 不动");

  // 夹具枢纽：hongqiao 无 guideFigures → 占位；remark 有内容时应能预处理（当前 fixture remark="测试"）
  const hongqiaoHub = guide.hubById(content, "hongqiao");
  assert.equal(guide.buildHubGuideView(hongqiaoHub, "baoshan").placeholder, "枢纽指引图待上传");
  assert.equal(guide.preprocessRemarkHtml(hongqiaoHub.remark), "测试");
}

// ---------------------------------------------------------------------------
// 9. 源码断言：app.json 注册 + openGuide 改跳原生页（webview 保留给预约乘车）
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
  assert.match(guideWxml, /binderror="onFigureImageError"/, "figure 图应有 -png 回落");
  assert.match(guideWxml, /实况指引/, "应渲染 sceneGuide 区块");
  assert.match(guideWxml, /pop-mask/, "应有热点说明弹层");
  assert.match(guideWxml, /枢纽指引/, "应渲染 guideFigures 区块");
  assert.match(guideWxml, /rich-text/, "备注应用 rich-text 渲染");
  assert.match(guideSource, /preprocessRemarkHtml/);
  assert.match(guideWxml, /bindtap="previewGuideImage"/, "枢纽简图/实景照应能点开大图");
  assert.match(guideWxml, /class="img-viewer"/, "应有全屏看图层");
  assert.match(guideSource, /onViewerTouchStart/, "看图层应接 JS 触摸手势");
  assert.match(guideSource, /toggleViewerScale/, "单击应切换放大/还原");

  // 白底不能只在纯函数里判对，还得真接到视图上：wxml 绑 class、wxss 定义背景、
  // 页面把 viewerNeedsPaper 的结果写进 imageViewer.paper。少任何一环，
  // SVG 简图叠在深色遮罩上就是镂空的。
  const guideWxss = readFileSync(
    join(repoRoot, "miniprogram/miniprogram/pages/guide/guide.wxss"),
    "utf8",
  );
  assert.match(guideWxml, /imageViewer\.paper \? 'img-viewer-img-paper'/, "看图层应按需挂白底 class");
  assert.match(
    guideWxss,
    /\.img-viewer-img-paper\s*\{[^}]*background-color:\s*#ffffff/i,
    "img-viewer-img-paper 必须定义白色背景",
  );
  assert.match(guideSource, /"imageViewer\.paper": viewerNeedsPaper\(/, "白底应由 viewerNeedsPaper 判定");
}

// ---------------------------------------------------------------------------
// 10. 看图列表：figure / 枢纽简图 / 实景配图，裂图不进
// ---------------------------------------------------------------------------
{
  const items = guide.collectGuidePreviewImages({
    cards: [
      { kind: "route", id: "r1" },
      {
        kind: "figure",
        id: "f1",
        src: "https://map.shutf.com/api/public/guide-assets/hub-png",
        fallbackSrc: "https://map.shutf.com/api/public/guide-assets/hub",
      },
      {
        kind: "figure",
        id: "f2",
        src: "https://map.shutf.com/broken",
        fallbackSrc: "https://map.shutf.com/broken",
        imgFailed: true,
      },
    ],
    hubGuide: {
      placeholder: "",
      figures: [{ src: "https://map.shutf.com/hub.jpg", fallbackSrc: "https://map.shutf.com/hub.jpg", caption: "" }],
    },
    sceneGuide: {
      intro: "",
      placeholder: "",
      pending: null,
      sections: [
        {
          title: "出站",
          accent: "",
          numbered: true,
          grid: true,
          figures: [{ src: "https://map.shutf.com/sec.jpg", fallbackSrc: "https://map.shutf.com/sec.jpg", caption: "" }],
          steps: [
            {
              text: "走西南",
              note: "",
              figures: [{ src: "https://map.shutf.com/step.jpg", fallbackSrc: "https://map.shutf.com/step.jpg" }],
            },
          ],
        },
      ],
    },
  });
  assert.deepEqual(
    items.map((item) => item.src),
    [
      "https://map.shutf.com/api/public/guide-assets/hub-png",
      "https://map.shutf.com/hub.jpg",
      "https://map.shutf.com/sec.jpg",
      "https://map.shutf.com/step.jpg",
    ],
  );
}

console.log("miniprogram-guide-page: all assertions passed");
