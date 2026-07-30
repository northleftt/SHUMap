import type { Env } from "../types/cloudflare";
import { all, first } from "../lib/db";
import { HttpError, json } from "../lib/http";
import { isoNow, parseJson } from "../lib/values";

export async function getCurrentRelease(env: Env): Promise<Response> {
  let releaseId = await env.RELEASE_KV.get("current_release_v2");
  if (!releaseId) {
    releaseId = (await first<{ id: string }>(env.DB, "select id from releases where status='active'"))?.id ?? null;
  }
  if (!releaseId) throw new HttpError(503, "release_unavailable", "No public release is active");
  const release = await first<{ artifact_key: string; artifact_sha256: string; version: string }>(
    env.DB,
    "select artifact_key,artifact_sha256,version from releases where id=? and status='active'",
    [releaseId],
  );
  if (!release?.artifact_key) throw new HttpError(503, "release_unavailable", "The active release artifact is unavailable");
  const object = await env.SHUMAP_BUCKET.get(release.artifact_key);
  if (!object) throw new HttpError(503, "release_unavailable", "The active release artifact is missing");
  const body = await object.text();
  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=60, stale-while-revalidate=300",
      "etag": `"${release.artifact_sha256}"`,
      "x-shumap-release": releaseId,
      "x-shumap-version": release.version,
      "x-content-type-options": "nosniff",
    },
  });
}

export async function getVersionedRelease(env: Env, releaseId: string): Promise<Response> {
  const release = await first<{ artifact_key: string; artifact_sha256: string; version: string }>(
    env.DB,
    "select artifact_key,artifact_sha256,version from releases where id=? and status in ('active','superseded')",
    [releaseId],
  );
  if (!release?.artifact_key) throw new HttpError(404, "not_found", "Release does not exist");
  const object = await env.SHUMAP_BUCKET.get(release.artifact_key);
  if (!object) throw new HttpError(503, "release_unavailable", "Release artifact is missing");
  return new Response(await object.text(), {
    headers: {
      "content-type": "application/json; charset=utf-8",
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
  const row = await first<{ object_key: string; content_type: string; sha256: string; bucket_scope: string; status: string }>(
    env.DB,
    `select me.object_key,me.content_type,me.sha256,me.bucket_scope,me.status
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
  return new Response(await object.arrayBuffer(), {
    headers: {
      "content-type": contentType,
      "content-disposition": "inline",
      "cache-control": "public, max-age=604800, immutable",
      "etag": `"${row.sha256}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
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
    facets: parseJson(String(row.facetsJson ?? "[]"), []),
    mapTarget: parseJson(String(row.mapTargetJson ?? "null"), null),
    facetsJson: undefined,
    mapTargetJson: undefined,
  })) }, { headers: { "cache-control": "public, max-age=30" } });
}

export async function publicPlace(env: Env, placeId: string): Promise<Response> {
  const release = await first<{ id: string }>(env.DB, "select id from releases where status='active'");
  if (!release) throw new HttpError(503, "release_unavailable", "No public release is active");
  const membership = await first<{ revision_id: string }>(env.DB, "select revision_id from release_items where release_id=? and entity_type='place' and entity_id=?", [release.id, placeId]);
  if (!membership?.revision_id) throw new HttpError(404, "not_found", "Place is not part of the current release");
  const place = await first<Record<string, unknown>>(
    env.DB,
    `select p.id,p.kind_id as kindId,p.campus_id as campusId,p.lifecycle_status as lifecycleStatus,
            r.display_name as displayName,r.summary,r.description,r.content_json as contentJson
       from places p join place_revisions r on r.id=? where p.id=?`,
    [membership.revision_id, placeId],
  );
  const [names, locations, facilities, floors] = await Promise.all([
    all(env.DB, "select language,name,name_type as nameType from place_names where place_id=?", [placeId]),
    all(env.DB, `select el.role,el.is_primary as isPrimary,la.* from entity_locations el join location_anchors la on la.id=el.anchor_id where el.entity_type='place' and el.entity_id=? and el.valid_to is null`, [placeId]),
    all<Record<string, unknown>>(env.DB, `select f.id,t.code as typeCode,t.name as typeName,fr.display_name as displayName,f.operational_status as operationalStatus,f.floor_id as floorId,fr.content_json as contentJson
       from facility_instances f join facility_types t on t.id=f.facility_type_id join release_items ri on ri.release_id=? and ri.entity_type='facility' and ri.entity_id=f.id
       join facility_revisions fr on fr.id=ri.revision_id where f.host_place_id=?`, [release.id, placeId]),
    all(env.DB, "select id,level_code as levelCode,level_order as levelOrder,display_name as displayName from floors where building_place_id=? and is_public=1 order by level_order", [placeId]),
  ]);
  const facilityItems = facilities.map(({ contentJson, ...facility }) => ({
    ...facility,
    content: parseJson(String(contentJson ?? "{}"), {}),
  }));
  return json({ releaseId: release.id, place: { ...place, content: parseJson(String(place?.contentJson ?? "{}"), {}), contentJson: undefined }, names, locations, facilities: facilityItems, floors }, { headers: { "cache-control": "public, max-age=60" } });
}

export async function listPublicPlaces(env: Env): Promise<Response> {
  const release = await first<{ id: string }>(env.DB, "select id from releases where status='active'");
  if (!release) return json({ releaseId: null, items: [] }, { headers: { "cache-control": "public, max-age=30" } });
  const items = await all(
    env.DB,
    `select p.id,p.kind_id as kindId,p.campus_id as campusId,r.display_name as displayName,r.summary
       from release_items ri join places p on p.id=ri.entity_id join place_revisions r on r.id=ri.revision_id
      where ri.release_id=? and ri.entity_type='place' order by r.display_name`,
    [release.id],
  );
  return json({ releaseId: release.id, items }, { headers: { "cache-control": "public, max-age=60" } });
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
