// Typed client for the v2 public API surface. All content is release-derived;
// bundled static data is never consulted. When no release is active the Worker
// returns 503 release_unavailable, surfaced as ApiError.isReleaseUnavailable.

import { ApiError, apiFetch } from "./client";
import { parseReleaseManifest } from "../release/manifestContract";
import { parseFacilityStatusResponse, parseOperationalEventsResponse } from "./publicContract";
import type {
  CampaignsResponse,
  CollectionTaskDto,
  CollectionTasksResponse,
  OwnedCollectionTaskDto,
  FacilityStatusResponse,
  JourneysResponse,
  MediaUploadResult,
  OperationalEventsResponse,
  PublicPlaceListResponse,
  PublicPlaceResponse,
  ReleaseManifest,
  SearchResponse,
  SubmissionInput,
  SubmissionResult,
  TripStopsResponse,
} from "./types";
import type { CollectionPayload } from "../../../shared/submission-contract";

/** GET /api/public/releases/current — the sole production content source. */
export async function getCurrentRelease(signal?: AbortSignal): Promise<ReleaseManifest> {
  const value = await apiFetch<unknown>("/api/public/releases/current", { signal });
  return parseReleaseManifest(value);
}

/** GET /api/public/releases/current — null only when no release is active. */
export async function getOptionalCurrentRelease(signal?: AbortSignal): Promise<ReleaseManifest | null> {
  try {
    return await getCurrentRelease(signal);
  } catch (error) {
    if (error instanceof ApiError && error.isReleaseUnavailable) return null;
    throw error;
  }
}

/** GET /api/public/releases/:id — immutable versioned artifact. */
export async function getRelease(releaseId: string, signal?: AbortSignal): Promise<ReleaseManifest> {
  const value = await apiFetch<unknown>(`/api/public/releases/${encodeURIComponent(releaseId)}`, { signal });
  return parseReleaseManifest(value);
}

/**
 * GET /api/public/maps/:mapVersionId/asset — 底图源文件（SVG/位图）。
 * 仅当该 map version 属于当前 active release 时可读，否则 404。
 * 返回的是相对路径，交给 <img>/fetch 使用，不经 apiFetch（响应不是 JSON）。
 */
export function mapAssetUrl(mapVersionId: string): string {
  return `/api/public/maps/${encodeURIComponent(mapVersionId)}/asset`;
}

/** 取底图 SVG 源码（内联渲染需要 DOM，因此取文本而非用 <img>）。 */
export async function fetchMapAssetSvg(mapVersionId: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(mapAssetUrl(mapVersionId), { credentials: "omit", signal });
  if (!response.ok) throw new Error(`底图读取失败（${response.status}）`);
  return response.text();
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

/**
 * GET /api/public/transit/trips/:tripId/stops — 班次的完整停靠序列（含时刻）。
 *
 * 不走 release manifest：班次时刻改了要立刻生效，快照里只留站点。
 */
export function getTripStops(tripId: string, signal?: AbortSignal): Promise<TripStopsResponse> {
  return apiFetch<TripStopsResponse>(`/api/public/transit/trips/${encodeURIComponent(tripId)}/stops`, { signal });
}

/**
 * GET /api/public/facility-status — 设施运营状态的实时读端。
 *
 * manifest 里的 operationalStatus 是发布快照基线，这里取到的新值盖在其上。
 */
export async function getFacilityStatus(signal?: AbortSignal): Promise<FacilityStatusResponse> {
  const value = await apiFetch<unknown>("/api/public/facility-status", { signal });
  return parseFacilityStatusResponse(value);
}

/** GET /api/public/operations — approved, currently-active operational events. */
export async function listOperations(signal?: AbortSignal): Promise<OperationalEventsResponse> {
  const value = await apiFetch<unknown>("/api/public/operations", { signal });
  return parseOperationalEventsResponse(value);
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

/**
 * POST /api/public/media — anonymous photo upload. Raw image bytes, no JSON envelope;
 * the Worker sniffs the magic bytes, caps each file at 2 MiB and parks the object in
 * the quarantine scope until a reviewer accepts the submission it is attached to.
 */
export function uploadPublicPhoto(blob: Blob, signal?: AbortSignal): Promise<MediaUploadResult> {
  return apiFetch<MediaUploadResult>("/api/public/media", {
    method: "POST",
    rawBody: blob,
    contentType: blob.type || "image/jpeg",
    signal,
  });
}

/** 采集表单可选的设施类型。 */
export interface PublicFacilityType {
  code: string;
  name: string;
  iconKey: string | null;
  status: "active" | "disabled";
}

/**
 * GET /api/public/facility-types — 采集读写共用的完整设施类型身份表。
 *
 * 不走 release manifest：状态需实时决定新建设施选项，历史采集记录仍用停用项解析名称。
 */
export function listPublicFacilityTypes(signal?: AbortSignal): Promise<{ items: PublicFacilityType[] }> {
  return apiFetch<{ items: PublicFacilityType[] }>("/api/public/facility-types", { signal });
}

export function listCollectionTasks(deviceId: string, signal?: AbortSignal): Promise<CollectionTasksResponse> {
  return apiFetch<CollectionTasksResponse>("/api/public/collection-tasks", {
    headers: { "x-shumap-device-id": deviceId },
    signal,
  });
}

export function claimCollectionTask(
  buildingId: string,
  body: { deviceId: string },
): Promise<{ task: OwnedCollectionTaskDto }> {
  return apiFetch<{ task: OwnedCollectionTaskDto }>(
    `/api/public/collection-tasks/${encodeURIComponent(buildingId)}/claim`,
    { method: "POST", body, headers: { "x-shumap-device-id": body.deviceId } },
  );
}

export function saveCollectionTask(
  buildingId: string,
  body: { deviceId: string; payload: CollectionPayload },
): Promise<{ task: OwnedCollectionTaskDto }> {
  return apiFetch<{ task: OwnedCollectionTaskDto }>(
    `/api/public/collection-tasks/${encodeURIComponent(buildingId)}`,
    { method: "PUT", body, headers: { "x-shumap-device-id": body.deviceId } },
  );
}

export function submitCollectionTask(
  buildingId: string,
  body: { deviceId: string; payload: CollectionPayload },
): Promise<{ task: OwnedCollectionTaskDto; submissionId: string }> {
  return apiFetch<{ task: OwnedCollectionTaskDto; submissionId: string }>(
    `/api/public/collection-tasks/${encodeURIComponent(buildingId)}/submit`,
    { method: "POST", body, headers: { "x-shumap-device-id": body.deviceId } },
  );
}
