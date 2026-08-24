// 返校指南入口条的显示判断与文案。
//
// 为什么值得单测：判断都不多，但每条都错得起 ——
//   1. 「有没有已发布的指南」判断错 → 开学了地图上没有入口，或者内容下线了入口还在；
//   2. 「用户关过哪一版」判断错 → 关不掉（每次刷新又冒出来），或者出了新版再也不提醒；
//   3. 文案取错 → 横幅上写着与指南无关的字。第 3 条真发生过：横幅曾借文档标题，
//      而文档标题是原稿封面上的「上海大学」，于是地图上挂出一条主标题毫无信息量的横幅。
// 组件本体是 DOM 与 fetch，在 node --test 里跑不动，所以判断逻辑放在
// src/lib/guideEntry.ts（无依赖的纯函数），这里直接覆盖它。

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundled = await build({
  absWorkingDir: root,
  entryPoints: ["src/lib/guideEntry.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const {
  GUIDE_SLUG,
  DEFAULT_BANNER_SUBTITLE,
  parseGuideSummary,
  dismissStamp,
  fallbackBannerTitle,
  guideAssetUrl,
  shouldShowGuideBanner,
} = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`);

/**
 * GET /api/public/guide/:slug 已发布时的响应形状。
 * `title` 是**文档**标题（原稿封面上的单位名），刻意留成「上海大学」：
 * 它必须存在（契约字段），但绝不该出现在横幅上。
 */
const published = {
  slug: "freshman-transit",
  title: "上海大学",
  edition: "2026 版 · 电子版",
  revisionId: "grev_1",
  revisionNo: 1,
  banner: null,
  content: { cards: [], hubs: [] },
};

test("后台配了横幅文案时，横幅用后台那份，不碰文档标题", () => {
  const summary = parseGuideSummary({
    ...published,
    banner: { title: "2026 版入校指南", subtitle: "副标题点击查看", icon: "banner-guide" },
  });
  assert.deepEqual(summary, {
    title: "2026 版入校指南",
    subtitle: "副标题点击查看",
    edition: "2026 版 · 电子版",
    iconAsset: "banner-guide",
    revisionNo: 1,
  });
});

test("老版本服务端不带顶层 banner 时，从整份内容里的 content.meta.banner 读", () => {
  // 客户端可能比服务端新：横幅字段还只存在内容里，不能因此退回文档标题。
  const summary = parseGuideSummary({
    ...published,
    banner: undefined,
    content: { cards: [], hubs: [], meta: { banner: { title: "内容里的标题" } } },
  });
  assert.equal(summary.title, "内容里的标题");
  assert.equal(summary.subtitle, DEFAULT_BANNER_SUBTITLE);
});

test("后台没配横幅标题时按版次派生，而不是回退到文档标题", () => {
  // 这条是「上海大学」那个 bug 的回归钉：文档标题再也不该上横幅。
  const summary = parseGuideSummary(published);
  assert.equal(summary.title, "2026 版入校指南");
  assert.notEqual(summary.title, published.title);
  assert.equal(summary.subtitle, DEFAULT_BANNER_SUBTITLE);
  assert.equal(summary.iconAsset, null);
});

test("版次派生标题只取「·」前那一段，不把「电子版」拼进标题", () => {
  assert.equal(fallbackBannerTitle("2026 版 · 电子版"), "2026 版入校指南");
  assert.equal(fallbackBannerTitle("2026 版"), "2026 版入校指南");
  // 连版次都没有时只写通名
  assert.equal(fallbackBannerTitle(null), "入校指南");
  assert.equal(fallbackBannerTitle(""), "入校指南");
  assert.equal(fallbackBannerTitle(" · 电子版"), "入校指南");
});

test("横幅字段类型不对时当作没配，走 fallback 而不是把对象渲染成字符串", () => {
  const summary = parseGuideSummary({
    ...published,
    banner: { title: 123, subtitle: "   ", icon: {} },
  });
  assert.equal(summary.title, "2026 版入校指南");
  assert.equal(summary.subtitle, DEFAULT_BANNER_SUBTITLE);
  assert.equal(summary.iconAsset, null);
});

test("未发布的指南没有摘要，因此没有入口", () => {
  // 未发布时接口 404，组件传进来的是 null
  assert.equal(parseGuideSummary(null), null);
  assert.equal(shouldShowGuideBanner(null, ""), false);
});

test("坏数据一律拒绝，而不是渲染成一条空白横幅", () => {
  assert.equal(parseGuideSummary({}), null);
  assert.equal(parseGuideSummary({ title: "只有标题" }), null);
  assert.equal(parseGuideSummary({ revisionNo: 1 }), null);
  assert.equal(parseGuideSummary({ title: "   ", revisionNo: 1 }), null);
  assert.equal(parseGuideSummary({ title: "x", revisionNo: "1" }), null);
  assert.equal(parseGuideSummary({ title: "x", revisionNo: Number.NaN }), null);
  assert.equal(parseGuideSummary("not an object"), null);
});

test("空版次串当作没有版次", () => {
  assert.equal(parseGuideSummary({ title: "指南", revisionNo: 1, edition: "" }).edition, null);
});

test("已发布的指南一直显示入口，直到用户关掉", () => {
  const guide = parseGuideSummary(published);
  assert.equal(shouldShowGuideBanner(guide, ""), true);
  assert.equal(shouldShowGuideBanner(guide, dismissStamp(guide.revisionNo)), false);
});

test("发了新版之后，之前关掉过的入口会重新出现", () => {
  // 用户关掉了第 1 版
  const stale = dismissStamp(1);
  const next = parseGuideSummary({ ...published, revisionNo: 2 });
  // 第 2 版发布后应重新出现：内容变了值得再提醒一次
  assert.equal(shouldShowGuideBanner(next, stale), true);
  // 关掉第 2 版后才再次隐藏
  assert.equal(shouldShowGuideBanner(next, dismissStamp(2)), false);
});

test("关闭标记按 slug 分命名空间，两份指南不会互相静音", () => {
  assert.equal(dismissStamp(1), `${GUIDE_SLUG}:1`);
  assert.notEqual(dismissStamp(1, "other-guide"), dismissStamp(1));
  const guide = parseGuideSummary(published);
  // 关掉别的指南不该顺带关掉这一条
  assert.equal(shouldShowGuideBanner(guide, dismissStamp(1, "other-guide")), true);
});

test("脏的关闭标记不会误伤已发布的指南", () => {
  const guide = parseGuideSummary(published);
  // localStorage 里可能留着旧格式或被别的代码写脏
  assert.equal(shouldShowGuideBanner(guide, "true"), true);
  assert.equal(shouldShowGuideBanner(guide, "freshman-transit"), true);
});

test("图标素材键转成公共读地址时会做转义", () => {
  assert.equal(guideAssetUrl("banner-guide"), "/api/public/guide-assets/banner-guide");
  assert.equal(guideAssetUrl("a b"), "/api/public/guide-assets/a%20b");
});
