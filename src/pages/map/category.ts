import type { MapBuilding } from "../../lib/types";

const LEGACY_CATEGORY_LABELS: Record<string, string> = {
  building: "建筑",
  dorm: "宿舍",
  canteen: "食堂",
  library: "图书馆",
  other: "其他",
};

const KIND_LABELS: Record<string, string> = {
  kind_building: "建筑",
  kind_outdoor: "室外区域",
  kind_service: "服务地点",
  kind_transit: "交通站点",
  kind_sports: "运动场馆",
  kind_residence: "宿舍",
  kind_other: "其他",
};

/** POI 副标题类目（M2「图书馆 · 宝山校区」的左半部分）。 */
export function categoryLabel(building: MapBuilding): string {
  return (
    LEGACY_CATEGORY_LABELS[building.category] ??
    KIND_LABELS[building.kindId] ??
    building.category
  );
}
