import type { Env, ExecutionContext, MessageBatch } from "./types/cloudflare";
import type { QueueJobMessage, SessionPrincipal } from "./domain/types";
import { asErrorResponse, HttpError, json } from "./lib/http";
import { handleBootstrap, handleLogin, handleLogout, handleSession, requireSession } from "./modules/auth";
import { recordAnalyticsEvent } from "./modules/analytics";
import { claimCollectionTask, listCollectionTasks, saveCollectionTask, submitCollectionTask } from "./modules/collections";
import { createFacilityHandler, createFacilityRevisionHandler, getFacility, listFacilities } from "./modules/facilities";
import { processQueue } from "./modules/jobs";
import { enqueueMapImport, createMapUploadIntent, listMapFeatures, listMapVersions, uploadMapContent } from "./modules/maps";
import { getPublicMedia } from "./modules/media";
import { createMerchant, createMerchantRevision, getMerchant, listMerchants } from "./modules/merchants";
import { createCampaign, createOperationalEvent, createOperationalEventUpdate, decideOperationalEvent, listCampaigns, listOperationalEvents, replaceOperationalEventLocations } from "./modules/operations";
import { createPlaceHandler, createPlaceRevisionHandler, getPlace, listPlaces } from "./modules/places";
import { getCurrentRelease, getVersionedRelease, listPublicPlaces, publicHealth, publicPlace, publicSearch } from "./modules/public";
import { listPendingRevisions, reviewRevision, submitRevision } from "./modules/reviews";
import { createSubmission, listSubmissions, reviewSubmission } from "./modules/submissions";
import { createDataSource, createFloor, createOrganization, createSpace, listCampusesAndSpaces, listReferenceData } from "./modules/spaces";
import { createCalendar, createPattern, createRoute, createStop, createTrip, listTransit, publicJourneys } from "./modules/transit";

export { ReleaseCoordinator } from "./modules/releases";

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "geolocation=(self), camera=(), microphone=()",
  "x-frame-options": "DENY",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
    try {
      const response = await route(request, env, ctx, requestId);
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
      headers.set("x-request-id", requestId);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      const response = asErrorResponse(error);
      response.headers.set("x-request-id", requestId);
      return response;
    }
  },
  async queue(batch: MessageBatch<QueueJobMessage>, env: Env): Promise<void> {
    await processQueue(batch, env);
  },
};

async function route(request: Request, env: Env, _ctx: ExecutionContext, requestId: string): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const path = normalizePath(url.pathname);

  if (method === "GET" && path === "/api/health") return publicHealth();
  if (method === "POST" && path === "/api/analytics/events") return recordAnalyticsEvent(request, env);
  if (method === "POST" && path === "/api/auth/bootstrap") return handleBootstrap(request, env);
  if (method === "POST" && path === "/api/auth/login") return handleLogin(request, env);
  if (method === "POST" && path === "/api/auth/logout") return handleLogout(request, env);
  if (method === "GET" && path === "/api/auth/session") return handleSession(request, env);

  if (method === "GET" && path === "/api/public/releases/current") return getCurrentRelease(env);
  const versionedRelease = match(path, "/api/public/releases/:id");
  if (method === "GET" && versionedRelease) return getVersionedRelease(env, versionedRelease.id);
  if (method === "GET" && path === "/api/public/search") return publicSearch(request, env);
  if (method === "GET" && path === "/api/public/places") return listPublicPlaces(env);
  const publicPlaceId = match(path, "/api/public/places/:id");
  if (method === "GET" && publicPlaceId) return publicPlace(env, publicPlaceId.id);
  if (method === "GET" && path === "/api/public/operations") return listOperationalEvents(env, true);
  if (method === "GET" && path === "/api/public/campaigns") return listCampaigns(env, true);
  if (method === "GET" && path === "/api/public/transit/journeys") return publicJourneys(request, env);
  if (method === "POST" && path === "/api/public/submissions") return createSubmission(request, env);
  if (method === "GET" && path === "/api/public/collection-tasks") return listCollectionTasks(request, env);
  const collectionClaim = match(path, "/api/public/collection-tasks/:id/claim");
  if (method === "POST" && collectionClaim) return claimCollectionTask(request, env, collectionClaim.id);
  const collectionSubmit = match(path, "/api/public/collection-tasks/:id/submit");
  if (method === "POST" && collectionSubmit) return submitCollectionTask(request, env, collectionSubmit.id);
  const collectionTask = match(path, "/api/public/collection-tasks/:id");
  if (method === "PUT" && collectionTask) return saveCollectionTask(request, env, collectionTask.id);
  const media = match(path, "/api/public/media/:id");
  if (method === "GET" && media) return getPublicMedia(env, media.id);

  if (path.startsWith("/api/admin/")) {
    return routeAdmin(request, env, requestId, path, method);
  }

  if (path.startsWith("/api/")) throw new HttpError(404, "not_found", "API route does not exist");
  if (env.ASSETS) return env.ASSETS.fetch(request);
  return json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });
}

async function routeAdmin(request: Request, env: Env, requestId: string, path: string, method: string): Promise<Response> {
  let principal: SessionPrincipal;

  if (method === "GET" && path === "/api/admin/spaces") {
    await requireSession(request, env, "read:admin");
    return listCampusesAndSpaces(env);
  }
  if (method === "POST" && path === "/api/admin/floors") {
    principal = await requireSession(request, env, "write:maps");
    return createFloor(request, env, principal, requestId);
  }
  if (method === "POST" && path === "/api/admin/spaces") {
    principal = await requireSession(request, env, "write:maps");
    return createSpace(request, env, principal, requestId);
  }
  if (method === "GET" && path === "/api/admin/reference-data") {
    await requireSession(request, env, "read:admin");
    return listReferenceData(env);
  }
  if (method === "POST" && path === "/api/admin/organizations") {
    principal = await requireSession(request, env, "write:content");
    return createOrganization(request, env, principal, requestId);
  }
  if (method === "POST" && path === "/api/admin/data-sources") {
    principal = await requireSession(request, env, "write:content");
    return createDataSource(request, env, principal, requestId);
  }

  if (method === "GET" && path === "/api/admin/places") {
    principal = await requireSession(request, env, "read:admin");
    return listPlaces(env);
  }
  if (method === "POST" && path === "/api/admin/places") {
    principal = await requireSession(request, env, "write:content");
    return createPlaceHandler(request, env, principal, requestId);
  }
  const place = match(path, "/api/admin/places/:id");
  if (method === "GET" && place) {
    await requireSession(request, env, "read:admin");
    return getPlace(env, place.id);
  }
  const placeRevision = match(path, "/api/admin/places/:id/revisions");
  if (method === "POST" && placeRevision) {
    principal = await requireSession(request, env, "write:content");
    return createPlaceRevisionHandler(request, env, principal, placeRevision.id, requestId);
  }

  if (method === "GET" && path === "/api/admin/facilities") {
    await requireSession(request, env, "read:admin");
    return listFacilities(env);
  }
  if (method === "POST" && path === "/api/admin/facilities") {
    principal = await requireSession(request, env, "write:content");
    return createFacilityHandler(request, env, principal, requestId);
  }
  const facility = match(path, "/api/admin/facilities/:id");
  if (method === "GET" && facility) {
    await requireSession(request, env, "read:admin");
    return getFacility(env, facility.id);
  }
  const facilityRevision = match(path, "/api/admin/facilities/:id/revisions");
  if (method === "POST" && facilityRevision) {
    principal = await requireSession(request, env, "write:content");
    return createFacilityRevisionHandler(request, env, principal, facilityRevision.id, requestId);
  }

  if (method === "GET" && path === "/api/admin/merchants") {
    await requireSession(request, env, "read:admin");
    return listMerchants(env);
  }
  if (method === "POST" && path === "/api/admin/merchants") {
    principal = await requireSession(request, env, "write:content");
    return createMerchant(request, env, principal, requestId);
  }
  const merchant = match(path, "/api/admin/merchants/:id");
  if (method === "GET" && merchant) {
    await requireSession(request, env, "read:admin");
    return getMerchant(env, merchant.id);
  }
  const merchantRevision = match(path, "/api/admin/merchants/:id/revisions");
  if (method === "POST" && merchantRevision) {
    principal = await requireSession(request, env, "write:content");
    return createMerchantRevision(request, env, principal, merchantRevision.id, requestId);
  }

  const revisionSubmit = match(path, "/api/admin/revisions/:type/:id/submit");
  if (method === "POST" && revisionSubmit) {
    principal = await requireSession(request, env, "write:content");
    return submitRevision(request, env, principal, revisionType(revisionSubmit.type), revisionSubmit.id, requestId);
  }
  if (method === "GET" && path === "/api/admin/revisions/pending") {
    await requireSession(request, env, "review:content");
    return listPendingRevisions(env);
  }
  const revisionReview = match(path, "/api/admin/revisions/:type/:id/review");
  if (method === "POST" && revisionReview) {
    principal = await requireSession(request, env, "review:content");
    return reviewRevision(request, env, principal, revisionType(revisionReview.type), revisionReview.id, requestId);
  }

  if (method === "GET" && path === "/api/admin/maps") {
    await requireSession(request, env, "read:admin");
    return listMapVersions(env);
  }
  if (method === "GET" && path === "/api/admin/map-features") {
    await requireSession(request, env, "read:admin");
    return listMapFeatures(request, env);
  }
  if (method === "POST" && path === "/api/admin/maps/upload-intents") {
    principal = await requireSession(request, env, "write:maps");
    return createMapUploadIntent(request, env, principal);
  }
  const mediaContent = match(path, "/api/admin/media/:id/content");
  if (method === "PUT" && mediaContent) {
    principal = await requireSession(request, env, "write:maps");
    return uploadMapContent(request, env, principal, mediaContent.id);
  }
  if (method === "POST" && path === "/api/admin/maps/import-jobs") {
    principal = await requireSession(request, env, "write:maps");
    return enqueueMapImport(request, env, principal, requestId);
  }

  if (method === "GET" && path === "/api/admin/operations") {
    await requireSession(request, env, "read:admin");
    return listOperationalEvents(env);
  }
  if (method === "POST" && path === "/api/admin/operations") {
    principal = await requireSession(request, env, "write:content");
    return createOperationalEvent(request, env, principal, requestId);
  }
  const eventReview = match(path, "/api/admin/operations/:id/review");
  if (method === "POST" && eventReview) {
    principal = await requireSession(request, env, "review:content");
    return decideOperationalEvent(request, env, principal, eventReview.id, requestId);
  }
  const eventLocations = match(path, "/api/admin/operations/:id/locations");
  if (method === "PUT" && eventLocations) {
    principal = await requireSession(request, env, "write:content");
    return replaceOperationalEventLocations(request, env, principal, eventLocations.id, requestId);
  }
  const eventUpdates = match(path, "/api/admin/operations/:id/updates");
  if (method === "POST" && eventUpdates) {
    principal = await requireSession(request, env, "write:content");
    return createOperationalEventUpdate(request, env, principal, eventUpdates.id, requestId);
  }
  if (method === "GET" && path === "/api/admin/campaigns") {
    await requireSession(request, env, "read:admin");
    return listCampaigns(env);
  }
  if (method === "POST" && path === "/api/admin/campaigns") {
    principal = await requireSession(request, env, "write:content");
    return createCampaign(request, env, principal, requestId);
  }

  if (method === "GET" && path === "/api/admin/transit") {
    await requireSession(request, env, "read:admin");
    return listTransit(env);
  }
  if (method === "POST" && path === "/api/admin/transit/stops") {
    principal = await requireSession(request, env, "write:transit");
    return createStop(request, env, principal, requestId);
  }
  if (method === "POST" && path === "/api/admin/transit/routes") {
    principal = await requireSession(request, env, "write:transit");
    return createRoute(request, env, principal, requestId);
  }
  if (method === "POST" && path === "/api/admin/transit/patterns") {
    principal = await requireSession(request, env, "write:transit");
    return createPattern(request, env, principal, requestId);
  }
  if (method === "POST" && path === "/api/admin/transit/calendars") {
    principal = await requireSession(request, env, "write:transit");
    return createCalendar(request, env, principal, requestId);
  }
  if (method === "POST" && path === "/api/admin/transit/trips") {
    principal = await requireSession(request, env, "write:transit");
    return createTrip(request, env, principal, requestId);
  }

  if (method === "GET" && path === "/api/admin/submissions") {
    await requireSession(request, env, "read:admin");
    return listSubmissions(env);
  }
  const submissionReview = match(path, "/api/admin/submissions/:id/review");
  if (method === "POST" && submissionReview) {
    principal = await requireSession(request, env, "review:content");
    return reviewSubmission(request, env, principal, submissionReview.id);
  }

  if (method === "POST" && path === "/api/admin/releases") {
    principal = await requireSession(request, env, "publish:release");
    return coordinatorRequest(request, env, "/release", principal, requestId);
  }
  const releaseRollback = match(path, "/api/admin/releases/:id/rollback");
  if (method === "POST" && releaseRollback) {
    principal = await requireSession(request, env, "rollback:release");
    return coordinatorRequest(request, env, `/rollback/${encodeURIComponent(releaseRollback.id)}`, principal, requestId);
  }

  throw new HttpError(404, "not_found", "Admin API route does not exist");
}

async function coordinatorRequest(request: Request, env: Env, path: string, principal: SessionPrincipal, requestId: string): Promise<Response> {
  const id = env.RELEASE_COORDINATOR.idFromName("production");
  const stub = env.RELEASE_COORDINATOR.get(id);
  const headers = new Headers(request.headers);
  headers.set("x-shumap-user-id", principal.userId);
  headers.set("x-shumap-request-id", requestId);
  return stub.fetch(new Request(`https://release.internal${path}`, { method: request.method, headers, body: request.body }));
}

function normalizePath(path: string): string {
  const value = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  return value || "/";
}

function match(path: string, pattern: string): Record<string, string> | null {
  const pathParts = path.split("/").filter(Boolean);
  const patternParts = pattern.split("/").filter(Boolean);
  if (pathParts.length !== patternParts.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index];
    const actual = pathParts[index];
    if (expected.startsWith(":")) params[expected.slice(1)] = decodeURIComponent(actual);
    else if (expected !== actual) return null;
  }
  return params;
}

function revisionType(value: string): "place" | "facility" | "merchant" {
  if (value === "place" || value === "facility" || value === "merchant") return value;
  throw new HttpError(400, "validation_error", "Invalid revision type");
}
