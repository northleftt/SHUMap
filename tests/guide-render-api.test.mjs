// 返校指南共用渲染层（guide-render.js / guide-styles.js）的对外契约。
//
// 为什么钉这个：渲染层是前台展示页与可视化编辑器共读的库，viewer / editor
// 由后续的重写直接对着 window.GuideRender 的 API 写 —— 这里钉住三件事：
//   1. 两个文件语法可解析、求值后暴露约定的 API 键与 window.GUIDE_CSS；
//   2. sanitizeRichHtml 的白名单消毒：node 里没有 DOMParser，走的是
//      正则兜底分支，必须剥掉 script / onclick / javascript: href /
//      非白名单标签，保住合法链接与 guide-assets 图片；
//   3. normalizeData 把 v1（cover/groups、卡片挂 group、hub 为对象）
//      就地升级成 v2，保护线上 D1 里可能残留的旧版已发布修订。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const renderFile = path.join(root, "public", "guide", "assets", "guide-render.js");
const stylesFile = path.join(root, "public", "guide", "assets", "guide-styles.js");
const iconsFile = path.join(root, "public", "guide", "data", "guide-icons.js");

/** 够模块初始化用的最小 window/document 桩（渲染层不操作真实 DOM）。 */
function makeSandbox() {
  const noop = () => {};
  const documentStub = {
    addEventListener: noop,
    getElementById: () => null,
    createElement: () => ({}),
    head: { appendChild: noop },
  };
  return { window: { addEventListener: noop }, document: documentStub };
}

function loadRender() {
  const sandbox = makeSandbox();
  vm.runInNewContext(fs.readFileSync(iconsFile, "utf8"), sandbox, { filename: iconsFile });
  vm.runInNewContext(fs.readFileSync(renderFile, "utf8"), sandbox, { filename: renderFile });
  return sandbox;
}

test("guide-render.js exposes the documented window.GuideRender API", () => {
  const GR = loadRender().window.GuideRender;
  assert.ok(GR, "guide-render.js 应求值出 window.GuideRender");
  for (const key of [
    "normalizeData", "hubFigures", "hubVideos", "appliesTo", "allIcons", "iconById", "renderIcon", "sanitizeRichHtml",
    "renderCard", "renderRouteCard", "renderFigureCard", "renderStepsCard",
    "renderHubGuide", "renderHubVideo", "renderRemark", "renderPairView",
    "buildPrintRoot", "lineColor", "lineInk", "lineSwatch", "lineBadgeStyle",
    "normalizeLineColors", "autoLineInk", "esc", "h",
    "openImageViewer", "closeImageViewer",
  ]) {
    assert.equal(typeof GR[key], "function", `GuideRender.${key} 缺失`);
  }
});

test("guide-styles.js exports window.GUIDE_CSS with the v2 class vocabulary", () => {
  const sandbox = makeSandbox();
  vm.runInNewContext(fs.readFileSync(stylesFile, "utf8"), sandbox, { filename: stylesFile });
  const css = sandbox.window.GUIDE_CSS;
  assert.equal(typeof css, "string", "guide-styles.js 应导出 window.GUIDE_CSS 字符串");
  for (const cls of [".gc-card", ".gc-grid", ".gc-dest-chip", ".gc-mode-badge", ".gc-meta-chip",
    ".gc-flag", ".gc-sched", ".gc-note", ".gc-hub-sec", ".gc-placeholder", ".gc-remark",
    ".gc-camptag", ".gc-hubfigs",
    ".gc-hot", ".gc-pop", ".gc-print-root", "#gc-screen", "@media print", "@page",
    ".gc-lightbox", ".gc-zoomable"]) {
    assert.ok(css.includes(cls), `CSS 缺少 ${cls}`);
  }
  assert.ok(css.includes("background:#fff") || css.includes("background: #fff"),
    "灯箱里的 SVG 必须垫白底，不能透出深色遮罩");
  for (const retired of [".gc-cover", ".gc-pick", ".gc-toc", ".gc-acts", ".gc-act", "存图"]) {
    assert.ok(!css.includes(retired), `CSS 不应再含已删除的 ${retired}`);
  }
});

test("sanitizeRichHtml strips scripts, handlers and non-whitelisted tags (fallback path)", () => {
  const { sanitizeRichHtml } = loadRender().window.GuideRender;
  // node 无 DOMParser —— 这里测的正是正则兜底分支
  assert.ok(typeof DOMParser === "undefined", "本测试应在无 DOMParser 环境运行");

  const dirty =
    '<p onclick="x()">允许<b>加粗</b><script>alert(1)</script></p>' +
    '<div class="c"><span style="color:red">字</span></div>' +
    '<a href="javascript:alert(1)">坏链</a>' +
    '<a href="https://example.com/?a=1&b=2" class="x">好链</a>' +
    '<a href="#card:abc">内链</a>' +
    '<img src="/api/public/guide-assets/route-hq" alt="图" onerror="x()">' +
    '<img src="https://evil.example/x.png">' +
    '<iframe src="https://evil.example"></iframe>';
  const out = sanitizeRichHtml(dirty);

  assert.ok(!/<script/i.test(out), "script 标签应被删除");
  assert.ok(!/alert\(1\)/.test(out), "script 内容不应残留");
  assert.ok(!/on(click|error)\s*=/i.test(out), "on* 属性应被剥掉");
  assert.ok(!/javascript:/i.test(out), "javascript: href 应被剥掉");
  assert.ok(!/<(div|iframe|style)/i.test(out), "非白名单标签应被剥壳");
  assert.ok(!/\s(style|class)=/i.test(out), "style/class 属性不应保留");
  assert.ok(/<b>加粗<\/b>/.test(out), "白名单标签应保留");
  assert.ok(/<span>字<\/span>/.test(out), "span 剥属性后保留");
  assert.ok(/<a>坏链<\/a>/.test(out), "非法 href 的 a 剥成无属性");
  assert.ok(/<a href="https:\/\/example\.com\/\?a=1&amp;b=2" target="_blank" rel="noopener">好链<\/a>/.test(out),
    "合法外链应保留 href 并补 target/rel");
  assert.ok(/<a href="#card:abc">内链<\/a>/.test(out), "# 内链应保留");
  assert.ok(/<img src="\/api\/public\/guide-assets\/route-hq" alt="图">/.test(out),
    "guide-assets 图片应保留 src/alt");
  assert.ok(/<img src="" alt="">/.test(out), "外部图片 src 应被清空");
});

test("normalizeData passes v2 through untouched", () => {
  const { normalizeData } = loadRender().window.GuideRender;
  const v2 = { schema: 2, meta: { title: "t" }, hubs: [], cards: [] };
  assert.equal(normalizeData(v2), v2, "v2 数据应原样返回");
});

test("normalizeData upgrades v1 cover/groups data to the v2 shape", () => {
  const { normalizeData } = loadRender().window.GuideRender;
  const v1 = {
    meta: { title: "上海大学", subtitle: "新生入校交通指南", footnote: "x" },
    lineColors: { l2: "#8cc63e" },
    campuses: [{ id: "baoshan", label: "宝山校区", short: "宝山" }],
    cover: {
      hubs: [
        { id: "hongqiao", name: "虹桥枢纽", note: "（…）", color: "#3aa17e", entries: [], tail: "t" },
        { id: "pudong", name: "浦东机场", note: null, color: "#3f6ea8", entries: [] },
      ],
    },
    groups: [{ id: "hq-bs", hub: "hongqiao", campus: "baoshan", title: "虹桥 → 宝山" }],
    cards: [
      {
        id: "hq-bs-metro", kind: "route", group: "hq-bs", page: 2,
        hub: { name: "虹桥枢纽", note: "（…）" },
        toward: "去往 宝山校区", mode: "metro", legs: [],
      },
      { id: "hq-fig", kind: "figure", group: "hq-bs", figure: "route-hq", title: "示意图" },
    ],
  };
  const d = normalizeData(v1);

  assert.equal(d.schema, 2);
  assert.ok(!("cover" in d) && !("groups" in d));
  assert.equal(d.hubs.length, 2);
  assert.deepEqual(
    // 渲染层在 vm 里求值，数组原型与本域不同，JSON 过一遍再比
    JSON.parse(JSON.stringify(d.hubs.map((h) => [h.id, h.order, h.guideFigures, h.guideVideos, h.remark]))),
    [["hongqiao", 1, [], [], ""], ["pudong", 2, [], [], ""]],
    "cover.hubs 应按顺序提升为顶层 hubs 并补空媒体/备注字段",
  );
  const route = d.cards[0];
  assert.equal(route.hub, "hongqiao", "card.group 应经 groups 反查出 hub id");
  assert.equal(route.campus, "baoshan");
  assert.deepEqual(route.origin, { name: "虹桥枢纽", note: "（…）" }, "hub 对象应改名 origin");
  assert.ok(!("group" in route) && !("page" in route), "group/page 不应残留");
  assert.equal(d.cards[1].hub, "hongqiao", "没有 hub 对象的图示卡也要挂回组合");
  assert.equal(typeof d.meta.edition, "string", "v2 meta 字段应补齐");
});

test("normalizeData lifts steps cards into hub.sceneGuide (intermediate v2 drafts)", () => {
  const { normalizeData } = loadRender().window.GuideRender;
  // sceneGuide 改造前保存的草稿：schema 已是 2，但实景指引还是独立 steps 卡
  const draft = {
    schema: 2,
    meta: { title: "t" },
    campuses: [
      { id: "baoshan", label: "宝山校区", short: "宝山" },
      { id: "scene", label: "实景指引", short: "实景" },
    ],
    hubs: [
      { id: "hongqiao", name: "虹桥枢纽", color: "#3aa17e", order: 1, guideFigure: null, guideVideo: null, remark: "" },
    ],
    cards: [
      { id: "hq-bs-metro", kind: "route", hub: "hongqiao", campus: "baoshan", legs: [] },
      {
        id: "hq-scene", kind: "steps", hub: "hongqiao", campus: "scene",
        sections: [{ title: "第一节", steps: [{ text: "第一步" }] }],
        pending: { label: "待录入", detail: "d" },
      },
    ],
  };
  const d = normalizeData(draft);

  assert.notEqual(d, draft, "中间形态应产出新对象");
  assert.equal(d.cards.length, 1, "steps 卡应从 cards 摘除");
  assert.equal(d.cards[0].id, "hq-bs-metro");
  const hub = d.hubs[0];
  assert.equal(hub.sceneGuide.sections.length, 1, "steps 小节应迁入 sceneGuide");
  assert.equal(hub.sceneGuide.sections[0].title, "第一节");
  assert.deepEqual(hub.sceneGuide.pending, { label: "待录入", detail: "d" }, "pending 应跟着迁");
  assert.ok(!d.campuses.some((c) => c.id === "scene"), "失去卡片的 scene 校区应移除");
  assert.equal(draft.cards.length, 2, "输入对象不应被改动");
  assert.equal(draft.hubs[0].sceneGuide, undefined, "输入的 hub 不应被改动");

  // 已是当前形态（无 steps 卡）的 v2 仍原样返回
  const current = { schema: 2, hubs: [{ id: "h", sceneGuide: { sections: [] } }], cards: [] };
  assert.equal(normalizeData(current), current);
});

test("hubFigures/appliesTo: 指引图按校区过滤，旧 guideFigure 字段兼容", () => {
  const { hubFigures, appliesTo } = loadRender().window.GuideRender;
  const plain = (v) => JSON.parse(JSON.stringify(v));   // vm 域数组摊平成本域再比
  // 旧草稿的单图字段升级读取
  assert.deepEqual(plain(hubFigures({ guideFigure: "guidefig-hq" })), [{ src: "guidefig-hq" }]);
  // 新数组字段优先，空项被滤掉
  assert.deepEqual(
    plain(hubFigures({ guideFigures: [{ src: "a" }, null, { src: "b", campuses: ["jiading"] }], guideFigure: "legacy" })),
    [{ src: "a" }, { src: "b", campuses: ["jiading"] }],
  );
  assert.deepEqual(hubFigures({}).length, 0);

  // 视频入口同一套逻辑：新数组 / 旧单条字段兼容，无 url 的条目不显示
  const { hubVideos } = loadRender().window.GuideRender;
  assert.deepEqual(plain(hubVideos({ guideVideo: { url: "u1", note: "n" } })), [{ url: "u1", note: "n" }]);
  assert.deepEqual(
    plain(hubVideos({ guideVideos: [{ url: "" }, { url: "u2", campuses: ["jiading"] }] })),
    [{ url: "u2", campuses: ["jiading"] }],
  );
  assert.equal(hubVideos({ guideVideo: { poster: "p" } }).length, 0, "旧字段没有 url 视为无视频");

  // 未声明 campuses = 通用；声明了的只在对应方向显示；campusId 为 null 时不过滤
  assert.equal(appliesTo({}, "jiading"), true);
  assert.equal(appliesTo({ campuses: [] }, "baoshan"), true);
  assert.equal(appliesTo({ campuses: ["jiading"] }, "jiading"), true);
  assert.equal(appliesTo({ campuses: ["jiading"] }, "baoshan"), false);
  assert.equal(appliesTo({ campuses: ["jiading"] }, null), true);
});

test("icon registry: data.icons override the factory seed by id", () => {
  const GR = loadRender().window.GuideRender;
  const seed = GR.allIcons({});
  assert.equal(seed.length, 3, "出厂种子有 3 个图标");
  const own = [{ id: "metro-sh", name: "自定义地铁", svg: "<svg/>" }, { id: "mine", name: "我的", uri: "data:image/png;base64,x" }];
  const merged = GR.allIcons({ icons: own });
  assert.equal(merged.length, 4, "用户图标应扩展注册表");
  assert.equal(GR.iconById({ icons: own }, "metro-sh").name, "自定义地铁", "同 id 时用户的覆盖出厂的");
  assert.equal(GR.iconById({}, "metro-sh").name, "上海地铁", "缺失时回落出厂种子");
  assert.equal(GR.iconById({}, "nope"), null);
});

test("line color library: string entries, object entries, and default ink", () => {
  const GR = loadRender().window.GuideRender;
  const legacy = { lineColors: { l2: "#8cc63e", l1: "#e4002b", l7: "#f3901d", neutral: "#8f98a3" } };
  assert.equal(GR.lineColor("l2", legacy), "#8cc63e", "旧稿字符串应直接当底色");
  assert.equal(GR.lineInk("l2", legacy), "#111111", "2 号线默认黑字");
  assert.equal(GR.lineInk("l7", legacy), "#111111", "7 号线默认黑字");
  assert.equal(GR.lineInk("l1", legacy), "#ffffff", "1 号线默认白字");
  assert.equal(GR.lineColor(null, legacy), "#8f98a3");
  assert.equal(GR.lineColor("#123456", legacy), "#123456", "未知 key 原样透传");

  const lib = {
    lineColors: {
      l2: { fill: "#82BF25", text: "#111111", label: "2号线" },
      custom: { fill: "#000000", text: "#ffee00", label: "自定义" },
    },
  };
  assert.equal(GR.lineColor("l2", lib), "#82BF25");
  assert.equal(GR.lineInk("l2", lib), "#111111");
  assert.equal(GR.lineSwatch("custom", lib).label, "自定义");
  assert.equal(GR.lineInk("custom", lib), "#ffee00", "色库显式字色优先于默认");
  assert.match(GR.lineBadgeStyle("l2", lib), /--c:#82BF25/);
  assert.match(GR.lineBadgeStyle("l2", lib), /color:#111111/);

  const upgraded = { schema: 2, hubs: [], cards: [], lineColors: { l2: "#8cc63e" } };
  GR.normalizeData(upgraded);
  assert.equal(typeof upgraded.lineColors.l2, "object");
  assert.equal(upgraded.lineColors.l2.fill, "#8cc63e");
  assert.equal(upgraded.lineColors.l2.text, "#111111");
  assert.equal(upgraded.lineColors.l2.label, "2号线");

  assert.equal(GR.autoLineInk("#FCD600"), "#111111", "亮黄应自动黑字");
  assert.equal(GR.autoLineInk("#E3002B"), "#ffffff", "深红应自动白字");
  assert.ok(Array.isArray(GR.LINE_COLOR_PRESETS) && GR.LINE_COLOR_PRESETS.length >= 10);
});
