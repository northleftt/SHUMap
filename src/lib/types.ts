export type CampusKey = "baoshan" | "jiading" | "yanchang";

export type FilterKey =
  | "teaching"
  | "office"
  | "dorm"
  | "canteen"
  | "library"
  | "commercial"
  | "printing"
  | "parking";

export type MapSheetMode =
  | "fullscreen_map"
  | "default_search"
  | "partial_results"
  | "full_results"
  | "poi_detail";

export interface NavigationData {
  coordSystem: string;
  longitude: number;
  latitude: number;
  address?: string;
  mapDisplayName?: string;
}

export interface RawBuilding {
  svgElementId: string;
  name: string;
  campus: string;
  category: string;
  navigation?: NavigationData;
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

export interface MapBuilding extends RawBuilding {
  campusKey: CampusKey;
  poiKey: string;
  campusLabel: string;
  filterGroups: FilterKey[];
  amapUrl: string | null;
}

export interface MapViewport {
  scale: number;
  translateX: number;
  translateY: number;
}
