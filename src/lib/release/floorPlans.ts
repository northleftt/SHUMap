// M5 楼层平面图的 release 派生数据。
//
// 两块信息都来自 active release manifest：
//   - maps[]      → 楼层图版本（map_versions 行，campus_id/floor_id 二选一）
//   - locations[] → 设施锚点（entity_locations ⋈ location_anchors）
//
// 楼层图资产本身不进 manifest，只带 map version id；SVG 走
// GET /api/public/maps/:mapVersionId/asset 按 release 成员资格读取。

import type { ReleaseLocation, ReleaseManifest, ReleaseMapVersion } from "../api/types";

/** 平面图可用的楼层图版本，按 floorId 索引。 */
export function floorMapVersionsByFloor(manifest: ReleaseManifest | null | undefined): Map<string, ReleaseMapVersion> {
  const byFloor = new Map<string, ReleaseMapVersion>();
  for (const version of manifest?.maps ?? []) {
    if (!version.floor_id) continue;
    // 平面图只认 svg_viewbox：徽章坐标与 viewBox 同一坐标系才谈得上叠加。
    if (version.coordinate_space_type !== "svg_viewbox") continue;
    byFloor.set(version.floor_id, version);
  }
  return byFloor;
}

export interface FacilityAnchorPoint {
  /** location_anchors.id，作为徽章 key */
  id: string;
  facilityId: string;
  x: number;
  y: number;
}

function pointOf(location: ReleaseLocation): { x: number; y: number } | null {
  if (!location.geometry_json) return null;
  try {
    const geometry = JSON.parse(location.geometry_json) as { type?: string; coordinates?: unknown };
    if (geometry.type !== "Point" || !Array.isArray(geometry.coordinates)) return null;
    const [x, y] = geometry.coordinates as number[];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  } catch {
    return null;
  }
}

/**
 * 某楼层图上的设施锚点。取 role='service_position'、crs='svg_viewbox' 的 Point，
 * 且锚点要么直接绑这张图（map_version_id），要么绑同一楼层（floor_id）。
 *
 * A11 设施编辑器暂不能编辑锚点，所以现网大概率返回空数组——调用方必须把
 * 「只有图纸、没有徽章」当正常状态处理。
 */
export function facilityAnchorsForFloor(
  manifest: ReleaseManifest | null | undefined,
  floorId: string,
  mapVersionId: string,
): FacilityAnchorPoint[] {
  const anchors: FacilityAnchorPoint[] = [];
  const seenFacilities = new Set<string>();
  for (const location of manifest?.locations ?? []) {
    if (location.entityType !== "facility" || location.role !== "service_position") continue;
    if (location.crs !== "svg_viewbox") continue;
    const boundToThisMap = location.map_version_id === mapVersionId;
    if (!boundToThisMap && location.floor_id !== floorId) continue;
    // 锚点绑了别的底图版本时不能按本图坐标画。
    if (location.map_version_id && !boundToThisMap) continue;
    const point = pointOf(location);
    if (!point) continue;
    // 一个设施在同一层只画一个徽章，优先 is_primary。
    if (seenFacilities.has(location.entityId) && location.isPrimary !== 1) continue;
    seenFacilities.add(location.entityId);
    anchors.push({ id: String(location.id), facilityId: location.entityId, x: point.x, y: point.y });
  }
  return anchors;
}
