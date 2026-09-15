// v2 admin domain types. These mirror the admin API payloads in worker/modules/*.
// The retired POI/marker/overview model has been removed.

import type { SubmissionPayload, SubmissionTargetType } from "../../shared/submission-contract";

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
  kindName: string;
  isBuilding: boolean;
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
  floors: Floor[];
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
  floorId?: string | null;
  indoorSpaceId?: string | null;
  quantity?: number | null;
  operationalStatus?: string;
  /** 设施只有三档：planned / active / retired。「坏了」是 operationalStatus 的事。 */
  lifecycleStatus?: string;
  displayName?: string | null;
  editorialStatus?: EditorialStatus | null;
  [column: string]: unknown;
}

export interface MerchantListItem {
  id: string;
  organizationId?: string | null;
  hostPlaceId?: string | null;
  floorId?: string | null;
  indoorSpaceId?: string | null;
  lifecycleStatus?: string;
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
  lifecycleStatus: MapLifecycleStatus;
  createdAt: string;
  featureCount: number;
}

export type MapLifecycleStatus = "draft" | "ready" | "published" | "archived" | "rejected";

// ---------------------------------------------------------------------------
// Operations + campaigns
// ---------------------------------------------------------------------------

export interface OperationalEventRow {
  id: string;
  eventType: string;
  severity: string;
  /** 地图标注颜色（#rrggbb）；null = 按 severity 默认色。 */
  color?: string | null;
  editorialStatus: EditorialStatus;
  operationalStatus: string;
  title: string;
  description: string | null;
  startsAt: string;
  expectedEndsAt: string | null;
  autoExpireAt: string | null;
  reviewNote?: string | null;
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

export type TransitStopStatus = "active" | "temporarily_closed" | "retired";

export interface TransitStopRow {
  id: string;
  placeId: string | null;
  campusId: string | null;
  code: string | null;
  name: string;
  status: TransitStopStatus;
  markerSize: number;
}

/**
 * A stop's own boarding / alighting anchors, keyed by `entityId`. Same row shape
 * the place & facility editors get, so `locationDraftFromApi` reads it unchanged.
 */
export interface TransitStopLocationRow extends Record<string, unknown> {
  entityId: string;
  bindingId: string;
  role: string;
  isPrimary: boolean;
}

/**
 * 站点可借用的地点（照片 / 联系方式 / 导航点都挂在地点上）。
 *
 * `isBuilding` 决定这条绑定在用户端到底有没有效果：客户端的 POI 列表只由带建筑
 * 轮廓的地点构成，校车详情页的「导航到这里」也是顺着这份列表找的。绑一个没有
 * 楼宇结构的地点，数据库收得下，但用户端什么都不会多出来。
 */
export interface TransitPlaceOptionRow {
  id: string;
  displayName: string | null;
  kindId: string;
  campusId: string | null;
  isBuilding: boolean;
}

export interface TransitRouteRow {
  id: string;
  code: string | null;
  name: string;
  operatorId: string | null;
  status: string;
  /** 预约是线路级属性（0024）；班次的同名列是它的冗余副本，由服务端强制同步。 */
  bookingPolicy: TransitBookingPolicy;
  bookingUrl: string | null;
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
  pickupType: TransitPickupType;
  dropoffType: TransitDropoffType;
}

/** 日历的日型（0025 迁移的 day_type 列），决定客户端「今天是工作日/假日……」标签。 */
export type ServiceCalendarDayType =
  | "weekday" | "weekend" | "holiday" | "winter_break" | "summer_break" | "other";

export interface ServiceCalendarRow {
  id: string;
  name: string;
  timezone: string;
  validFrom: string;
  validTo: string;
  /** 'other' = 不属于任何日型（考试周、临时加开）：班次照常运营，只是不参与日型标签。 */
  dayType: ServiceCalendarDayType;
  monday: number;
  tuesday: number;
  wednesday: number;
  thursday: number;
  friday: number;
  saturday: number;
  sunday: number;
  sourceId: string | null;
}

export type TransitBookingPolicy = "required" | "optional" | "not_required";

export interface TransitTripRow {
  id: string;
  patternId: string;
  serviceCalendarId: string;
  publicLabel: string | null;
  bookingPolicy: TransitBookingPolicy;
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

export interface ServiceCalendarExceptionRow {
  calendarId: string;
  serviceDate: string;
  exceptionType: "added" | "removed";
  label: string | null;
}

export interface TransitResponse {
  stops: TransitStopRow[];
  stopLocations: TransitStopLocationRow[];
  routes: TransitRouteRow[];
  patterns: TransitPatternRow[];
  patternStops: TransitPatternStopRow[];
  calendars: ServiceCalendarRow[];
  exceptions: ServiceCalendarExceptionRow[];
  trips: TransitTripRow[];
  stopTimes: TransitStopTimeRow[];
  places: TransitPlaceOptionRow[];
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
  targetType: SubmissionTargetType;
  targetId: string | null;
  baseRevisionId: string | null;
  payload: SubmissionPayload;
  submitterName: string | null;
  submitterContact: string | null;
  status: string;
  createdAt: string;
  reviewedAt: string | null;
  photos: SubmissionPhotoRow[];
  /**
   * 提交账号。反馈允许匿名，所以为 null 有两种含义：游客提交，或该行早于
   * 0018（那时端点还没有会话）。志愿者采集提交必然带账号。
   */
  submitterUserId: string | null;
  submitterEmail: string | null;
  /** 账号真名，与用户自填的 submitterName 区分开。 */
  submitterAccountName: string | null;
}

// ---------------------------------------------------------------------------
// 功能评分反馈（GET /api/admin/feature-feedback）
// ---------------------------------------------------------------------------

/**
 * 一条功能评分。纯运营数据：匿名提交、无审核流，page 是自由分组键
 * （search / shuttle 等，随版本增加），不是枚举。
 */
export interface FeatureFeedbackRow {
  id: string;
  page: string;
  rating: number;
  reason: string | null;
  createdAt: string;
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
