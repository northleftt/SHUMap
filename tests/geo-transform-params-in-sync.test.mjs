// gcj02 → viewBox 仿射参数一共存在三处，这个文件只做一件事：钉住它们相等，
// 并且钉住它们与【当前发版的底图】是同一个坐标空间。
//
//   1. data/geo-transform.json                          （配准脚本的产物）
//   2. src/lib/release/mapData.ts                        （网页端 + 管理端画布选点）
//   3. miniprogram/miniprogram/lib/release/mapData.ts     （小程序端）
//
// 为什么值得单独一个测试：这三份是手工同步的，重跑配准后漏改一处不会有任何报错，
// 只表现为某一端的定位蓝点偏移。而「偏一点」在真机上几乎看不出来，能一直带到线上。
//
// 更要紧的是坐标空间。配准脚本原先读仓库里的 地图/*.svg，而两端渲染的是发版里的
// 底图；宝山两者 viewBox 不同（856×842 vs 921.6×1019.7，整体差约 65 个 viewBox
// 单位 ≈ 107m），于是线上蓝点系统性偏了约 100m，而当时所有自检都过——因为它们
// 都用同一份错底图，自洽。所以这里必须拿 data/published-maps/manifest.json 对账。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseSvgViewBox } from "../shared/svg-geometry.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(join(repoRoot, relativePath), "utf8");

const CAMPUS_KEYS = ["baoshan", "jiading", "yanchang"];
const PARAMS = ["a", "b", "c", "d", "e", "f"];
/** 两端源码里写的是 toFixed(6)，所以按 6 位小数对齐。 */
const TOLERANCE = 1e-6;

const TS_COPIES = [
  "src/lib/release/mapData.ts",
  "miniprogram/miniprogram/lib/release/mapData.ts",
];

/**
 * 从 TS 源码里抽出每个校区 geoTransform 的六个数。
 * 用文本解析而不是 import：小程序那份是 TS 且带 wx 全局，node 直接 import 不了。
 */
function extractTransforms(source, file) {
  const found = {};
  for (const key of CAMPUS_KEYS) {
    const campusAt = source.indexOf(`${key}: {`);
    assert.notEqual(campusAt, -1, `${file} 里找不到校区 ${key}`);
    // 只在这一个校区的块内找，避免串到下一个校区去。
    const block = source.slice(campusAt, campusAt + 1200);
    const transformAt = block.indexOf("geoTransform: {");
    assert.notEqual(transformAt, -1, `${file} 的 ${key} 没有 geoTransform`);
    const body = block.slice(transformAt, block.indexOf("}", transformAt));
    const values = {};
    for (const param of PARAMS) {
      const match = body.match(new RegExp(`\\b${param}:\\s*(-?[0-9]+(?:\\.[0-9]+)?)`));
      assert.ok(match, `${file} 的 ${key}.geoTransform 缺少 ${param}`);
      values[param] = Number(match[1]);
    }
    found[key] = values;
  }
  return found;
}

test("三处仿射参数逐位相等（漏同步一处只会表现为某一端蓝点偏移，不报错）", () => {
  const canonical = JSON.parse(read("data/geo-transform.json"));
  for (const file of TS_COPIES) {
    const copies = extractTransforms(read(file), file);
    for (const key of CAMPUS_KEYS) {
      const want = canonical[key]?.transform;
      assert.ok(want, `data/geo-transform.json 缺少校区 ${key}`);
      for (const param of PARAMS) {
        const expected = Number(want[param].toFixed(6));
        assert.ok(
          Math.abs(copies[key][param] - expected) <= TOLERANCE,
          `${file} 的 ${key}.${param} = ${copies[key][param]}，`
            + `data/geo-transform.json 是 ${expected}`
            + "（重跑配准后三处都要同步）",
        );
      }
    }
  }
});

test("参数拟合自当前发版的底图，而不是仓库里的 地图/*.svg", () => {
  const canonical = JSON.parse(read("data/geo-transform.json"));
  const manifest = JSON.parse(read("data/published-maps/manifest.json"));
  const published = new Map(manifest.campuses.map((entry) => [entry.key, entry]));

  for (const key of CAMPUS_KEYS) {
    const entry = published.get(key);
    assert.ok(entry, `published-maps/manifest.json 缺少校区 ${key}`);
    const record = canonical[key];
    assert.ok(record, `data/geo-transform.json 缺少校区 ${key}`);

    assert.equal(
      record.mapVersionId,
      entry.mapVersionId,
      `${key} 的参数拟合自 ${record.mapVersionId}，当前发版底图是 ${entry.mapVersionId}`
        + "；重跑 node scripts/fetch_published_maps.mjs && node scripts/generate_geo_transform.mjs",
    );
    assert.equal(record.viewBox?.width, entry.viewBox.width, `${key} viewBox 宽与发版底图不一致`);
    assert.equal(record.viewBox?.height, entry.viewBox.height, `${key} viewBox 高与发版底图不一致`);

    // 钉下来的 SVG 本身也要与 manifest 相符，否则文件被换过而 manifest 没跟上。
    const viewBox = parseSvgViewBox(read(`data/published-maps/${entry.file}`));
    assert.equal(viewBox.width, entry.viewBox.width, `${entry.file} 的 viewBox 与 manifest 不一致`);
    assert.equal(viewBox.height, entry.viewBox.height, `${entry.file} 的 viewBox 与 manifest 不一致`);
  }
});

test("宝山的发版底图与仓库 SVG 确实不同空间（这就是当初偏 100m 的原因）", () => {
  // 这条是文档性质的回归：只要两者仍然不同，就说明"不能用仓库 SVG 配准"这个约束
  // 依然成立。哪天有人把发版底图换回 856×842，这条会失败，提醒重新评估。
  const published = parseSvgViewBox(read("data/published-maps/baoshan.svg"));
  const repo = parseSvgViewBox(read("地图/宝山本部地图.svg"));
  const sameSpace = published.width === repo.width && published.height === repo.height;
  assert.equal(
    sameSpace,
    false,
    "宝山的发版底图与仓库 SVG 现在尺寸相同了。若确实统一了坐标空间，"
      + "请更新 scripts/generate_geo_transform.mjs 的注释与本断言。",
  );
});

test("配准脚本读已发布底图，没有退回仓库 SVG", () => {
  const source = read("scripts/generate_geo_transform.mjs");
  assert.match(source, /published-maps/, "配准必须读 data/published-maps");
  // campus-map-assets.json 指向仓库里的 地图/*.svg，是错的坐标空间。
  assert.doesNotMatch(
    source,
    /campus-map-assets\.json/,
    "配准脚本不能再读 data/campus-map-assets.json（它指向仓库 SVG，坐标空间与发版不同）",
  );
});
