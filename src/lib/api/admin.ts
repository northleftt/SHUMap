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

export function createFloor(body: Record<string, unknown>): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/api/admin/floors", { method: "POST", body });
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

// ---------------------------------------------------------------------------
// Facilities + merchants
// ---------------------------------------------------------------------------

export function listFacilities<T = unknown>(signal?: AbortSignal): Promise<ListResponse<T>> {
  return apiFetch<ListResponse<T>>("/api/admin/facilities", { signal });
}

export function createFacility(body: Record<string, unknown>): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/api/admin/facilities", { method: "POST", body });
}

export function createFacilityRevision(id: string, body: Record<string, unknown>): Promise<{ id: string }> {
  return apiFetch<{ id: string }>(`/api/admin/facilities/${encodeURIComponent(id)}/revisions`, {
    method: "POST",
    body,
  });
}

export function listMerchants<T = unknown>(signal?: AbortSignal): Promise<ListResponse<T>> {
  return apiFetch<ListResponse<T>>("/api/admin/merchants", { signal });
}

export function createMerchant(body: Record<string, unknown>): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/api/admin/merchants", { method: "POST", body });
}

export function createMerchantRevision(id: string, body: Record<string, unknown>): Promise<{ id: string }> {
  return apiFetch<{ id: string }>(`/api/admin/merchants/${encodeURIComponent(id)}/revisions`, {
    method: "POST",
    body,
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

export function reviewOperation(id: string, body: { decision: "approve" | "reject" }): Promise<unknown> {
  return apiFetch(`/api/admin/operations/${encodeURIComponent(id)}/review`, { method: "POST", body });
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

// ---------------------------------------------------------------------------
// Submissions review
// ---------------------------------------------------------------------------

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
}

export function listSubmissions(signal?: AbortSignal): Promise<ListResponse<AdminSubmission>> {
  return apiFetch<ListResponse<AdminSubmission>>("/api/admin/submissions", { signal });
}

export function reviewSubmission(
  id: string,
  body: { decision: "accept" | "partial" | "reject"; note?: string; fieldDecisions?: Record<string, unknown> },
): Promise<{ id: string; submissionId: string; status: string }> {
  return apiFetch<{ id: string; submissionId: string; status: string }>(
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
