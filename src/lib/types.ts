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
  typeLabel: string;
  facilityNotes: string;
  organization: string;
  openHours: string;
  phone: string;
  accessMethod: string;
  coverImageUrl: string;
  galleryImageUrl: string;
  hasPrinter: boolean | null;
  hasElevator: boolean | null;
  hasVendingMachine: boolean | null;
  hasPowerBank: boolean | null;
  hasParking: boolean | null;
}

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
  detail?: Partial<PoiDetailData>;
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

export interface MapBuilding extends Omit<RawBuilding, "detail"> {
  detail: PoiDetailData;
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
