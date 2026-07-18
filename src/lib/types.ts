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
}

export interface MapViewport {
  scale: number;
  translateX: number;
  translateY: number;
}
