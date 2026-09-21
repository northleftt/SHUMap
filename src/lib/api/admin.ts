// Typed client for the v2 admin API surface. All requests use cookie-session
// auth (credentials: "include" via apiFetch); there are no Bearer tokens.
// Route map: worker/index-v2.ts (routeAdmin) and worker/modules/*.

import { apiFetch } from "./client";
import type { FeatureFeedbackRow, ServiceCalendarDayType } from "../../admin/adminTypes";
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

/** GET /api/admin/spaces — campuses, buildings, floors. */
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

/** PUT /api/admin/floors/:id/image — 上传/替换楼层平面图位图（原始字节，≤8 MiB）。 */
export function uploadFloorImage(
  floorId: string,
  file: File | Blob,
  contentType: string,
): Promise<{ id: string; imageMediaId: string; imageUrl: string }> {
  return apiFetch<{ id: string; imageMediaId: string; imageUrl: string }>(
    `/api/admin/floors/${encodeURIComponent(floorId)}/image`,
    { method: "PUT", rawBody: file, contentType },
  );
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
  assetType: "campus_svg";
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
  campusId: string;
  versionLabel: string;
}): Promise<{ id: string; status: string }> {
  return apiFetch<{ id: string; status: string }>("/api/admin/maps/import-jobs", { method: "POST", body });
}

export interface MapImportAnchorReviewItem {
  anchorId: string | null;
  role: string | null;
  entityType: string | null;
  entityId: string | null;
  entityName: string | null;
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
  anchorReview: MapImportAnchorReviewItem[];
  anchorAutoMigrated: MapImportAnchorReviewItem[];
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
  /** 地图标注颜色（#rrggbb）；null = 按 severity 默认色。 */
  color: string | null;
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

/** PUT /api/admin/operations/:id — 编辑事件主体（几何仍走 replaceOperationLocations）。 */
export type OperationUpdateInput = Omit<OperationCreateInput, "locations">;

export function updateOperation(id: string, body: OperationUpdateInput): Promise<{ id: string; editorialStatus: string }> {
  return apiFetch<{ id: string; editorialStatus: string }>(`/api/admin/operations/${encodeURIComponent(id)}`, {
    method: "PUT",
    body,
  });
}

/** DELETE /api/admin/operations/:id — 删除事件（含 targets/updates/几何锚点，服务端审计）。 */
export function deleteOperation(id: string): Promise<{ id: string; deleted: boolean }> {
  return apiFetch<{ id: string; deleted: boolean }>(`/api/admin/operations/${encodeURIComponent(id)}`, { method: "DELETE" });
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
  markerSize?: number;
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
  markerSize?: number;
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
  bookingPolicy?: TransitBookingPolicy;
  bookingUrl?: string | null;
}

export interface TransitRouteUpdateInput {
  name?: string;
  code?: string | null;
  operatorId?: string | null;
  status?: TransitRouteStatus;
  bookingPolicy?: TransitBookingPolicy;
  bookingUrl?: string | null;
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
  /** 日型：决定客户端的「今天是工作日/假日……」标签，'other' 表示不参与标签。 */
  dayType: ServiceCalendarDayType;
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
  /** 0024 起为线路级属性：这里传了也会被服务端按所属线路覆盖。 */
  bookingPolicy?: TransitBookingPolicy;
  bookingUrl: string | null;
  sourceId: string | null;
  stopTimes: TransitStopTimeInput[];
}

export interface TransitTripUpdateInput {
  serviceCalendarId?: string;
  /** 0024 起为线路级属性：这里传了也会被服务端按所属线路覆盖。 */
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
  dayType?: ServiceCalendarDayType;
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
// 校历（academic calendar）+ 就餐（dining）
//
// 校历是校园级日型（工作日 / 周末 / 假日 / 寒暑假）的唯一数据源；就餐的开放
// 安排按日型命中。两张表都即时生效、不进 release，写权限 write:content。
// ---------------------------------------------------------------------------

export type AcademicTermDayType = "term" | "winter_break" | "summer_break";
export type AcademicDateKind = "holiday" | "workday_override";

export interface AcademicTermRow {
  id: string;
  yearId: string;
  name: string;
  dayType: AcademicTermDayType;
  validFrom: string;
  validTo: string;
  sortOrder: number;
}

export interface AcademicDateRow {
  yearId: string;
  serviceDate: string;
  kind: AcademicDateKind;
}

export interface AcademicYearRow {
  id: string;
  name: string;
  terms: AcademicTermRow[];
  dates: AcademicDateRow[];
}

export interface AcademicYearWrite {
  name: string;
  terms: Array<{ name: string; dayType: AcademicTermDayType; validFrom: string; validTo: string; sortOrder?: number }>;
  dates: Array<{ serviceDate: string; kind: AcademicDateKind }>;
}

export function listAcademicYears(signal?: AbortSignal): Promise<ListResponse<AcademicYearRow>> {
  return apiFetch<ListResponse<AcademicYearRow>>("/api/admin/calendar/years", { signal });
}

export function createAcademicYear(body: AcademicYearWrite): Promise<{ id: string; name: string }> {
  return apiFetch<{ id: string; name: string }>("/api/admin/calendar/years", { method: "POST", body });
}

export function updateAcademicYear(yearId: string, body: AcademicYearWrite): Promise<{ id: string; name: string }> {
  return apiFetch<{ id: string; name: string }>(`/api/admin/calendar/years/${encodeURIComponent(yearId)}`, {
    method: "PUT",
    body,
  });
}

/** DELETE /api/admin/calendar/years/:id — 覆盖今天的学年返回 409 `academic_year_current`。 */
export function deleteAcademicYear(yearId: string): Promise<void> {
  return apiFetch<void>(`/api/admin/calendar/years/${encodeURIComponent(yearId)}`, { method: "DELETE" });
}

export type DiningMeal = "breakfast" | "lunner" | "latenight";
export type DiningDayType = "weekday" | "weekend" | "holiday" | "winter_break" | "summer_break";

export interface DiningMealPeriodRow {
  id: string;
  meal: DiningMeal;
  startTime: string;
  endTime: string;
  sortOrder: number;
}

export interface DiningScheduleRow {
  id: string;
  validFrom: string;
  validTo: string;
  dayTypes: DiningDayType[];
  updatedAt: string;
  floors: Array<{ floorId: string; noBreakfast: boolean }>;
}

export interface DiningAdminResponse {
  mealPeriods: DiningMealPeriodRow[];
  schedules: DiningScheduleRow[];
}

export function listDiningAdmin(signal?: AbortSignal): Promise<DiningAdminResponse> {
  return apiFetch<DiningAdminResponse>("/api/admin/dining", { signal });
}

/** PUT /api/admin/dining/meal-periods — 整表替换；数组顺序即展示顺序。 */
export function replaceMealPeriods(
  periods: Array<{ meal: DiningMeal; startTime: string; endTime: string; sortOrder?: number }>,
): Promise<{ count: number }> {
  return apiFetch<{ count: number }>("/api/admin/dining/meal-periods", { method: "PUT", body: { periods } });
}

export interface DiningScheduleWrite {
  validFrom: string;
  validTo: string;
  dayTypes: DiningDayType[];
  floors: Array<{ floorId: string; noBreakfast: boolean }>;
}

export function createDiningSchedule(body: DiningScheduleWrite): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/api/admin/dining/schedules", { method: "POST", body });
}

export function updateDiningSchedule(scheduleId: string, body: DiningScheduleWrite): Promise<{ id: string }> {
  return apiFetch<{ id: string }>(`/api/admin/dining/schedules/${encodeURIComponent(scheduleId)}`, {
    method: "PUT",
    body,
  });
}

export function deleteDiningSchedule(scheduleId: string): Promise<void> {
  return apiFetch<void>(`/api/admin/dining/schedules/${encodeURIComponent(scheduleId)}`, { method: "DELETE" });
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

/** GET /api/admin/feature-feedback — 功能评分列表（运营数据，最新 200 条）。 */
export function listFeatureFeedback(signal?: AbortSignal): Promise<ListResponse<FeatureFeedbackRow>> {
  return apiFetch<ListResponse<FeatureFeedbackRow>>("/api/admin/feature-feedback", { signal });
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

/** 发布校验发现的旧地图绑定；供发布中心直接指出应去哪里重新选点。 */
export interface ReleaseMapBindingIssue {
  anchorId: string;
  entityType: "place" | "facility" | "merchant_outlet" | "transit_stop";
  entityId: string;
  entityName: string;
  role: string;
  currentMapVersionId: string | null;
  currentMapVersionLabel: string | null;
  currentMapCampusName: string | null;
  selectedMapVersionId: string | null;
  selectedMapVersionLabel: string | null;
  selectedMapCampusName: string | null;
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
    /** 老 Worker 的校验响应没有该字段，前端读取时需兼容一次滚动部署窗口。 */
    mapBindingIssues?: ReleaseMapBindingIssue[];
    counts: Record<string, number>;
  };
}

export function publishRelease(body: PublishReleaseInput): Promise<PublishReleaseResult> {
  return apiFetch<PublishReleaseResult>("/api/admin/releases", { method: "POST", body });
}

export function rollbackRelease(releaseId: string, body: { reason: string | null }): Promise<unknown> {
  return apiFetch(`/api/admin/releases/${encodeURIComponent(releaseId)}/rollback`, { method: "POST", body });
}

/** GET /api/admin/releases 的一行：发布历史。 */
export interface ReleaseHistoryRow {
  id: string;
  version: string;
  status: string;
  summary: string | null;
  createdAt: string;
  activatedAt: string | null;
  createdBy: string | null;
  itemCount: number;
  rollbackEligible: boolean;
}

export async function listReleaseHistory(signal?: AbortSignal): Promise<ReleaseHistoryRow[]> {
  const response = await apiFetch<{ items: ReleaseHistoryRow[] }>("/api/admin/releases", { signal });
  return response.items;
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

/** 后台上传的自定义图标（0029）。iconKey 一律带 `custom-` 前缀。 */
export interface CustomFacilityIconRow {
  iconKey: string;
  label: string;
  status: string;
}

export interface FacilityTypesResponse {
  items: FacilityTypeRow[];
  /** 内置图标 key，界面据此渲染带预览的选择器。 */
  iconKeys: string[];
  /** 自定义图标，接在内置那排格子后面。含停用的，界面只把 active 的列为可选项。 */
  customIcons: CustomFacilityIconRow[];
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
// 自定义设施图标（0029）
//
// 内置图标是硬编码的（改一枚要动三处代码再发一次版），这条通道让后台直接上传
// SVG：字节落 R2，行落 facility_icons，键存进 facility_types.icon_key。
// ---------------------------------------------------------------------------

export interface FacilityIconRow {
  id: string;
  iconKey: string;
  label: string;
  status: string;
  byteSize: number;
  sha256: string;
  createdAt: string;
  updatedAt: string;
  /** 有多少个设施类型正在用它。>0 时删不掉。 */
  usageCount: number;
  metadata: Record<string, unknown>;
}

/** GET /api/admin/facility-icons — 全部自定义图标 + 各自的引用数。 */
export function listFacilityIcons(signal?: AbortSignal): Promise<{ items: FacilityIconRow[] }> {
  return apiFetch<{ items: FacilityIconRow[] }>("/api/admin/facility-icons", { signal });
}

/**
 * PUT /api/admin/facility-icons/:key?label=… — 上传 / 替换一枚图标（raw SVG body）。
 *
 * 同键重传即替换，引用它的设施类型不用改一个字。新建必须给 label（后台图标
 * 选择器要显示它），替换时不给就沿用原名。
 */
export function uploadFacilityIcon(
  iconKey: string,
  svg: ArrayBuffer | Blob | string,
  label?: string,
): Promise<{ iconKey: string; label: string; byteSize: number; status: string; metadata: Record<string, unknown> }> {
  return apiFetch(`/api/admin/facility-icons/${encodeURIComponent(iconKey)}`, {
    method: "PUT",
    query: label === undefined ? undefined : { label },
    rawBody: svg,
    contentType: "image/svg+xml",
  });
}

/** PATCH /api/admin/facility-icons/:key — 改名 / 停用启用。 */
export function updateFacilityIcon(
  iconKey: string,
  body: { label?: string; status?: "active" | "disabled" },
): Promise<{ iconKey: string; label: string; status: string }> {
  return apiFetch(`/api/admin/facility-icons/${encodeURIComponent(iconKey)}`, { method: "PATCH", body });
}

/** DELETE /api/admin/facility-icons/:key — 仅在没有设施类型引用时可用。 */
export function deleteFacilityIcon(iconKey: string): Promise<{ iconKey: string; deleted: boolean }> {
  return apiFetch(`/api/admin/facility-icons/${encodeURIComponent(iconKey)}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// 楼层与楼层平面图管理
//
// 与设施 / 商户的同步靠共享的 floor_id 外键：这些列表是**反查**出来的，所以在设施
// 编辑器里改了楼层归属，楼层页刷新即变，不存在两处数据不一致。
//
// 楼层平面图不再是 SVG map_version：每层一张位图（floors.image_media_id →
// media_assets），上传即替换，见 uploadFloorImage。
// ---------------------------------------------------------------------------

/** 一层楼被引用的次数，非零则不能删除。 */
export interface FloorUsage {
  facilities: number;
  merchants: number;
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
  /** 平面图位图 media_assets id；未上传为 null。 */
  imageMediaId: string | null;
  /** 平面图位图公开地址（/api/public/media/<id>）；未上传为 null。 */
  imageUrl: string | null;
  usage: FloorUsage;
}

export interface FloorsOverviewResponse {
  building: { placeId: string; displayName: string | null; campusId: string | null };
  items: FloorOverviewRow[];
}

/** GET /api/admin/floors?buildingPlaceId=… — 一栋楼的全部楼层 + 每层平面图与引用计数。 */
export function listBuildingFloors(buildingPlaceId: string, signal?: AbortSignal): Promise<FloorsOverviewResponse> {
  return apiFetch<FloorsOverviewResponse>("/api/admin/floors", { query: { buildingPlaceId }, signal });
}

export interface FloorFacilityRow {
  id: string;
  facilityTypeId: string;
  facilityTypeName: string;
  lifecycleStatus: string;
  operationalStatus: string;
  displayName: string;
  editorialStatus: string | null;
  /** 已在平面图上标出服务位置的锚点数；0 表示这个设施还没落点。 */
  positionedCount: number;
}

export interface FloorMerchantRow {
  id: string;
  lifecycleStatus: string;
  displayName: string | null;
  businessType: string | null;
  editorialStatus: string | null;
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
    imageMediaId: string | null;
    imageUrl: string | null;
  };
  facilities: FloorFacilityRow[];
  merchants: FloorMerchantRow[];
  anchors: FloorAnchorRow[];
  usage: FloorUsage;
}

/** GET /api/admin/floors/:id — 单层详情：该层设施 / 商户 / 锚点与引用计数。 */
export function getFloorDetail(floorId: string, signal?: AbortSignal): Promise<FloorDetailResponse> {
  return apiFetch<FloorDetailResponse>(`/api/admin/floors/${encodeURIComponent(floorId)}`, { signal });
}

/** DELETE /api/admin/floors/:id — 仅在该层没有任何引用时可用，否则 409 floor_in_use。 */
export function deleteFloor(floorId: string): Promise<{ id: string; deleted: boolean }> {
  return apiFetch<{ id: string; deleted: boolean }>(`/api/admin/floors/${encodeURIComponent(floorId)}`, {
    method: "DELETE",
  });
}

// ---------------------------------------------------------------------------
// 指南文档（guide_documents）
//
// 一套端点服务两份内容，按 slug 区分：freshman-transit 是返校指南（由
// public/guide/editor.html 那个独立静态编辑器维护），shuttle-ride 是校车乘坐
// 指南（由 admin 内的 ShuttleGuidePanel 维护）。两份走同一条草稿→送审→发布→
// 回滚的流水线，互不干扰。
//
// 这些函数以前不存在：返校指南编辑器是纯静态页，直接 fetch 拼字符串。
// 校车乘坐指南跑在 React admin 里，走 apiFetch 才能拿到统一的
// ApiError 语义与 admin-data-changed 刷新广播。
// ---------------------------------------------------------------------------

export interface GuideDocumentRow {
  id: string;
  slug: string;
  title: string;
  lifecycleStatus: "draft" | "published" | "archived";
  currentRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
  publishedRevisionNo: number | null;
  publishedEdition: string | null;
  revisionCount: number;
  openCount: number;
}

export interface GuideRevisionRow {
  id: string;
  revisionNo: number;
  editorialStatus: "draft" | "in_review" | "approved" | "rejected" | "superseded";
  title: string;
  edition: string | null;
  note: string | null;
  contentHash: string;
  createdAt: string;
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  contentBytes: number;
  authorName: string | null;
  reviewerName: string | null;
}

export interface GuideDocumentDetail {
  document: {
    id: string;
    slug: string;
    title: string;
    lifecycleStatus: "draft" | "published" | "archived";
    currentRevisionId: string | null;
    createdAt: string;
    updatedAt: string;
  };
  revisions: GuideRevisionRow[];
  /** 当前在编辑的那一版（优先 in_review，其次最新 draft，都没有则退回已发布版）。 */
  working: {
    id: string;
    revisionNo: number;
    editorialStatus: string;
    content: Record<string, unknown>;
  } | null;
}

/** GET /api/admin/guide/documents */
export function listGuideDocuments(signal?: AbortSignal): Promise<ListResponse<GuideDocumentRow>> {
  return apiFetch<ListResponse<GuideDocumentRow>>("/api/admin/guide/documents", { signal });
}

/** GET /api/admin/guide/documents/:id */
export function getGuideDocument(id: string, signal?: AbortSignal): Promise<GuideDocumentDetail> {
  return apiFetch<GuideDocumentDetail>(`/api/admin/guide/documents/${encodeURIComponent(id)}`, { signal });
}

/** POST /api/admin/guide/documents — 新建文档（content 可省，服务端给空壳）。 */
export function createGuideDocument(body: {
  slug: string;
  title: string;
  edition?: string | null;
  note?: string | null;
  content?: Record<string, unknown>;
}): Promise<{ id: string; revisionId: string; revisionNo: number; editorialStatus: string; contentHash: string }> {
  return apiFetch("/api/admin/guide/documents", { method: "POST", body });
}

/**
 * POST /api/admin/guide/documents/:id/revisions — 保存草稿。
 *
 * 语义是「保存」而不是「开新版」：已有 draft 就原地更新，只有已发布版时才
 * 开新的一版。送审中（in_review）保存会被服务端 409 拒掉。
 */
export function saveGuideRevision(
  documentId: string,
  body: { title: string; edition?: string | null; note?: string | null; content: Record<string, unknown> },
): Promise<{ id: string; revisionNo: number; editorialStatus: string; contentHash: string; unchanged?: boolean }> {
  return apiFetch(`/api/admin/guide/documents/${encodeURIComponent(documentId)}/revisions`, { method: "POST", body });
}

/** POST /api/admin/guide/revisions/:id/submit — 送审（仅 draft 可送）。 */
export function submitGuideRevision(revisionId: string, note?: string): Promise<{ id: string; editorialStatus: string }> {
  return apiFetch(`/api/admin/guide/revisions/${encodeURIComponent(revisionId)}/submit`, {
    method: "POST",
    body: note ? { note } : {},
  });
}

/** POST /api/admin/guide/revisions/:id/review — 审核决议（仅 in_review 可决）。 */
export function reviewGuideRevision(
  revisionId: string,
  decision: "approve" | "reject",
  note?: string,
): Promise<{ id: string; editorialStatus: string }> {
  return apiFetch(`/api/admin/guide/revisions/${encodeURIComponent(revisionId)}/review`, {
    method: "POST",
    body: note ? { decision, note } : { decision },
  });
}

/**
 * POST /api/admin/guide/documents/:id/publish — 发布 / 回滚。
 * 指向更新的版本是发布，指向更早的是回滚，机制完全一样；只能指向 approved 版。
 */
export function publishGuideRevision(
  documentId: string,
  revisionId: string,
): Promise<{ id: string; currentRevisionId: string; lifecycleStatus: string }> {
  return apiFetch(`/api/admin/guide/documents/${encodeURIComponent(documentId)}/publish`, {
    method: "POST",
    body: { revisionId },
  });
}

/** POST /api/admin/guide/documents/:id/unpublish — 下线（前台立刻 404，内容与历史保留）。 */
export function unpublishGuideDocument(
  documentId: string,
): Promise<{ id: string; currentRevisionId: null; lifecycleStatus: string }> {
  return apiFetch(`/api/admin/guide/documents/${encodeURIComponent(documentId)}/unpublish`, { method: "POST" });
}

/**
 * PUT /api/admin/guide/assets/:key?kind=… — 上传 / 替换素材。
 *
 * 按 key 寻址而不是 POST 新建：同一个键重复上传即替换，引用它的内容不必改。
 * kind=figure_png 实收 PNG 与 JPEG（服务端按魔术字节嗅探），小程序端只有位图画得出来。
 */
export function uploadGuideAsset(
  key: string,
  bytes: ArrayBuffer | Blob,
  kind: "figure_png" | "figure_svg" | "icon_png" | "icon_svg" = "figure_png",
  contentType = "image/png",
): Promise<{ assetKey: string; assetKind: string; byteSize: number; contentType: string; metadata: Record<string, unknown> }> {
  return apiFetch(`/api/admin/guide/assets/${encodeURIComponent(key)}`, {
    method: "PUT",
    query: { kind },
    rawBody: bytes,
    contentType,
  });
}

/** 素材键 → 公共读地址（管理端预览用同源相对路径）。 */
export function guideAssetUrl(assetKey: string): string {
  return `/api/public/guide-assets/${encodeURIComponent(assetKey)}`;
}

// ---------------------------------------------------------------------------
// 埋点统计
// ---------------------------------------------------------------------------

export interface AnalyticsEventTypeCount {
  event_type: string;
  event_count: number;
}

export interface AnalyticsDailyCount extends AnalyticsEventTypeCount {
  day: string;
}

export interface AnalyticsTopPlace {
  place_id: string;
  place_name: string | null;
  view_count: number;
}

export interface AnalyticsSummaryResponse {
  days: number;
  since: string;
  totals: AnalyticsEventTypeCount[];
  daily: AnalyticsDailyCount[];
  topPlaces: AnalyticsTopPlace[];
}

/** GET /api/admin/analytics/summary?days= — 用户埋点事件统计（类型汇总 + 按天拆分 + POI 曝光榜）。 */
export function getAnalyticsSummary(days: number, signal?: AbortSignal): Promise<AnalyticsSummaryResponse> {
  return apiFetch<AnalyticsSummaryResponse>("/api/admin/analytics/summary", { query: { days }, signal });
}
