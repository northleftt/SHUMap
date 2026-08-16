// 地图标记层与命中测试纯函数。
// 输入是 release 装配产物（MapPoi[]）与 parseSvgFeatures 解析出的底图要素：
//   - 独立点 POI（设施/商户/站点/楼外地点）→ 屏幕图钉（MapMarker），按可见性策略过滤；
//   - 楼宇 → 不出图钉（名字已在 SVG 底图上），但要有可点中的几何（BuildingShape，
//     footprint 取自 parseSvgFeatures 的 geometry，与 Web 端点楼宇选中行为一致）。
// hitTest 先认容差内最近的图钉，再认包含点的楼宇。纯函数，node 单测可直接跑。

import type { FilterKey, MapPoi } from "../release/types";
import { shouldRenderPointPoi } from "../release/filters";
import type { ParsedSvgFeature } from "../svg-geometry";
import type { Point } from "./viewport";

export interface MapMarker {
  poiKey: string;
  entityType: MapPoi["entityType"];
  name: string;
  kindName: string;
  iconKey: string;
  /** viewBox 世界坐标。 */
  x: number;
  y: number;
  /** 设施不可用且策略允许展示时置灰（对应 Web 端的弱化展示）。 */
  dimmed: boolean;
}

export interface BuildingShape {
  poiKey: string;
  name: string;
  kindName: string;
  sourceElementId: string;
  geometry: Record<string, unknown>;
  bbox: [number, number, number, number];
  center: Point;
}

export type MapHit =
  | { kind: "marker"; marker: MapMarker }
  | { kind: "building"; building: BuildingShape };

type Ring = number[][];
type PolygonCoords = Ring[];

function ringContainsPoint(ring: Ring, point: Point): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const start = ring[previous];
    const end = ring[index];
    if ((end[1] > point.y) !== (start[1] > point.y)) {
      const crossingX = ((start[0] - end[0]) * (point.y - end[1])) / (start[1] - end[1]) + end[0];
      if (point.x < crossingX) inside = !inside;
    }
  }
  return inside;
}

function polygonContainsPoint(coordinates: PolygonCoords, point: Point): boolean {
  const [shell, ...holes] = coordinates;
  if (!shell || !ringContainsPoint(shell, point)) return false;
  return !holes.some((hole) => ringContainsPoint(hole, point));
}

function isRing(value: unknown): value is Ring {
  return (
    Array.isArray(value)
    && value.length >= 3
    && value.every(
      (point) => Array.isArray(point) && point.length >= 2
        && typeof point[0] === "number" && typeof point[1] === "number",
    )
  );
}

/** 点是否落在 GeoJSON 风格几何内（仅面状几何可命中；线/点返回 false）。 */
export function pointInGeometry(geometry: Record<string, unknown>, point: Point): boolean {
  const type = geometry.type;
  const coordinates = geometry.coordinates;
  if (type === "Polygon" && Array.isArray(coordinates) && coordinates.every(isRing)) {
    return polygonContainsPoint(coordinates as PolygonCoords, point);
  }
  if (type === "MultiPolygon" && Array.isArray(coordinates)) {
    return (coordinates as unknown[]).some(
      (polygon) => Array.isArray(polygon) && (polygon as unknown[]).every(isRing)
        && polygonContainsPoint(polygon as PolygonCoords, point),
    );
  }
  if (type === "GeometryCollection" && Array.isArray(geometry.geometries)) {
    return (geometry.geometries as Record<string, unknown>[]).some(
      (child) => child && typeof child === "object" && pointInGeometry(child, point),
    );
  }
  return false;
}

/** 设施可见性：campusDefault 决定是否默认出图钉；不可用且策略不允许时隐藏、允许时置灰。 */
function markerVisible(poi: MapPoi): boolean {
  if (!poi.visibility.default) return false;
  if (poi.facilityOperationalStatus === "unavailable" && !poi.visibility.whenUnavailable) return false;
  return true;
}

/** 生成当前校区的图钉列表（世界坐标）。 */
export function buildMarkers(pois: MapPoi[], campusKey: string): MapMarker[] {
  return pois
    .filter((poi) => poi.campusKey === campusKey && poi.markerPoint !== null && markerVisible(poi))
    .map((poi) => ({
      poiKey: poi.poiKey,
      entityType: poi.entityType,
      name: poi.name,
      kindName: poi.kindName,
      iconKey: poi.markerIconKey ?? "generic",
      x: poi.markerPoint!.x,
      y: poi.markerPoint!.y,
      dimmed: poi.facilityOperationalStatus === "unavailable",
    }));
}

/**
 * 带筛选/搜索/选中态的图钉构建（可见性走 release/filters.shouldRenderPointPoi，
 * 与 Web 端 useMapPageState 的 visiblePointPois 同决策树）。无筛选无搜索无选中时
 * 结果与 buildMarkers 完全一致。matchedKeys 由调用方按 filterMapPois 算好。
 */
export function buildVisibleMarkers(
  pois: MapPoi[],
  campusKey: string,
  options: {
    selectedPoiKey: string | null;
    queryActive: boolean;
    activeFilters: readonly FilterKey[];
    matchedKeys: ReadonlySet<string>;
  },
): MapMarker[] {
  return pois
    .filter((poi) => poi.campusKey === campusKey && shouldRenderPointPoi({
      poi,
      selectedPoiKey: options.selectedPoiKey,
      queryActive: options.queryActive,
      activeFilters: options.activeFilters,
      matched: options.matchedKeys.has(poi.poiKey),
    }))
    .map((poi) => ({
      poiKey: poi.poiKey,
      entityType: poi.entityType,
      name: poi.name,
      kindName: poi.kindName,
      iconKey: poi.markerIconKey ?? "generic",
      x: poi.markerPoint!.x,
      y: poi.markerPoint!.y,
      dimmed: poi.facilityOperationalStatus === "unavailable",
    }));
}

/**
 * 生成当前校区楼宇的可点中几何。底图要素按 sourceElementId 与楼宇绑定，
// 没有 geometry（解析不出面）或不在本校区底图上的楼宇静默跳过——Web 端靠 DOM
 * querySelector 命中，缺失时抛错；小程序侧解析产物与底图同一份 SVG，缺失只可能是
 * 数据契约问题，由 release 装配阶段的校验兜底，这里不重复抛。
 */
export function buildBuildingShapes(
  pois: MapPoi[],
  features: ParsedSvgFeature[],
  campusKey: string,
): BuildingShape[] {
  const featureBySourceElementId = new Map(features.map((feature) => [feature.sourceElementId, feature]));
  const shapes: BuildingShape[] = [];
  for (const poi of pois) {
    if (poi.campusKey !== campusKey || poi.entityType !== "building") continue;
    const feature = featureBySourceElementId.get(poi.sourceElementId!);
    if (!feature || !feature.geometry || !feature.bbox) continue;
    shapes.push({
      poiKey: poi.poiKey,
      name: poi.name,
      kindName: poi.kindName,
      sourceElementId: poi.sourceElementId!,
      geometry: feature.geometry,
      bbox: feature.bbox,
      center: {
        x: (feature.bbox[0] + feature.bbox[2]) / 2,
        y: (feature.bbox[1] + feature.bbox[3]) / 2,
      },
    });
  }
  return shapes;
}

/**
 * 命中测试：先找容差（世界坐标单位，调用方用 tolPx/scale 换算）内最近的图钉，
 * 找不到再按 bbox 预筛 + 精确包含找楼宇。图钉优先——站点图钉常落在楼宇 footprint 上。
 */
export function hitTest(
  markers: MapMarker[],
  buildings: BuildingShape[],
  point: Point,
  tolerance: number,
): MapHit | null {
  let nearest: MapMarker | null = null;
  let nearestDistance = tolerance;
  for (const marker of markers) {
    const distance = Math.hypot(marker.x - point.x, marker.y - point.y);
    if (distance <= nearestDistance) {
      nearest = marker;
      nearestDistance = distance;
    }
  }
  if (nearest) return { kind: "marker", marker: nearest };
  // 多个 footprint 叠在一起时取面积（bbox 面积）最小的——最具体的那个。
  let best: BuildingShape | null = null;
  let bestArea = Infinity;
  for (const building of buildings) {
    const [minX, minY, maxX, maxY] = building.bbox;
    if (point.x < minX || point.x > maxX || point.y < minY || point.y > maxY) continue;
    if (!pointInGeometry(building.geometry, point)) continue;
    const area = (maxX - minX) * (maxY - minY);
    if (area < bestArea) {
      best = building;
      bestArea = area;
    }
  }
  return best ? { kind: "building", building: best } : null;
}
