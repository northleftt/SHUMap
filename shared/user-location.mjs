// 网页端「用户定位 dot」的纯逻辑：wgs84 → 校区 viewBox 坐标、精度圈米数换算、
// 校区范围判断。浏览器 geolocation 返回 wgs84，必须先 wgs84ToGcj02 再进仿射
// （背景见 shared/geo-transform.mjs 头注释）。

import { applyGeoTransform, wgs84ToGcj02 } from "./geo-transform.mjs";

// 上海纬度下 1° 经度 ≈ 95150 米（与 scripts/generate_geo_transform.mjs 的配准口径一致）。
export const METERS_PER_DEGREE_LNG = 95150;

/**
 * wgs84(lng,lat) → 校区 SVG viewBox(x,y)。
 * @param {import("./geo-transform.mjs").GeoTransform} transform
 */
export function wgs84ToViewBoxPoint(transform, longitude, latitude) {
  const gcj = wgs84ToGcj02(longitude, latitude);
  return applyGeoTransform(transform, gcj.longitude, gcj.latitude);
}

/**
 * 定位精度（米）→ viewBox 单位（精度圈半径）。
 * viewBox 单位/米 = hypot(a,d) / 95150：经度方向 1° 在 viewBox 里走 hypot(a,d) 个单位。
 * @param {import("./geo-transform.mjs").GeoTransform} transform
 */
export function metersToViewBoxUnits(transform, meters) {
  return meters / (METERS_PER_DEGREE_LNG / Math.hypot(transform.a, transform.d));
}

/** 点是否落在校区 viewBox 范围内（不在当前校区则不渲染 dot）。 */
export function isPointInViewBox(point, viewBox) {
  return (
    point.x >= viewBox.x &&
    point.x <= viewBox.x + viewBox.width &&
    point.y >= viewBox.y &&
    point.y <= viewBox.y + viewBox.height
  );
}

/**
 * gcj02(lng,lat) → 落在哪个校区的 viewBox 内；都不在返回 null。
 * 入参是 gcj02（网页端 geolocation 的 wgs84 需先经 wgs84ToGcj02 转换）。
 * viewBox 由调用方解析并缓存（别每次定位回调都重解析 SVG）。
 * @param {Array<{ key:string, geoTransform:import("./geo-transform.mjs").GeoTransform, viewBox:{x:number,y:number,width:number,height:number} }>} campuses
 */
export function campusKeyForGcj02Point(campuses, longitude, latitude) {
  for (const campus of campuses) {
    const point = applyGeoTransform(campus.geoTransform, longitude, latitude);
    if (isPointInViewBox(point, campus.viewBox)) return campus.key;
  }
  return null;
}
