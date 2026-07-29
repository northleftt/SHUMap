export type CampusKey = "baoshan" | "jiading" | "yanchang";

export type FilterKey =
  | "teaching"
  | "office"
  | "dorm"
  | "canteen"
  | "library"
  | "commercial"
  | "printing"
  | "parking"
  | "powerBank";

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
  key: CampusKey;
  label: string;
  svgRaw: string;
  focusPoint: { x: number; y: number };
  scaleMultiplier: number;
  minScaleMultiplier: number;
  edgePaddingRatio: number;
  selectionEdgePaddingRatio: number;
  selectionScaleMultiplier: number;
}

/**
 * A release-derived building rendered on the campus map.
 *
 * - `id` / `poiKey`: the stable place ID — the sole business identity.
 * - `svgElementId`: render-only selector for the campus SVG. Never a business ID.
 */
export interface MapBuilding {
  id: string;
  poiKey: string;
  svgElementId: string;
  name: string;
  campusKey: CampusKey;
  campusLabel: string;
  category: string;
  kindId: string;
  filterGroups: FilterKey[];
  tags: string[];
  detail: PoiDetailData;
  navigationUrls: NavigationUrls | null;
  /** 楼内商户（release manifest 的 merchants 按 hostPlaceId 归组）。 */
  merchants: MerchantSummary[];
}

export interface MapViewport {
  scale: number;
  translateX: number;
  translateY: number;
}
