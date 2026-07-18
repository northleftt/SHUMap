import type { Env, MessageBatch } from "../types/cloudflare";
import type { QueueJobMessage } from "../domain/types";
import { first } from "../lib/db";
import { isoNow, jsonString, makeId, parseJson, sha256 } from "../lib/values";

interface JobRow {
  id: string;
  job_type: QueueJobMessage["jobType"];
  status: string;
  payload_json: string;
  attempt_count: number;
}

interface ImportPayload {
  mediaAssetId: string;
  campusId?: string | null;
  floorId?: string | null;
  versionLabel: string;
  coordinateSpaceType: string;
  coordinateSpace: Record<string, unknown>;
}

export async function processQueue(batch: MessageBatch<QueueJobMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processJob(env, message.body.jobId);
      message.ack();
    } catch (error) {
      console.error("Queue job failed", message.body.jobId, error);
      const job = await first<JobRow>(env.DB, "select * from jobs where id=?", [message.body.jobId]);
      const attempts = (job?.attempt_count ?? 0) + 1;
      await env.DB.prepare(
        "update jobs set status=?,error_message=?,attempt_count=?,finished_at=? where id=?",
      ).bind(attempts >= 5 ? "failed" : "queued", error instanceof Error ? error.message : "Unknown error", attempts, attempts >= 5 ? isoNow() : null, message.body.jobId).run();
      if (attempts >= 5) message.ack();
      else message.retry({ delaySeconds: Math.min(300, 2 ** attempts * 5) });
    }
  }
}

async function processJob(env: Env, jobId: string): Promise<void> {
  const job = await first<JobRow>(env.DB, "select id,job_type,status,payload_json,attempt_count from jobs where id=?", [jobId]);
  if (!job || job.status === "succeeded" || job.status === "cancelled") return;
  await env.DB.prepare("update jobs set status='running',started_at=?,attempt_count=attempt_count+1,error_message=null where id=?")
    .bind(isoNow(), jobId).run();
  switch (job.job_type) {
    case "map_import":
    case "floor_import":
      await processMapImport(env, job);
      break;
    case "search_build":
    case "release_build":
    case "media_process":
    case "garbage_collect":
      await env.DB.prepare("update jobs set status='succeeded',result_json=?,finished_at=? where id=?")
        .bind(jsonString({ skipped: true, reason: "No work required for this job payload" }), isoNow(), job.id).run();
      break;
  }
}

async function processMapImport(env: Env, job: JobRow): Promise<void> {
  const payload = parseJson<ImportPayload>(job.payload_json, {} as ImportPayload);
  const media = await first<{ id: string; object_key: string; content_type: string; sha256: string; status: string }>(
    env.DB,
    "select id,object_key,content_type,sha256,status from media_assets where id=?",
    [payload.mediaAssetId],
  );
  if (!media || media.status !== "approved") throw new Error("Import media is unavailable");
  const object = await env.SHUMAP_BUCKET.get(media.object_key);
  if (!object) throw new Error("Import object is missing from R2");
  const content = await object.text();
  const actualHash = await sha256(content);
  if (actualHash !== media.sha256) throw new Error("Import object checksum mismatch");

  const mapAssetId = makeId("mapasset");
  const mapVersionId = makeId("mapver");
  const now = isoNow();
  const features = media.content_type === "image/svg+xml" ? parseSvgFeatures(content, mapVersionId) : [];
  const statements = [
    env.DB.prepare("insert into map_assets(id,asset_type,media_asset_id,checksum,metadata_json,created_at) values(?,?,?,?,?,?)")
      .bind(mapAssetId, payload.floorId ? "floor_svg" : "campus_svg", media.id, media.sha256, jsonString({ importJobId: job.id }), now),
    env.DB.prepare(
      `insert into map_versions(id,campus_id,floor_id,map_asset_id,version_label,coordinate_space_type,coordinate_space_json,parser_version,lifecycle_status,created_at)
       values(?,?,?,?,?,?,?,'svg-dom-v2','ready',?)`,
    ).bind(mapVersionId, payload.campusId ?? null, payload.floorId ?? null, mapAssetId, payload.versionLabel, payload.coordinateSpaceType, jsonString(payload.coordinateSpace), now),
  ];
  for (const feature of features) {
    statements.push(env.DB.prepare(
      `insert into map_features(id,map_version_id,stable_feature_key,source_element_id,feature_kind,shape_hash,label,metadata_json)
       values(?,?,?,?,?,?,?,?)`,
    ).bind(feature.id, mapVersionId, feature.stableKey, feature.sourceId, feature.kind, feature.shapeHash, feature.label, "{}"));
  }
  statements.push(env.DB.prepare("update jobs set status='succeeded',result_json=?,finished_at=? where id=?")
    .bind(jsonString({ mapAssetId, mapVersionId, featureCount: features.length }), now, job.id));
  await env.DB.batch(statements);
}

function parseSvgFeatures(svg: string, mapVersionId: string) {
  const openingTags = svg.match(/<(g|path|polygon|polyline|rect|circle|ellipse|line)\b[^>]*\bid=(?:"([^"]+)"|'([^']+)')[^>]*>/gi) ?? [];
  return openingTags.flatMap((tag, index) => {
    const idMatch = tag.match(/\bid=(?:"([^"]+)"|'([^']+)')/i);
    const sourceId = idMatch?.[1] ?? idMatch?.[2];
    if (!sourceId) return [];
    const tagName = tag.match(/^<([a-z]+)/i)?.[1]?.toLowerCase() ?? "other";
    const normalized = sourceId.normalize("NFKC").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
    const kind = /building|dorm|canteen|library|gym|hall/i.test(sourceId) ? "building_footprint" : tagName === "path" ? "path" : "other";
    return [{
      id: `feature_${mapVersionId}_${index}`,
      stableKey: normalized || null,
      sourceId,
      kind,
      shapeHash: null,
      label: null,
    }];
  });
}
