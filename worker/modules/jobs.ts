import { parseSvgFeatures, parseSvgViewBox, type ParsedSvgFeature } from "../../shared/svg-geometry.mjs";
import type { QueueJobMessage } from "../domain/types";
import type { Env, MessageBatch } from "../types/cloudflare";
import { all, first } from "../lib/db";
import { isoNow, jsonString, makeId, sha256 } from "../lib/values";

/**
 * 导入数据本身的确定性问题（缺图形、几何类型不对、校验和不符等）：重试不会自愈，
 * 首次失败即终态——否则任务在队列里反复空转，管理端看到的永远是「排队中」。
 * 非预期异常（D1/R2 故障等）仍是普通 Error，走原有重试。
 */
export class ImportValidationError extends Error {}

interface JobRow {
  id: string;
  job_type: QueueJobMessage["jobType"];
  status: string;
  payload_json: string;
  attempt_count: number;
}

interface ImportPayload {
  mediaAssetId: string;
  campusId: string | null;
  floorId: string | null;
  versionLabel: string;
}

interface PreviousFeatureRow {
  id: string;
  sourceElementId: string;
  stableFeatureKey: string | null;
}

interface FootprintBindingRow {
  featureId: string;
  sourceElementId: string;
  placeId: string;
  anchorId: string;
  bindingId: string;
  campusId: string;
  isPrimary: number;
}

interface ImportedFeature extends ParsedSvgFeature {
  id: string;
  shapeHash: string | null;
}

const IMPORT_PAYLOAD_KEYS = new Set(["mediaAssetId", "campusId", "floorId", "versionLabel"]);
const MAX_MAP_ASSET_BYTES = 50 * 1024 * 1024;

function requiredJobString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ImportValidationError(`Map import ${field} must be a non-empty string`);
  return value.trim();
}

function optionalJobId(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requiredJobString(value, field);
}

function parseImportPayload(job: JobRow): ImportPayload {
  let value: unknown;
  try {
    value = JSON.parse(job.payload_json) as unknown;
  } catch {
    throw new ImportValidationError("Map import payload is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ImportValidationError("Map import payload must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!IMPORT_PAYLOAD_KEYS.has(key)) throw new ImportValidationError(`Map import payload contains unsupported field ${key}`);
  }
  const payload = {
    mediaAssetId: requiredJobString(record.mediaAssetId, "mediaAssetId"),
    campusId: optionalJobId(record.campusId, "campusId"),
    floorId: optionalJobId(record.floorId, "floorId"),
    versionLabel: requiredJobString(record.versionLabel, "versionLabel"),
  };
  if (Number(payload.campusId !== null) + Number(payload.floorId !== null) !== 1) {
    throw new ImportValidationError("Map import payload must identify exactly one campus or floor");
  }
  if (job.job_type === "map_import" && payload.campusId === null) {
    throw new ImportValidationError("Campus map import payload has no campusId");
  }
  if (job.job_type === "floor_import" && payload.floorId === null) {
    throw new ImportValidationError("Floor map import payload has no floorId");
  }
  return payload;
}

export async function processQueue(batch: MessageBatch<QueueJobMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processJob(env, message.body.jobId);
      message.ack();
    } catch (error) {
      console.error("Queue job failed", message.body.jobId, error);
      const job = await first<JobRow>(env.DB, "select * from jobs where id=?", [message.body.jobId]);
      const attempts = job?.attempt_count ?? 0;
      // 确定性校验错误直接终态；其余错误重试，超过 5 次放弃。
      const failed = error instanceof ImportValidationError || attempts >= 5;
      await env.DB.prepare(
        "update jobs set status=?,error_message=?,finished_at=? where id=?",
      ).bind(
        failed ? "failed" : "queued",
        error instanceof Error ? error.message : "Unknown queue error",
        failed ? isoNow() : null,
        message.body.jobId,
      ).run();
      if (failed) message.ack();
      else message.retry({ delaySeconds: Math.min(300, 2 ** attempts * 5) });
    }
  }
}

async function processJob(env: Env, jobId: string): Promise<void> {
  const job = await first<JobRow>(env.DB, "select id,job_type,status,payload_json,attempt_count from jobs where id=?", [jobId]);
  if (!job || job.status === "succeeded" || job.status === "cancelled") return;
  await env.DB.prepare("update jobs set status='running',started_at=?,attempt_count=attempt_count+1,error_message=null where id=?")
    .bind(isoNow(), jobId).run();
  await processMapImport(env, job);
}

async function importedFeatures(svg: string, mapVersionId: string): Promise<ImportedFeature[]> {
  return Promise.all(parseSvgFeatures(svg).map(async (feature) => {
    const serializedGeometry = feature.geometry === null ? null : JSON.stringify(feature.geometry);
    return {
      ...feature,
      id: `feature_${mapVersionId}_${feature.order}`,
      shapeHash: serializedGeometry === null ? null : await sha256(serializedGeometry),
    };
  }));
}

function footprintBindings(rows: FootprintBindingRow[]): Map<string, FootprintBindingRow> {
  const result = new Map<string, FootprintBindingRow>();
  for (const row of rows) {
    if (result.has(row.sourceElementId)) {
      throw new ImportValidationError(`Map feature ${row.sourceElementId} has multiple active building footprint bindings`);
    }
    result.set(row.sourceElementId, row);
  }
  return result;
}

function featureMetadata(feature: ImportedFeature): Record<string, unknown> {
  return {
    sourceOrder: feature.order,
    ...(feature.approximated ? { geometryApproximation: "curve_endpoints" } : {}),
  };
}

function importedStableKey(
  payload: ImportPayload,
  feature: ImportedFeature,
  previous: PreviousFeatureRow | undefined,
  footprint: FootprintBindingRow | undefined,
): string {
  if (footprint) return `place:${footprint.placeId}`;
  if (previous?.stableFeatureKey) return previous.stableFeatureKey;
  const target = payload.campusId ? `campus:${payload.campusId}` : `floor:${payload.floorId}`;
  return `${target}:svg:${feature.sourceElementId}`;
}

async function processMapImport(env: Env, job: JobRow): Promise<void> {
  const payload = parseImportPayload(job);
  const media = await first<{
    id: string;
    object_key: string;
    content_type: string;
    byte_size: number;
    sha256: string;
    status: string;
    source_id: string | null;
  }>(
    env.DB,
    "select id,object_key,content_type,byte_size,sha256,status,source_id from media_assets where id=?",
    [payload.mediaAssetId],
  );
  if (!media || media.status !== "approved") throw new ImportValidationError("Import media is unavailable");
  if (media.content_type !== "image/svg+xml") throw new ImportValidationError("Map import requires an SVG media asset");
  if (!Number.isSafeInteger(media.byte_size) || media.byte_size <= 0 || media.byte_size > MAX_MAP_ASSET_BYTES) {
    throw new ImportValidationError(`Import media has invalid stored byte size ${media.byte_size}`);
  }
  const object = await env.SHUMAP_BUCKET.get(media.object_key);
  if (!object) throw new ImportValidationError("Import object is missing from R2");
  if (object.size !== media.byte_size) {
    throw new ImportValidationError(`Import object size ${object.size} does not match stored byte size ${media.byte_size}`);
  }
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength !== media.byte_size) {
    throw new ImportValidationError(`Import object body size ${bytes.byteLength} does not match stored byte size ${media.byte_size}`);
  }
  if (await sha256(bytes) !== media.sha256) throw new ImportValidationError("Import object checksum mismatch");
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ImportValidationError("Import SVG is not valid UTF-8");
  }

  const mapAssetId = makeId("mapasset");
  const mapVersionId = makeId("mapver");
  const now = isoNow();
  const features = await importedFeatures(content, mapVersionId);
  if (!features.length) throw new ImportValidationError("Map SVG contains no addressable features");
  const coordinateSpace = parseSvgViewBox(content);
  const previousVersion = await first<{ id: string }>(
    env.DB,
    `select id from map_versions
      where coalesce(campus_id,'')=coalesce(?,'') and coalesce(floor_id,'')=coalesce(?,'')
        and lifecycle_status in ('ready','published','archived')
      order by created_at desc,id desc limit 1`,
    [payload.campusId, payload.floorId],
  );
  const previousFeatures = previousVersion
    ? await all<PreviousFeatureRow>(
      env.DB,
      `select id,source_element_id as sourceElementId,stable_feature_key as stableFeatureKey
         from map_features where map_version_id=? and source_element_id is not null`,
      [previousVersion.id],
    )
    : [];
  const previousBySourceId = new Map(previousFeatures.map((feature) => [feature.sourceElementId, feature]));
  const activeFootprints = payload.campusId
    ? await all<FootprintBindingRow>(
      env.DB,
      `select mf.id as featureId,mf.source_element_id as sourceElementId,el.entity_id as placeId,
              la.id as anchorId,el.id as bindingId,la.campus_id as campusId,el.is_primary as isPrimary
         from map_features mf
         join map_versions mv on mv.id=mf.map_version_id and mv.floor_id is null
         join location_anchors la on la.map_feature_id=mf.id and la.role='footprint' and la.valid_to is null
         join entity_locations el on el.anchor_id=la.id and el.entity_type='place'
              and el.role='footprint' and el.valid_to is null
         join buildings b on b.place_id=el.entity_id and b.place_id=la.building_place_id
        where mv.campus_id=? and la.campus_id=? and mf.source_element_id is not null`,
      [payload.campusId, payload.campusId],
    )
    : [];
  const footprintBySourceId = footprintBindings(activeFootprints);
  const importedSourceIds = new Set(features.map((feature) => feature.sourceElementId));
  const missingFootprints = activeFootprints
    .filter((footprint) => !importedSourceIds.has(footprint.sourceElementId))
    .map((footprint) => footprint.sourceElementId)
    .sort();
  if (missingFootprints.length) {
    throw new ImportValidationError(`Map SVG is missing active building footprint elements: ${missingFootprints.join(", ")}`);
  }

  const statements = [
    env.DB.prepare("insert into map_assets(id,asset_type,media_asset_id,checksum,metadata_json,created_at) values(?,?,?,?,?,?)")
      .bind(mapAssetId, payload.floorId ? "floor_svg" : "campus_svg", media.id, media.sha256, jsonString({ importJobId: job.id }), now),
    env.DB.prepare(
      `insert into map_versions(id,campus_id,floor_id,map_asset_id,parent_version_id,version_label,coordinate_space_type,coordinate_space_json,parser_version,lifecycle_status,created_at)
       values(?,?,?,?,?,?,'svg_viewbox',?,'svg-geometry-v3','ready',?)`,
    ).bind(mapVersionId, payload.campusId, payload.floorId, mapAssetId, previousVersion?.id ?? null, payload.versionLabel, jsonString(coordinateSpace), now),
  ];

  for (const feature of features) {
    const previous = previousBySourceId.get(feature.sourceElementId);
    const footprint = footprintBySourceId.get(feature.sourceElementId);
    const geometryType = feature.geometry?.type;
    if (typeof geometryType !== "string") {
      if (footprint) throw new ImportValidationError(`Building footprint ${feature.sourceElementId} has no geometry type`);
    }
    if (footprint && geometryType !== "Polygon" && geometryType !== "MultiPolygon") {
      throw new ImportValidationError(`Building footprint ${feature.sourceElementId} must resolve to Polygon or MultiPolygon geometry`);
    }
    if (footprint && footprint.campusId !== payload.campusId) {
      throw new ImportValidationError(`Building footprint ${feature.sourceElementId} belongs to another campus`);
    }
    statements.push(env.DB.prepare(
      `insert into map_features(id,map_version_id,stable_feature_key,source_element_id,feature_kind,geometry_json,bbox_json,shape_hash,label,metadata_json)
       values(?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      feature.id,
      mapVersionId,
      importedStableKey(payload, feature, previous, footprint),
      feature.sourceElementId,
      footprint ? "building_footprint" : "other",
      feature.geometry === null ? null : JSON.stringify(feature.geometry),
      feature.bbox === null ? null : JSON.stringify(feature.bbox),
      feature.shapeHash,
      feature.label,
      jsonString(featureMetadata(feature)),
    ));
    const lineageSources = new Set([
      ...(previous ? [previous.id] : []),
      ...(footprint ? [footprint.featureId] : []),
    ]);
    for (const sourceFeatureId of lineageSources) {
      statements.push(env.DB.prepare(
        `insert into map_feature_mappings(from_feature_id,to_feature_id,mapping_status,confidence)
         values(?,?,'automatic',1)`,
      ).bind(sourceFeatureId, feature.id));
    }
    if (footprint && typeof geometryType === "string") {
      const anchorId = makeId("anchor");
      const bindingId = makeId("eloc");
      statements.push(
        env.DB.prepare("update entity_locations set valid_to=? where id=? and valid_to is null").bind(now, footprint.bindingId),
        env.DB.prepare("update location_anchors set valid_to=?,updated_at=? where id=? and valid_to is null").bind(now, now, footprint.anchorId),
        env.DB.prepare(
          `insert into location_anchors(
             id,campus_id,building_place_id,role,geometry_type,map_version_id,map_feature_id,
             precision_level,source_id,verification_status,valid_from,created_at,updated_at
           ) values(?,?,?,'footprint',?,?,?,'exact',?,'unverified',?,?,?)`,
        ).bind(anchorId, payload.campusId, footprint.placeId, geometryType, mapVersionId, feature.id, media.source_id, now, now, now),
        env.DB.prepare(
          `insert into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,valid_from,created_at)
           values(?,'place',?,?,'footprint',?,?,?)`,
        ).bind(bindingId, footprint.placeId, anchorId, Number(footprint.isPrimary) === 1 ? 1 : 0, now, now),
      );
    }
  }
  statements.push(env.DB.prepare("update jobs set status='succeeded',result_json=?,finished_at=? where id=?")
    .bind(jsonString({ mapAssetId, mapVersionId, featureCount: features.length }), now, job.id));
  await env.DB.batch(statements);
}
