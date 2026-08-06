// Typed client for the v2 admin API surface. All requests use cookie-session
// auth (credentials: "include" via apiFetch); there are no Bearer tokens.
// Route map: worker/index-v2.ts (routeAdmin) and worker/modules/*.

import { apiFetch } from "./client";
import type {
  FacilityRevisionWrite,
  GeometryType,
  MerchantRevisionWrite,
  PlaceRevisionWrite,
} from "../../../shared/revision-contract";
import type {
  SubmissionPayload,
  SubmissionReviewInput,
  SubmissionTargetType,
} from "../../../shared/submission-contract";

// ---------------------------------------------------------------------------
// Auth / session (cookie-based)
// ---------------------------------------------------------------------------

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
}

export interface SessionResponse {
  user: SessionUser;
  permissions: string[];
}

export interface LoginResponse {
  user: SessionUser;
  expiresAt: string;
}

/** GET /api/auth/session — resolves the current cookie session or throws 401. */
export function getSession(signal?: AbortSignal): Promise<SessionResponse> {
  return apiFetch<SessionResponse>("/api/auth/session", { signal });
}

/** POST /api/auth/login — sets the HttpOnly session cookie on success. */
export function login(email: string, password: string): Promise<LoginResponse> {
  return apiFetch<LoginResponse>("/api/auth/login", {
    method: "POST",
    body: { email, password },
  });
}

/** POST /api/auth/logout — revokes the session and clears the cookie. */
export function logout(): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
}

// ---------------------------------------------------------------------------
// Generic list envelope
// ---------------------------------------------------------------------------

export interface ListResponse<T> {
  items: T[];
}

// ---------------------------------------------------------------------------
// Spaces / reference data
// ---------------------------------------------------------------------------

/** GET /api/admin/spaces — campuses, buildings, floors, indoor spaces. */
export function listSpaces<T = unknown>(signal?: AbortSignal): Promise<T> {
  return apiFetch<T>("/api/admin/spaces", { signal });
}

/** GET /api/admin/reference-data — kinds, facility types, roles, etc. */
export function listReferenceData<T = unknown>(signal?: AbortSignal): Promise<T> {
  return apiFetch<T>("/api/admin/reference-data", { signal });
}

export function createFloor(body: {
  buildingPlaceId: string;
  levelCode: string;
  levelOrder: number;
  displayName: string;
  isPublic: boolean;
}): Promise<{ id: string; levelCode: string; levelOrder: number; displayName: string }> {
  return apiFetch<{ id: string; levelCode: string; levelOrder: number; displayName: string }>("/api/admin/floors", {
    method: "POST",
    body,
  });
}

/** PATCH /api/admin/floors/:id — 楼层显示名 / 排序 / 是否对外可见。 */
export function updateFloor(
  floorId: string,
  body: { displayName?: string; levelOrder?: number; isPublic?: boolean },
): Promise<{ id: string; displayName: string; levelOrder: number; isPublic: number }> {
  return apiFetch(`/api/admin/floors/${encodeURIComponent(floorId)}`, { method: "PATCH", body });
}

export type IndoorSpaceType = "room" | "zone" | "corridor" | "entrance" | "stair" | "elevator" | "service_area" | "other";

export interface IndoorSpaceCreateInput {
  floorId: string;
  parentSpaceId: string | null;
  spaceType: IndoorSpaceType;
  stableCode: string | null;
  displayName: string;
}

export function createSpace(body: IndoorSpaceCreateInput): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/api/admin/spaces", { method: "POST", body });
}

// ---------------------------------------------------------------------------
// 品牌 / 机构（organizations）
//
// 引用它的五处内容（商户、数据来源、运营事件、楼宇、校车线路）都是 set null 外键，
// 所以列表带上 usage 计数：零引用才允许 DELETE，否则只能把 status 改成 retired。
// ---------------------------------------------------------------------------

export interface OrganizationRow {
  id: string;
  name: string;
  kind: string;
  status: "active" | "retired";
  createdAt: string;
  updatedAt: string;
  /** 引用计数，决定能否真删 */
  usage: { merchants: number; sources: number; events: number; buildings: number; transit: number };
}

export interface OrganizationsResponse {
  items: OrganizationRow[];
  kinds: string[];
}

export function listOrganizations(signal?: AbortSignal): Promise<OrganizationsResponse> {
  return apiFetch<OrganizationsResponse>("/api/admin/organizations", { signal });
}

export function createOrganization(body: { name: string; kind: string }): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/api/admin/organizations", { method: "POST", body });
}

export function updateOrganization(
  id: string,
  body: { name?: string; kind?: string; status?: "active" | "retired" },
): Promise<{ id: string }> {
  return apiFetch<{ id: string }>(`/api/admin/organizations/${encodeURIComponent(id)}`, { method: "PATCH", body });
}

export function deleteOrganization(id: string): Promise<void> {
  return apiFetch<void>(`/api/admin/organizations/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export type DataSourceType = "official" | "survey" | "import" | "community" | "derived";
export type DataSourceReliability = "authoritative" | "reviewed" | "unverified" | "unknown";

export interface DataSourceCreateInput {
  sourceType: DataSourceType;
  title: string;
  organizationId: string | null;
  url: string | null;
  license: string | null;
  obtainedAt: string | null;
  reliability: DataSourceReliability;
  metadata: Record<string, unknown>;
}

export function createDataSource(body: DataSourceCreateInput): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/api/admin/data-sources", { method: "POST", body });
}

// ---------------------------------------------------------------------------
// Places + revision lifecycle
// ---------------------------------------------------------------------------

export function listAdminPlaces<T = unknown>(signal?: AbortSignal): Promise<ListResponse<T>> {
  return apiFetch<ListResponse<T>>("/api/admin/places", { signal });
}

export function getAdminPlace<T = unknown>(id: string, signal?: AbortSignal): Promise<T> {
  return apiFetch<T>(`/api/admin/places/${encodeURIComponent(id)}`, { signal });
}

export function createPlace(body: PlaceRevisionWrite): Promise<{ id: string; revisionId: string }> {
  return apiFetch<{ id: string; revisionId: string }>("/api/admin/places", { method: "POST", body });
}

export function createPlaceRevision(placeId: string, body: PlaceRevisionWrite): Promise<{ id: string }> {
  return apiFetch<{ id: string }>(`/api/admin/places/${encodeURIComponent(placeId)}/revisions`, {
    method: "POST",
    body,
  });
}

export type PlaceLifecycle = "planned" | "active" | "temporarily_closed" | "retired";

/**
 * PATCH /api/admin/places/:id/lifecycle —— 筹建 / 启用 / 暂时关闭 / 停用。
 *
 * 名称与介绍走修订流，「这栋楼现在还开不开」即时生效。
 */
export function updatePlaceLifecycle(
  id: string,
  lifecycleStatus: PlaceLifecycle,
): Promise<{ id: string; lifecycleStatus: PlaceLifecycle }> {
  return apiFetch<{ id: string; lifecycleStatus: PlaceLifecycle }>(
    `/api/admin/places/${encodeURIComponent(id)}/lifecycle`,
    { method: "PATCH", body: { lifecycleStatus } },
  );
}

/**
 * DELETE /api/admin/places/:id —— 只用来清掉建错的地点。
 *
 * 有下级地点 / 设施 / 商户 / 站点 / 楼层 / 供稿引用时回 409 `place_in_use`；
 * 已经进过发布快照的回 409 `place_released`。两种都该改用停用。
 */
export function deletePlace(id: string): Promise<void> {
  return apiFetch<void>(`/api/admin/places/${encodeURIComponent(id)}`, { method: "DELETE" });
}


// ---------------------------------------------------------------------------
// Facilities + merchants
// ---------------------------------------------------------------------------

export function listFacilities<T = unknown>(signal?: AbortSignal): Promise<ListResponse<T>> {
  return apiFetch<ListResponse<T>>("/api/admin/facilities", { signal });
}

export function getFacility<T = unknown>(id: string, signal?: AbortSignal): Promise<T> {
  return apiFetch<T>(`/api/admin/facilities/${encodeURIComponent(id)}`, { signal });
}

export function createFacility(body: FacilityRevisionWrite): Promise<{ id: string; revisionId: string }> {
  return apiFetch<{ id: string; revisionId: string }>("/api/admin/facilities", { method: "POST", body });
}

export function createFacilityRevision(id: string, body: FacilityRevisionWrite): Promise<{ id: string }> {
  return apiFetch<{ id: string }>(`/api/admin/facilities/${encodeURIComponent(id)}/revisions`, {
    method: "POST",
    body,
  });
}

/** 设施没有 temporarily_closed：「暂时不能用」是 operationalStatus 的事。 */
export type FacilityLifecycle = "planned" | "active" | "retired";

/** PATCH /api/admin/facilities/:id/lifecycle —— 筹建 / 启用 / 停用，即时生效。 */
export function updateFacilityLifecycle(
  id: string,
  lifecycleStatus: FacilityLifecycle,
): Promise<{ id: string; lifecycleStatus: FacilityLifecycle }> {
  return apiFetch<{ id: string; lifecycleStatus: FacilityLifecycle }>(
    `/api/admin/facilities/${encodeURIComponent(id)}/lifecycle`,
    { method: "PATCH", body: { lifecycleStatus } },
  );
}

/**
 * DELETE /api/admin/facilities/:id —— 只用来清掉建错的设施。
 *
 * 被供稿或运营事件引用时回 409 `facility_in_use`；进过发布快照的回
 * 409 `facility_released`。两种都该改用停用。
 */
export function deleteFacility(id: string): Promise<void> {
  return apiFetch<void>(`/api/admin/facilities/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function listMerchants<T = unknown>(signal?: AbortSignal): Promise<ListResponse<T>> {
  return apiFetch<ListResponse<T>>("/api/admin/merchants", { signal });
}

export function getMerchant<T = unknown>(id: string, signal?: AbortSignal): Promise<T> {
  return apiFetch<T>(`/api/admin/merchants/${encodeURIComponent(id)}`, { signal });
}

export function createMerchant(body: MerchantRevisionWrite): Promise<{ id: string; revisionId: string }> {
  return apiFetch<{ id: string; revisionId: string }>("/api/admin/merchants", { method: "POST", body });
}

export function createMerchantRevision(id: string, body: MerchantRevisionWrite): Promise<{ id: string }> {
  return apiFetch<{ id: string }>(`/api/admin/merchants/${encodeURIComponent(id)}/revisions`, {
    method: "POST",
    body,
  });
}

export type MerchantLifecycle = "planned" | "active" | "temporarily_closed" | "retired";

/**
 * PATCH /api/admin/merchants/:id/lifecycle —— 开业 / 暂停营业 / 关店。
 *
 * 门店的名称与品类走修订流，是否在营业即时生效。
 */
export function updateMerchantLifecycle(
  id: string,
  lifecycleStatus: MerchantLifecycle,
): Promise<{ id: string; lifecycleStatus: MerchantLifecycle }> {
  return apiFetch<{ id: string; lifecycleStatus: MerchantLifecycle }>(
    `/api/admin/merchants/${encodeURIComponent(id)}/lifecycle`,
    { method: "PATCH", body: { lifecycleStatus } },
  );
}


// ---------------------------------------------------------------------------
// 管理端图片直传（POST /api/admin/media）
// ---------------------------------------------------------------------------

export interface AdminMediaUploadResult {
  mediaId: string;
  /** 可直接写进内容字段的公共读地址。 */
  url: string;
  byteSize: number;
  contentType: string;
  status: string;
}

/**
 * POST /api/admin/media — 管理端图片直传，落 public scope 并立即可读。
 *
 * 与匿名投稿通道（POST /api/public/media → 隔离区 → 审核采纳才发布）不同：
 * 管理员是可信方，无需隔离。返回的 url 就是内容里应当保存的地址。
 */
export function uploadAdminMedia(blob: Blob): Promise<AdminMediaUploadResult> {
  return apiFetch<AdminMediaUploadResult>("/api/admin/media", {
    method: "POST",
    rawBody: blob,
    contentType: blob.type || "image/jpeg",
  });
}

// ---------------------------------------------------------------------------
// Revision review workflow (place | facility | merchant)
// ---------------------------------------------------------------------------

export type RevisionType = "place" | "facility" | "merchant";

export function submitRevision(type: RevisionType, id: string, body: Record<string, unknown> = {}): Promise<unknown> {
  return apiFetch(`/api/admin/revisions/${type}/${encodeURIComponent(id)}/submit`, { method: "POST", body });
}

export function reviewRevision(
  type: RevisionType,
  id: string,
  body: { decision: string; note?: string },
): Promise<unknown> {
  return apiFetch(`/api/admin/revisions/${type}/${encodeURIComponent(id)}/review`, { method: "POST", body });
}

export interface PendingRevisionRow {
  type: "place" | "facility" | "merchant";
  revisionId: string;
  entityId: string;
  title: string;
  revisionNo: number;
  submittedAt: string;
}

export function listPendingRevisions(signal?: AbortSignal): Promise<ListResponse<PendingRevisionRow>> {
  return apiFetch<ListResponse<PendingRevisionRow>>("/api/admin/revisions/pending", { signal });
}

// ---------------------------------------------------------------------------
// Maps: upload intent -> PUT content -> import job
// ---------------------------------------------------------------------------

export interface MapVersionRow {
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

export function listMapVersions(signal?: AbortSignal): Promise<ListResponse<MapVersionRow>> {
  return apiFetch<ListResponse<MapVersionRow>>("/api/admin/maps", { signal });
}

export async function fetchAdminMapAssetSvg(mapVersionId: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`/api/admin/maps/${encodeURIComponent(mapVersionId)}/asset`, { credentials: "include", signal });
  if (!response.ok) throw new Error(`底图读取失败（${response.status}）`);
  return response.text();
}

/** 归在某个地点类型下的一个地点。地点类型卡片用它展开「建筑」这类的明细。 */
export interface MapFilterPlaceEntryRow {
  id: string;
  kindId: string;
  displayName: string;
  lifecycleStatus: string;
  isBuilding: boolean;
  campusId: string | null;
  campusName: string | null;
  editorialStatus: string | null;
}

/**
 * 一个地点类型，连同它自己那个筛选按钮。
 *
 * filterLabel 与 name 经常不同（`building`「建筑」的按钮叫「教学楼」），所以两者
 * 都在，只是在同一张卡片里编辑，不再需要先去理解「标签」这一层。
 */
export interface PlaceKindRow {
  id: string;
  name: string;
  sortOrder: number;
  isSearchable: boolean;
  placeCount: number;
  mapFilterMemberId: string | null;
  categoryId: string | null;
  filterKey: string | null;
  filterLabel: string | null;
  filterActive: boolean | null;
  filterSortOrder: number | null;
  /** >1 表示这个按钮还挂着别的成员（历史数据），此时不能就地改按钮属性。 */
  filterMemberCount: number;
  entries: MapFilterPlaceEntryRow[];
}

/** 商户整类纳入的那一个筛选按钮。它没有「类型」可挂，所以单独一行。 */
export interface MerchantFilterRow {
  memberId: string;
  categoryId: string;
  filterKey: string;
  filterLabel: string;
  filterActive: boolean;
  filterSortOrder: number;
  outletCount: number;
  filterMemberCount: number;
}

/** 一个按钮挂了多个（或零个）成员的历史数据。正常库里为空。 */
export interface MapFilterGroupRow {
  id: string;
  key: string;
  label: string;
  active: boolean;
  sortOrder: number;
  memberCount: number;
  memberLabels: string;
}

export interface MapFiltersResponse {
  placeKinds: PlaceKindRow[];
  merchants: MerchantFilterRow | null;
  groups: MapFilterGroupRow[];
}

export function listMapFilters(signal?: AbortSignal): Promise<MapFiltersResponse> {
  return apiFetch<MapFiltersResponse>("/api/admin/map-filters", { signal });
}

/** 按钮属性只在异常分组（一个按钮挂多个成员）里单独改，正常情况走类型自己的接口。 */
export function updateMapFilter(
  id: string,
  body: { label?: string; sortOrder?: number; active?: boolean },
): Promise<{ id: string }> {
  return apiFetch<{ id: string }>(`/api/admin/map-filters/${encodeURIComponent(id)}`, { method: "PATCH", body });
}

/**
 * DELETE /api/admin/map-filters/:id —— 只用来清掉一个成员都没挂的空按钮。
 *
 * 空按钮会被发版校验直接拒（`Active map filter ... has no members`），所以异常分组
 * 里必须给得出这条出路，否则页面只能报出问题而无法解决它。服务端对还挂着成员的
 * 按钮回 409 `map_filter_not_empty`。
 */
export function deleteMapFilter(id: string): Promise<void> {
  return apiFetch<void>(`/api/admin/map-filters/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function listPlaceKinds(signal?: AbortSignal): Promise<ListResponse<PlaceKindRow>> {
  return apiFetch<ListResponse<PlaceKindRow>>("/api/admin/place-kinds", { signal });
}

/** 不再要求先挑一个标签：服务端顺手建好这个类型自己的筛选按钮。 */
export function createPlaceKind(body: {
  id: string;
  name: string;
  sortOrder?: number;
  isSearchable?: boolean;
  filterLabel?: string;
  filterSortOrder?: number;
}): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/api/admin/place-kinds", { method: "POST", body });
}

export function updatePlaceKind(
  id: string,
  body: {
    name?: string;
    sortOrder?: number;
    isSearchable?: boolean;
    filterLabel?: string;
    filterSortOrder?: number;
    filterActive?: boolean;
  },
): Promise<{ id: string }> {
  return apiFetch<{ id: string }>(`/api/admin/place-kinds/${encodeURIComponent(id)}`, { method: "PATCH", body });
}

export function deletePlaceKind(id: string): Promise<void> {
  return apiFetch<void>(`/api/admin/place-kinds/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export interface MapUploadIntentResult {
  mediaAssetId: string;
  objectKey: string;
  upload: { method: string; endpoint: string };
}

export function createMapUploadIntent(body: {
  assetType: string;
  originalName: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  sourceId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<MapUploadIntentResult> {
  return apiFetch<MapUploadIntentResult>("/api/admin/maps/upload-intents", { method: "POST", body });
}

/** PUT /api/admin/media/:id/content — uploads raw bytes; size + sha256 must match the intent. */
export function uploadMediaContent(
  mediaId: string,
  bytes: ArrayBuffer | Blob,
  contentType: string,
): Promise<{ id: string; status: string }> {
  return apiFetch<{ id: string; status: string }>(
    `/api/admin/media/${encodeURIComponent(mediaId)}/content`,
    { method: "PUT", rawBody: bytes, contentType },
  );
}

export interface MapFeatureRow {
  id: string;
  mapVersionId: string;
  stableFeatureKey: string | null;
  sourceElementId: string | null;
  kind: string;
  label: string | null;
  geometryJson: string | null;
  geometryType: GeometryType | null;
  bboxJson: string | null;
  shapeHash: string | null;
  metadataJson: string;
  footprintPlaceId: string | null;
}

/** GET /api/admin/map-features?mapVersionId=… — features of one imported version. */
export function listMapFeatures(mapVersionId: string, signal?: AbortSignal): Promise<ListResponse<MapFeatureRow>> {
  return apiFetch<ListResponse<MapFeatureRow>>(
    `/api/admin/map-features?mapVersionId=${encodeURIComponent(mapVersionId)}`,
    { signal },
  );
}

export function createImportJob(body: {
  mediaAssetId: string;
  campusId?: string | null;
  floorId?: string | null;
  versionLabel: string;
}): Promise<{ id: string; status: string }> {
  return apiFetch<{ id: string; status: string }>("/api/admin/maps/import-jobs", { method: "POST", body });
}

export interface MapImportJobRow {
  id: string;
  jobType: "map_import" | "floor_import";
  status: string;
  attemptCount: number;
  errorMessage: string | null;
  versionLabel: string | null;
  campusId: string | null;
  floorId: string | null;
  mediaAssetId: string | null;
  fileName: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** GET /api/admin/maps/import-jobs — 最近 20 条底图/楼层导入任务（payload 解析失败字段为 null）。 */
export function listMapImportJobs(signal?: AbortSignal): Promise<ListResponse<MapImportJobRow>> {
  return apiFetch<ListResponse<MapImportJobRow>>("/api/admin/maps/import-jobs", { signal });
}

// ---------------------------------------------------------------------------
// Operations + campaigns (admin views)
// ---------------------------------------------------------------------------

export function listAdminOperations<T = unknown>(signal?: AbortSignal): Promise<ListResponse<T>> {
  return apiFetch<ListResponse<T>>("/api/admin/operations", { signal });
}

export type OperationEventType = "maintenance" | "activity" | "closure" | "notice";
export type OperationSeverity = "info" | "warning" | "critical";
export type OperationTargetType =
  | "place"
  | "floor"
  | "space"
  | "facility"
  | "merchant_outlet"
  | "transit_stop"
  | "transit_route"
  | "transit_trip"
  | "map_feature";

export interface OperationTargetInput {
  type: OperationTargetType;
  id: string;
  impactType: string;
}

export interface OperationCreateInput {
  eventType: OperationEventType;
  severity: OperationSeverity;
  title: string;
  description: string | null;
  startsAt: string;
  expectedEndsAt: string | null;
  autoExpireAt: string | null;
  sourceId: string | null;
  responsibleOrganizationId: string | null;
  targets: OperationTargetInput[];
  locations: OperationLocationInput[];
}

export function createOperation(body: OperationCreateInput): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/api/admin/operations", { method: "POST", body });
}

export function reviewOperation(
  id: string,
  body: { decision: "approve" | "reject"; note?: string },
): Promise<{ id: string; editorialStatus: string; reviewNote: string | null }> {
  return apiFetch<{ id: string; editorialStatus: string; reviewNote: string | null }>(
    `/api/admin/operations/${encodeURIComponent(id)}/review`,
    { method: "POST", body },
  );
}

/** One row of GET /api/admin/operations `locations[]` (live anchors, not manifest). */
export interface OperationLocationRow {
  id: string;
  role: OperationLocationRole;
  geometryType: string;
  geometryJson: string | null;
  crs: string | null;
  campusId: string | null;
}

export type OperationLocationRole = "event_location" | "impact_area" | "route_shape";

export interface OperationLocationInput {
  campusId: string | null;
  buildingPlaceId: string | null;
  floorId: string | null;
  indoorSpaceId: string | null;
  role: OperationLocationRole;
  geometryType: GeometryType;
  geometry: Record<string, unknown>;
  crs: string | null;
  mapVersionId: string | null;
  mapFeatureId: string | null;
  locationHint: string | null;
  precisionLevel: "campus" | "building" | "floor" | "space" | "exact" | "unknown";
  accuracyMeters: number | null;
  sourceId: string | null;
  validFrom: string | null;
  validTo: string | null;
  isPrimary: boolean;
}

/**
 * PUT /api/admin/operations/:id/locations — replace-all: the submitted array
 * becomes the event's complete geometry set, and an empty array clears it.
 */
export function replaceOperationLocations(
  id: string,
  locations: OperationLocationInput[],
): Promise<{ id: string; removed: number; locations: Array<{ id: string; role: string; isPrimary: boolean }> }> {
  return apiFetch(`/api/admin/operations/${encodeURIComponent(id)}/locations`, {
    method: "PUT",
    body: { locations },
  });
}

export function createOperationUpdate(
  id: string,
  body: { status: "progress" | "delayed" | "resolved"; message: string; expectedEndsAt?: string },
): Promise<{ id: string; status: string }> {
  return apiFetch<{ id: string; status: string }>(`/api/admin/operations/${encodeURIComponent(id)}/updates`, { method: "POST", body });
}

export function listAdminCampaigns<T = unknown>(signal?: AbortSignal): Promise<ListResponse<T>> {
  return apiFetch<ListResponse<T>>("/api/admin/campaigns", { signal });
}

export function createCampaign(body: Record<string, unknown>): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/api/admin/campaigns", { method: "POST", body });
}

// ---------------------------------------------------------------------------
// Transit
// ---------------------------------------------------------------------------

export function listAdminTransit<T = unknown>(signal?: AbortSignal): Promise<T> {
  return apiFetch<T>("/api/admin/transit", { signal });
}

export type TransitStopStatus = "active" | "temporarily_closed" | "retired";

export interface TransitStopCreateInput {
  name: string;
  code: string | null;
  placeId: string | null;
  campusId: string | null;
  locations: Array<import("../../../shared/revision-contract").RevisionLocationInput>;
}

export function createTransitStop(body: TransitStopCreateInput): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/api/admin/transit/stops", { method: "POST", body });
}

/**
 * PATCH /api/admin/transit/stops/:id — omitted fields keep their stored value.
 * Sending `locations` replaces the stop's whole anchor set; omit it to leave the
 * anchors untouched.
 */
export interface TransitStopUpdateInput {
  name?: string;
  code?: string | null;
  placeId?: string | null;
  campusId?: string | null;
  status?: TransitStopStatus;
  locations?: Array<import("../../../shared/revision-contract").RevisionLocationInput>;
}

export function updateTransitStop(stopId: string, body: TransitStopUpdateInput): Promise<{ id: string }> {
  return apiFetch<{ id: string }>(`/api/admin/transit/stops/${encodeURIComponent(stopId)}`, { method: "PATCH", body });
}

/** DELETE /api/admin/transit/stops/:id — 409 `transit_stop_in_use` while referenced. */
export function deleteTransitStop(stopId: string): Promise<void> {
  return apiFetch<void>(`/api/admin/transit/stops/${encodeURIComponent(stopId)}`, { method: "DELETE" });
}

export type TransitRouteStatus = "active" | "suspended" | "retired";

export interface TransitRouteCreateInput {
  name: string;
  code: string | null;
  operatorId: string | null;
}

export interface TransitRouteUpdateInput {
  name?: string;
  code?: string | null;
  operatorId?: string | null;
  status?: TransitRouteStatus;
}

export function updateTransitRoute(routeId: string, body: TransitRouteUpdateInput): Promise<{ id: string }> {
  return apiFetch<{ id: string }>(`/api/admin/transit/routes/${encodeURIComponent(routeId)}`, { method: "PATCH", body });
}

/** DELETE /api/admin/transit/routes/:id — 409 `transit_route_in_use` while it has directions. */
export function deleteTransitRoute(routeId: string): Promise<void> {
  return apiFetch<void>(`/api/admin/transit/routes/${encodeURIComponent(routeId)}`, { method: "DELETE" });
}

export interface TransitPatternUpdateInput {
  name?: string;
  directionId?: 0 | 1;
}

export function updateTransitPattern(patternId: string, body: TransitPatternUpdateInput): Promise<{ id: string }> {
  return apiFetch<{ id: string }>(`/api/admin/transit/patterns/${encodeURIComponent(patternId)}`, { method: "PATCH", body });
}

/** DELETE /api/admin/transit/patterns/:id — 409 `transit_pattern_in_use` while it has trips. */
export function deleteTransitPattern(patternId: string): Promise<void> {
  return apiFetch<void>(`/api/admin/transit/patterns/${encodeURIComponent(patternId)}`, { method: "DELETE" });
}

export type TransitPickupType = "regular" | "reservation_only" | "none";
export type TransitDropoffType = "regular" | "none";

export interface TransitPatternStopInput {
  stopId: string;
  pickupType: TransitPickupType;
  dropoffType: TransitDropoffType;
}

export interface TransitPatternCreateInput {
  routeId: string;
  directionId: 0 | 1;
  name: string;
  stops: TransitPatternStopInput[];
}

export interface TransitCalendarExceptionInput {
  date: string;
  type: "added" | "removed";
  label: string | null;
}

export interface TransitCalendarCreateInput {
  name: string;
  validFrom: string;
  validTo: string;
  weekdays: Record<"monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday", boolean>;
  exceptions: TransitCalendarExceptionInput[];
  sourceId: string | null;
}

export type TransitBookingPolicy = "required" | "optional" | "not_required";

export interface TransitStopTimeInput {
  arrivalTime: string | null;
  departureTime: string | null;
}

export interface TransitTripCreateInput {
  patternId: string;
  serviceCalendarId: string;
  publicLabel: string | null;
  bookingPolicy: TransitBookingPolicy;
  bookingUrl: string | null;
  sourceId: string | null;
  stopTimes: TransitStopTimeInput[];
}

export interface TransitTripUpdateInput {
  serviceCalendarId?: string;
  bookingPolicy?: TransitBookingPolicy;
  bookingUrl?: string | null;
  stopTimes?: TransitStopTimeInput[];
}

export function createTransitRoute(body: TransitRouteCreateInput): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/api/admin/transit/routes", { method: "POST", body });
}

export function createTransitPattern(body: TransitPatternCreateInput): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/api/admin/transit/patterns", { method: "POST", body });
}

export function createTransitCalendar(body: TransitCalendarCreateInput): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/api/admin/transit/calendars", { method: "POST", body });
}

/**
 * PATCH /api/admin/transit/calendars/:id — omitted fields keep their stored
 * value. Sending `exceptions` replaces the whole list; omitting it while
 * narrowing the date range is refused with 409 when a stored exception would
 * fall outside the new range.
 */
export interface TransitCalendarUpdateInput {
  name?: string;
  validFrom?: string;
  validTo?: string;
  weekdays?: Record<"monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday", boolean>;
  exceptions?: TransitCalendarExceptionInput[];
  sourceId?: string | null;
}

export function updateTransitCalendar(calendarId: string, body: TransitCalendarUpdateInput): Promise<{ id: string }> {
  return apiFetch<{ id: string }>(`/api/admin/transit/calendars/${encodeURIComponent(calendarId)}`, { method: "PATCH", body });
}

/** DELETE /api/admin/transit/calendars/:id — 409 `service_calendar_in_use` while trips run on it. */
export function deleteTransitCalendar(calendarId: string): Promise<void> {
  return apiFetch<void>(`/api/admin/transit/calendars/${encodeURIComponent(calendarId)}`, { method: "DELETE" });
}

export function createTransitTrip(body: TransitTripCreateInput): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/api/admin/transit/trips", { method: "POST", body });
}

/**
 * PUT /api/admin/transit/patterns/:id/stops — replace-all: the payload order
 * becomes the new stop sequence, so add / remove / reorder all use this call.
 */
export function replaceTransitPatternStops(
  patternId: string,
  stops: TransitPatternStopInput[],
): Promise<{ patternId: string }> {
  return apiFetch<{ patternId: string }>(`/api/admin/transit/patterns/${encodeURIComponent(patternId)}/stops`, {
    method: "PUT",
    body: { stops },
  });
}

export function updateTransitTrip(tripId: string, body: TransitTripUpdateInput): Promise<{ id: string }> {
  return apiFetch<{ id: string }>(`/api/admin/transit/trips/${encodeURIComponent(tripId)}`, { method: "PUT", body });
}

export function deleteTransitTrip(tripId: string): Promise<{ id: string; status: string }> {
  return apiFetch<{ id: string; status: string }>(`/api/admin/transit/trips/${encodeURIComponent(tripId)}`, {
    method: "DELETE",
  });
}

// ---------------------------------------------------------------------------
// Submissions review
// ---------------------------------------------------------------------------

/** 一条提交关联的用户照片。审核端用 GET /api/admin/media/:id/content 取原图。 */
export interface AdminSubmissionPhoto {
  mediaId: string;
  bucketScope: string;
  status: string;
}

export interface AdminSubmission {
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
  photos: AdminSubmissionPhoto[];
  /**
   * 提交账号。反馈允许匿名，所以这三个字段可以全为 null——那表示这条提交无从
   * 溯源到账号；志愿者采集必然带账号。submitterName 是自称，不能当身份用。
   */
  submitterUserId: string | null;
  submitterEmail: string | null;
  submitterAccountName: string | null;
}

/** GET /api/admin/media/:id/content — 任意 scope（含隔离区）的原图地址。 */
export function adminMediaContentUrl(mediaId: string): string {
  return `/api/admin/media/${encodeURIComponent(mediaId)}/content`;
}

export function listSubmissions(signal?: AbortSignal): Promise<ListResponse<AdminSubmission>> {
  return apiFetch<ListResponse<AdminSubmission>>("/api/admin/submissions", { signal });
}

export function reviewSubmission(
  id: string,
  body: SubmissionReviewInput,
): Promise<{ id: string; submissionId: string; status: string; producedRevisionType: string | null; producedRevisionId: string | null }> {
  return apiFetch<{ id: string; submissionId: string; status: string; producedRevisionType: string | null; producedRevisionId: string | null }>(
    `/api/admin/submissions/${encodeURIComponent(id)}/review`,
    { method: "POST", body },
  );
}

// ---------------------------------------------------------------------------
// Releases: publish + rollback (Durable Object coordinator)
// ---------------------------------------------------------------------------

export interface PublishReleaseInput {
  version: string;
  summary: string | null;
  reason: string | null;
  mapVersionIds: string[];
}

export interface PublishReleaseResult {
  id: string;
  version?: string;
  status: string;
  artifactSha256?: string;
  validation?: {
    valid: boolean;
    errors: string[];
    warnings: string[];
    mapAssets: Array<{
      mapVersionId: string;
      objectKey: string;
      valid: boolean;
      error: string | null;
    }>;
    mapSelection: {
      requestedMapVersionIds: string[];
      selectedMapVersionIds: string[];
      missingMapVersionIds: string[];
    };
    counts: Record<string, number>;
  };
}

export function publishRelease(body: PublishReleaseInput): Promise<PublishReleaseResult> {
  return apiFetch<PublishReleaseResult>("/api/admin/releases", { method: "POST", body });
}

export function rollbackRelease(releaseId: string, body: { reason: string | null }): Promise<unknown> {
  return apiFetch(`/api/admin/releases/${encodeURIComponent(releaseId)}/rollback`, { method: "POST", body });
}

export type PendingEntityType = "place" | "facility" | "merchant_outlet" | "transit_stop" | "map_version";
export type PendingChangeKind = "added" | "changed" | "removed";

export interface PendingChangeRow {
  entityType: PendingEntityType;
  entityId: string;
  displayName: string;
  change: PendingChangeKind;
}

export interface PendingReleaseChanges {
  /** 当前线上版本；从未发过版时为 null（此时所有内容都算「新增」）。 */
  release: { id: string; version: string; activatedAt: string } | null;
  hasPendingChanges: boolean;
  total: number;
  changes: PendingChangeRow[];
}

/**
 * GET /api/admin/releases/pending —— 当前库与线上快照的差异。
 *
 * 「地图数据只来自 release」的代价是后台改完不发版则线上不变；这个端点回答
 * 「现在到底攒了哪些待发布的改动」，侧栏的小黄点与发布中心的清单都用它。
 */
export function pendingReleaseChanges(signal?: AbortSignal): Promise<PendingReleaseChanges> {
  return apiFetch<PendingReleaseChanges>("/api/admin/releases/pending", { signal });
}

// ---------------------------------------------------------------------------
// 账户管理（requires manage:users）
// ---------------------------------------------------------------------------

export interface AdminUserRow {
  id: string;
  email: string;
  displayName: string;
  status: string;
  roles: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AdminRoleRow {
  id: string;
  name: string;
  permissions: string[];
  /** owner 不可在此界面分配。 */
  assignable: boolean;
}

export interface AdminUsersResponse {
  items: AdminUserRow[];
  roles: AdminRoleRow[];
}

/** GET /api/admin/users — 账户列表 + 可分配角色。 */
export function listAdminUsers(signal?: AbortSignal): Promise<AdminUsersResponse> {
  return apiFetch<AdminUsersResponse>("/api/admin/users", { signal });
}

export function createAdminUser(body: {
  email: string;
  displayName: string;
  password: string;
  roleId: string;
}): Promise<AdminUserRow> {
  return apiFetch<AdminUserRow>("/api/admin/users", { method: "POST", body });
}

/** PATCH /api/admin/users/:id — 只提交需要变更的字段。 */
export function updateAdminUser(
  id: string,
  body: { displayName?: string; status?: "active" | "disabled"; password?: string; roleId?: string },
): Promise<AdminUserRow & { sessionsRevoked: boolean }> {
  return apiFetch<AdminUserRow & { sessionsRevoked: boolean }>(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
  });
}

// ---------------------------------------------------------------------------
// 设施类型（标签）维护（读 read:admin，写 write:content）
// ---------------------------------------------------------------------------

/** 一个类型下挂着的点位。楼宇名 / 楼层名由后端 join 出来。 */
export interface FacilityTypeInstanceRow {
  id: string;
  facilityTypeId: string;
  displayName: string;
  lifecycleStatus: string;
  operationalStatus: string;
  hostPlaceId: string | null;
  placeName: string | null;
  floorId: string | null;
  floorName: string | null;
  floorLevelCode: string | null;
  spaceName: string | null;
  editorialStatus: string | null;
}

/**
 * 设施类型的可见性开关。
 *
 * `campusDefault` 决定「不选任何筛选时校区图上要不要直接画这个类型的图钉」——
 * 楼外设施能不能被看见就取决于它（见 useMapPageState 的 shouldRenderPointPoi）。
 * 其余键控制搜索与筛选命中时的行为。buildingSummary / floorDefault 属于楼内展示，
 * 后台暂不提供开关，但服务端会原样保留。
 */
export interface FacilityVisibilityPolicy {
  campusDefault?: boolean;
  searchable?: boolean;
  filterable?: boolean;
  showOnSearch?: boolean;
  showOnFilter?: boolean;
  showWhenUnavailable?: boolean;
  buildingSummary?: boolean;
  floorDefault?: boolean;
}

export interface FacilityTypeRow {
  id: string;
  code: string;
  name: string;
  category: string;
  iconKey: string | null;
  status: string;
  verificationIntervalDays: number | null;
  createdAt: string;
  updatedAt: string;
  visibilityPolicy: FacilityVisibilityPolicy;
  instanceCount: number;
  collectionReferenceCount: number;
  mapFilterMemberId: string;
  mapFilterCategoryId: string;
  /** 这个类型自己那个筛选按钮：前台显示的名称、排序、要不要出现在筛选栏。 */
  filterLabel: string;
  filterActive: boolean;
  filterSortOrder: number;
  /** >1 表示这个按钮还挂着别的成员（历史数据），此时按钮属性不能就地改。 */
  filterMemberCount: number;
  instances: FacilityTypeInstanceRow[];
}

export interface FacilityTypeWriteResult {
  id: string;
  code: string;
  name: string;
  category: string;
  iconKey: string | null;
  status: string;
  verificationIntervalDays: number | null;
  instanceCount: number;
  mapFilterMemberId: string;
  mapFilterCategoryId: string;
}

export interface FacilityTypesResponse {
  items: FacilityTypeRow[];
  /** 可选图标 key，界面据此渲染带预览的下拉。 */
  iconKeys: string[];
  categories: string[];
}

/** GET /api/admin/facility-types — 全部类型（含停用）+ 每类型的点位明细。 */
export function listFacilityTypes(signal?: AbortSignal): Promise<FacilityTypesResponse> {
  return apiFetch<FacilityTypesResponse>("/api/admin/facility-types", { signal });
}

/**
 * POST /api/admin/facility-types
 *
 * 不再需要先挑一个筛选按钮：服务端顺手给新类型建好它自己那一个。filterLabel 缺省
 * 时沿用类型名称，之后可以单独改（「打印服务」的按钮叫「打印机」）。
 */
export function createFacilityType(body: {
  code: string;
  name: string;
  category?: string;
  iconKey?: string | null;
  verificationIntervalDays?: number | null;
  filterLabel?: string;
  filterSortOrder?: number;
}): Promise<FacilityTypeWriteResult> {
  return apiFetch<FacilityTypeWriteResult>("/api/admin/facility-types", { method: "POST", body });
}

/**
 * PATCH /api/admin/facility-types/:id — code 不可改；status='disabled' 即停用。
 *
 * `visibilityPolicy` 是补丁：只提交要改的那几个开关，服务端与已存策略合并，
 * 界面上没有的键（buildingSummary / floorDefault）原样保留。
 */
export function updateFacilityType(
  id: string,
  body: {
    name?: string;
    category?: string;
    iconKey?: string | null;
    status?: "active" | "disabled";
    verificationIntervalDays?: number | null;
    /** 这个类型自己那个筛选按钮的属性，跟类型属性同一个请求里改。 */
    filterLabel?: string;
    filterSortOrder?: number;
    filterActive?: boolean;
    visibilityPolicy?: FacilityVisibilityPolicy;
  },
): Promise<FacilityTypeWriteResult> {
  return apiFetch<FacilityTypeWriteResult>(`/api/admin/facility-types/${encodeURIComponent(id)}`, { method: "PATCH", body });
}

/** DELETE /api/admin/facility-types/:id — 仅在没有点位或采集数据引用时可用。 */
export function deleteFacilityType(id: string): Promise<{ id: string; deleted: boolean }> {
  return apiFetch<{ id: string; deleted: boolean }>(`/api/admin/facility-types/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// ---------------------------------------------------------------------------
// 楼层与楼层平面图管理
//
// 与设施 / 商户的同步靠共享的 floor_id 外键：这些列表是**反查**出来的，所以在设施
// 编辑器里改了楼层归属，楼层页刷新即变，不存在两处数据不一致。
// ---------------------------------------------------------------------------

export interface FloorPlanRow {
  id: string;
  versionLabel: string;
  lifecycleStatus: MapLifecycleStatus;
  coordinateSpaceType: string;
  createdAt: string;
  featureCount: number;
}

/** 一层楼被引用的次数，非零则不能删除。 */
export interface FloorUsage {
  facilities: number;
  merchants: number;
  spaces: number;
  mapVersions: number;
  anchors: number;
}

export interface FloorOverviewRow {
  id: string;
  buildingPlaceId: string;
  levelCode: string;
  levelOrder: number;
  displayName: string;
  isPublic: boolean;
  lifecycleStatus: string;
  plans: FloorPlanRow[];
  usage: FloorUsage;
}

export interface FloorsOverviewResponse {
  building: { placeId: string; displayName: string | null; campusId: string | null };
  items: FloorOverviewRow[];
}

/** GET /api/admin/floors?buildingPlaceId=… — 一栋楼的全部楼层 + 每层图纸与引用计数。 */
export function listBuildingFloors(buildingPlaceId: string, signal?: AbortSignal): Promise<FloorsOverviewResponse> {
  return apiFetch<FloorsOverviewResponse>("/api/admin/floors", { query: { buildingPlaceId }, signal });
}

export interface FloorFacilityRow {
  id: string;
  facilityTypeId: string;
  facilityTypeName: string;
  lifecycleStatus: string;
  operationalStatus: string;
  indoorSpaceId: string | null;
  displayName: string;
  editorialStatus: string | null;
  /** 已在平面图上标出服务位置的锚点数；0 表示这个设施还没落点。 */
  positionedCount: number;
}

export interface FloorMerchantRow {
  id: string;
  lifecycleStatus: string;
  indoorSpaceId: string | null;
  displayName: string | null;
  businessType: string | null;
  editorialStatus: string | null;
}

export interface FloorSpaceRow {
  id: string;
  spaceType: string;
  stableCode: string | null;
  displayName: string;
  lifecycleStatus: string;
}

export interface FloorAnchorRow {
  id: string;
  role: string;
  geometryType: string;
  precisionLevel: string;
  mapVersionId: string | null;
  locationHint: string | null;
  entityType: string | null;
  entityId: string | null;
}

export interface FloorDetailResponse {
  floor: {
    id: string;
    buildingPlaceId: string;
    buildingName: string | null;
    levelCode: string;
    levelOrder: number;
    displayName: string;
    isPublic: boolean;
    lifecycleStatus: string;
  };
  plans: FloorPlanRow[];
  facilities: FloorFacilityRow[];
  merchants: FloorMerchantRow[];
  spaces: FloorSpaceRow[];
  anchors: FloorAnchorRow[];
  usage: FloorUsage;
}

/** GET /api/admin/floors/:id — 单层详情：图纸 + 该层设施 / 商户 / 空间 / 锚点。 */
export function getFloorDetail(floorId: string, signal?: AbortSignal): Promise<FloorDetailResponse> {
  return apiFetch<FloorDetailResponse>(`/api/admin/floors/${encodeURIComponent(floorId)}`, { signal });
}

/** DELETE /api/admin/floors/:id — 仅在该层没有任何引用时可用，否则 409 floor_in_use。 */
export function deleteFloor(floorId: string): Promise<{ id: string; deleted: boolean }> {
  return apiFetch<{ id: string; deleted: boolean }>(`/api/admin/floors/${encodeURIComponent(floorId)}`, {
    method: "DELETE",
  });
}

/** PATCH /api/admin/floor-plans/:id/status — 楼层图就绪 / 归档（published 由发版流程管）。 */
export function updateFloorPlanStatus(
  mapVersionId: string,
  lifecycleStatus: "ready" | "archived",
): Promise<{ id: string; lifecycleStatus: string }> {
  return apiFetch<{ id: string; lifecycleStatus: string }>(
    `/api/admin/floor-plans/${encodeURIComponent(mapVersionId)}/status`,
    { method: "PATCH", body: { lifecycleStatus } },
  );
}
