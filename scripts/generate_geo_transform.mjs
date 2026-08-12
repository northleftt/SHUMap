// 配准脚本：用 data/campus-buildings.picked.json 的楼栋控制点
// （svgElementId + gcj02 经纬度，全部 verified）和各校区 SVG 底图几何，
// 最小二乘拟合每校区 gcj02 → viewBox 仿射变换参数。
// 输出：data/geo-transform.json + 可粘贴进两端 CAMPUS_DISPLAY 的 TS 片段。
// 跑法：node scripts/generate_geo_transform.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseSvgFeatures } from "../shared/svg-geometry.mjs";
import { fitGeoTransform, applyGeoTransform } from "../shared/geo-transform.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const CAMPUS_NAME_TO_KEY = {
  宝山校区: "baoshan",
  嘉定校区: "jiading",
  延长校区: "yanchang",
};

// 上海纬度下 1 度经/纬度约合米数，用于把残差换算成米。
const METERS_PER_DEG_LNG = 111320 * Math.cos((31.3 / 180) * Math.PI);
const METERS_PER_DEG_LAT = 110940;

// 离群点剔除阈值：残差超过此米数视为打点错误，剔除后重新拟合。
const OUTLIER_METERS = 30;

const picked = JSON.parse(readFileSync(join(root, "data/campus-buildings.picked.json"), "utf8"));
const assets = JSON.parse(readFileSync(join(root, "data/campus-map-assets.json"), "utf8"));

const featureIndexByCampus = {};
for (const asset of assets) {
  const svg = readFileSync(join(root, asset.sourcePath), "utf8");
  const features = parseSvgFeatures(svg);
  const index = new Map();
  for (const feature of features) {
    if (feature.sourceElementId && feature.bbox) index.set(feature.sourceElementId, feature);
  }
  featureIndexByCampus[asset.key] = index;
}

const controlByCampus = { baoshan: [], jiading: [], yanchang: [] };
const unmatched = [];
for (const entry of picked) {
  const key = CAMPUS_NAME_TO_KEY[entry.campus];
  if (!key) continue;
  const index = featureIndexByCampus[key];
  const feature = index.get(entry.svgElementId);
  if (!feature) {
    unmatched.push(`${entry.campus}/${entry.svgElementId} (${entry.name})`);
    continue;
  }
  const [minX, minY, maxX, maxY] = feature.bbox;
  controlByCampus[key].push({
    id: entry.svgElementId,
    name: entry.name,
    longitude: entry.navigation.longitude,
    latitude: entry.navigation.latitude,
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
  });
}

function residualsMeters(transform, points) {
  return points.map((p) => {
    const projected = applyGeoTransform(transform, p.longitude, p.latitude);
    // viewBox 残差换算回米：用变换把单位 viewBox 位移近似成经纬度位移。
    const dx = projected.x - p.x;
    const dy = projected.y - p.y;
    // viewBox 残差换算回米：列向量范数给出"单位经/纬度对应的 viewBox 位移"，
    // 其倒数乘每度米数即 viewBox 单位位移对应的米数。
    const metersPerUnitX = METERS_PER_DEG_LNG / Math.hypot(transform.a, transform.d);
    const metersPerUnitY = METERS_PER_DEG_LAT / Math.hypot(transform.b, transform.e);
    return {
      ...p,
      viewBoxDx: dx,
      viewBoxDy: dy,
      meters: Math.hypot(dx * metersPerUnitX, dy * metersPerUnitY),
    };
  });
}

const result = {};
for (const key of Object.keys(controlByCampus)) {
  let points = controlByCampus[key];
  if (points.length < 3) {
    console.log(`\n[${key}] 控制点不足（${points.length}），跳过`);
    continue;
  }
  let transform = fitGeoTransform(points);
  let evaluated = residualsMeters(transform, points);
  const outliers = evaluated.filter((r) => r.meters > OUTLIER_METERS);
  if (outliers.length > 0 && points.length - outliers.length >= 3) {
    points = points.filter((p) => !outliers.some((o) => o.id === p.id));
    transform = fitGeoTransform(points);
    evaluated = residualsMeters(transform, points);
  }
  const sorted = [...evaluated].sort((a, b) => b.meters - a.meters);
  const mean = evaluated.reduce((sum, r) => sum + r.meters, 0) / evaluated.length;
  const max = sorted[0]?.meters ?? 0;
  result[key] = {
    controlPoints: points.length,
    droppedOutliers: outliers.map((o) => `${o.id} (${o.name}) ${o.meters.toFixed(1)}m`),
    meanResidualMeters: Number(mean.toFixed(2)),
    maxResidualMeters: Number(max.toFixed(2)),
    transform,
  };
  console.log(
    `\n[${key}] 控制点 ${points.length}（剔除离群 ${outliers.length}）` +
      ` 平均残差 ${mean.toFixed(1)}m 最大残差 ${max.toFixed(1)}m`,
  );
  if (outliers.length > 0) {
    for (const o of outliers) console.log(`  剔除: ${o.id} (${o.name}) ${o.meters.toFixed(1)}m`);
  }
  for (const r of sorted.slice(0, 5)) {
    console.log(`  残差: ${r.id} (${r.name}) ${r.meters.toFixed(1)}m`);
  }
}

if (unmatched.length > 0) {
  console.log(`\nSVG 中未找到 svgElementId（未参与拟合）: ${unmatched.length}`);
  for (const item of unmatched) console.log(`  ${item}`);
}

writeFileSync(join(root, "data/geo-transform.json"), JSON.stringify(result, null, 2) + "\n");

console.log("\n=== CAMPUS_DISPLAY 片段 ===");
for (const [key, entry] of Object.entries(result)) {
  const t = entry.transform;
  console.log(
    `${key}: geoTransform: { a: ${t.a.toFixed(6)}, b: ${t.b.toFixed(6)}, c: ${t.c.toFixed(6)}, d: ${t.d.toFixed(6)}, e: ${t.e.toFixed(6)}, f: ${t.f.toFixed(6)} },`,
  );
}
console.log("\n已写入 data/geo-transform.json");
