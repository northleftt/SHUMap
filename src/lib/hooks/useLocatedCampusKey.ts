import { useEffect, useMemo, useState } from "react";
import { wgs84ToGcj02 } from "../../../shared/geo-transform.mjs";
import { parseSvgViewBox } from "../../../shared/svg-geometry.mjs";
import { campusKeyForGcj02Point, type CampusGeoEntry } from "../../../shared/user-location.mjs";
import type { CampusConfig, CampusKey } from "../types";

/**
 * 定位所在校区（与地图页定位 dot 同一套逻辑：watchPosition 持续定位，
 * wgs84 → gcj02 → 各校区 viewBox 命中判定）。定位不可用 / 不在任何校区
 * 范围内时返回 null，由调用方按默认顺序（宝山→嘉定→延长）兜底。
 */
export function useLocatedCampusKey(campuses: readonly CampusConfig[]): CampusKey | null {
  const [located, setLocated] = useState<CampusKey | null>(null);
  // viewBox 解析在此缓存，定位回调不重复解析 SVG（同 MapPage）。
  const geoIndex = useMemo<CampusGeoEntry[]>(
    () => campuses.map((campus) => ({
      key: campus.key,
      geoTransform: campus.geoTransform,
      viewBox: parseSvgViewBox(campus.svgRaw),
    })),
    [campuses],
  );
  useEffect(() => {
    if (!("geolocation" in navigator) || geoIndex.length === 0) return;
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const gcj = wgs84ToGcj02(position.coords.longitude, position.coords.latitude);
        const key = campusKeyForGcj02Point(geoIndex, gcj.longitude, gcj.latitude);
        if (key) setLocated(key as CampusKey);
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 30000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [geoIndex]);
  return located;
}
