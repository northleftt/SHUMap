// Types mirroring the v2 Worker public/admin contracts.
// Sources of truth: worker/modules/releases.ts (candidate builder + search documents)
// and worker/modules/public.ts (endpoint payloads).

// ---------------------------------------------------------------------------
// Release manifest (GET /api/public/releases/current | /releases/:id)
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

/**
 * 楼层骨架（floors 表的 lifecycle active 行）。楼层此前不进 manifest，客户端
 * 只能绕过 release 直读 GET /api/public/places/:id 才拿得到楼层。
 */
export interface ReleaseFloor {
  id: string;
  buildingPlaceId: string;
  levelCode: string;
  levelOrder: number;
  displayName: string;
  isPublic: 0 | 1;
}

/**
 * 设施类型字典。设施行只带 facilityTypeId（形如 facility_type_printer），
 * 真实业务代码（printer / power_bank / …）在这里，前端筛选按 code 匹配。
 */
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

/**
 * 快照里只留站点：站点带几何，属于地图数据。线路/班次/时刻/日历都是实时数据，
 * 走 GET /api/public/transit/journeys 与 /transit/trips/:tripId/stops，不再冻结进 manifest。
 */
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

// ---------------------------------------------------------------------------
// GET /api/public/search
// ---------------------------------------------------------------------------

export interface SearchResult {
  type: string;
  id: string;
  title: string;
  subtitle: string | null;
  campusId: string | null;
  buildingPlaceId: string | null;
  floorId: string | null;
  facets: string[];
  mapTarget: MapTarget | null;
  rankingWeight: number;
}

export interface SearchResponse {
  query: string;
  releaseId?: string;
  results: SearchResult[];
}

// ---------------------------------------------------------------------------
// GET /api/public/places/:id
// ---------------------------------------------------------------------------

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

export interface PublicPlaceFloor {
  id: string;
  levelCode: string;
  levelOrder: number;
  displayName: string | null;
}

export interface PublicPlaceResponse {
  releaseId: string;
  place: {
    id: string;
    kindId: string;
    kindName: string;
    isBuilding: boolean;
    campusId: string | null;
    lifecycleStatus: string;
    displayName: string;
    summary: string | null;
    description: string | null;
    content: Record<string, unknown>;
    aliases: string[];
  };
  locations: ReleaseLocation[];
  facilities: PublicPlaceFacility[];
  floors: PublicPlaceFloor[];
}

export interface PublicPlaceListItem {
  id: string;
  kindId: string;
  kindName: string;
  isBuilding: boolean;
  campusId: string | null;
  displayName: string;
  summary: string | null;
}

export interface PublicPlaceListResponse {
  releaseId: string;
  items: PublicPlaceListItem[];
}

// ---------------------------------------------------------------------------
// GET /api/public/transit/journeys
// ---------------------------------------------------------------------------

export interface Journey {
  tripId: string;
  routeId: string;
  routeName: string;
  patternId: string;
  bookingPolicy: string;
  bookingUrl: string | null;
  departureTime: string;
  /** null when the source only carries departure times. */
  arrivalTime: string | null;
  fromSequence: number;
  toSequence: number;
}

export interface JourneysResponse {
  date: string;
  timezone: string;
  journeys: Journey[];
}

// ---------------------------------------------------------------------------
// GET /api/public/transit/trips/:tripId/stops
// ---------------------------------------------------------------------------

/** 一个班次的完整停靠序列（pattern 顺序 + 该班次的到发时刻）。 */
export interface TripStop {
  stopId: string;
  stopName: string;
  stopSequence: number;
  pickupType: string;
  dropoffType: string;
  arrivalTime: string | null;
  departureTime: string | null;
}

export interface TripStopsResponse {
  tripId: string;
  patternId: string;
  stops: TripStop[];
}

// ---------------------------------------------------------------------------
// GET /api/public/facility-status
// ---------------------------------------------------------------------------

/** 设施 id → operational_status，盖在 manifest 的基线值之上。 */
export type FacilityOperationalStatus = "available" | "partially_available" | "unavailable" | "unknown";

export interface FacilityStatusResponse {
  statuses: Record<string, FacilityOperationalStatus>;
}

// ---------------------------------------------------------------------------
// Operations & campaigns (GET /api/public/operations | /campaigns)
// ---------------------------------------------------------------------------

export interface OperationalEventTarget {
  targetType:
    | "place"
    | "floor"
    | "space"
    | "facility"
    | "merchant_outlet"
    | "transit_stop"
    | "transit_route"
    | "transit_trip"
    | "map_feature";
  targetId: string;
  impactType: string;
}

export interface OperationalEventUpdate {
  id: string;
  status: string;
  message: string;
  createdAt: string;
}

/** 事件位置（live 下发，不经 release manifest）；geometryJson 为 GeoJSON 字符串。 */
export interface OperationalEventLocation {
  id: string;
  role: "event_location" | "impact_area" | "route_shape";
  geometryType: "Point" | "Polygon" | "LineString";
  geometryJson: string;
  crs: "svg_viewbox";
  campusId: string | null;
}

export interface OperationalEvent {
  id: string;
  eventType: "maintenance" | "activity" | "closure" | "notice";
  severity: "info" | "warning" | "critical";
  editorialStatus: "approved";
  operationalStatus: "scheduled" | "active" | "resolved" | "cancelled" | "expired";
  title: string;
  description: string | null;
  startsAt: string;
  expectedEndsAt: string | null;
  autoExpireAt: string | null;
  resolvedAt: string | null;
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  targets: OperationalEventTarget[];
  updates: OperationalEventUpdate[];
  locations: OperationalEventLocation[];
}

export interface OperationalEventsResponse {
  items: OperationalEvent[];
}

export interface Campaign {
  id: string;
  title: string;
  summary: string | null;
  editorialStatus: string;
  lifecycleStatus: string;
  startsAt: string;
  endsAt: string;
  audienceJson: string | null;
  placementsJson: string | null;
}

export interface CampaignsResponse {
  items: Campaign[];
}

// ---------------------------------------------------------------------------
// POST /api/public/submissions
// ---------------------------------------------------------------------------

export type {
  FeedbackSubmissionInput as SubmissionInput,
  FeedbackType,
  SubmissionPayload,
  SubmissionTargetType,
} from "../../../shared/submission-contract";

export interface SubmissionResult {
  id: string;
  status: string;
  photoCount?: number;
}

// ---------------------------------------------------------------------------
// POST /api/public/media — anonymous photo upload (quarantine scope)
// ---------------------------------------------------------------------------

export interface MediaUploadResult {
  mediaId: string;
  byteSize: number;
  contentType: string;
  status: string;
}

// ---------------------------------------------------------------------------
// Public collection tasks
// ---------------------------------------------------------------------------

import type { CollectionPayload } from "../../../shared/submission-contract";

export type CollectionTaskStatus = "collecting" | "submitted" | "accepted" | "needs_recollection";

interface CollectionTaskDtoBase {
  buildingId: string;
  status: CollectionTaskStatus;
  assignee: string | null;
  lockExpiresAt: string | null;
  updatedAt: string;
  submittedAt: string | null;
}

export interface OwnedCollectionTaskDto extends CollectionTaskDtoBase {
  owned: true;
  payload: CollectionPayload;
  submissionId: string | null;
}

export interface UnownedCollectionTaskDto extends CollectionTaskDtoBase {
  owned: false;
  payload?: never;
  submissionId?: never;
}

export type CollectionTaskDto = OwnedCollectionTaskDto | UnownedCollectionTaskDto;

export interface CollectionTasksResponse {
  items: CollectionTaskDto[];
}
