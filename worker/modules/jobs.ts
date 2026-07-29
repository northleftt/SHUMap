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
      `insert into map_features(id,map_version_id,stable_feature_key,source_element_id,feature_kind,geometry_json,bbox_json,shape_hash,label,metadata_json)
       values(?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      feature.id, mapVersionId, feature.stableKey, feature.sourceId, feature.kind,
      feature.geometry ? jsonString(feature.geometry) : null,
      feature.bbox ? jsonString(feature.bbox) : null,
      feature.shapeHash, feature.label,
      jsonString(feature.approximated ? { geometryApproximation: "curve_endpoints" } : {}),
    ));
  }
  statements.push(env.DB.prepare("update jobs set status='succeeded',result_json=?,finished_at=? where id=?")
    .bind(jsonString({ mapAssetId, mapVersionId, featureCount: features.length }), now, job.id));
  await env.DB.batch(statements);
}

// ---------------------------------------------------------------------------
// SVG feature parsing
//
// The campus sources put the meaningful ids on `<g>` wrappers whose children are
// plain shapes, and carry no `transform` attributes, so shape coordinates are
// already in the viewBox space that map_features.geometry_json is expected to
// hold. A group's geometry is the union of its descendant shapes; a shape that
// carries the id directly contributes only itself.
//
// Curves (C/S/Q/T/A) are reduced to their endpoints rather than flattened, so a
// feature containing them is marked `geometryApproximation` in metadata_json.
// ---------------------------------------------------------------------------

type Vert = [number, number];

interface SubPath {
  points: Vert[];
  closed: boolean;
}

interface Shape {
  subPaths: SubPath[];
  approximated: boolean;
}

interface ParsedFeature {
  order: number;
  id: string;
  stableKey: string | null;
  sourceId: string;
  kind: string;
  geometry: unknown;
  bbox: number[] | null;
  approximated: boolean;
  shapeHash: null;
  label: string | null;
}

const SHAPE_TAGS = new Set(["path", "polygon", "polyline", "rect", "circle", "ellipse", "line"]);
const NUMBER_PATTERN = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

function numbers(value: string): number[] {
  return (value.match(NUMBER_PATTERN) ?? []).map(Number).filter((n) => Number.isFinite(n));
}

function attribute(attrs: string, name: string): string | null {
  const match = attrs.match(new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`, "i"));
  return match ? (match[1] ?? match[2] ?? null) : null;
}

function parsePath(d: string): Shape {
  const subPaths: SubPath[] = [];
  let approximated = false;
  let current: SubPath | null = null;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;

  const open = (): SubPath => {
    const next: SubPath = { points: [], closed: false };
    subPaths.push(next);
    return next;
  };
  const lineTo = (nx: number, ny: number) => {
    if (!current) current = open();
    x = nx;
    y = ny;
    current.points.push([nx, ny]);
  };

  for (const chunk of d.match(/[MmLlHhVvCcSsQqTtAaZz][^MmLlHhVvCcSsQqTtAaZz]*/g) ?? []) {
    const code = chunk[0];
    const args = numbers(chunk.slice(1));
    const relative = code === code.toLowerCase();
    switch (code.toUpperCase()) {
      case "M": {
        for (let i = 0; i + 1 < args.length; i += 2) {
          const nx = relative ? x + args[i] : args[i];
          const ny = relative ? y + args[i + 1] : args[i + 1];
          if (i === 0) {
            current = open();
            startX = nx;
            startY = ny;
          }
          lineTo(nx, ny);
        }
        break;
      }
      case "L": {
        for (let i = 0; i + 1 < args.length; i += 2) {
          lineTo(relative ? x + args[i] : args[i], relative ? y + args[i + 1] : args[i + 1]);
        }
        break;
      }
      case "H": {
        for (const arg of args) lineTo(relative ? x + arg : arg, y);
        break;
      }
      case "V": {
        for (const arg of args) lineTo(x, relative ? y + arg : arg);
        break;
      }
      // Curve commands: keep the endpoint, drop the control points.
      case "C":
      case "S":
      case "Q":
      case "T":
      case "A": {
        const stride = { C: 6, S: 4, Q: 4, T: 2, A: 7 }[code.toUpperCase() as "C" | "S" | "Q" | "T" | "A"];
        for (let i = 0; i + stride <= args.length; i += stride) {
          const ex = args[i + stride - 2];
          const ey = args[i + stride - 1];
          lineTo(relative ? x + ex : ex, relative ? y + ey : ey);
          approximated = true;
        }
        break;
      }
      case "Z": {
        if (current) current.closed = true;
        x = startX;
        y = startY;
        current = null;
        break;
      }
    }
  }
  return { subPaths, approximated };
}

function parseShape(tag: string, attrs: string): Shape | null {
  if (tag === "path") {
    const d = attribute(attrs, "d");
    return d ? parsePath(d) : null;
  }
  if (tag === "polygon" || tag === "polyline") {
    const raw = numbers(attribute(attrs, "points") ?? "");
    const points: Vert[] = [];
    for (let i = 0; i + 1 < raw.length; i += 2) points.push([raw[i], raw[i + 1]]);
    if (points.length === 0) return null;
    return { subPaths: [{ points, closed: tag === "polygon" }], approximated: false };
  }
  if (tag === "rect") {
    const x = Number(attribute(attrs, "x") ?? 0);
    const y = Number(attribute(attrs, "y") ?? 0);
    const w = Number(attribute(attrs, "width") ?? NaN);
    const h = Number(attribute(attrs, "height") ?? NaN);
    if (![x, y, w, h].every(Number.isFinite)) return null;
    return { subPaths: [{ points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], closed: true }], approximated: false };
  }
  if (tag === "line") {
    const x1 = Number(attribute(attrs, "x1") ?? NaN);
    const y1 = Number(attribute(attrs, "y1") ?? NaN);
    const x2 = Number(attribute(attrs, "x2") ?? NaN);
    const y2 = Number(attribute(attrs, "y2") ?? NaN);
    if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
    return { subPaths: [{ points: [[x1, y1], [x2, y2]], closed: false }], approximated: false };
  }
  if (tag === "circle" || tag === "ellipse") {
    const cx = Number(attribute(attrs, "cx") ?? 0);
    const cy = Number(attribute(attrs, "cy") ?? 0);
    const rx = Number(attribute(attrs, tag === "circle" ? "r" : "rx") ?? NaN);
    const ry = tag === "circle" ? rx : Number(attribute(attrs, "ry") ?? NaN);
    if (![cx, cy, rx, ry].every(Number.isFinite)) return null;
    // Approximated by its bounding box rather than flattened into an arc.
    return {
      subPaths: [{ points: [[cx - rx, cy - ry], [cx + rx, cy - ry], [cx + rx, cy + ry], [cx - rx, cy + ry]], closed: true }],
      approximated: true,
    };
  }
  return null;
}

function ring(points: Vert[]): Vert[] {
  const first = points[0];
  const last = points[points.length - 1];
  return first[0] === last[0] && first[1] === last[1] ? points : [...points, first];
}

function geometryOf(subPaths: SubPath[]): unknown {
  const polygons = subPaths.filter((sub) => sub.closed && sub.points.length >= 3).map((sub) => [ring(sub.points)]);
  const lines = subPaths.filter((sub) => !(sub.closed && sub.points.length >= 3) && sub.points.length >= 2).map((sub) => sub.points);
  if (polygons.length === 1 && lines.length === 0) return { type: "Polygon", coordinates: polygons[0] };
  if (polygons.length > 1 && lines.length === 0) return { type: "MultiPolygon", coordinates: polygons };
  if (lines.length === 1 && polygons.length === 0) return { type: "LineString", coordinates: lines[0] };
  if (lines.length > 1 && polygons.length === 0) return { type: "MultiLineString", coordinates: lines };
  if (polygons.length === 0 && lines.length === 0) return null;
  return {
    type: "GeometryCollection",
    geometries: [
      { type: "MultiPolygon", coordinates: polygons },
      { type: "MultiLineString", coordinates: lines },
    ],
  };
}

function bboxOf(subPaths: SubPath[]): number[] | null {
  const points = subPaths.flatMap((sub) => sub.points);
  if (points.length === 0) return null;
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Collapses a `<text>` element's inner markup (usually `<tspan>`s) to plain text. */
function textContent(inner: string): string {
  return inner.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function featureKind(sourceId: string, tag: string): string {
  if (/building|dorm|canteen|library|gym|hall/i.test(sourceId)) return "building_footprint";
  return tag === "path" ? "path" : "other";
}

function parseSvgFeatures(svg: string, mapVersionId: string) {
  const features: ParsedFeature[] = [];
  const stack: Array<{ sourceId: string | null; order: number; subPaths: SubPath[]; approximated: boolean; texts: string[] }> = [];
  const seen = new Set<string>();
  let order = 0;

  const push = (
    sourceId: string,
    tag: string,
    at: number,
    subPaths: SubPath[],
    approximated: boolean,
    label: string | null,
  ) => {
    // map_features has unique(map_version_id, source_element_id); a duplicate id
    // in the source would otherwise abort the whole import batch.
    if (seen.has(sourceId)) return;
    seen.add(sourceId);
    features.push({
      order: at,
      id: `feature_${mapVersionId}_${at}`,
      stableKey: sourceId.normalize("NFKC").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || null,
      sourceId,
      kind: featureKind(sourceId, tag),
      geometry: geometryOf(subPaths),
      bbox: bboxOf(subPaths),
      approximated,
      shapeHash: null,
      label,
    });
  };

  const tagPattern = /<(\/?)([a-zA-Z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(svg)) !== null) {
    const closing = match[1] === "/";
    const tag = match[2].toLowerCase();
    const attrs = match[3] ?? "";
    const selfClosing = match[4] === "/";

    if (tag === "g") {
      if (closing) {
        const frame = stack.pop();
        if (frame?.sourceId) {
          const label = frame.texts.join(" ").replace(/\s+/g, " ").trim();
          push(frame.sourceId, "g", frame.order, frame.subPaths, frame.approximated, label ? label.slice(0, 200) : null);
        }
        continue;
      }
      if (selfClosing) continue;
      const sourceId = attribute(attrs, "id");
      stack.push({
        sourceId,
        order: sourceId ? order++ : -1,
        subPaths: [],
        approximated: false,
        texts: [],
      });
      continue;
    }

    // `<text>` supplies the human label for the enclosing group; skip its body
    // wholesale so nested `<tspan>`s are not walked as separate elements.
    if (tag === "text" && !closing && !selfClosing) {
      const end = svg.indexOf("</text>", tagPattern.lastIndex);
      const inner = end === -1 ? "" : svg.slice(tagPattern.lastIndex, end);
      const label = textContent(inner);
      if (label) for (const frame of stack) frame.texts.push(label);
      if (end !== -1) tagPattern.lastIndex = end + "</text>".length;
      continue;
    }

    if (closing || !SHAPE_TAGS.has(tag)) continue;
    const shape = parseShape(tag, attrs);
    if (!shape) continue;
    for (const frame of stack) {
      frame.subPaths.push(...shape.subPaths);
      frame.approximated = frame.approximated || shape.approximated;
    }
    const sourceId = attribute(attrs, "id");
    if (sourceId) push(sourceId, tag, order++, shape.subPaths, shape.approximated, null);
  }

  return features.sort((a, b) => a.order - b.order);
}
