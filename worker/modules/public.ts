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
  const [names, locations, facilities] = await Promise.all([
    all(env.DB, "select language,name,name_type as nameType from place_names where place_id=?", [placeId]),
    all(env.DB, `select el.role,el.is_primary as isPrimary,la.* from entity_locations el join location_anchors la on la.id=el.anchor_id where el.entity_type='place' and el.entity_id=? and el.valid_to is null`, [placeId]),
    all(env.DB, `select f.id,t.code as typeCode,t.name as typeName,fr.display_name as displayName,f.operational_status as operationalStatus,f.floor_id as floorId
       from facility_instances f join facility_types t on t.id=f.facility_type_id join release_items ri on ri.release_id=? and ri.entity_type='facility' and ri.entity_id=f.id
       join facility_revisions fr on fr.id=ri.revision_id where f.host_place_id=?`, [release.id, placeId]),
  ]);
  return json({ releaseId: release.id, place: { ...place, content: parseJson(String(place?.contentJson ?? "{}"), {}), contentJson: undefined }, names, locations, facilities }, { headers: { "cache-control": "public, max-age=60" } });
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
