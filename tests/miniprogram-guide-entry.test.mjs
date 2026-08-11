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

const summary = guide.parseGuideSummary({ title: "返校指南", edition: "2026 秋", revisionNo: 3 });
assert.deepEqual(summary, { title: "返校指南", edition: "2026 秋", revisionNo: 3 });
assert.equal(guide.guideSubtitle(summary), "2026 秋 · 查看到校路线");
assert.equal(guide.shouldShowGuideBanner(summary, ""), true);
assert.equal(guide.shouldShowGuideBanner(summary, guide.dismissStamp(3)), false);
assert.equal(guide.shouldShowGuideBanner({ ...summary, revisionNo: 4 }, guide.dismissStamp(3)), true);
assert.equal(guide.parseGuideSummary({ title: "", revisionNo: 1 }), null);
assert.equal(guide.parseGuideSummary({ title: "x", revisionNo: "1" }), null);

console.log("miniprogram-guide-entry: all assertions passed");
