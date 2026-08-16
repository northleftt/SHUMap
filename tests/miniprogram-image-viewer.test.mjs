// 指南图片查看器纯函数：缩放钳制 / 单击切换 / 捏合 / 平移 / URL 收集。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "tmp/guide-test");
mkdirSync(outDir, { recursive: true });

execFileSync(join(repoRoot, "node_modules/.bin/esbuild"), [
  join(repoRoot, "miniprogram/miniprogram/lib/image-viewer.ts"),
  "--bundle",
  "--format=cjs",
  "--platform=node",
  `--outfile=${join(outDir, "image-viewer.cjs")}`,
]);

const require = createRequire(import.meta.url);
const viewer = require(join(outDir, "image-viewer.cjs"));

assert.equal(viewer.clampViewerScale(0.2), 1);
assert.equal(viewer.clampViewerScale(9), 5);
assert.equal(viewer.clampViewerScale(2), 2);
assert.equal(viewer.clampViewerScale(Number.NaN), 1);

assert.equal(viewer.toggleViewerScale(1), 2.5);
assert.equal(viewer.toggleViewerScale(2.5), 1);
assert.equal(viewer.toggleViewerScale(1.2), 1);

assert.equal(viewer.touchDistance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
assert.equal(viewer.pinchScale(1, 100, 200), 2);
assert.equal(viewer.pinchScale(2, 100, 50), 1);
assert.equal(viewer.pinchScale(1, 100, 800), 5);
assert.equal(viewer.pinchScale(1, 0, 100), 1);

assert.deepEqual(viewer.panViewer({ scale: 1, tx: 10, ty: 4 }, 20, 8), { scale: 1, tx: 0, ty: 0 });
assert.deepEqual(viewer.panViewer({ scale: 2, tx: 10, ty: 4 }, 20, 8), { scale: 2, tx: 30, ty: 12 });

assert.equal(
  viewer.viewerTransformStyle({ scale: 2.5, tx: -8, ty: 12 }),
  "transform: translate(-8px, 12px) scale(2.5);",
);

assert.deepEqual(
  viewer.collectPreviewableUrls([
    { src: "https://map.shutf.com/a.jpg" },
    { src: "https://map.shutf.com/a.jpg" },
    { src: "data:image/png;base64,AAA" },
    { fallbackSrc: "https://map.shutf.com/b.png" },
    null,
    { src: "" },
  ]),
  ["https://map.shutf.com/a.jpg", "https://map.shutf.com/b.png"],
);

assert.equal(viewer.viewerNeedsPaper("https://map.shutf.com/api/public/guide-assets/hub-hongqiao"), true);
assert.equal(viewer.viewerNeedsPaper("https://map.shutf.com/api/public/guide-assets/hub-hongqiao-png"), true);
assert.equal(viewer.viewerNeedsPaper("https://map.shutf.com/x.svg"), true);
assert.equal(viewer.viewerNeedsPaper("https://map.shutf.com/guide/figures/scene/shanghai-exit-sw.jpg"), false);
assert.equal(viewer.viewerNeedsPaper("https://map.shutf.com/api/public/guide-assets/scene-img-abc"), true);

console.log("miniprogram-image-viewer: all assertions passed");
