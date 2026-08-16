// release 通路需要的类型定义。按需搬运自 Web 端：
//   - src/lib/api/types.ts 的 release manifest 部分（ReleaseCampus … ReleaseManifest）
//   - src/lib/types.ts 的地图模型部分（CampusConfig / MapPoi / MerchantSummary 等）
// 只保留 release 装配用到的，其余（search/places 详情/供稿）用到了再补。

// ---------------------------------------------------------------------------
// Release manifest（GET /api/public/releases/current | /releases/:id）
// ---------------------------------------------------------------------------

export interface ReleaseCampus {
  id: string;
  code: string;
  name: string;
  timezone: string;
}

export interface ReleasePlace {
  id: string;
  kindId: string;
  kindName: string;
  isBuilding: boolean;
  campusId: string | null;
  parentPlaceId: string | null;
  lifecycleStatus: string;
  revisionId: string;
  displayName: string;
  summary: string | null;
  description: string | null;
  content: Record<string, unknown>;
  contentHash: string;
  aliases: string[];
}

export type FacilityOperationalStatus = "available" | "partially_available" | "unavailable" | "unknown";

export interface ReleaseFacility {
  id: string;
  facilityTypeId: string;
  hostPlaceId: string | null;
  floorId: string | null;
  indoorSpaceId: string | null;
  operationalStatus: FacilityOperationalStatus;
  quantity: number | null;
  revisionId: string;
  displayName: string;
  facilityTypeStatus: "active" | "disabled";
  serviceHours: { text: string } | null;
  content: Record<string, unknown>;
  contentHash: string;
  visibilityPolicy: Record<string, unknown>;
}

export interface ReleaseMerchant {
  id: string;
  organizationId: string | null;
  hostPlaceId: string | null;
  floorId: string | null;
  indoorSpaceId: string | null;
  revisionId: string;
  displayName: string;
  businessType: string | null;
  openingHours: { text: string } | null;
  contact: { phone: string } | null;
  content: Record<string, unknown>;
  contentHash: string;
}

export interface ReleaseFloor {
  id: string;
  buildingPlaceId: string;
  levelCode: string;
  levelOrder: number;
  displayName: string;
  isPublic: 0 | 1;
}

export interface ReleaseFacilityType {
  id: string;
  code: string;
  name: string;
  category: string;
  iconKey: string | null;
  status: "active" | "disabled";
}

export interface ReleaseMapFilter {
  id: string;
  key: string;
  label: string;
  sortOrder: number;
  placeKindIds: string[];
  facilityTypeIds: string[];
  includesMerchants: boolean;
}

export interface ReleaseMapVersion {
  id: string;
  campus_id: string | null;
  floor_id: string | null;
  map_asset_id: string;
  parent_version_id: string | null;
  campusCode: string | null;
  campusName: string | null;
  version_label: string;
  coordinate_space_type: "svg_viewbox" | "normalized_image" | "local_metric" | "geographic";
  coordinate_space_json: string;
  parser_version: string | null;
  lifecycle_status: "ready" | "published";
  created_by: string | null;
  created_at: string;
  checksum: string;
  assetKey: string;
}

export interface ReleaseLocation {
  entityType: "place" | "facility" | "merchant_outlet" | "transit_stop";
  entityId: string;
  role: string;
  isPrimary: 0 | 1;
  id: string;
  campus_id: string | null;
  building_place_id: string | null;
  floor_id: string | null;
  indoor_space_id: string | null;
  geometry_type: "Point" | "LineString" | "Polygon" | "MultiPolygon";
  geometry_json: string | null;
  crs: string | null;
  map_version_id: string | null;
  map_feature_id: string | null;
  sourceElementId: string | null;
  featureKind: "building_footprint" | "road" | "path" | "entrance" | "room" | "label" | "water" | "green" | "area" | "other" | null;
  location_hint: string | null;
  precision_level: "campus" | "building" | "floor" | "space" | "exact" | "unknown";
  accuracy_meters: number | null;
  source_id: string | null;
  verification_status: "unverified" | "reviewed" | "verified" | "rejected";
  verified_by: string | null;
  verified_at: string | null;
  valid_from: string | null;
  valid_to: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReleaseTransit {
  stops: TransitStop[];
}

export interface TransitStop {
  id: string;
  place_id: string | null;
  campus_id: string | null;
  code: string | null;
  name: string;
  status: "active";
  created_at: string;
  updated_at: string;
}

export type MapTarget =
  | { type: "locationAnchor"; id: string }
  | { type: "place"; id: string }
  | { type: "facility"; id: string }
  | { type: "merchant_outlet"; id: string };

export interface SearchDocument {
  documentType: "place" | "facility" | "merchant_outlet";
  entityId: string;
  title: string;
  subtitle: string | null;
  normalizedText: string;
  pinyin: string | null;
  campusId: string | null;
  buildingPlaceId: string | null;
  floorId: string | null;
  facets: Array<string>;
  mapTarget: MapTarget;
  rankingWeight: number;
}

export interface ReleaseManifest {
  schemaVersion: 2;
  release: { id: string; version: string; createdAt: string };
  campuses: ReleaseCampus[];
  places: ReleasePlace[];
  facilities: ReleaseFacility[];
  merchants: ReleaseMerchant[];
  maps: ReleaseMapVersion[];
  locations: ReleaseLocation[];
  floors: ReleaseFloor[];
  facilityTypes: ReleaseFacilityType[];
  mapFilters: ReleaseMapFilter[];
  transit: ReleaseTransit;
  searchDocuments: SearchDocument[];
  generatedAt: string;
}

/** GET /api/public/places/:id 的楼内设施条目（release 装配也复用它挂在楼宇/POI 上）。 */
export interface PublicPlaceFacility {
  id: string;
  typeCode: string;
  typeName: string;
  displayName: string;
  operationalStatus: string;
  floorId: string | null;
  /** Parsed facility revision content_json — carries 位置描述 etc. */
  content: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 地图模型（release 装配产物）
// ---------------------------------------------------------------------------

export type CampusKey = "baoshan" | "jiading" | "yanchang";

export type FilterKey = string;

export interface PoiDetailData {
  summary: string;
  description: string;
  media: Array<{
    id?: string;
    role: "cover" | "gallery";
    url: string;
    alt?: string;
    caption?: string;
    floorLevelCode?: string;
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

/** 商户门店（merchant_outlet）在前台的展示模型。 */
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

/** gcj02 → SVG viewBox 仿射变换参数（scripts/generate_geo_transform.mjs 拟合）。 */
export interface GeoTransform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface CampusConfig {
  id: string;
  key: CampusKey;
  label: string;
  mapVersionId: string;
  svgRaw: string;
  focusPoint: { x: number; y: number };
  geoTransform: GeoTransform;
  scaleMultiplier: number;
  minScaleMultiplier: number;
  edgePaddingRatio: number;
  selectionEdgePaddingRatio: number;
  selectionScaleMultiplier: number;
}

/** A campus-map POI backed by an SVG footprint or an independent point marker. */
export type MapPoiKind = "building" | "place" | "facility" | "merchant" | "transit_stop";

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
  /**
   * 校车站点不走修订流（改一个字段即时生效），所以没有修订号。其余实体都有。
   * 供稿要基于修订号提交，因此取这个字段的地方必须先判空。
   */
  revisionId: string | null;
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
  /** GCJ-02 导航坐标（wx.openLocation 直接用）；无导航锚点时为 null。 */
  navigationPoint: { longitude: number; latitude: number; displayName: string } | null;
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
  revisionId: string;
  mapFeatureId: string;
  mapVersionId: string;
  sourceElementId: string;
  markerPoint: null;
}
