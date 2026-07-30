import type { MapBuilding } from "../../lib/types";

const LEGACY_CATEGORY_LABELS: Record<string, string> = {
  building: "建筑",
  dorm: "宿舍",
  canteen: "食堂",
  library: "图书馆",
  other: "其他",
};

/**
 * place_kinds.id → 中文名。键必须是 schema 里真实的主键值
 * （migrations-v2/0001 的 place_kinds 种子行），此前用的是 `kind_*` 前缀写法，
 * 与任何一行都对不上，导致这张表永不命中、类目一律回落到原始 id。
 */
export const KIND_LABELS: Record<string, string> = {
  building: "建筑",
  outdoor_area: "室外区域",
  service_place: "服务地点",
  transit_stop: "交通站点",
  sports_venue: "运动场馆",
  residence: "宿舍",
  other: "其他",
};

/** POI 副标题类目（M2「图书馆 · 宝山校区」的左半部分）。 */
export function categoryLabel(building: MapBuilding): string {
  return (
    LEGACY_CATEGORY_LABELS[building.category] ??
    KIND_LABELS[building.kindId] ??
    building.category
  );
}
