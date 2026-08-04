import type { FacilityOperationalStatus, PublicPlaceFacility } from "./api/types";

export type CampusKey = "baoshan" | "jiading" | "yanchang";

export type FilterKey = string;

export type MapSheetMode =
  | "fullscreen_map"
  | "default_search"
  | "partial_results"
  | "full_results"
  | "poi_detail";

export interface PoiDetailData {
  summary: string;
  description: string;
  media: Array<{
    id?: string;
    role: "cover" | "gallery";
    url: string;
    alt?: string;
    caption?: string;
  }>;
  facts: Array<{
    id?: string;
    label: string;
    value: string;
  }>;
}

/** content_json.menu 条目（商户可选扩展字段）。 */
export interface MerchantMenuItem {
  name: string;
  price: string;
  description: string;
}

/**
 * 商户门店（merchant_outlet）在前台的展示模型。
 *
 * 商户不单设页面：按 release manifest 的 `hostPlaceId` 归到所在地点，
 * 复用 M2 POI 详情版式渲染（扩展字段 menu / 档口号 / 人均）。
 */
export interface MerchantSummary {
  id: string;
  name: string;
  businessType: string;
  openingHours: string;
  stallCode: string;
  phone: string;
  avgPrice: string;
  summary: string;
  media: PoiDetailData["media"];
  floorId: string | null;
  menu: MerchantMenuItem[];
}

export interface NavigationUrls {
  amap: string;
  tencent: string;
  baidu: string;
  system: string;
}

export interface CampusConfig {
  id: string;
  key: CampusKey;
  label: string;
  mapVersionId: string;
  svgRaw: string;
  focusPoint: { x: number; y: number };
  scaleMultiplier: number;
  minScaleMultiplier: number;
  edgePaddingRatio: number;
  selectionEdgePaddingRatio: number;
  selectionScaleMultiplier: number;
}

/** A campus-map POI backed by an SVG footprint or an independent point marker. */
export type MapPoiKind = "building" | "place" | "facility" | "merchant";

export interface MapPoiPoint {
  x: number;
  y: number;
}

export interface MapPoiVisibility {
  default: boolean;
  searchable: boolean;
  filterable: boolean;
  search: boolean;
  filter: boolean;
  whenUnavailable: boolean;
}

/**
 * Release-derived POI used by the campus map, search list, and detail sheet.
 *
 * Buildings keep their imported SVG identity. Independent outdoor entities use
 * `markerPoint` and intentionally leave the three footprint fields null.
 */
export interface MapPoi {
  id: string;
  poiKey: string;
  revisionId: string;
  entityType: MapPoiKind;
  entityId: string;
  mapFeatureId: string | null;
  mapVersionId: string | null;
  sourceElementId: string | null;
  markerPoint: MapPoiPoint | null;
  markerIconKey: string | null;
  name: string;
  campusKey: CampusKey;
  campusLabel: string;
  kindId: string;
  kindName: string;
  filterGroups: FilterKey[];
  detail: PoiDetailData;
  navigationUrls: NavigationUrls | null;
  /** 楼内设施已经由同一 release 解析并挂到楼宇。 */
  facilities: PublicPlaceFacility[];
  /** 楼内商户（release manifest 的 merchants 按 hostPlaceId 归组）。 */
  merchants: MerchantSummary[];
  /** 独立设施的发布快照状态；其他 POI 没有该字段。 */
  facilityOperationalStatus: FacilityOperationalStatus | null;
  /** 设施类型策略控制默认、搜索、筛选及不可用状态下的小图标。 */
  visibility: MapPoiVisibility;
}

/** Buildings remain a distinct subset for floors, shuttle links, and collection flows. */
export interface MapBuilding extends MapPoi {
  entityType: "building";
  mapFeatureId: string;
  mapVersionId: string;
  sourceElementId: string;
  markerPoint: null;
}

export interface MapPointPoi extends MapPoi {
  entityType: "place" | "facility" | "merchant";
  mapFeatureId: null;
  mapVersionId: null;
  sourceElementId: null;
  markerPoint: MapPoiPoint;
}

/** The only rendering identity MapCanvas accepts from application code. */
export interface MapFeatureBinding {
  id: string;
  sourceElementId: string;
}

export interface MapViewport {
  scale: number;
  translateX: number;
  translateY: number;
}
