// Typed client for the v2 admin API surface. All requests use cookie-session
// auth (credentials: "include" via apiFetch); there are no Bearer tokens.
// Route map: worker/index-v2.ts (routeAdmin) and worker/modules/*.

import { apiFetch } from "./client";

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
  isPublic?: boolean;
}): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/api/admin/floors", { method: "POST", body });
}

/** PATCH /api/admin/floors/:id — 楼层显示名 / 排序 / 是否对外可见。 */
export function updateFloor(
  floorId: string,
  body: { displayName?: string; levelOrder?: number; isPublic?: boolean },
): Promise<{ id: string; displayName: string; levelOrder: number; isPublic: number }> {
  return apiFetch(`/api/admin/floors/${encodeURIComponent(floorId)}`, { method: "PATCH", body });
}

export function createSpace(body: Record<string, unknown>): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/api/admin/spaces", { method: "POST", body });
}

export function createOrganization(body: Record<string, unknown>): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/api/admin/organizations", { method: "POST", body });
}

export function createDataSource(body: Record<string, unknown>): Promise<{ id: string }> {
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

export function createPlace(body: Record<string, unknown>): Promise<{ id: string; revisionId: string }> {
  return apiFetch<{ id: string; revisionId: string }>("/api/admin/places", { method: "POST", body });
}

export function createPlaceRevision(placeId: string, body: Record<string, unknown>): Promise<{ id: string }> {
  return apiFetch<{ id: string }>(`/api/admin/places/${encodeURIComponent(placeId)}/revisions`, {
    method: "POST",
    body,
  });
}

/**
 * PATCH /api/admin/places/:id — 结构字段（类型 / 校区 / 编码 / 别名）即时生效。
 *
 * 这些字段在修订表里没有对应列，因此不走「草稿 → 审核 → 发布」，提交即写库。
 * 名称、简介、详细描述等正文字段仍旧只能经 createPlaceRevision。
 */
export function updatePlace(
  placeId: string,
  body: {
    kindId?: string;
    campusId?: string | null;
    stableCode?: string | null;
    buildingCode?: string | null;
    aliases?: string[];
  },
): Promise<{ id: string; kindId: string; campusId: string | null; stableCode: string | null }> {
  return apiFetch(`/api/admin/places/${encodeURIComponent(placeId)}`, { method: "PATCH", body });
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

export function createFacility(body: Record<string, unknown>): Promise<{ id: string; revisionId: string }> {
  return apiFetch<{ id: string; revisionId: string }>("/api/admin/facilities", { method: "POST", body });
}

export function createFacilityRevision(id: string, body: Record<string, unknown>): Promise<{ id: string }> {
  return apiFetch<{ id: string }>(`/api/admin/facilities/${encodeURIComponent(id)}/revisions`, {
    method: "POST",
    body,
  });
}

/**
 * PATCH /api/admin/facilities/:id — 挂接关系（类型 / 楼宇 / 楼层）即时生效。
 * 与 updatePlace 同理：这些字段在修订表里没有对应列，不走审核流。
 */
export function updateFacility(
  id: string,
  body: {
    facilityTypeId?: string;
    hostPlaceId?: string | null;
    floorId?: string | null;
    indoorSpaceId?: string | null;
    operationalStatus?: string;
  },
): Promise<{ id: string; facilityTypeId: string; hostPlaceId: string | null; floorId: string | null }> {
  return apiFetch(`/api/admin/facilities/${encodeURIComponent(id)}`, { method: "PATCH", body });
}

/**
 * PUT /api/admin/facilities/:id/location — 服务位置锚点 replace-all。
 *
 * `point` 是楼层图的 svg_viewbox 坐标，需同时给 mapVersionId；只给 locationHint
 * 表示「无图纸，仅文字引导」；两者都不给即清空该设施的位置。
 */
export function replaceFacilityLocation(
  id: string,
  body: { point?: { x: number; y: number } | null; mapVersionId?: string | null; locationHint?: string | null },
): Promise<{ id: string; removed: number; anchorId: string | null }> {
  return apiFetch(`/api/admin/facilities/${encodeURIComponent(id)}/location`, { method: "PUT", body });
}

export function listMerchants<T = unknown>(signal?: AbortSignal): Promise<ListResponse<T>> {
  return apiFetch<ListResponse<T>>("/api/admin/merchants", { signal });
}

export function getMerchant<T = unknown>(id: string, signal?: AbortSignal): Promise<T> {
  return apiFetch<T>(`/api/admin/merchants/${encodeURIComponent(id)}`, { signal });
}

export function createMerchant(body: Record<string, unknown>): Promise<{ id: string; revisionId: string }> {
  return apiFetch<{ id: string; revisionId: string }>("/api/admin/merchants", { method: "POST", body });
}

export function createMerchantRevision(id: string, body: Record<string, unknown>): Promise<{ id: string }> {
  return apiFetch<{ id: string }>(`/api/admin/merchants/${encodeURIComponent(id)}/revisions`, {
    method: "POST",
    body,
  });
}

/**
 * PATCH /api/admin/merchants/:id — 门店挂接关系（品牌 / 地点 / 楼层）即时生效。
 */
export function updateMerchant(
  id: string,
  body: {
    organizationId?: string | null;
    hostPlaceId?: string | null;
    floorId?: string | null;
    indoorSpaceId?: string | null;
  },
): Promise<{ id: string; organizationId: string | null; hostPlaceId: string | null; floorId: string | null }> {
  return apiFetch(`/api/admin/merchants/${encodeURIComponent(id)}`, { method: "PATCH", body });
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
  lifecycleStatus: string;
  createdAt: string;
  featureCount: number;
}

export function listMapVersions(signal?: AbortSignal): Promise<ListResponse<MapVersionRow>> {
  return apiFetch<ListResponse<MapVersionRow>>("/api/admin/maps", { signal });
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
  bboxJson: string | null;
  shapeHash: string | null;
  metadataJson: string;
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
  coordinateSpaceType: string;
  coordinateSpace: Record<string, unknown>;
}): Promise<{ id: string; status: string }> {
  return apiFetch<{ id: string; status: string }>("/api/admin/maps/import-jobs", { method: "POST", body });
}

// ---------------------------------------------------------------------------
// Operations + campaigns (admin views)
// ---------------------------------------------------------------------------

export function listAdminOperations<T = unknown>(signal?: AbortSignal): Promise<ListResponse<T>> {
  return apiFetch<ListResponse<T>>("/api/admin/operations", { signal });
}

export function createOperation(body: Record<string, unknown>): Promise<{ id: string }> {
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
  role: string;
  geometryType: string;
  geometryJson: string | null;
  crs: string | null;
  campusId: string | null;
}

export interface OperationLocationInput {
  role: string;
  campusId?: string | null;
  mapVersionId?: string | null;
  geometryType: string;
  geometry: unknown;
  crs: string;
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

export function createTransitStop(body: Record<string, unknown>): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/api/admin/transit/stops", { method: "POST", body });
}

export function createTransitRoute(body: Record<string, unknown>): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/api/admin/transit/routes", { method: "POST", body });
}

export function createTransitPattern(body: Record<string, unknown>): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/api/admin/transit/patterns", { method: "POST", body });
}

export function createTransitCalendar(body: Record<string, unknown>): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/api/admin/transit/calendars", { method: "POST", body });
}

export function createTransitTrip(body: Record<string, unknown>): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/api/admin/transit/trips", { method: "POST", body });
}

/**
 * PUT /api/admin/transit/patterns/:id/stops — replace-all: the payload order
 * becomes the new stop sequence, so add / remove / reorder all use this call.
 */
export function replaceTransitPatternStops(
  patternId: string,
  stops: Array<{ stopId: string; pickupType: string; dropoffType: string }>,
): Promise<{ patternId: string }> {
  return apiFetch<{ patternId: string }>(`/api/admin/transit/patterns/${encodeURIComponent(patternId)}/stops`, {
    method: "PUT",
    body: { stops },
  });
}

export function updateTransitTrip(tripId: string, body: Record<string, unknown>): Promise<{ id: string }> {
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
  targetType: string;
  targetId: string | null;
  baseRevisionId: string | null;
  payloadJson: string;
  submitterName: string | null;
  submitterContact: string | null;
  status: string;
  createdAt: string;
  reviewedAt: string | null;
  photos: AdminSubmissionPhoto[];
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
  body: { decision: "accept" | "partial" | "reject"; note?: string; fieldDecisions?: Record<string, unknown> },
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
  summary?: string;
  reason?: string;
  mapVersionIds?: string[];
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
    counts: Record<string, number>;
  };
}

export function publishRelease(body: PublishReleaseInput): Promise<PublishReleaseResult> {
  return apiFetch<PublishReleaseResult>("/api/admin/releases", { method: "POST", body });
}

export function rollbackRelease(releaseId: string, body: { reason?: string } = {}): Promise<unknown> {
  return apiFetch(`/api/admin/releases/${encodeURIComponent(releaseId)}/rollback`, { method: "POST", body });
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
  instanceCount: number;
  instances: FacilityTypeInstanceRow[];
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

export function createFacilityType(body: {
  code: string;
  name: string;
  category?: string;
  iconKey?: string | null;
  verificationIntervalDays?: number | null;
}): Promise<FacilityTypeRow> {
  return apiFetch<FacilityTypeRow>("/api/admin/facility-types", { method: "POST", body });
}

/** PATCH /api/admin/facility-types/:id — code 不可改；status='disabled' 即停用。 */
export function updateFacilityType(
  id: string,
  body: {
    name?: string;
    category?: string;
    iconKey?: string | null;
    status?: "active" | "disabled";
    verificationIntervalDays?: number | null;
  },
): Promise<FacilityTypeRow> {
  return apiFetch<FacilityTypeRow>(`/api/admin/facility-types/${encodeURIComponent(id)}`, { method: "PATCH", body });
}

/** DELETE /api/admin/facility-types/:id — 仅在没有任何点位引用时可用。 */
export function deleteFacilityType(id: string): Promise<{ id: string; deleted: boolean }> {
  return apiFetch<{ id: string; deleted: boolean }>(`/api/admin/facility-types/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
