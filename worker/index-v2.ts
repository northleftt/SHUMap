import type { Env, ExecutionContext, MessageBatch } from "./types/cloudflare";
import type { QueueJobMessage, SessionPrincipal } from "./domain/types";
import { asErrorResponse, HttpError, json } from "./lib/http";
import { handleBootstrap, handleLogin, handleLogout, handleSession, optionalSession, requireSession } from "./modules/auth";
import { recordAnalyticsEvent } from "./modules/analytics";
import { claimCollectionTask, listCollectionTasks, saveCollectionTask, submitCollectionTask } from "./modules/collections";
import { createFacilityHandler, createFacilityRevisionHandler, getFacility, listFacilities, publicFacilityStatus } from "./modules/facilities";
import { createFacilityType, deleteFacilityType, listFacilityTypes, listPublicFacilityTypes, updateFacilityType } from "./modules/facility-types";
import { processQueue } from "./modules/jobs";
import { enqueueMapImport, createMapUploadIntent, listMapFeatures, listMapVersions, uploadMapContent } from "./modules/maps";
import { createAdminMediaUpload, createPublicMediaUpload, getAdminMediaContent, getPublicMedia } from "./modules/media";
import { createMerchant, createMerchantRevision, getMerchant, listMerchants, updateMerchantLifecycle } from "./modules/merchants";
import { createCampaign, createOperationalEvent, createOperationalEventUpdate, decideOperationalEvent, listCampaigns, listOperationalEvents, replaceOperationalEventLocations } from "./modules/operations";
import { createPlaceHandler, createPlaceRevisionHandler, getPlace, listPlaces } from "./modules/places";
import { getAdminMapAsset, getCurrentRelease, getPublicMapAsset, getVersionedRelease, listPublicPlaces, publicHealth, publicPlace, publicSearch } from "./modules/public";
import { listPendingRevisions, reviewRevision, submitRevision } from "./modules/reviews";
import { createSubmission, listSubmissions, reviewSubmission } from "./modules/submissions";
import { createOrganization, deleteOrganization, listOrganizations, updateOrganization } from "./modules/organizations";
import { deleteFloor, getFloorDetail, listFloorsForBuilding, updateFloorPlanStatus } from "./modules/floors";
import { createDataSource, createFloor, createSpace, listCampusesAndSpaces, listReferenceData, updateFloor } from "./modules/spaces";
import { createUser, listUsers, updateUser } from "./modules/users";
import {
  createMapFilter,
  createMapFilterMember,
  createPlaceKind,
  deleteMapFilter,
  deleteMapFilterMember,
  deletePlaceKind,
  listMapFilters,
  listPlaceKinds,
  updateMapFilter,
  updateMapFilterMember,
  updatePlaceKind,
} from "./modules/map-filters";
import {
  createCalendar,
  createPattern,
  createRoute,
  createStop,
  createTrip,
  deleteCalendar,
  deletePattern,
  deleteRoute,
  deleteStop,
  deleteTrip,
  listTransit,
  publicJourneys,
  publicTripStops,
  replacePatternStops,
  updateCalendar,
  updatePattern,
  updateRoute,
  updateStop,
  updateTrip,
} from "./modules/transit";

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
  const publicTrip = match(path, "/api/public/transit/trips/:tripId/stops");
  if (method === "GET" && publicTrip) return publicTripStops(env, publicTrip.tripId);
  // 反馈可匿名也可署名：登录了就把账号记进 submitter_user_id，没登录照样能提。
  // 志愿者采集则必须登录（见下方 collection-tasks 一组，要求 collect:data）。
  if (method === "POST" && path === "/api/public/submissions") {
    const principal = await optionalSession(request, env);
    return createSubmission(request, env, principal);
  }
  if (method === "GET" && path === "/api/public/facility-types") return listPublicFacilityTypes(env);
  if (method === "GET" && path === "/api/public/facility-status") return publicFacilityStatus(env);
  if (method === "GET" && path === "/api/public/collection-tasks") {
    const principal = await requireSession(request, env, "collect:data");
    return listCollectionTasks(request, env, principal);
  }
  const collectionClaim = match(path, "/api/public/collection-tasks/:id/claim");
  if (method === "POST" && collectionClaim) {
    const principal = await requireSession(request, env, "collect:data");
    return claimCollectionTask(request, env, principal, collectionClaim.id);
  }
  const collectionSubmit = match(path, "/api/public/collection-tasks/:id/submit");
  if (method === "POST" && collectionSubmit) {
    const principal = await requireSession(request, env, "collect:data");
    return submitCollectionTask(request, env, principal, collectionSubmit.id);
  }
  const collectionTask = match(path, "/api/public/collection-tasks/:id");
  if (method === "PUT" && collectionTask) {
    const principal = await requireSession(request, env, "collect:data");
    return saveCollectionTask(request, env, principal, collectionTask.id);
  }
  // 照片同样可匿名：匿名反馈要能附图。登录时记 uploaded_by，便于审核溯源。
  if (method === "POST" && path === "/api/public/media") {
    const principal = await optionalSession(request, env);
    return createPublicMediaUpload(request, env, principal);
  }
  const media = match(path, "/api/public/media/:id");
  if (method === "GET" && media) return getPublicMedia(env, media.id);
  const mapAsset = match(path, "/api/public/maps/:mapVersionId/asset");
  if (method === "GET" && mapAsset) return getPublicMapAsset(env, mapAsset.mapVersionId);

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
  // 楼层与楼层图管理。读用 read:admin，写用 write:maps（与校区图一致）。
  // 列表 / 详情把该层的设施、商户、锚点反查出来，因此楼层页与内容管理天然同步。
  if (method === "GET" && path === "/api/admin/floors") {
    await requireSession(request, env, "read:admin");
    return listFloorsForBuilding(request, env);
  }
  if (method === "POST" && path === "/api/admin/floors") {
    principal = await requireSession(request, env, "write:maps");
    return createFloor(request, env, principal, requestId);
  }
  const floor = match(path, "/api/admin/floors/:id");
  if (method === "GET" && floor) {
    await requireSession(request, env, "read:admin");
    return getFloorDetail(env, floor.id);
  }
  if (method === "PATCH" && floor) {
    principal = await requireSession(request, env, "write:maps");
    return updateFloor(request, env, principal, floor.id, requestId);
  }
  if (method === "DELETE" && floor) {
    principal = await requireSession(request, env, "write:maps");
    return deleteFloor(env, principal, floor.id, requestId);
  }
  const floorPlanStatus = match(path, "/api/admin/floor-plans/:id/status");
  if (method === "PATCH" && floorPlanStatus) {
    principal = await requireSession(request, env, "write:maps");
    return updateFloorPlanStatus(request, env, principal, floorPlanStatus.id, requestId);
  }
  if (method === "POST" && path === "/api/admin/spaces") {
    principal = await requireSession(request, env, "write:maps");
    return createSpace(request, env, principal, requestId);
  }
  if (method === "GET" && path === "/api/admin/reference-data") {
    await requireSession(request, env, "read:admin");
    return listReferenceData(env);
  }
  // 品牌 / 机构维护。读用 read:admin，增改删用 write:content。
  if (method === "GET" && path === "/api/admin/organizations") {
    await requireSession(request, env, "read:admin");
    return listOrganizations(env);
  }
  if (method === "POST" && path === "/api/admin/organizations") {
    principal = await requireSession(request, env, "write:content");
    return createOrganization(request, env, principal, requestId);
  }
  const organization = match(path, "/api/admin/organizations/:id");
  if (method === "PATCH" && organization) {
    principal = await requireSession(request, env, "write:content");
    return updateOrganization(request, env, principal, organization.id, requestId);
  }
  if (method === "DELETE" && organization) {
    principal = await requireSession(request, env, "write:content");
    return deleteOrganization(env, principal, organization.id, requestId);
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

  // 设施类型（标签）维护。读用 read:admin，增改删用 write:content。
  if (method === "GET" && path === "/api/admin/facility-types") {
    await requireSession(request, env, "read:admin");
    return listFacilityTypes(env);
  }
  if (method === "POST" && path === "/api/admin/facility-types") {
    principal = await requireSession(request, env, "write:content");
    return createFacilityType(request, env, principal, requestId);
  }
  const facilityType = match(path, "/api/admin/facility-types/:id");
  if (method === "PATCH" && facilityType) {
    principal = await requireSession(request, env, "write:content");
    return updateFacilityType(request, env, principal, facilityType.id, requestId);
  }
  if (method === "DELETE" && facilityType) {
    principal = await requireSession(request, env, "write:content");
    return deleteFacilityType(env, principal, facilityType.id, requestId);
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
  const merchantLifecycle = match(path, "/api/admin/merchants/:id/lifecycle");
  if (method === "PATCH" && merchantLifecycle) {
    principal = await requireSession(request, env, "write:content");
    return updateMerchantLifecycle(request, env, principal, merchantLifecycle.id, requestId);
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
  const adminMapAsset = match(path, "/api/admin/maps/:mapVersionId/asset");
  if (method === "GET" && adminMapAsset) {
    await requireSession(request, env, "read:admin");
    return getAdminMapAsset(env, adminMapAsset.mapVersionId);
  }
  if (method === "GET" && path === "/api/admin/map-features") {
    await requireSession(request, env, "read:admin");
    return listMapFeatures(request, env);
  }
  if (method === "GET" && path === "/api/admin/map-filters") {
    await requireSession(request, env, "read:admin");
    return listMapFilters(env);
  }
  if (method === "POST" && path === "/api/admin/map-filters") {
    principal = await requireSession(request, env, "write:content");
    return createMapFilter(request, env, principal, requestId);
  }
  if (method === "GET" && path === "/api/admin/place-kinds") {
    await requireSession(request, env, "read:admin");
    return listPlaceKinds(env);
  }
  if (method === "POST" && path === "/api/admin/place-kinds") {
    principal = await requireSession(request, env, "write:content");
    return createPlaceKind(request, env, principal, requestId);
  }
  const placeKind = match(path, "/api/admin/place-kinds/:id");
  if (method === "PATCH" && placeKind) {
    principal = await requireSession(request, env, "write:content");
    return updatePlaceKind(request, env, principal, placeKind.id, requestId);
  }
  if (method === "DELETE" && placeKind) {
    principal = await requireSession(request, env, "write:content");
    return deletePlaceKind(env, principal, placeKind.id, requestId);
  }
  const mapFilter = match(path, "/api/admin/map-filters/:id");
  if (method === "PATCH" && mapFilter) {
    principal = await requireSession(request, env, "write:content");
    return updateMapFilter(request, env, principal, mapFilter.id, requestId);
  }
  if (method === "DELETE" && mapFilter) {
    principal = await requireSession(request, env, "write:content");
    return deleteMapFilter(env, principal, mapFilter.id, requestId);
  }
  const mapFilterMembers = match(path, "/api/admin/map-filters/:id/members");
  if (method === "POST" && mapFilterMembers) {
    principal = await requireSession(request, env, "write:content");
    return createMapFilterMember(request, env, principal, mapFilterMembers.id, requestId);
  }
  const mapFilterMember = match(path, "/api/admin/map-filter-members/:id");
  if (method === "PATCH" && mapFilterMember) {
    principal = await requireSession(request, env, "write:content");
    return updateMapFilterMember(request, env, principal, mapFilterMember.id, requestId);
  }
  if (method === "DELETE" && mapFilterMember) {
    principal = await requireSession(request, env, "write:content");
    return deleteMapFilterMember(env, principal, mapFilterMember.id, requestId);
  }
  if (method === "POST" && path === "/api/admin/maps/upload-intents") {
    principal = await requireSession(request, env, "write:maps");
    return createMapUploadIntent(request, env, principal);
  }
  // 管理端直传：图片一步落 public scope 并 published。管理员是可信方，
  // 无需经匿名上传的隔离区 + 审核采纳流程。
  if (method === "POST" && path === "/api/admin/media") {
    principal = await requireSession(request, env, "write:content");
    return createAdminMediaUpload(request, env, principal);
  }
  const mediaContent = match(path, "/api/admin/media/:id/content");
  if (method === "PUT" && mediaContent) {
    principal = await requireSession(request, env, "write:maps");
    return uploadMapContent(request, env, principal, mediaContent.id);
  }
  // 审核端读原图：任意 scope（含隔离区）可读，因此只对已登录的管理会话开放。
  if (method === "GET" && mediaContent) {
    principal = await requireSession(request, env, "read:admin");
    return getAdminMediaContent(env, principal, mediaContent.id);
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
  const patternStops = match(path, "/api/admin/transit/patterns/:id/stops");
  if (method === "PUT" && patternStops) {
    principal = await requireSession(request, env, "write:transit");
    return replacePatternStops(request, env, principal, patternStops.id, requestId);
  }
  const transitStop = match(path, "/api/admin/transit/stops/:id");
  if (method === "PATCH" && transitStop) {
    principal = await requireSession(request, env, "write:transit");
    return updateStop(request, env, principal, transitStop.id, requestId);
  }
  if (method === "DELETE" && transitStop) {
    principal = await requireSession(request, env, "write:transit");
    return deleteStop(env, principal, transitStop.id, requestId);
  }
  const transitRoute = match(path, "/api/admin/transit/routes/:id");
  if (method === "PATCH" && transitRoute) {
    principal = await requireSession(request, env, "write:transit");
    return updateRoute(request, env, principal, transitRoute.id, requestId);
  }
  if (method === "DELETE" && transitRoute) {
    principal = await requireSession(request, env, "write:transit");
    return deleteRoute(env, principal, transitRoute.id, requestId);
  }
  const transitPattern = match(path, "/api/admin/transit/patterns/:id");
  if (method === "PATCH" && transitPattern) {
    principal = await requireSession(request, env, "write:transit");
    return updatePattern(request, env, principal, transitPattern.id, requestId);
  }
  if (method === "DELETE" && transitPattern) {
    principal = await requireSession(request, env, "write:transit");
    return deletePattern(env, principal, transitPattern.id, requestId);
  }
  const transitCalendar = match(path, "/api/admin/transit/calendars/:id");
  if (method === "PATCH" && transitCalendar) {
    principal = await requireSession(request, env, "write:transit");
    return updateCalendar(request, env, principal, transitCalendar.id, requestId);
  }
  if (method === "DELETE" && transitCalendar) {
    principal = await requireSession(request, env, "write:transit");
    return deleteCalendar(env, principal, transitCalendar.id, requestId);
  }
  const transitTrip = match(path, "/api/admin/transit/trips/:id");
  if (method === "PUT" && transitTrip) {
    principal = await requireSession(request, env, "write:transit");
    return updateTrip(request, env, principal, transitTrip.id, requestId);
  }
  if (method === "DELETE" && transitTrip) {
    principal = await requireSession(request, env, "write:transit");
    return deleteTrip(env, principal, transitTrip.id, requestId);
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

  if (method === "GET" && path === "/api/admin/users") {
    await requireSession(request, env, "manage:users");
    return listUsers(env);
  }
  if (method === "POST" && path === "/api/admin/users") {
    principal = await requireSession(request, env, "manage:users");
    return createUser(request, env, principal, requestId);
  }
  const adminUser = match(path, "/api/admin/users/:id");
  if (method === "PATCH" && adminUser) {
    principal = await requireSession(request, env, "manage:users");
    return updateUser(request, env, principal, adminUser.id, requestId);
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
