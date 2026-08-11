// 地图楼宇筛选覆盖层的纯逻辑自验：
// 1. release fixture 中每个筛选项的楼宇 sourceElementId 都能生成选择器；
// 2. match / selected 样式数值与网页端 MapCanvas 保持一致；
// 3. 空集合、重复 id、特殊字符 id 与坏 SVG 的边界行为稳定。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "tmp/map-test");
mkdirSync(outDir, { recursive: true });

for (const [entry, out] of [
  ["miniprogram/miniprogram/lib/map/svg-highlight.ts", "svg-highlight.cjs"],
  ["miniprogram/miniprogram/lib/release/manifestContract.ts", "manifest-contract.cjs"],
  ["miniprogram/miniprogram/lib/release/mapData.ts", "map-data.cjs"],
  ["miniprogram/miniprogram/lib/release/filters.ts", "filters.cjs"],
]) {
  execFileSync(join(repoRoot, "node_modules/.bin/esbuild"), [
    join(repoRoot, entry),
    "--bundle",
    "--platform=node",
    "--format=cjs",
    `--outfile=${join(outDir, out)}`,
  ]);
}

const require = createRequire(import.meta.url);
const svgHighlight = require(join(outDir, "svg-highlight.cjs"));
const manifestContract = require(join(outDir, "manifest-contract.cjs"));
const mapData = require(join(outDir, "map-data.cjs"));
const filters = require(join(outDir, "filters.cjs"));

const rawManifest = JSON.parse(readFileSync(join(repoRoot, "tests/fixtures/release-manifest-live.json"), "utf8"));
const manifest = manifestContract.parseReleaseManifest(rawManifest);
const campusMaps = mapData.campusMapVersions(manifest);
const campuses = campusMaps.map((map) => mapData.campusConfigFromMap(
  map,
  `<svg viewBox="${map.svgViewbox}"></svg>`,
));
const pois = mapData.buildMapPois(manifest, campuses);

for (const campus of campuses) {
  const campusPois = pois.filter((poi) => poi.campusKey === campus.key);
  for (const filter of manifest.mapFilters) {
    const ids = filters.filterMapPois(campusPois, [filter.key], null).flatMap((poi) =>
      poi.entityType === "building" && poi.sourceElementId ? [poi.sourceElementId] : [],
    );
    if (ids.length === 0) continue;
    const svg = svgHighlight.injectSvgHighlight("<svg viewBox=\"0 0 10 10\"></svg>", ids, "match");
    assert.ok(svg, `${campus.key}/${filter.key} 应生成筛选楼宇 SVG`);
    assert.equal(
      (svg.match(/ path,/g) ?? []).length,
      new Set(ids).size,
      `${campus.key}/${filter.key} 每栋命中楼宇应有一条 path 选择器`,
    );
  }
}

const matchSvg = svgHighlight.injectSvgHighlight(
  '<svg><g id="building:a.b"><path/></g></svg>',
  ["building:a.b", "building:a.b"],
  "match",
);
assert.match(matchSvg, /#building\\:a\\\.b path/);
assert.match(matchSvg, /fill: rgba\(215, 232, 243, 0\.95\) !important/);
assert.match(matchSvg, /stroke-width: 1\.8 !important/);
assert.match(matchSvg, /<path style="fill: rgba\(215, 232, 243, 0\.95\) !important/);
assert.equal((matchSvg.match(/#building\\:a\\\.b path/g) ?? []).length, 1);

const existingStyleSvg = svgHighlight.injectSvgHighlight(
  '<svg><g id="building"><path style="opacity:.5"/></g><g id="other"><path/></g></svg>',
  ["building"],
  "match",
);
assert.match(existingStyleSvg, /style="opacity:\.5; fill: rgba\(215, 232, 243, 0\.95\) !important/);
assert.match(existingStyleSvg, /<g id="other"><path\/><\/g>/, "未命中的楼宇图形不应写 inline style");
const selfClosingGroupSvg = svgHighlight.injectSvgHighlight(
  '<svg><g id="building"/><g id="other"><path/></g></svg>',
  ["building"],
  "match",
);
assert.match(selfClosingGroupSvg, /<g id="other"><path\/><\/g>/, "自闭合目标分组不应影响后续图形");

const selectedSvg = svgHighlight.injectSvgHighlight("<svg></svg>", ["building"], "selected");
assert.match(selectedSvg, /fill: rgba\(215, 232, 243, 1\) !important/);
assert.match(selectedSvg, /stroke-width: 3 !important/);
assert.equal(svgHighlight.injectSvgHighlight("<svg></svg>", [], "match"), null);
assert.throws(
  () => svgHighlight.injectSvgHighlight("<svg>", ["building"], "match"),
  /closing root element/,
);

console.log("miniprogram-map-svg-highlight: all assertions passed");
