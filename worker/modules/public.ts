import type { Env, R2ObjectBody } from "../types/cloudflare";
import { all, first } from "../lib/db";
import { HttpError, json } from "../lib/http";
import { isoNow, parseJsonArray, parseJsonObject } from "../lib/values";
import type { ReleaseManifest } from "./releases";

const MAX_RELEASE_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_MAP_ASSET_BYTES = 50 * 1024 * 1024;

interface ActiveReleaseArtifact {
  release: { id: string; artifact_key: string; artifact_sha256: string; version: string };
  object: R2ObjectBody;
}

async function activeReleaseArtifact(env: Env): Promise<ActiveReleaseArtifact> {
  const release = await first<{ id: string; artifact_key: string | null; artifact_sha256: string | null; version: string }>(
    env.DB,
    "select id,artifact_key,artifact_sha256,version from releases where status='active'",
  );
  if (!release?.artifact_key || !release.artifact_sha256) {
    throw new HttpError(503, "release_unavailable", "The active release artifact is unavailable");
  }
  const object = await env.SHUMAP_BUCKET.get(release.artifact_key);
  if (!object) throw new HttpError(503, "release_unavailable", "The active release artifact is missing");
  assertObjectSizeWithin(object.size, MAX_RELEASE_ARTIFACT_BYTES, `Release ${release.id}`);
  return {
    release: {
      id: release.id,
      artifact_key: release.artifact_key,
      artifact_sha256: release.artifact_sha256,
      version: release.version,
    },
    object,
  };
}

async function activeReleaseManifest(env: Env): Promise<ReleaseManifest> {
  const artifact = await activeReleaseArtifact(env);
  const manifest = await artifact.object.json<ReleaseManifest>();
  if (manifest.schemaVersion !== 2 || manifest.release.id !== artifact.release.id) {
    throw new Error(`Active release ${artifact.release.id} artifact identity does not match`);
  }
  return manifest;
}

export async function getCurrentRelease(env: Env): Promise<Response> {
  const { release, object } = await activeReleaseArtifact(env);
  return new Response(object.body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(object.size),
      "cache-control": "public, max-age=60, stale-while-revalidate=300",
      "etag": `"${release.artifact_sha256}"`,
      "x-shumap-release": release.id,
      "x-shumap-version": release.version,
      "x-content-type-options": "nosniff",
    },
  });
}

export async function getVersionedRelease(env: Env, releaseId: string): Promise<Response> {
  const release = await first<{ artifact_key: string | null; artifact_sha256: string | null; version: string }>(
    env.DB,
    "select artifact_key,artifact_sha256,version from releases where id=? and status in ('active','superseded')",
    [releaseId],
  );
  if (!release?.artifact_key || !release.artifact_sha256) throw new HttpError(404, "not_found", "Release does not exist");
  const object = await env.SHUMAP_BUCKET.get(release.artifact_key);
  if (!object) throw new HttpError(503, "release_unavailable", "Release artifact is missing");
  assertObjectSizeWithin(object.size, MAX_RELEASE_ARTIFACT_BYTES, `Release ${releaseId}`);
  return new Response(object.body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(object.size),
      "cache-control": "public, max-age=31536000, immutable",
      "etag": `"${release.artifact_sha256}"`,
      "x-shumap-release": releaseId,
      "x-content-type-options": "nosniff",
    },
  });
}

/** 允许经公共底图通道流出的类型；其余（PDF/CAD/GeoJSON 源文件等）一律 404。 */
const MAP_ASSET_CONTENT_TYPES: Record<string, string> = {
  "image/svg+xml": "image/svg+xml; charset=utf-8",
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/webp": "image/webp",
};

/**
 * GET /api/public/maps/:mapVersionId/asset — 楼层/校区底图的公共读端。
 *
 * 唯一放行条件：该 map version 是**当前 active release** 的成员
 * （release_map_versions ⋈ releases.status='active'）。因此导入完成但未发布的
 * 版本、被 superseded 的版本都读不到。底图对象仍留在原 private key，不做
 * 公共拷贝；这里只是按 release 成员资格代理读取，并额外要求媒体行处于
 * private/public scope 且已 approved/published——隔离区对象因此不可能经此泄漏。
 * 响应强制 nosniff + sandbox CSP，避免 SVG 被当作可执行文档直接导航。
 */
export async function getPublicMapAsset(env: Env, mapVersionId: string): Promise<Response> {
  const row = await first<{ object_key: string; content_type: string; byte_size: number; sha256: string; bucket_scope: string; status: string }>(
    env.DB,
    `select me.object_key,me.content_type,me.byte_size,me.sha256,me.bucket_scope,me.status
       from release_map_versions rmv
       join releases rel on rel.id=rmv.release_id and rel.status='active'
       join map_versions mv on mv.id=rmv.map_version_id
       join map_assets ma on ma.id=mv.map_asset_id
       join media_assets me on me.id=ma.media_asset_id
      where rmv.map_version_id=?`,
    [mapVersionId],
  );
  if (!row) throw new HttpError(404, "not_found", "Map asset is not part of the current release");
  if (!["private", "public"].includes(row.bucket_scope) || !["approved", "published"].includes(row.status)) {
    throw new HttpError(404, "not_found", "Map asset is not readable");
  }
  const contentType = MAP_ASSET_CONTENT_TYPES[row.content_type.toLowerCase()];
  if (!contentType) throw new HttpError(404, "not_found", "Map asset is not a renderable image");
  const object = await env.SHUMAP_BUCKET.get(row.object_key);
  if (!object) throw new HttpError(404, "not_found", "Map object is missing");
  assertStoredObjectSize(row.byte_size, object.size, MAX_MAP_ASSET_BYTES, `Map ${mapVersionId}`);
  return new Response(object.body, {
    headers: {
      "content-type": contentType,
      "content-length": String(object.size),
      "content-disposition": "inline",
      "cache-control": "public, max-age=604800, immutable",
      "etag": `"${row.sha256}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}

export async function getAdminMapAsset(env: Env, mapVersionId: string): Promise<Response> {
  const row = await first<{ object_key: string; content_type: string; byte_size: number; sha256: string; bucket_scope: string; status: string }>(
    env.DB,
    `select me.object_key,me.content_type,me.byte_size,me.sha256,me.bucket_scope,me.status
       from map_versions mv join map_assets ma on ma.id=mv.map_asset_id join media_assets me on me.id=ma.media_asset_id
      where mv.id=? and mv.lifecycle_status in ('ready','published')`,
    [mapVersionId],
  );
  if (!row || !["private", "public"].includes(row.bucket_scope) || !["approved", "published"].includes(row.status)) {
    throw new HttpError(404, "not_found", "Map asset is not readable");
  }
  const contentType = MAP_ASSET_CONTENT_TYPES[row.content_type.toLowerCase()];
  if (!contentType) throw new HttpError(404, "not_found", "Map asset is not a renderable image");
  const object = await env.SHUMAP_BUCKET.get(row.object_key);
  if (!object) throw new HttpError(404, "not_found", "Map object is missing");
  assertStoredObjectSize(row.byte_size, object.size, MAX_MAP_ASSET_BYTES, `Map ${mapVersionId}`);
  return new Response(object.body, { headers: {
    "content-type": contentType, "content-disposition": "inline", "cache-control": "private, max-age=60",
    "content-length": String(object.size),
    "etag": `"${row.sha256}"`, "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  } });
}

export async function publicSearch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const query = normalize(url.searchParams.get("q") ?? "");
  const campusId = url.searchParams.get("campusId");
  const type = url.searchParams.get("type");
  if (!query) return json({ query: "", results: [] }, { headers: { "cache-control": "public, max-age=30" } });
  const release = await first<{ id: string }>(env.DB, "select id from releases where status='active'");
  if (!release) throw new HttpError(503, "release_unavailable", "No public release is active");
  const like = `%${escapeLike(query)}%`;
  const results = await all<Record<string, unknown>>(
    env.DB,
    `select document_type as type,entity_id as id,title,subtitle,campus_id as campusId,building_place_id as buildingPlaceId,
            floor_id as floorId,facets_json as facetsJson,map_target_json as mapTargetJson,ranking_weight as rankingWeight
       from search_documents
      where release_id=? and normalized_text like ? escape '\\'
        and (? is null or campus_id=?) and (? is null or document_type=?)
      order by ranking_weight desc,title limit 50`,
    [release.id, like, campusId, campusId, type, type],
  );
  return json({ query, releaseId: release.id, results: results.map((row) => ({
    ...row,
    facets: parseJsonArray(row.facetsJson, "search_documents.facets_json"),
    mapTarget: row.mapTargetJson === null
      ? null
      : parseJsonObject(row.mapTargetJson, "search_documents.map_target_json"),
    facetsJson: undefined,
    mapTargetJson: undefined,
  })) }, { headers: { "cache-control": "public, max-age=30" } });
}

export async function publicPlace(env: Env, placeId: string): Promise<Response> {
  const manifest = await activeReleaseManifest(env);
  const place = manifest.places.find((item) => item.id === placeId);
  if (!place) throw new HttpError(404, "not_found", "Place is not part of the current release");
  const typeById = new Map(manifest.facilityTypes.map((type) => [type.id, type]));
  const facilities = manifest.facilities
    .filter((facility) => facility.hostPlaceId === placeId)
    .map((facility) => {
      const type = typeById.get(facility.facilityTypeId);
      if (!type) throw new Error(`Release facility ${facility.id} has no facility type`);
      return {
        id: facility.id,
        typeCode: type.code,
        typeName: type.name,
        displayName: facility.displayName,
        operationalStatus: facility.operationalStatus,
        floorId: facility.floorId,
        content: facility.content,
      };
    });
  const locations = manifest.locations.filter((location) => location.entityType === "place" && location.entityId === placeId);
  const floors = manifest.floors
    .filter((floor) => floor.buildingPlaceId === placeId && floor.isPublic === 1)
    .map((floor) => ({
      id: floor.id,
      levelCode: floor.levelCode,
      levelOrder: floor.levelOrder,
      displayName: floor.displayName,
      imageUrl: floor.imageUrl,
    }));
  return json({
    releaseId: manifest.release.id,
    place: {
      id: place.id,
      kindId: place.kindId,
      kindName: place.kindName,
      isBuilding: place.isBuilding,
      campusId: place.campusId,
      lifecycleStatus: place.lifecycleStatus,
      displayName: place.displayName,
      summary: place.summary,
      description: place.description,
      content: place.content,
      aliases: place.aliases,
    },
    locations,
    facilities,
    floors,
  }, { headers: { "cache-control": "public, max-age=60" } });
}

export async function listPublicPlaces(env: Env): Promise<Response> {
  const manifest = await activeReleaseManifest(env);
  const items = manifest.places
    .map((place) => ({
      id: place.id,
      kindId: place.kindId,
      kindName: place.kindName,
      isBuilding: place.isBuilding,
      campusId: place.campusId,
      displayName: place.displayName,
      summary: place.summary,
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-CN"));
  return json({ releaseId: manifest.release.id, items }, { headers: { "cache-control": "public, max-age=60" } });
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function publicHealth(): Response {
  return json({ status: "ok", architecture: 2, time: isoNow() }, { headers: { "cache-control": "no-store" } });
}

function assertObjectSizeWithin(actual: number, maximum: number, label: string): void {
  if (!Number.isInteger(actual) || actual <= 0 || actual > maximum) {
    throw new Error(`${label} object has invalid byte size ${actual}`);
  }
}

function assertStoredObjectSize(expected: number, actual: number, maximum: number, label: string): void {
  assertObjectSizeWithin(expected, maximum, `${label} database`);
  if (actual !== expected) throw new Error(`${label} object size ${actual} does not match stored byte size ${expected}`);
}
