// Typed client for the v2 public API surface. All content is release-derived;
// there is no fallback to bundled static data. When no release is active the
// Worker returns 503 release_unavailable, surfaced as ApiError.isReleaseUnavailable.

import { apiFetch } from "./client";
import type {
  CampaignsResponse,
  JourneysResponse,
  OperationalEventsResponse,
  PublicPlaceListResponse,
  PublicPlaceResponse,
  ReleaseManifest,
  SearchResponse,
  SubmissionInput,
  SubmissionResult,
} from "./types";

/** GET /api/public/releases/current — the sole production content source. */
export function getCurrentRelease(signal?: AbortSignal): Promise<ReleaseManifest> {
  return apiFetch<ReleaseManifest>("/api/public/releases/current", { signal });
}

/** GET /api/public/releases/:id — immutable versioned artifact. */
export function getRelease(releaseId: string, signal?: AbortSignal): Promise<ReleaseManifest> {
  return apiFetch<ReleaseManifest>(`/api/public/releases/${encodeURIComponent(releaseId)}`, { signal });
}

/** GET /api/public/search — published search over the active release. */
export function search(
  params: { q: string; campusId?: string | null; type?: string | null },
  signal?: AbortSignal,
): Promise<SearchResponse> {
  return apiFetch<SearchResponse>("/api/public/search", {
    query: { q: params.q, campusId: params.campusId, type: params.type },
    signal,
  });
}

/** GET /api/public/places — release place index. */
export function listPlaces(signal?: AbortSignal): Promise<PublicPlaceListResponse> {
  return apiFetch<PublicPlaceListResponse>("/api/public/places", { signal });
}

/** GET /api/public/places/:id — place detail assembled from the active release. */
export function getPlace(placeId: string, signal?: AbortSignal): Promise<PublicPlaceResponse> {
  return apiFetch<PublicPlaceResponse>(`/api/public/places/${encodeURIComponent(placeId)}`, { signal });
}

/** GET /api/public/transit/journeys — GTFS-like journeys between two stops on a date. */
export function getJourneys(
  params: { fromStopId: string; toStopId: string; date?: string },
  signal?: AbortSignal,
): Promise<JourneysResponse> {
  return apiFetch<JourneysResponse>("/api/public/transit/journeys", {
    query: { fromStopId: params.fromStopId, toStopId: params.toStopId, date: params.date },
    signal,
  });
}

/** GET /api/public/operations — approved, currently-active operational events. */
export function listOperations(signal?: AbortSignal): Promise<OperationalEventsResponse> {
  return apiFetch<OperationalEventsResponse>("/api/public/operations", { signal });
}

/** GET /api/public/campaigns — approved, currently-active campaigns. */
export function listCampaigns(signal?: AbortSignal): Promise<CampaignsResponse> {
  return apiFetch<CampaignsResponse>("/api/public/campaigns", { signal });
}

/** POST /api/public/submissions — public contribution against the new submission contract. */
export function createSubmission(input: SubmissionInput, signal?: AbortSignal): Promise<SubmissionResult> {
  return apiFetch<SubmissionResult>("/api/public/submissions", {
    method: "POST",
    body: input,
    signal,
  });
}
