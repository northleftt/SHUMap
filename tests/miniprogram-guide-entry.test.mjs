// 小程序端返校指南入口条的显示判断与文案（对齐 tests/guide-banner-entry.test.mjs）。
//
// 重点同 Web 端：横幅文案来自内容里的 meta.banner，不再借文档标题——
// 借标题的那一版在地图上挂出过「上海大学 / 2026 版 · 查看到校路线」。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "tmp/guide-test/guide-entry.cjs");
mkdirSync(dirname(out), { recursive: true });
execFileSync(join(root, "node_modules/.bin/esbuild"), [
  join(root, "miniprogram/miniprogram/lib/guide-entry.ts"),
  "--bundle", "--platform=node", "--format=cjs", `--outfile=${out}`,
]);
const guide = createRequire(import.meta.url)(out);

// 后台填了横幅字段：三项都照原文用。
const configured = guide.parseGuideSummary({
  title: "上海大学",
  edition: "2026 秋",
  revisionNo: 3,
  banner: { title: "2026 版入校指南", subtitle: "点击查看", icon: "icon-guide" },
});
assert.deepEqual(configured, {
  title: "2026 版入校指南",
  subtitle: "点击查看",
  edition: "2026 秋",
  iconAsset: "icon-guide",
  revisionNo: 3,
});

// 老响应没有顶层 banner，字段还在整份内容里（content.meta.banner）。
const nested = guide.parseGuideSummary({
  title: "上海大学",
  edition: "2026 秋",
  revisionNo: 3,
  content: { meta: { banner: { title: "内容里的标题" } } },
});
assert.equal(nested.title, "内容里的标题");
assert.equal(nested.subtitle, "点击查看", "副标题没配时兜底");

// 没配横幅：标题按版次派生，绝不回落到文档标题（「上海大学」）。
const derived = guide.parseGuideSummary({ title: "上海大学", edition: "2026 版 · 电子版", revisionNo: 3 });
assert.equal(derived.title, "2026 版入校指南");
assert.notEqual(derived.title, "上海大学");
assert.equal(derived.iconAsset, null);
assert.equal(guide.fallbackBannerTitle(null), "入校指南");

assert.equal(guide.shouldShowGuideBanner(configured, ""), true);
assert.equal(guide.shouldShowGuideBanner(configured, guide.dismissStamp(3)), false);
assert.equal(guide.shouldShowGuideBanner({ ...configured, revisionNo: 4 }, guide.dismissStamp(3)), true);
assert.equal(guide.parseGuideSummary({ title: "", revisionNo: 1 }), null);
assert.equal(guide.parseGuideSummary({ title: "x", revisionNo: "1" }), null);

// 小程序拼的是绝对地址（不能用同源相对路径）。
assert.match(guide.guideAssetUrl("icon-guide"), /^https?:\/\/.+\/api\/public\/guide-assets\/icon-guide$/);

console.log("miniprogram-guide-entry: all assertions passed");
