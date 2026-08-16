// 配准脚本：拟合每校区 gcj02 → viewBox 的 6 参数仿射变换。
// 输出：data/geo-transform.json + 可粘贴进两端 CAMPUS_DISPLAY 的 TS 片段。
// 跑法：node scripts/generate_geo_transform.mjs
//
// 底图必须用【已发布】的那一份（data/published-maps/，由
// scripts/fetch_published_maps.mjs 从当前发版拉取并钉住），不是仓库里的
// 地图/*.svg。
//
// 为什么：前端渲染的是发布在 release 里的底图，而仓库 SVG 是它的上游草稿，
// 两者的 viewBox 可能不同——实测宝山已发布 921.6×1019.7、仓库 856×842，
// 同一张画整体平移了 65 个 viewBox 单位（≈107m）。用仓库 SVG 拟合出的参数
// 拿到前端用，定位蓝点就整体偏 107m，而且因为误差是纯平移、处处自洽，
// 从残差数字上完全看不出来（这个坑真实发生过）。
//
// 因此本脚本把用到的 mapVersionId 与 viewBox 一并写进输出 JSON：
// 参数与底图从此可追溯，对不上时能立刻发现。
//
// 控制点来源，按优先级：
//   1. data/geo-control-points.json —— 管理端「开发工具 → 坐标校准器」导出。
//      腾讯选点器给 GCJ-02 地面真值 + 校园底图上点同一特征给 viewBox，成对产出。
//      这是首选：控制点是点状特征（路口中线、跑道角），噪声约 1–3m。
//   2. data/campus-buildings.picked.json —— 早期 121 个楼栋点，取楼轮廓 bbox
//      中心当 viewBox 坐标。噪声大（平均残差 15m，因为"楼中心"本身有歧义），
//      仅作为校准器控制点尚未导出时的兜底。

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseSvgFeatures, parseSvgViewBox } from "../shared/svg-geometry.mjs";
import {
  applyGeoTransform,
  fitGeoTransform,
  geoTransformResiduals,
  metersPerViewBoxUnit,
} from "../shared/geo-transform.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISHED_DIR = join(root, "data/published-maps");
const CALIBRATOR_PATH = join(root, "data/geo-control-points.json");
const LEGACY_PATH = join(root, "data/campus-buildings.picked.json");
const OUTPUT_PATH = join(root, "data/geo-transform.json");

const CAMPUS_KEYS = ["baoshan", "jiading", "yanchang"];
const CAMPUS_NAME_TO_KEY = {
  宝山校区: "baoshan",
  嘉定校区: "jiading",
  延长校区: "yanchang",
};

// 离群点阈值。
// 校准器控制点是点状特征，超过 15m 基本只能是标错（实测好点全在 7m 内）。
// 楼栋点的残差与楼的尺寸相关（大楼的 POI 点合理地不在几何中心），用绝对阈值
// 会把 D14–D19、伟长楼这类大楼的有效数据当噪声丢掉，所以取相对值。
const CALIBRATOR_OUTLIER_METERS = 15;
const LEGACY_OUTLIER_FLOOR_METERS = 30;
const LEGACY_OUTLIER_RADIUS_RATIO = 0.6;

function loadPublishedMaps() {
  const manifestPath = join(PUBLISHED_DIR, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `缺少 ${relative(manifestPath)}。先跑 node scripts/fetch_published_maps.mjs 把当前发版的底图钉下来。`,
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const maps = {};
  for (const key of CAMPUS_KEYS) {
    // campuses 是数组（保持与 fetch 脚本的写出顺序一致），按 key 查而不是下标索引。
    const entry = Array.isArray(manifest.campuses)
      ? manifest.campuses.find((item) => item?.key === key)
      : manifest.campuses?.[key];
    if (!entry) throw new Error(`published-maps/manifest.json 缺少校区 ${key}`);
    const svgPath = join(PUBLISHED_DIR, `${key}.svg`);
    if (!existsSync(svgPath)) throw new Error(`缺少已发布底图 ${relative(svgPath)}`);
    const svg = readFileSync(svgPath, "utf8");
    const viewBox = parseSvgViewBox(svg);
    // manifest 记的 viewBox 与文件实际内容必须一致，否则钉下来的东西已经被改过。
    if (
      Math.abs(viewBox.width - entry.viewBox.width) > 1e-6
      || Math.abs(viewBox.height - entry.viewBox.height) > 1e-6
    ) {
      throw new Error(
        `${key}.svg 的 viewBox（${viewBox.width}×${viewBox.height}）与 manifest`
          + `（${entry.viewBox.width}×${entry.viewBox.height}）不一致，请重新 fetch`,
      );
    }
    maps[key] = { ...entry, svg, viewBox };
  }
  return { manifest, maps };
}

const relative = (path) => path.replace(`${root}/`, "");

/** svgElementId → bbox（仅楼栋点兜底路径需要）。 */
function featureBboxIndex(svg) {
  const index = new Map();
  for (const feature of parseSvgFeatures(svg)) {
    if (feature.sourceElementId && feature.bbox) index.set(feature.sourceElementId, feature.bbox);
  }
  return index;
}

/** 校准器导出：控制点已经是 (GCJ-02, viewBox) 成对的量，直接用。 */
function loadCalibratorPoints() {
  const payload = JSON.parse(readFileSync(CALIBRATOR_PATH, "utf8"));
  const byCampus = {};
  for (const key of CAMPUS_KEYS) byCampus[key] = [];
  for (const [key, entry] of Object.entries(payload.campuses ?? {})) {
    if (!CAMPUS_KEYS.includes(key)) continue;
    for (const [index, item] of (entry.controlPoints ?? []).entries()) {
      const { longitude, latitude, x, y } = item;
      if ([longitude, latitude, x, y].some((value) => typeof value !== "number" || !Number.isFinite(value))) {
        throw new Error(`geo-control-points.json ${key}[${index}] 坐标不是有限数`);
      }
      byCampus[key].push({
        id: item.label || `${key}-${index + 1}`,
        name: item.label || "(未命名)",
        longitude,
        latitude,
        x,
        y,
        // 点状特征没有"尺寸"，离群判定用绝对阈值。
        radiusMeters: null,
      });
    }
  }
  return { source: "calibrator", label: relative(CALIBRATOR_PATH), byCampus, unmatched: [] };
}

/** 楼栋点兜底：viewBox 坐标取【已发布底图】里该楼轮廓的 bbox 中心。 */
function loadLegacyPoints(maps) {
  const picked = JSON.parse(readFileSync(LEGACY_PATH, "utf8"));
  const indexByCampus = {};
  for (const key of CAMPUS_KEYS) indexByCampus[key] = featureBboxIndex(maps[key].svg);

  const byCampus = {};
  for (const key of CAMPUS_KEYS) byCampus[key] = [];
  const unmatched = [];
  for (const entry of picked) {
    const key = CAMPUS_NAME_TO_KEY[entry.campus];
    if (!key) continue;
    const { longitude, latitude } = entry.navigation ?? {};
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;
    const bbox = indexByCampus[key].get(entry.svgElementId);
    if (!bbox) {
      unmatched.push(`${entry.campus}/${entry.svgElementId} (${entry.name})`);
      continue;
    }
    const [minX, minY, maxX, maxY] = bbox;
    byCampus[key].push({
      id: entry.svgElementId,
      name: entry.name,
      longitude,
      latitude,
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      // 楼的"半径"（外接盒半对角线）换算成米，供相对离群阈值用。
      radiusUnits: Math.hypot(maxX - minX, maxY - minY) / 2,
    });
  }
  return { source: "legacy-buildings", label: relative(LEGACY_PATH), byCampus, unmatched };
}

function outlierThresholdMeters(point, transform, source) {
  if (source !== "legacy-buildings" || point.radiusUnits === undefined) {
    return CALIBRATOR_OUTLIER_METERS;
  }
  const unit = metersPerViewBoxUnit(transform);
  const radiusMeters = point.radiusUnits * Math.hypot(unit.x, unit.y) / Math.SQRT2;
  return Math.max(LEGACY_OUTLIER_FLOOR_METERS, radiusMeters * LEGACY_OUTLIER_RADIUS_RATIO);
}

function meanLatitude(points) {
  return points.reduce((sum, point) => sum + point.latitude, 0) / points.length;
}

/** 拟合一个校区：拟合 → 按阈值剔离群 → 重拟合。 */
function fitCampus(points, source) {
  let kept = points;
  let transform = fitGeoTransform(kept);
  let residuals = geoTransformResiduals(transform, kept, meanLatitude(kept));
  const dropped = [];
  for (const [index, residual] of residuals.entries()) {
    const limit = outlierThresholdMeters(kept[index], transform, source);
    if (residual.meters > limit) {
      dropped.push({ ...kept[index], meters: residual.meters, limit });
    }
  }
  if (dropped.length > 0 && kept.length - dropped.length >= 3) {
    const droppedIds = new Set(dropped.map((item) => item.id));
    kept = kept.filter((point) => !droppedIds.has(point.id));
    transform = fitGeoTransform(kept);
    residuals = geoTransformResiduals(transform, kept, meanLatitude(kept));
  } else if (dropped.length > 0) {
    // 剔完就不够拟合了，宁可全留着并如实报出来。
    dropped.length = 0;
  }
  const meters = residuals.map((residual) => residual.meters);
  const evaluated = kept
    .map((point, index) => ({ ...point, meters: meters[index] }))
    .sort((left, right) => right.meters - left.meters);
  const unit = metersPerViewBoxUnit(transform, meanLatitude(kept));
  return {
    transform,
    kept,
    dropped,
    evaluated,
    meanResidualMeters: meters.reduce((sum, value) => sum + value, 0) / meters.length,
    maxResidualMeters: Math.max(...meters),
    unit,
  };
}

/**
 * 变换不确定度：重采样控制点重拟合，看同一个地理点被投到哪，散布即为
 * "这套参数本身有多准"。这与单点残差是两件事——单点残差是控制点自己的打点
 * 噪声，不会传播；不确定度才决定用户端定位蓝点偏多少。
 */
function transformUncertaintyMeters(points, samples = 400) {
  if (points.length < 4) return null;
  const full = fitGeoTransform(points);
  const latitude = meanLatitude(points);
  const unit = metersPerViewBoxUnit(full, latitude);
  const lngs = points.map((point) => point.longitude);
  const lats = points.map((point) => point.latitude);
  const probes = [];
  for (const fx of [0.05, 0.5, 0.95]) {
    for (const fy of [0.05, 0.5, 0.95]) {
      probes.push({
        longitude: Math.min(...lngs) + (Math.max(...lngs) - Math.min(...lngs)) * fx,
        latitude: Math.min(...lats) + (Math.max(...lats) - Math.min(...lats)) * fy,
      });
    }
  }
  const base = probes.map((probe) => applyGeoTransform(full, probe.longitude, probe.latitude));
  const deviations = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const resampled = [];
    for (let i = 0; i < points.length; i += 1) {
      resampled.push(points[Math.floor(Math.random() * points.length)]);
    }
    let candidate;
    try {
      candidate = fitGeoTransform(resampled);
    } catch {
      continue; // 重采样恰好共线，跳过这一次
    }
    probes.forEach((probe, index) => {
      const projected = applyGeoTransform(candidate, probe.longitude, probe.latitude);
      deviations.push(Math.hypot(
        (projected.x - base[index].x) * unit.x,
        (projected.y - base[index].y) * unit.y,
      ));
    });
  }
  if (deviations.length === 0) return null;
  deviations.sort((left, right) => left - right);
  const at = (ratio) => deviations[Math.min(deviations.length - 1, Math.floor(deviations.length * ratio))];
  return { medianMeters: at(0.5), p90Meters: at(0.9) };
}

// ---------------------------------------------------------------------------

const { manifest, maps } = loadPublishedMaps();
const usingCalibrator = existsSync(CALIBRATOR_PATH);
const control = usingCalibrator ? loadCalibratorPoints() : loadLegacyPoints(maps);

console.log(`底图：data/published-maps（发版 ${manifest.releaseId ?? "?"}，取自 ${manifest.source ?? "?"}）`);
console.log(`控制点：${control.label}${usingCalibrator ? "" : "  ← 兜底来源，精度有限"}`);
if (!usingCalibrator) {
  console.log(
    "  提示：管理端「开发工具 → 坐标校准器」导出 data/geo-control-points.json 后，"
      + "本脚本会自动优先使用它（精度高一个数量级）。",
  );
}

const result = {
  generatedAt: new Date().toISOString(),
  // 参数与底图的绑定关系。对不上就说明参数是拿另一张底图拟合的，不能用。
  basemap: {
    source: "data/published-maps",
    releaseId: manifest.releaseId ?? null,
    fetchedFrom: manifest.fetchedFrom ?? null,
    fetchedAt: manifest.fetchedAt ?? null,
  },
  controlPointSource: control.source,
};

for (const key of CAMPUS_KEYS) {
  const points = control.byCampus[key] ?? [];
  const map = maps[key];
  if (points.length < 3) {
    console.log(`\n[${key}] 控制点不足（${points.length}），跳过`);
    continue;
  }
  const fit = fitCampus(points, control.source);
  const uncertainty = transformUncertaintyMeters(fit.kept);
  result[key] = {
    mapVersionId: map.mapVersionId,
    viewBox: { width: map.viewBox.width, height: map.viewBox.height },
    controlPoints: fit.kept.length,
    droppedOutliers: fit.dropped.map(
      (item) => `${item.id} (${item.name}) ${item.meters.toFixed(1)}m > ${item.limit.toFixed(0)}m`,
    ),
    meanResidualMeters: Number(fit.meanResidualMeters.toFixed(2)),
    maxResidualMeters: Number(fit.maxResidualMeters.toFixed(2)),
    transformUncertaintyMeters: uncertainty
      ? {
        median: Number(uncertainty.medianMeters.toFixed(2)),
        p90: Number(uncertainty.p90Meters.toFixed(2)),
      }
      : null,
    metersPerViewBoxUnit: {
      x: Number(fit.unit.x.toFixed(4)),
      y: Number(fit.unit.y.toFixed(4)),
    },
    transform: fit.transform,
  };

  console.log(
    `\n[${key}] 底图 ${map.viewBox.width}×${map.viewBox.height}（${map.mapVersionId}）`
      + `\n  控制点 ${fit.kept.length}（剔除离群 ${fit.dropped.length}）`
      + `  平均残差 ${fit.meanResidualMeters.toFixed(1)}m  最大 ${fit.maxResidualMeters.toFixed(1)}m`,
  );
  if (uncertainty) {
    console.log(
      `  变换不确定度 中位 ${uncertainty.medianMeters.toFixed(1)}m`
        + `  p90 ${uncertainty.p90Meters.toFixed(1)}m  ← 决定用户端定位偏移`,
    );
  }
  for (const item of fit.dropped) {
    console.log(`  剔除: ${item.id} (${item.name}) ${item.meters.toFixed(1)}m > 阈值 ${item.limit.toFixed(0)}m`);
  }
  for (const item of fit.evaluated.slice(0, 5)) {
    console.log(`  残差: ${item.id} (${item.name}) ${item.meters.toFixed(1)}m`);
  }
}

if (control.unmatched.length > 0) {
  console.log(`\n已发布底图中未找到 svgElementId（未参与拟合）: ${control.unmatched.length}`);
  for (const item of control.unmatched.slice(0, 10)) console.log(`  ${item}`);
  if (control.unmatched.length > 10) console.log(`  …其余 ${control.unmatched.length - 10} 条略`);
}

writeFileSync(OUTPUT_PATH, `${JSON.stringify(result, null, 2)}\n`);

console.log("\n=== CAMPUS_DISPLAY 片段（三处硬编码都要同步）===");
for (const key of CAMPUS_KEYS) {
  const entry = result[key];
  if (!entry) continue;
  const t = entry.transform;
  console.log(
    `${key}: geoTransform: { a: ${t.a.toFixed(6)}, b: ${t.b.toFixed(6)}, c: ${t.c.toFixed(6)},`
      + ` d: ${t.d.toFixed(6)}, e: ${t.e.toFixed(6)}, f: ${t.f.toFixed(6)} },`,
  );
}
console.log("\n  1. src/lib/release/mapData.ts");
console.log("  2. miniprogram/miniprogram/lib/release/mapData.ts");
console.log("  3. data/geo-transform.json（本脚本已写入）");
console.log(`\n已写入 ${relative(OUTPUT_PATH)}`);
