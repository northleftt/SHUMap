// 用户定位 dot 的纯逻辑：gcj02 定位结果 → 当前校区 viewBox 下的蓝点 + 精度圈。
// 纯函数，node 单测可直接跑（tests/miniprogram-user-location.test.mjs）。
// 页面侧（pages/map/map）负责 wx.getLocation 轮询与渲染，这里只做坐标与尺寸判断。

import { applyGeoTransform, type GeoTransform } from "../geo-transform";

/** 精度圈上限：accuracy 超过该值（米）时不再画圈（圈会铺满大半个校区，没有信息量）。 */
export const MAX_ACCURACY_CIRCLE_METERS = 500;

/**
 * 上海纬度附近 1° 经度的近似地面距离（米）。
 * 只做经度方向的米→viewBox 单位近似换算（垂直方向随纬度有偏差，精度圈本来就是近似）。
 */
const METERS_PER_LONGITUDE_DEGREE = 95150;

export interface ViewBoxSize {
  width: number;
  height: number;
}

/** viewBox 坐标系下的定位 dot 渲染参数。 */
export interface UserLocationMarker {
  x: number;
  y: number;
  /** 精度圈半径（viewBox 单位）；0 = 不画圈（精度未知/非法/超过上限）。 */
  radius: number;
}

/** 点是否落在 viewBox 范围内（含边界）；超出当前校区时 dot 不显示。 */
export function isInsideViewBox(point: { x: number; y: number }, viewBox: ViewBoxSize): boolean {
  return (
    Number.isFinite(point.x)
    && Number.isFinite(point.y)
    && point.x >= 0
    && point.x <= viewBox.width
    && point.y >= 0
    && point.y <= viewBox.height
  );
}

/**
 * 米 → viewBox 单位（经度方向近似）：
 * 1° 经度 ≈ 95150m，对应 viewBox 的 hypot(t.a, t.d) 个单位（x、y 对经度的偏导）。
 */
export function metersToViewBoxUnits(meters: number, transform: GeoTransform): number {
  return meters / (METERS_PER_LONGITUDE_DEGREE / Math.hypot(transform.a, transform.d));
}

/**
 * gcj02 定位结果 → 当前校区 viewBox 下的 dot。
 * 坐标不在当前校区 viewBox 内时返回 null（dot 隐藏）；
 * accuracy 非法（NaN/≤0）或超过 MAX_ACCURACY_CIRCLE_METERS 时 radius 为 0（只画点不画圈）。
 */
export function computeUserLocationMarker({
  transform,
  longitude,
  latitude,
  accuracyMeters,
  viewBox,
}: {
  transform: GeoTransform;
  longitude: number;
  latitude: number;
  accuracyMeters: number;
  viewBox: ViewBoxSize;
}): UserLocationMarker | null {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  const point = applyGeoTransform(transform, longitude, latitude);
  if (!isInsideViewBox(point, viewBox)) return null;
  const showCircle = Number.isFinite(accuracyMeters)
    && accuracyMeters > 0
    && accuracyMeters <= MAX_ACCURACY_CIRCLE_METERS;
  return {
    x: point.x,
    y: point.y,
    radius: showCircle ? metersToViewBoxUnits(accuracyMeters, transform) : 0,
  };
}

/** 校区地理边界：geoTransform + svgRaw 解析出的 viewBox（页面侧解析一次缓存，别每次轮询都解析）。 */
export interface CampusGeoBounds {
  key: string;
  geoTransform: GeoTransform;
  viewBox: ViewBoxSize & { x?: number; y?: number };
}

/**
 * gcj02 坐标落在哪个校区的 viewBox 内 → 该校区的 key；都不在返回 null。
 * 多个校区重叠时取数组中的第一个匹配（三校区实际不相交）。
 * 注意 viewBox 原点可能非零（parseSvgViewBox 返回 {x,y,width,height}），比较前减去原点。
 */
export function campusKeyForGcj02Point(
  campuses: CampusGeoBounds[],
  longitude: number,
  latitude: number,
): string | null {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  for (const campus of campuses) {
    const point = applyGeoTransform(campus.geoTransform, longitude, latitude);
    const originX = campus.viewBox.x ?? 0;
    const originY = campus.viewBox.y ?? 0;
    if (isInsideViewBox({ x: point.x - originX, y: point.y - originY }, campus.viewBox)) {
      return campus.key;
    }
  }
  return null;
}
