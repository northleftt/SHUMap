// 返校指南入口条的显示判断。
//
// 为什么值得单测：只有两条判断，但两条都错得起 ——
//   1. 「有没有已发布的指南」判断错 → 开学了地图上没有入口，或者内容下线了入口还在；
//   2. 「用户关过哪一版」判断错 → 关不掉（每次刷新又冒出来），或者出了新版再也不提醒。
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
  parseGuideSummary,
  dismissStamp,
  shouldShowGuideBanner,
  guideSubtitle,
} = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`);

/** GET /api/public/guide/:slug 已发布时的响应形状。 */
const published = {
  slug: "freshman-transit",
  title: "新生入校交通指南",
  edition: "2025 版 · 电子版",
  revisionId: "grev_1",
  revisionNo: 1,
  content: { cards: [], cover: {} },
};

test("a published guide is parsed into a summary", () => {
  assert.deepEqual(parseGuideSummary(published), {
    title: "新生入校交通指南",
    edition: "2025 版 · 电子版",
    revisionNo: 1,
  });
});

test("an unpublished guide yields no summary and therefore no entry", () => {
  // 未发布时接口 404，组件传进来的是 null
  assert.equal(parseGuideSummary(null), null);
  assert.equal(shouldShowGuideBanner(null, ""), false);
});

test("a malformed payload is refused rather than rendered as an empty banner", () => {
  assert.equal(parseGuideSummary({}), null);
  assert.equal(parseGuideSummary({ title: "只有标题" }), null);
  assert.equal(parseGuideSummary({ revisionNo: 1 }), null);
  assert.equal(parseGuideSummary({ title: "   ", revisionNo: 1 }), null);
  assert.equal(parseGuideSummary({ title: "x", revisionNo: "1" }), null);
  assert.equal(parseGuideSummary({ title: "x", revisionNo: Number.NaN }), null);
  assert.equal(parseGuideSummary("not an object"), null);
});

test("a missing edition degrades to a bare subtitle instead of printing null", () => {
  const summary = parseGuideSummary({ title: "指南", revisionNo: 2 });
  assert.deepEqual(summary, { title: "指南", edition: null, revisionNo: 2 });
  assert.equal(guideSubtitle(summary), "查看到校路线");
  assert.equal(
    guideSubtitle({ title: "指南", edition: "2026 版", revisionNo: 2 }),
    "2026 版 · 查看到校路线",
  );
});

test("an empty edition string is treated as absent", () => {
  assert.equal(parseGuideSummary({ title: "指南", revisionNo: 1, edition: "" }).edition, null);
});

test("a published guide shows the entry until it is dismissed", () => {
  const guide = parseGuideSummary(published);
  assert.equal(shouldShowGuideBanner(guide, ""), true);
  assert.equal(shouldShowGuideBanner(guide, dismissStamp(guide.revisionNo)), false);
});

test("publishing a new revision brings the entry back after an earlier dismissal", () => {
  // 用户关掉了第 1 版
  const stale = dismissStamp(1);
  const next = parseGuideSummary({ ...published, revisionNo: 2 });
  // 第 2 版发布后应重新出现：内容变了值得再提醒一次
  assert.equal(shouldShowGuideBanner(next, stale), true);
  // 关掉第 2 版后才再次隐藏
  assert.equal(shouldShowGuideBanner(next, dismissStamp(2)), false);
});

test("the dismissal stamp is namespaced by slug so two guides do not silence each other", () => {
  assert.equal(dismissStamp(1), `${GUIDE_SLUG}:1`);
  assert.notEqual(dismissStamp(1, "other-guide"), dismissStamp(1));
  const guide = parseGuideSummary(published);
  // 关掉别的指南不该顺带关掉这一条
  assert.equal(shouldShowGuideBanner(guide, dismissStamp(1, "other-guide")), true);
});

test("a stray dismissal value does not hide a published guide", () => {
  const guide = parseGuideSummary(published);
  // localStorage 里可能留着旧格式或被别的代码写脏
  assert.equal(shouldShowGuideBanner(guide, "true"), true);
  assert.equal(shouldShowGuideBanner(guide, "freshman-transit"), true);
});
