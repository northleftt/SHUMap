import type { SessionPrincipal } from "../domain/types";
import type { Env } from "../types/cloudflare";
import { all, assertExists, first } from "../lib/db";
import { HttpError, json, readBodyLimited, readJson } from "../lib/http";
import { isoNow, jsonString, makeId, optionalString, requiredString, sha256 } from "../lib/values";
import { audit } from "./audit";

interface CreateMapUploadBody {
  assetType: "campus_svg" | "floor_svg" | "floor_image" | "geojson" | "source_cad" | "source_bim" | "source_pdf";
  originalName: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  sourceId?: string | null;
  metadata?: Record<string, unknown>;
}

interface CreateImportJobBody {
  mediaAssetId: string;
  campusId?: string | null;
  floorId?: string | null;
  versionLabel: string;
}

const ASSET_TYPES = ["campus_svg", "floor_svg", "floor_image", "geojson", "source_cad", "source_bim", "source_pdf"];
const IMPORT_CONTENT_TYPES = new Set(["image/svg+xml", "image/png", "image/jpeg", "application/pdf", "application/json", "application/octet-stream"]);
const MAX_MAP_ASSET_BYTES = 50 * 1024 * 1024;

export async function createMapUploadIntent(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
): Promise<Response> {
  const body = await readJson<CreateMapUploadBody>(request);
  if (!ASSET_TYPES.includes(body.assetType)) throw new HttpError(400, "validation_error", "Invalid assetType");
  const originalName = requiredString(body.originalName, "originalName", 300);
  const contentType = requiredString(body.contentType, "contentType", 100).toLowerCase();
  if (!IMPORT_CONTENT_TYPES.has(contentType)) throw new HttpError(415, "unsupported_media_type", "Unsupported map source type");
  if (!Number.isSafeInteger(body.byteSize) || body.byteSize <= 0 || body.byteSize > MAX_MAP_ASSET_BYTES) {
    throw new HttpError(400, "validation_error", "Map source must be between 1 byte and 50 MiB");
  }
  if (!/^[a-f0-9]{64}$/i.test(body.sha256)) throw new HttpError(400, "validation_error", "sha256 must be a hexadecimal SHA-256 digest");
  const sourceId = optionalString(body.sourceId, "sourceId", 100);
  await assertExists(env.DB, "data_sources", sourceId, "Data source");
  const mediaId = makeId("media");
  const objectKey = `private/imports/${mediaId}/${sanitizeName(originalName)}`;
  const now = isoNow();
  await env.DB.prepare(
    `insert into media_assets(id,bucket_scope,object_key,original_name,content_type,byte_size,sha256,status,source_id,uploaded_by,created_at)
     values(?,'private',?,?,?,?,?,'quarantined',?,?,?)`,
  ).bind(mediaId, objectKey, originalName, contentType, body.byteSize, body.sha256.toLowerCase(), sourceId, principal.userId, now).run();

  return json({ mediaAssetId: mediaId, objectKey, upload: { method: "PUT", endpoint: `/api/admin/media/${mediaId}/content` } }, { status: 201 });
}

export async function uploadMapContent(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  mediaId: string,
): Promise<Response> {
  const media = await first<{ object_key: string; content_type: string; byte_size: number; sha256: string; status: string; uploaded_by: string }>(
    env.DB,
    "select object_key,content_type,byte_size,sha256,status,uploaded_by from media_assets where id=? and bucket_scope='private'",
    [mediaId],
  );
  if (!media) throw new HttpError(404, "not_found", "Media asset does not exist");
  if (media.uploaded_by !== principal.userId && !principal.permissions.includes("*")) throw new HttpError(403, "forbidden", "Only the creator can upload this asset");
  if (media.status !== "quarantined") throw new HttpError(409, "invalid_state", "Media asset is not accepting content");
  if (!Number.isSafeInteger(media.byte_size) || media.byte_size <= 0 || media.byte_size > MAX_MAP_ASSET_BYTES) {
    throw new Error(`Media ${mediaId} has invalid stored byte size ${media.byte_size}`);
  }
  const bytes = await readBodyLimited(request, media.byte_size);
  if (bytes.byteLength !== media.byte_size) throw new HttpError(400, "size_mismatch", "Uploaded size does not match declared size");
  const digest = await sha256(bytes);
  if (digest !== media.sha256) throw new HttpError(400, "checksum_mismatch", "Uploaded checksum does not match declared checksum");
  await env.SHUMAP_BUCKET.put(media.object_key, bytes, { httpMetadata: { contentType: media.content_type, cacheControl: "private, no-store" } });
  await env.DB.prepare("update media_assets set status='approved',approved_at=? where id=?").bind(isoNow(), mediaId).run();
  return json({ id: mediaId, status: "approved" });
}

export async function enqueueMapImport(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  requestId: string,
): Promise<Response> {
  const body = await readJson<CreateImportJobBody>(request);
  const mediaAssetId = requiredString(body.mediaAssetId, "mediaAssetId", 100);
  const campusId = optionalString(body.campusId, "campusId", 100);
  const floorId = optionalString(body.floorId, "floorId", 100);
  if ((campusId ? 1 : 0) + (floorId ? 1 : 0) !== 1) {
    throw new HttpError(400, "validation_error", "Exactly one of campusId or floorId is required");
  }
  const media = await first<{ id: string; status: string; content_type: string }>(
    env.DB,
    "select id,status,content_type from media_assets where id=?",
    [mediaAssetId],
  );
  if (!media || media.status !== "approved") throw new HttpError(409, "media_not_ready", "Media must be uploaded and approved first");
  if (media.content_type !== "image/svg+xml") {
    throw new HttpError(415, "unsupported_media_type", "Map import requires an SVG media asset");
  }
  await Promise.all([
    assertExists(env.DB, "campuses", campusId, "Campus"),
    assertExists(env.DB, "floors", floorId, "Floor"),
  ]);
  const versionLabel = requiredString(body.versionLabel, "versionLabel", 100);
  const payload = { mediaAssetId, campusId, floorId, versionLabel };
  const idempotencyKey = await sha256(jsonString(payload));
  const existing = await first<{ id: string; status: string }>(env.DB, "select id,status from jobs where idempotency_key=?", [idempotencyKey]);
  if (existing) return json(existing, { status: 202 });
  const jobId = makeId("job");
  const jobType = floorId ? "floor_import" : "map_import";
  await env.DB.prepare(
    `insert into jobs(id,job_type,idempotency_key,status,payload_json,attempt_count,created_by,created_at)
     values(?,?,?,'queued',?,0,?,?)`,
  ).bind(jobId, jobType, idempotencyKey, jsonString(payload), principal.userId, isoNow()).run();
  await env.IMPORT_QUEUE.send({ jobId, jobType }, { contentType: "json" });
  await audit(env, principal, "map.import.enqueue", "job", jobId, requestId, null, payload);
  return json({ id: jobId, status: "queued" }, { status: 202 });
}

/**
 * GET /api/admin/map-features?mapVersionId=... — features of one imported map
 * version. geometry_json/bbox_json are populated by the SVG import parser; they
 * stay null for sources it cannot resolve to coordinates.
 */
export async function listMapFeatures(request: Request, env: Env): Promise<Response> {
  const mapVersionId = requiredString(new URL(request.url).searchParams.get("mapVersionId"), "mapVersionId", 100);
  const version = await first<{ id: string }>(env.DB, "select id from map_versions where id=?", [mapVersionId]);
  if (!version) throw new HttpError(404, "not_found", "Map version does not exist");
  const items = await all(
    env.DB,
    `select id,map_version_id as mapVersionId,stable_feature_key as stableFeatureKey,source_element_id as sourceElementId,
            feature_kind as kind,label,geometry_json as geometryJson,json_extract(geometry_json,'$.type') as geometryType,
            bbox_json as bboxJson,shape_hash as shapeHash,
            metadata_json as metadataJson,
            (select el.entity_id
               from location_anchors la join entity_locations el on el.anchor_id=la.id
              where la.map_feature_id=map_features.id and la.role='footprint' and la.valid_to is null
                and el.entity_type='place' and el.role='footprint' and el.valid_to is null
              limit 1) as footprintPlaceId
       from map_features where map_version_id=? order by feature_kind, coalesce(label, source_element_id)`,
    [mapVersionId],
  );
  return json({ items });
}

interface MapImportJobRow {
  id: string;
  jobType: string;
  status: string;
  attemptCount: number;
  errorMessage: string | null;
  payloadJson: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface MapImportJobPayload {
  versionLabel: string | null;
  campusId: string | null;
  floorId: string | null;
  mediaAssetId: string | null;
}

// 列表是只读视图：payload 缺字段或不是对象时降级为 null，不能让一条脏数据拖垮整个接口。
function parseJobPayload(raw: string | null): MapImportJobPayload {
  const empty: MapImportJobPayload = { versionLabel: null, campusId: null, floorId: null, mediaAssetId: null };
  if (!raw) return empty;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
    const record = value as Record<string, unknown>;
    const text = (field: unknown): string | null => (typeof field === "string" && field.trim() ? field.trim() : null);
    return {
      versionLabel: text(record.versionLabel),
      campusId: text(record.campusId),
      floorId: text(record.floorId),
      mediaAssetId: text(record.mediaAssetId),
    };
  } catch {
    return empty;
  }
}

/**
 * GET /api/admin/maps/import-jobs — 最近的底图/楼层导入任务，管理端轮询用。
 * payload 在 TS 侧解析（而非 SQL json_extract），保证脏数据容错。
 */
export async function listMapImportJobs(env: Env): Promise<Response> {
  const rows = await all<MapImportJobRow>(
    env.DB,
    `select id,job_type as jobType,status,attempt_count as attemptCount,error_message as errorMessage,
            payload_json as payloadJson,created_at as createdAt,started_at as startedAt,finished_at as finishedAt
       from jobs where job_type in ('map_import','floor_import')
      order by created_at desc,id desc limit 20`,
  );
  const mediaAssetIds = [...new Set(rows.map((row) => parseJobPayload(row.payloadJson).mediaAssetId).filter((id): id is string => id !== null))];
  const fileNames = new Map<string, string>();
  if (mediaAssetIds.length) {
    const media = await all<{ id: string; originalName: string }>(
      env.DB,
      `select id,original_name as originalName from media_assets where id in (${mediaAssetIds.map(() => "?").join(",")})`,
      mediaAssetIds,
    );
    for (const row of media) fileNames.set(row.id, row.originalName);
  }
  const items = rows.map((row) => {
    const payload = parseJobPayload(row.payloadJson);
    return {
      id: row.id,
      jobType: row.jobType,
      status: row.status,
      attemptCount: row.attemptCount,
      errorMessage: row.errorMessage,
      versionLabel: payload.versionLabel,
      campusId: payload.campusId,
      floorId: payload.floorId,
      mediaAssetId: payload.mediaAssetId,
      fileName: payload.mediaAssetId ? fileNames.get(payload.mediaAssetId) ?? null : null,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    };
  });
  return json({ items });
}

export async function listMapVersions(env: Env): Promise<Response> {
  const items = await all(
    env.DB,
    `select mv.id,mv.campus_id as campusId,mv.floor_id as floorId,mv.version_label as versionLabel,
            mv.coordinate_space_type as coordinateSpaceType,mv.lifecycle_status as lifecycleStatus,mv.created_at as createdAt,
            count(mf.id) as featureCount
       from map_versions mv left join map_features mf on mf.map_version_id=mv.id
      group by mv.id order by mv.created_at desc`,
  );
  return json({ items });
}

function sanitizeName(name: string): string {
  return name.normalize("NFKC").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "asset";
}
