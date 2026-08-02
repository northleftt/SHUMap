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

export interface OrganizationCreateInput {
  name: string;
  kind: string;
}

export function createOrganization(body: OrganizationCreateInput): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/api/admin/organizations", { method: "POST", body });
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

export interface MapFilterRow {
  id: string;
  key: string;
  label: string;
  active: boolean;
  sortOrder: number;
  members: MapFilterMemberRow[];
}

export interface MapFilterMemberRow {
  id: string;
  categoryId: string;
  placeKindId: string | null;
  facilityTypeId: string | null;
  includesMerchants: boolean;
  sortOrder: number;
  targetLabel: string;
  targetCode: string | null;
}

export interface MapFilterTargetRow {
  id: string;
  name: string;
  code?: string;
}

export interface MapFiltersResponse {
  items: MapFilterRow[];
  placeKinds: PlaceKindRow[];
  unassigned: {
    placeKinds: MapFilterTargetRow[];
    facilityTypes: MapFilterTargetRow[];
    includesMerchants: boolean;
  };
}

export interface PlaceKindRow {
  id: string;
  name: string;
  sortOrder: number;
  isSearchable: boolean;
  placeCount: number;
  mapFilterMemberId: string | null;
  categoryId: string | null;
}

export function listMapFilters(signal?: AbortSignal): Promise<MapFiltersResponse> {
  return apiFetch<MapFiltersResponse>("/api/admin/map-filters", { signal });
}

export function createMapFilter(body: { key: string; label: string; sortOrder: number }): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/api/admin/map-filters", { method: "POST", body });
}

export function updateMapFilter(id: string, body: Partial<Pick<MapFilterRow, "label" | "sortOrder">> & { active?: boolean }): Promise<{ id: string }> {
  return apiFetch<{ id: string }>(`/api/admin/map-filters/${encodeURIComponent(id)}`, { method: "PATCH", body });
}

export function deleteMapFilter(id: string): Promise<void> {
  return apiFetch<void>(`/api/admin/map-filters/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function createMapFilterMember(
  categoryId: string,
  body: { placeKindId: string } | { facilityTypeId: string } | { includesMerchants: true },
): Promise<{ id: string }> {
  return apiFetch<{ id: string }>(`/api/admin/map-filters/${encodeURIComponent(categoryId)}/members`, {
    method: "POST",
    body,
  });
}

export function updateMapFilterMember(
  id: string,
  body: { categoryId?: string; sortOrder?: number },
): Promise<{ id: string }> {
  return apiFetch<{ id: string }>(`/api/admin/map-filter-members/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
  });
}

export function deleteMapFilterMember(id: string): Promise<void> {
  return apiFetch<void>(`/api/admin/map-filter-members/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function listPlaceKinds(signal?: AbortSignal): Promise<ListResponse<PlaceKindRow>> {
  return apiFetch<ListResponse<PlaceKindRow>>("/api/admin/place-kinds", { signal });
}

export function createPlaceKind(body: {
  id: string;
  name: string;
  sortOrder?: number;
  isSearchable?: boolean;
  categoryId: string;
}): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/api/admin/place-kinds", { method: "POST", body });
}

export function updatePlaceKind(
  id: string,
  body: { name?: string; sortOrder?: number; isSearchable?: boolean },
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

export interface TransitRouteCreateInput {
  name: string;
  code: string | null;
  operatorId: string | null;
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
  collectionReferenceCount: number;
  mapFilterMemberId: string;
  mapFilterCategoryId: string;
  mapFilterLabel: string;
  mapFilterActive: boolean;
  instances: FacilityTypeInstanceRow[];
}

export interface FacilityTypeMapFilterCategory {
  id: string;
  label: string;
  active: boolean;
  sortOrder: number;
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
  mapFilterCategories: FacilityTypeMapFilterCategory[];
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
  mapFilterCategoryId: string;
}): Promise<FacilityTypeWriteResult> {
  return apiFetch<FacilityTypeWriteResult>("/api/admin/facility-types", { method: "POST", body });
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
    mapFilterCategoryId?: string;
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
