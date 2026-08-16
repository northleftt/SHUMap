// 从楼栋轮廓自动推导导航终点（viewBox 面几何 → GCJ-02 点）。
//
// 为什么要有这个模块：新建楼栋地点时，导航终点原先是「手动加一行 + 改用途 + 填坐标」
// 三步，漏掉任何一步用户端就没有「导航到这里」按钮，而保存、审核、发版全程都不报错
// （发版校验只校验已存在的导航点形状，从不检查缺失）。楼栋本来就有轮廓，代表点可以
// 直接算出来，所以这一步不该靠人记。
//
// 关键安全性质：仿射参数必须与轮廓所属的那一版底图同源。同一校区在库里存在两套
// map_features（仓库图 map_version_campus_* 与发版图 mapver_*），坐标空间相差约
// 65 个 viewBox 单位≈107m。拿错参数算出来的经纬度会整体偏移，且因为处处自洽而完全
// 看不出来——这个坑真实发生过。所以 deriveNavigationTarget 要求调用方传入轮廓的
// mapVersionId，与参数记录里的 mapVersionId 不一致时返回 null 而不是硬算。

import { applyGeoTransform, invertGeoTransform } from "./geo-transform.mjs";

/** 环的面积（含首尾闭合点的环；符号表示绕向）。 */
function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum / 2;
}

/** 面的面积加权质心。退化成线时取顶点均值。 */
function ringCentroid(ring) {
  let cx = 0, cy = 0, area = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const cross = ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    area += cross;
    cx += (ring[i][0] + ring[i + 1][0]) * cross;
    cy += (ring[i][1] + ring[i + 1][1]) * cross;
  }
  area /= 2;
  if (Math.abs(area) < 1e-12) {
    const n = ring.length - 1 || ring.length;
    return [
      ring.slice(0, n).reduce((s, p) => s + p[0], 0) / n,
      ring.slice(0, n).reduce((s, p) => s + p[1], 0) / n,
    ];
  }
  return [cx / (6 * area), cy / (6 * area)];
}

function pointInRing(ring, point) {
  let inside = false;
  for (let i = 0, k = ring.length - 1; i < ring.length; k = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xk, yk] = ring[k];
    if ((yi > point[1]) !== (yk > point[1])) {
      const crossX = ((xk - xi) * (point[1] - yi)) / (yk - yi) + xi;
      if (point[0] < crossX) inside = !inside;
    }
  }
  return inside;
}

/**
 * 几何的代表点（viewBox 空间）。
 *
 * MultiPolygon 取面积最大的那一块；质心落在面外（L 形、环形、带内院的楼）时，沿质心
 * 所在扫描线取面内最长区段的中点，保证点确实落在楼里——导航终点落在楼外的空地上，
 * 用户跟着走会停在错的地方。存量重建时 216 个楼里有 12 个走了扫描线兜底。
 *
 * @param {{type?:string, coordinates?:unknown}} geometry
 * @returns {{ point:[number,number], method:string } | null}
 */
export function representativePoint(geometry) {
  if (!geometry || typeof geometry !== "object") return null;
  let rings = null;
  if (geometry.type === "Polygon" && Array.isArray(geometry.coordinates)) {
    rings = geometry.coordinates;
  } else if (geometry.type === "MultiPolygon" && Array.isArray(geometry.coordinates)) {
    let best = null, bestArea = -1;
    for (const polygon of geometry.coordinates) {
      if (!Array.isArray(polygon) || !Array.isArray(polygon[0])) continue;
      const area = Math.abs(ringArea(polygon[0]));
      if (area > bestArea) { bestArea = area; best = polygon; }
    }
    rings = best;
  } else if (geometry.type === "Point" && Array.isArray(geometry.coordinates)) {
    const [x, y] = geometry.coordinates;
    return Number.isFinite(x) && Number.isFinite(y) ? { point: [x, y], method: "point" } : null;
  }
  if (!Array.isArray(rings) || !Array.isArray(rings[0]) || rings[0].length < 4) return null;
  const outer = rings[0];
  if (!outer.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))) return null;

  const centroid = ringCentroid(outer);
  const holes = rings.slice(1).filter((r) => Array.isArray(r) && r.length >= 4);
  const inside = (p) => pointInRing(outer, p) && !holes.some((h) => pointInRing(h, p));
  if (inside(centroid)) return { point: centroid, method: "centroid" };

  const xs = outer.map((p) => p[0]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const steps = 400;
  let bestMid = null, bestLen = 0, runStart = null;
  for (let i = 0; i <= steps; i += 1) {
    const x = minX + ((maxX - minX) * i) / steps;
    if (inside([x, centroid[1]])) {
      if (runStart === null) runStart = x;
    } else if (runStart !== null) {
      const len = x - runStart;
      if (len > bestLen) { bestLen = len; bestMid = (runStart + x) / 2; }
      runStart = null;
    }
  }
  if (runStart !== null) {
    const len = maxX - runStart;
    if (len > bestLen) { bestLen = len; bestMid = (runStart + maxX) / 2; }
  }
  if (bestMid !== null) return { point: [bestMid, centroid[1]], method: "scanline" };
  return { point: centroid, method: "centroid-outside" };
}

const round7 = (value) => Math.round(value * 1e7) / 1e7;

/**
 * 楼栋轮廓 → 导航终点（GCJ-02）。任何一步不成立都返回 null，绝不猜。
 *
 * @param {object} options
 * @param {{type?:string, coordinates?:unknown}} options.geometry 轮廓几何（viewBox 空间）
 * @param {string} options.mapVersionId 轮廓所属的底图版本
 * @param {{ transform:object, mapVersionId?:string, transformUncertaintyMeters?:object }} options.params
 *        该校区的仿射参数记录（shared/campus-geo-transforms.mjs 的一项）
 * @returns {{ longitude:number, latitude:number, method:string, accuracyMeters:number|null } | null}
 */
export function deriveNavigationTarget({ geometry, mapVersionId, params }) {
  if (!params?.transform) return null;
  // 参数与底图同源检查 —— 见文件头注释，这是整个模块最重要的一条。
  if (params.mapVersionId && mapVersionId && params.mapVersionId !== mapVersionId) return null;
  const representative = representativePoint(geometry);
  if (!representative) return null;
  const [x, y] = representative.point;
  let inverse;
  try {
    inverse = invertGeoTransform(params.transform);
  } catch {
    return null;
  }
  const point = applyGeoTransform(inverse, x, y);
  const longitude = round7(point.x);
  const latitude = round7(point.y);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) return null;
  const uncertainty = params.transformUncertaintyMeters?.p90;
  return {
    longitude,
    latitude,
    method: representative.method,
    accuracyMeters: Number.isFinite(uncertainty) ? Number(uncertainty.toFixed(1)) : null,
  };
}
