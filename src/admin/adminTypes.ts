// v2 admin domain types. These mirror the admin API payloads in worker/modules/*.
// The legacy POI/marker/overview model has been removed.

export type AdminSection =
  | "dashboard"
  | "spaces"
  | "places"
  | "facilities"
  | "merchants"
  | "maps"
  | "operations"
  | "transit"
  | "submissions"
  | "releases";

export type Severity = "ok" | "warning" | "error" | "info";

export type EditorialStatus = "draft" | "in_review" | "approved" | "rejected" | "superseded";

// ---------------------------------------------------------------------------
// Spaces + reference data (GET /api/admin/spaces, /api/admin/reference-data)
// ---------------------------------------------------------------------------

export interface Campus {
  id: string;
  code: string;
  name: string;
  timezone: string;
  status: string;
}

export interface Building {
  placeId: string;
  buildingCode: string | null;
  managingOrganizationId: string | null;
  publicAccessLevel: string;
  displayName: string | null;
  campusId: string | null;
}

export interface Floor {
  id: string;
  buildingPlaceId: string;
  levelCode: string;
  levelOrder: number;
  displayName: string;
  isPublic: number;
  lifecycleStatus: string;
}

export interface IndoorSpace {
  id: string;
  floorId: string;
  parentSpaceId: string | null;
  spaceType: string;
  stableCode: string | null;
  displayName: string;
  lifecycleStatus: string;
}

export interface SpacesResponse {
  campuses: Campus[];
  buildings: Building[];
  floors: Floor[];
  spaces: IndoorSpace[];
}

export interface Organization {
  id: string;
  name: string;
  kind: string;
  status: string;
  [column: string]: unknown;
}

export interface DataSource {
  id: string;
  source_type: string;
  title: string;
  reliability: string;
  [column: string]: unknown;
}

export interface FacilityType {
  id: string;
  category: string;
  name: string;
  [column: string]: unknown;
}

export interface PlaceKind {
  id: string;
  name: string;
  sort_order: number;
  [column: string]: unknown;
}

export interface ReferenceDataResponse {
  organizations: Organization[];
  sources: DataSource[];
  facilityTypes: FacilityType[];
  placeKinds: PlaceKind[];
}

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

export interface PlaceListItem {
  id: string;
  kindId: string;
  campusId: string | null;
  parentPlaceId: string | null;
  stableCode: string | null;
  lifecycleStatus: string;
  currentRevisionId: string | null;
  displayName: string | null;
  summary: string | null;
  editorialStatus: EditorialStatus | null;
  updatedAt: string;
}

export interface PlaceRevision {
  id: string;
  place_id: string;
  revision_no: number;
  editorial_status: EditorialStatus;
  display_name: string;
  summary: string | null;
  description: string | null;
  created_at: string;
  [column: string]: unknown;
}

export interface PlaceDetailResponse {
  place: Record<string, unknown>;
  revisions: PlaceRevision[];
  names: Array<Record<string, unknown>>;
  locations: Array<Record<string, unknown>>;
  floors: Array<Record<string, unknown>>;
}

export interface FacilityDetailResponse {
  facility: Record<string, unknown>;
  revisions: Array<Record<string, unknown>>;
  locations: Array<Record<string, unknown>>;
}

export interface MerchantDetailResponse {
  merchant: Record<string, unknown>;
  revisions: Array<Record<string, unknown>>;
  locations: Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Facilities + merchants
// ---------------------------------------------------------------------------

export interface FacilityListItem {
  id: string;
  facilityTypeId?: string;
  hostPlaceId?: string | null;
  operationalStatus?: string;
  displayName?: string | null;
  editorialStatus?: EditorialStatus | null;
  [column: string]: unknown;
}

export interface MerchantListItem {
  id: string;
  organizationId?: string | null;
  hostPlaceId?: string | null;
  displayName?: string | null;
  businessType?: string | null;
  editorialStatus?: EditorialStatus | null;
  [column: string]: unknown;
}

// ---------------------------------------------------------------------------
// Maps
// ---------------------------------------------------------------------------

export interface MapVersion {
  id: string;
  campusId: string | null;
  floorId: string | null;
  versionLabel: string;
  coordinateSpaceType: string;
  lifecycleStatus: string;
  createdAt: string;
  featureCount: number;
}

// ---------------------------------------------------------------------------
// Operations + campaigns
// ---------------------------------------------------------------------------

export interface OperationalEventRow {
  id: string;
  eventType: string;
  severity: string;
  editorialStatus: EditorialStatus;
  operationalStatus: string;
  title: string;
  description: string | null;
  startsAt: string;
  expectedEndsAt: string | null;
  autoExpireAt: string | null;
  createdAt: string;
  [column: string]: unknown;
}

export interface CampaignRow {
  id: string;
  title: string;
  summary: string | null;
  editorialStatus: EditorialStatus;
  lifecycleStatus: string;
  startsAt: string;
  endsAt: string;
  [column: string]: unknown;
}

// ---------------------------------------------------------------------------
// Transit
// ---------------------------------------------------------------------------

export interface TransitStopRow {
  id: string;
  placeId: string | null;
  campusId: string | null;
  code: string | null;
  name: string;
  status: string;
}

export interface TransitRouteRow {
  id: string;
  code: string | null;
  name: string;
  operatorId: string | null;
  status: string;
}

export interface TransitPatternRow {
  id: string;
  routeId: string;
  directionId: number;
  name: string;
  routeAnchorId: string | null;
}

export type TransitPickupType = "regular" | "reservation_only" | "none";
export type TransitDropoffType = "regular" | "none";

export interface TransitPatternStopRow {
  patternId: string;
  stopId: string;
  stopSequence: number;
  pickupType: string;
  dropoffType: string;
}

/**
 * 服务日历。`displayName` 由后端解析（导入数据的 name 是英文桶名），
 * 界面一律显示 displayName。
 */
export interface ServiceCalendarRow {
  id: string;
  name: string;
  displayName: string;
  timezone: string;
  validFrom: string;
  validTo: string;
  monday: number;
  tuesday: number;
  wednesday: number;
  thursday: number;
  friday: number;
  saturday: number;
  sunday: number;
}

export type TransitBookingPolicy = "required" | "optional" | "not_required";

export interface TransitTripRow {
  id: string;
  patternId: string;
  serviceCalendarId: string;
  publicLabel: string | null;
  bookingPolicy: string;
  bookingUrl: string | null;
  status: string;
}

export interface TransitStopTimeRow {
  tripId: string;
  stopId: string;
  stopSequence: number;
  arrivalTime: string | null;
  departureTime: string | null;
}

export interface TransitResponse {
  stops: TransitStopRow[];
  routes: TransitRouteRow[];
  patterns: TransitPatternRow[];
  patternStops: TransitPatternStopRow[];
  calendars: ServiceCalendarRow[];
  exceptions: Array<Record<string, unknown>>;
  trips: TransitTripRow[];
  stopTimes: TransitStopTimeRow[];
}

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

/** 一条提交关联的照片。scope/status 用来提示「尚在隔离区」还是「已发布」。 */
export interface SubmissionPhotoRow {
  mediaId: string;
  bucketScope: string;
  status: string;
}

export interface SubmissionRow {
  id: string;
  targetType: string;
  targetId: string | null;
  baseRevisionId: string | null;
  payloadJson: string;
  submitterName: string | null;
  submitterContact: string | null;
  status: string;
  createdAt: string;
  reviewedAt: string | null;
  photos?: SubmissionPhotoRow[];
}

// ---------------------------------------------------------------------------
// 账户管理（GET /api/admin/users）
// ---------------------------------------------------------------------------

export type AccountStatus = "active" | "disabled";

export interface AccountRow {
  id: string;
  email: string;
  displayName: string;
  status: AccountStatus | string;
  /** 已绑定角色，当前一个账户只分配一个。 */
  roles: string[];
  createdAt: string;
  updatedAt: string;
}

/** 可选角色。assignable=false 的角色（拥有者）不出现在新建/改角色的下拉里。 */
export interface AccountRoleOption {
  id: string;
  name: string;
  permissions: string[];
  assignable: boolean;
}
