// 地理坐标 ↔ viewBox 仿射变换自验（node 直跑，不经微信开发者工具）。
// 1. shared/geo-transform.mjs：fit/apply/invert 往返、wgs84↔gcj02 往返、outOfChina；
// 2. 小程序搬运版 miniprogram/miniprogram/lib/geo-transform.ts 与 shared 逐点同值；
// 3. data/geo-transform.json 里的拟合参数对全部控制点的残差在容差内
//    （仿射拟合精度上限，超出说明参数被手改坏或底图/控制点变了，需重跑配准脚本）。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyGeoTransform,
  fitGeoTransform,
  gcj02ToWgs84,
  invertGeoTransform,
  outOfChina,
  wgs84ToGcj02,
} from "../shared/geo-transform.mjs";
import { parseSvgFeatures } from "../shared/svg-geometry.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// 1. shared 模块：拟合/正反变换/坐标系转换
// ---------------------------------------------------------------------------
{
  // 构造已知仿射 + 控制点，拟合应还原参数
  const truth = { a: 50000, b: -1000, c: -6000000, d: 200, e: -60000, f: 2000000 };
  const points = [];
  for (let i = 0; i < 20; i++) {
    const longitude = 121.39 + (i % 5) * 0.002;
    const latitude = 31.31 + Math.floor(i / 5) * 0.002;
    points.push({ longitude, latitude, ...applyGeoTransform(truth, longitude, latitude) });
  }
  const fitted = fitGeoTransform(points);
  for (const key of ["a", "b", "c", "d", "e", "f"]) {
    assert.ok(
      Math.abs(fitted[key] - truth[key]) < Math.max(1e-6, Math.abs(truth[key]) * 1e-9),
      `fit should recover ${key}: got ${fitted[key]}, want ${truth[key]}`,
    );
  }

  // invert 是 apply 的逆
  const inverse = invertGeoTransform(fitted);
  const world = applyGeoTransform(fitted, 121.395, 31.313);
  const geo = applyGeoTransform(inverse, world.x, world.y);
  assert.ok(Math.abs(geo.x - 121.395) < 1e-9, "invert longitude roundtrip");
  assert.ok(Math.abs(geo.y - 31.313) < 1e-9, "invert latitude roundtrip");

  // wgs84→gcj02→wgs84 往返（上海）
  const gcj = wgs84ToGcj02(121.395, 31.313);
  const shiftMeters =
    Math.hypot((gcj.longitude - 121.395) * 95150, (gcj.latitude - 31.313) * 110940);
  assert.ok(shiftMeters > 50 && shiftMeters < 1000, `gcj02 shift ${shiftMeters}m in sane range`);
  const back = gcj02ToWgs84(gcj.longitude, gcj.latitude);
  assert.ok(Math.abs(back.longitude - 121.395) < 1e-5, "wgs84 roundtrip longitude");
  assert.ok(Math.abs(back.latitude - 31.313) < 1e-5, "wgs84 roundtrip latitude");

  // 境外不偏移
  assert.equal(outOfChina(121.395, 31.313), false);
  assert.equal(outOfChina(139.7, 35.7), true);
  const tokyo = wgs84ToGcj02(139.7, 35.7);
  assert.deepEqual(tokyo, { longitude: 139.7, latitude: 35.7 });

  // 退化输入报错
  assert.throws(() => fitGeoTransform([{ longitude: 1, latitude: 1, x: 0, y: 0 }]), /at least 3/);
}

// ---------------------------------------------------------------------------
// 2. 小程序搬运版与 shared 逐点同值
// ---------------------------------------------------------------------------
{
  const outDir = join(repoRoot, "tmp/geo-transform-test");
  mkdirSync(outDir, { recursive: true });
  execFileSync(join(repoRoot, "node_modules/.bin/esbuild"), [
    join(repoRoot, "miniprogram/miniprogram/lib/geo-transform.ts"),
    "--bundle",
    "--format=cjs",
    "--platform=node",
    `--outfile=${join(outDir, "geo-transform.cjs")}`,
  ]);
  const require = createRequire(import.meta.url);
  const ported = require(join(outDir, "geo-transform.cjs"));

  const t = { a: 58096.670477, b: -1364.771256, c: -7009421.632837, d: 74.651725, e: -67597.619419, f: 2108283.774692 };
  for (const [longitude, latitude] of [[121.395, 31.313], [121.258, 31.286], [121.402, 31.318]]) {
    assert.deepEqual(
      ported.applyGeoTransform(t, longitude, latitude),
      applyGeoTransform(t, longitude, latitude),
    );
    assert.deepEqual(ported.wgs84ToGcj02(longitude, latitude), wgs84ToGcj02(longitude, latitude));
    assert.deepEqual(ported.gcj02ToWgs84(longitude, latitude), gcj02ToWgs84(longitude, latitude));
  }
  assert.deepEqual(ported.invertGeoTransform(t), invertGeoTransform(t));
}

// ---------------------------------------------------------------------------
// 3. 拟合参数对真实控制点的残差在容差内
// ---------------------------------------------------------------------------
{
  const CAMPUS_NAME_TO_KEY = { 宝山校区: "baoshan", 嘉定校区: "jiading", 延长校区: "yanchang" };
  const fitted = JSON.parse(readFileSync(join(repoRoot, "data/geo-transform.json"), "utf8"));
  const assets = JSON.parse(readFileSync(join(repoRoot, "data/campus-map-assets.json"), "utf8"));
  const picked = JSON.parse(
    readFileSync(join(repoRoot, "data/campus-buildings.picked.json"), "utf8"),
  );
  const METERS_PER_DEG_LNG = 111320 * Math.cos((31.3 / 180) * Math.PI);
  const METERS_PER_DEG_LAT = 110940;
  // 仿射拟合的精度上限：平均残差 ~10-17m，离群点（局部失真/打点错）剔除前 ~50-100m。
  const MAX_RESIDUAL_METERS = 120;

  const featureIndexByCampus = {};
  for (const asset of assets) {
    const svg = readFileSync(join(repoRoot, asset.sourcePath), "utf8");
    const index = new Map();
    for (const feature of parseSvgFeatures(svg)) {
      if (feature.sourceElementId && feature.bbox) index.set(feature.sourceElementId, feature.bbox);
    }
    featureIndexByCampus[asset.key] = index;
  }

  for (const entry of picked) {
    const key = CAMPUS_NAME_TO_KEY[entry.campus];
    const bbox = key && featureIndexByCampus[key].get(entry.svgElementId);
    const transform = fitted[key] && fitted[key].transform;
    if (!bbox || !transform) continue;
    const projected = applyGeoTransform(
      transform,
      entry.navigation.longitude,
      entry.navigation.latitude,
    );
    const meters = Math.hypot(
      (projected.x - (bbox[0] + bbox[2]) / 2) *
        (METERS_PER_DEG_LNG / Math.hypot(transform.a, transform.d)),
      (projected.y - (bbox[1] + bbox[3]) / 2) *
        (METERS_PER_DEG_LAT / Math.hypot(transform.b, transform.e)),
    );
    assert.ok(
      meters < MAX_RESIDUAL_METERS,
      `${key}/${entry.svgElementId} residual ${meters.toFixed(1)}m exceeds ${MAX_RESIDUAL_METERS}m`,
    );
  }
}

console.log("geo-transform tests passed");
