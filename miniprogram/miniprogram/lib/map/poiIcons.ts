// 列表行/设施的图标名（images/poi/<name>.png，由 scripts/generate-tab-icons.mjs 生成）。
// 语义对齐 Web 端：SearchHomeSheet.PlaceSquareIcon（行图标）与
// facilityIcons.facilityIcon（设施类型 → 图标，未知用通用标记兜底）。

import type { MapPoi } from "../release/types";

/** facility_types.code → 图标名（对齐 FACILITY_ICONS 九个内置类型）。 */
const FACILITY_TYPE_ICONS: Record<string, string> = {
  printer: "printer",
  study_area: "desk",
  restroom: "restroom",
  drinking_water: "water",
  elevator: "elevator",
  vending_machine: "vending",
  power_bank: "battery",
  charging_station: "charging",
  service_center: "service",
};

/** FACILITY_ICON_BY_KEY 的合法 key 全集（图标脚本按这张表出图，页面按 key 取图）。 */
const FACILITY_ICON_KEYS = new Set([
  "printer", "desk", "restroom", "water", "elevator", "vending", "battery", "charging",
  "service", "wifi", "food", "parking", "bike", "bus", "mail", "health", "lounge",
  "locker", "security", "landmark", "sports", "trash", "generic",
]);

/** icon_key → 图标名；未知或留空用 generic 兜底（对齐 facilityIconByKey）。 */
export function facilityIconNameByKey(iconKey: string | null | undefined): string {
  return iconKey && FACILITY_ICON_KEYS.has(iconKey) ? iconKey : "generic";
}

/** 类型编码 → 图标名（对齐 facilityIcon：内置类型表 → icon_key 同名匹配 → 兜底）。 */
export function facilityIconName(typeCode: string): string {
  return FACILITY_TYPE_ICONS[typeCode] ?? facilityIconNameByKey(typeCode);
}

/** 列表行图标（对齐 PlaceSquareIcon）：楼宇=building-2、商户=store、
 *  设施/站点=facilityIconByKey(markerIconKey)、其他=map-pin。 */
export function poiRowIconName(poi: Pick<MapPoi, "entityType" | "markerIconKey">): string {
  if (poi.entityType === "building") return "building-2";
  if (poi.entityType === "merchant") return "store";
  if (poi.entityType === "facility" || poi.entityType === "transit_stop") {
    return facilityIconNameByKey(poi.markerIconKey);
  }
  return "map-pin";
}

/**
 * 地图图钉图标（对齐 Web 端 MapPoiOverlay，规则与列表行**不同**）：
 * 商户=store，其余一律 facilityIconByKey(markerIconKey)——楼外地点与站点
 * 也走 icon_key（站点的 icon_key 固定是 bus），未知 key 落 generic。
 */
export function markerIconName(marker: { entityType: MapPoi["entityType"]; iconKey: string }): string {
  return marker.entityType === "merchant" ? "store" : facilityIconNameByKey(marker.iconKey);
}
