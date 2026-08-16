import { useMemo } from "react";
import { parseSvgViewBox } from "../../../shared/svg-geometry.mjs";
import {
  isPointInViewBox,
  metersToViewBoxUnits,
  wgs84ToViewBoxPoint,
} from "../../../shared/user-location.mjs";
import { markerUnit } from "../../lib/map/markerScale";
import type { CampusConfig } from "../../lib/types";
import type { MapViewWindow } from "./MapCanvas";

/** 精度差于该值（米）就不画精度圈——圈太大只会糊满屏幕，只剩 dot 示意。 */
const MAX_ACCURACY_CIRCLE_METERS = 500;

export interface UserLocationPosition {
  longitude: number;
  latitude: number;
  /** 水平精度（米），geolocation coords.accuracy。 */
  accuracy: number;
}

/**
 * 用户定位 dot（结构与 MapPoiOverlay 同范式：绝对定位 svg 直接画世界坐标）。
 * wgs84 → wgs84ToGcj02 → applyGeoTransform；落在当前校区 viewBox 外不渲染。
 */
export function MapUserLocationOverlay({
  viewWindow,
  campus,
  position,
}: {
  viewWindow: MapViewWindow | null;
  campus: CampusConfig;
  position: UserLocationPosition | null;
}) {
  const viewBox = useMemo(() => parseSvgViewBox(campus.svgRaw), [campus.svgRaw]);
  if (!viewWindow || !position) return null;
  const point = wgs84ToViewBoxPoint(campus.geoTransform, position.longitude, position.latitude);
  if (!isPointInViewBox(point, viewBox)) return null;
  // 以较短视轴换算 dot 尺寸，让横屏与窄屏保持相近的屏幕像素大小（同 MapPoiOverlay 的
  // 基准单位）。这里不吃图钉大小档位——「我的位置」是定位指示，不随图钉一起缩放。
  const unit = markerUnit(viewWindow);
  const accuracyRadius =
    position.accuracy > 0 && position.accuracy <= MAX_ACCURACY_CIRCLE_METERS
      ? metersToViewBoxUnits(campus.geoTransform, position.accuracy)
      : null;

  return (
    <svg
      aria-label="我的位置"
      className="absolute inset-0 h-full w-full"
      preserveAspectRatio="xMidYMid meet"
      style={{ pointerEvents: "none" }}
      viewBox={`${viewWindow.x} ${viewWindow.y} ${viewWindow.width} ${viewWindow.height}`}
    >
      {accuracyRadius !== null ? (
        <circle cx={point.x} cy={point.y} fill="#1e80c1" opacity={0.15} r={accuracyRadius} />
      ) : null}
      <circle
        cx={point.x}
        cy={point.y}
        fill="#1e80c1"
        r={unit * 0.42}
        stroke="#ffffff"
        strokeWidth={unit * 0.14}
      />
    </svg>
  );
}
