#!/usr/bin/env node
// 导航终点重建：用【新的、拟合自已发布底图的】仿射参数，从每个地点在地图上的
// 实际几何反算 GCJ-02 导航终点。
//
// 为什么可以这么做（前置条件已实测确认）：
//   1) 全部 216 个 footprint 锚点都指向已发布底图的 map_version
//      （mapver_*，不是仓库图 map_version_campus_*），所以几何与新参数同一坐标空间；
//   2) 新参数拟合自 data/published-maps 的底图，变换不确定度 1.4–3.2m。
// 这两条任一不成立就不能直接逆变换 —— 那正是之前偏 107m 的成因。
//
// 精度口径：导航点取几何的代表点（面的质心，落在面外时退回面内点）。
// 与"楼的主入口"仍有几十米差（大楼尤其明显），所以 precision_level 记 'building'
// 而不是 'exact'，verification_status 记 'unverified'：这是可用的默认值，
// 需要精确到门口的地点由人在管理端画布上覆盖。
//
// 两处都要写（与 generate_navigation_purge.mjs 对称）：
//   1) 关系表 location_anchors + entity_locations —— 用户端导航按钮读这一份；
//   2) place_revisions.structure_json.locations[] —— 管理端地点编辑器读这一份
//      （src/admin/pages/PlaceEditorPage.tsx:131）。只写关系表的话编辑器看不到，
//      下次保存会把它抹掉。content_hash 覆盖 structure_json，必须重算。
//
// 用法见 --help。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { invertGeoTransform, applyGeoTransform } from "../shared/geo-transform.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = path.join(root, "output/navigation-rebuild.sql");

export const ROLE = "navigation_target";
export const SOURCE_ID = "source_navigation_rebuild_calibrated_v1";
// 代表点与主入口的差异是主导误差项（不是仿射的 1.4–3.2m），所以不是 'exact'。
export const PRECISION_LEVEL = "building";

// ---------------------------------------------------------------------------
// 配套查询
// ---------------------------------------------------------------------------

/** 每个 place 的 footprint 几何（已发布底图空间）。 */
export const FOOTPRINT_QUERY = `select el.entity_id as placeId,
       c.code as campusCode,
       la.campus_id as campusId,
       mf.geometry_json as geometryJson,
       mf.source_element_id as sourceElementId
  from entity_locations el
  join location_anchors la on la.id=el.anchor_id
  join map_features mf on mf.id=la.map_feature_id
  join map_versions mv on mv.id=la.map_version_id
  join campuses c on c.id=mv.campus_id
 where el.entity_type='place' and el.role='footprint'
   and el.valid_to is null and la.valid_to is null;`;

/** 非楼栋实体自己画在图上的点（facility / transit_stop / 无 footprint 的 place）。 */
export const CANVAS_POINT_QUERY = `select el.entity_type as entityType,
       el.entity_id as entityId,
       c.code as campusCode,
       la.campus_id as campusId,
       la.geometry_json as geometryJson,
       la.role as sourceRole
  from entity_locations el
  join location_anchors la on la.id=el.anchor_id
  join map_versions mv on mv.id=la.map_version_id
  join campuses c on c.id=mv.campus_id
 where la.crs='svg_viewbox' and la.geometry_type='Point'
   and el.valid_to is null and la.valid_to is null;`;

/** 已经有 is_primary=1 绑定的实体 —— 唯一索引不允许再插一个。 */
export const PRIMARY_TAKEN_QUERY = `select entity_type as entityType, entity_id as entityId
  from entity_locations where is_primary=1 and valid_to is null;`;

/** 待改写的 place_revisions（哈希输入全字段）。 */
export const REVISION_QUERY = `select r.id as revisionId,
       r.place_id as placeId,
       r.display_name as displayName,
       r.summary as summary,
       r.description as description,
       r.content_json as contentJson,
       r.structure_json as structureJson,
       r.content_hash as contentHash
  from place_revisions r
 order by r.place_id, r.id;`;

/** 已存在的 navigation_target —— 应为 0，非 0 说明清除没跑或有人又写了。 */
export const EXISTING_NAV_QUERY = `select count(*) as n
  from entity_locations where role='${ROLE}' and valid_to is null;`;

const sha256 = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex");
const q = (value) =>
  value === null || value === undefined ? "null" : `'${String(value).replaceAll("'", "''")}'`;
const j = (value) => q(JSON.stringify(value));
const now = "datetime('now')";
const round7 = (value) => Math.round(value * 1e7) / 1e7;
const field = (row, camel, snake) => (row[camel] !== undefined ? row[camel] : row[snake]);

export function normalizeRows(payload) {
  if (Array.isArray(payload)) {
    if (payload.length === 0) return [];
    if (payload.every((item) => item && typeof item === "object" && Array.isArray(item.results))) {
      return payload.flatMap((item) => item.results);
    }
    return payload;
  }
  if (payload && typeof payload === "object" && Array.isArray(payload.results)) return payload.results;
  throw new Error("Unrecognized input: expected [{results:[…]}], {results:[…]} or a bare row array");
}

// ---------------------------------------------------------------------------
// 几何 → 代表点
// ---------------------------------------------------------------------------

function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum / 2;
}

/** 面的面积加权质心（含首尾闭合的环）。 */
function ringCentroid(ring) {
  let cx = 0, cy = 0, area = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const cross = ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    area += cross;
    cx += (ring[i][0] + ring[i + 1][0]) * cross;
    cy += (ring[i][1] + ring[i + 1][1]) * cross;
  }
  area /= 2;
  if (Math.abs(area) < 1e-12) {
    // 退化成线：取顶点均值。
    const n = ring.length - 1 || ring.length;
    return [
      ring.slice(0, n).reduce((s, p) => s + p[0], 0) / n,
      ring.slice(0, n).reduce((s, p) => s + p[1], 0) / n,
    ];
  }
  return [cx / (6 * area), cy / (6 * area)];
}

function pointInRing(ring, point) {
  let inside = false;
  for (let i = 0, k = ring.length - 1; i < ring.length; k = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xk, yk] = ring[k];
    if ((yi > point[1]) !== (yk > point[1])) {
      const crossX = ((xk - xi) * (point[1] - yi)) / (yk - yi) + xi;
      if (point[0] < crossX) inside = !inside;
    }
  }
  return inside;
}

/**
 * 几何的代表点（viewBox 空间）。
 * MultiPolygon 取面积最大的那一块；质心落在面外（L 形、环形楼）时，
 * 沿质心所在扫描线取面内最长区段的中点，保证点确实落在楼里。
 */
export function representativePoint(geometry) {
  if (!geometry || typeof geometry !== "object") return null;
  let rings = null;
  if (geometry.type === "Polygon" && Array.isArray(geometry.coordinates)) {
    rings = geometry.coordinates;
  } else if (geometry.type === "MultiPolygon" && Array.isArray(geometry.coordinates)) {
    let best = null, bestArea = -1;
    for (const polygon of geometry.coordinates) {
      if (!Array.isArray(polygon) || !Array.isArray(polygon[0])) continue;
      const area = Math.abs(ringArea(polygon[0]));
      if (area > bestArea) { bestArea = area; best = polygon; }
    }
    rings = best;
  } else if (geometry.type === "Point" && Array.isArray(geometry.coordinates)) {
    const [x, y] = geometry.coordinates;
    return Number.isFinite(x) && Number.isFinite(y) ? { point: [x, y], method: "point" } : null;
  }
  if (!Array.isArray(rings) || !Array.isArray(rings[0]) || rings[0].length < 4) return null;
  const outer = rings[0];
  if (!outer.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))) return null;

  const centroid = ringCentroid(outer);
  const holes = rings.slice(1).filter((r) => Array.isArray(r) && r.length >= 4);
  const inside = (p) => pointInRing(outer, p) && !holes.some((h) => pointInRing(h, p));
  if (inside(centroid)) return { point: centroid, method: "centroid" };

  // 质心在面外：沿 y=centroid.y 扫描，取面内最长区段的中点。
  const xs = outer.map((p) => p[0]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const steps = 400;
  let bestMid = null, bestLen = 0, runStart = null;
  for (let i = 0; i <= steps; i += 1) {
    const x = minX + ((maxX - minX) * i) / steps;
    if (inside([x, centroid[1]])) {
      if (runStart === null) runStart = x;
    } else if (runStart !== null) {
      const len = x - runStart;
      if (len > bestLen) { bestLen = len; bestMid = (runStart + x) / 2; }
      runStart = null;
    }
  }
  if (runStart !== null) {
    const len = maxX - runStart;
    if (len > bestLen) { bestLen = len; bestMid = (runStart + maxX) / 2; }
  }
  if (bestMid !== null) return { point: [bestMid, centroid[1]], method: "scanline" };
  return { point: centroid, method: "centroid-outside" };
}

// ---------------------------------------------------------------------------
// structure_json 写回
// ---------------------------------------------------------------------------

export function placeContentHash({ displayName, summary, description, contentJson, structureJson }) {
  return sha256(
    `${displayName}\n${summary ?? ""}\n${description ?? ""}\n${contentJson}\n${structureJson}`,
  );
}

/**
 * 把导航点插回 structure_json.locations。
 * 与清除脚本一样先做 parse→stringify 逐字节往返自检：不能忠实复现就不动这一行。
 * 导航点插在数组开头，与 seed 原本的顺序一致（nav 在前、footprint 在后）。
 */
export function rewriteStructureJson(structureJson, entry) {
  let parsed;
  try {
    parsed = JSON.parse(structureJson);
  } catch {
    return { ok: false, reason: "structure_json 不是合法 JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "structure_json 不是对象" };
  }
  if (JSON.stringify(parsed) !== structureJson) {
    return { ok: false, reason: "structure_json 无法逐字节往返（键序/数字记法与 JSON.stringify 不一致）" };
  }
  if (!Array.isArray(parsed.locations)) {
    return { ok: false, reason: "structure_json.locations 不是数组" };
  }
  if (parsed.locations.some((item) => item && typeof item === "object" && item.role === ROLE)) {
    return { noop: true, reason: "structure_json 里已有导航终点" };
  }
  const location = {
    campusId: entry.campusId,
    buildingPlaceId: entry.buildingPlaceId ?? null,
    role: ROLE,
    geometryType: "Point",
    geometry: { type: "Point", coordinates: [entry.longitude, entry.latitude] },
    crs: "GCJ02",
    precisionLevel: PRECISION_LEVEL,
    sourceId: SOURCE_ID,
    // structure_json 走 JSON boolean。写成 0/1 会被地点编辑器 requiredBoolean 拒掉。
    isPrimary: entry.isPrimary === true || entry.isPrimary === 1,
  };
  return {
    ok: true,
    next: JSON.stringify({ ...parsed, locations: [location, ...parsed.locations] }),
  };
}

// ---------------------------------------------------------------------------
// 计划
// ---------------------------------------------------------------------------

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

/**
 * @param {{ footprints?:unknown, canvasPoints?:unknown, revisions?:unknown,
 *           primaryTaken?:unknown, existingNav?:unknown, transforms:object,
 *           publishedManifest:object }} input
 */
export function planNavigationRebuild(input) {
  const transforms = input.transforms;
  const inverse = {};
  const viewBoxByCampus = {};
  for (const entry of input.publishedManifest.campuses) {
    const record = transforms[entry.key];
    if (!record?.transform) throw new Error(`data/geo-transform.json 缺少校区 ${entry.key}`);
    // 参数必须拟合自当前发版的底图，否则逆变换出来的经纬度整体偏移。
    if (record.mapVersionId !== entry.mapVersionId) {
      throw new Error(
        `${entry.key} 的参数拟合自 ${record.mapVersionId}，当前发版底图是 ${entry.mapVersionId}；`
          + "先跑 fetch_published_maps.mjs && generate_geo_transform.mjs",
      );
    }
    inverse[entry.key] = invertGeoTransform(record.transform);
    viewBoxByCampus[entry.key] = entry.viewBox;
  }

  const existingNav = normalizeRows(input.existingNav ?? []);
  const existingNavCount = existingNav.length > 0
    ? Number(field(existingNav[0], "n", "n") ?? 0)
    : 0;

  const primaryTaken = new Set(
    normalizeRows(input.primaryTaken ?? []).map(
      (row) => `${field(row, "entityType", "entity_type")}:${field(row, "entityId", "entity_id")}`,
    ),
  );

  const inserts = [];
  const skipped = [];
  const seenEntities = new Set();

  const addEntry = (entity) => {
    const key = `${entity.entityType}:${entity.entityId}`;
    if (seenEntities.has(key)) {
      skipped.push({ ...entity, reason: "同一实体出现多次，只取第一条" });
      return;
    }
    const campusKey = entity.campusCode;
    if (!inverse[campusKey]) {
      skipped.push({ ...entity, reason: `未知校区 ${campusKey}` });
      return;
    }
    let geometry;
    try {
      geometry = JSON.parse(entity.geometryJson);
    } catch {
      skipped.push({ ...entity, reason: "几何不是合法 JSON" });
      return;
    }
    const representative = representativePoint(geometry);
    if (!representative) {
      skipped.push({ ...entity, reason: `无法从 ${geometry?.type ?? "?"} 取代表点` });
      return;
    }
    const [x, y] = representative.point;
    const viewBox = viewBoxByCampus[campusKey];
    // 代表点必须落在底图范围内，否则几何本身就不属于这张图。
    if (x < viewBox.x - 1 || y < viewBox.y - 1
      || x > viewBox.x + viewBox.width + 1 || y > viewBox.y + viewBox.height + 1) {
      skipped.push({ ...entity, reason: `代表点 (${x.toFixed(1)}, ${y.toFixed(1)}) 落在 viewBox 外` });
      return;
    }
    const geo = applyGeoTransform(inverse[campusKey], x, y);
    const longitude = round7(geo.x);
    const latitude = round7(geo.y);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)
      || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
      skipped.push({ ...entity, reason: `逆变换结果越界 (${longitude}, ${latitude})` });
      return;
    }
    seenEntities.add(key);
    const suffix = hash(`${entity.entityType}:${entity.entityId}:navigation-rebuild`).slice(0, 24);
    inserts.push({
      entityType: entity.entityType,
      entityId: entity.entityId,
      campusCode: campusKey,
      campusId: entity.campusId,
      // buildings 表的 place 才能挂 building_place_id（触发器要求）。
      buildingPlaceId: entity.isBuilding ? entity.entityId : null,
      anchorId: `anchor_${suffix}`,
      bindingId: `eloc_${suffix}`,
      longitude,
      latitude,
      viewBoxPoint: [round1(x), round1(y)],
      method: representative.method,
      // 唯一索引 one_primary：每实体最多一个 is_primary=1。楼栋路径要求导航点
      // isPrimary===1 才出「导航到这里」，所以没被占用时一律取 1。
      isPrimary: primaryTaken.has(key) ? 0 : 1,
      accuracyMeters: accuracyOf(transforms[campusKey]),
      source: entity.source,
    });
  };

  for (const row of normalizeRows(input.footprints ?? [])) {
    addEntry({
      entityType: "place",
      entityId: field(row, "placeId", "place_id"),
      campusCode: field(row, "campusCode", "campus_code"),
      campusId: field(row, "campusId", "campus_id"),
      geometryJson: field(row, "geometryJson", "geometry_json"),
      isBuilding: true,
      source: `footprint:${field(row, "sourceElementId", "source_element_id") ?? "?"}`,
    });
  }
  for (const row of normalizeRows(input.canvasPoints ?? [])) {
    const entityType = field(row, "entityType", "entity_type");
    const entityId = field(row, "entityId", "entity_id");
    if (seenEntities.has(`${entityType}:${entityId}`)) continue; // 已由 footprint 覆盖
    addEntry({
      entityType,
      entityId,
      campusCode: field(row, "campusCode", "campus_code"),
      campusId: field(row, "campusId", "campus_id"),
      geometryJson: field(row, "geometryJson", "geometry_json"),
      isBuilding: false,
      source: `canvas:${field(row, "sourceRole", "source_role") ?? "?"}`,
    });
  }

  // structure_json：只有 place 需要，且只改该 place 的全部 revision。
  const insertByPlace = new Map(
    inserts.filter((item) => item.entityType === "place").map((item) => [item.entityId, item]),
  );
  const updates = [];
  const revisionSkipped = [];
  const seenRevisions = new Set();
  for (const raw of normalizeRows(input.revisions ?? [])) {
    const row = {
      revisionId: field(raw, "revisionId", "id"),
      placeId: field(raw, "placeId", "place_id"),
      displayName: field(raw, "displayName", "display_name"),
      summary: field(raw, "summary", "summary") ?? null,
      description: field(raw, "description", "description") ?? null,
      contentJson: field(raw, "contentJson", "content_json"),
      structureJson: field(raw, "structureJson", "structure_json"),
      contentHash: field(raw, "contentHash", "content_hash"),
    };
    if (!row.revisionId || seenRevisions.has(row.revisionId)) continue;
    seenRevisions.add(row.revisionId);
    const entry = insertByPlace.get(row.placeId);
    if (!entry) continue; // 这个 place 没有新导航点
    if (typeof row.structureJson !== "string" || typeof row.contentJson !== "string"
      || typeof row.displayName !== "string" || typeof row.contentHash !== "string") {
      revisionSkipped.push({ revisionId: row.revisionId, placeId: row.placeId, reason: "缺少哈希输入字段" });
      continue;
    }
    const currentHash = placeContentHash(row);
    if (currentHash !== row.contentHash) {
      revisionSkipped.push({
        revisionId: row.revisionId,
        placeId: row.placeId,
        reason: `现有 content_hash 与内容不自洽（算得 ${currentHash.slice(0, 12)}…，库里 ${row.contentHash.slice(0, 12)}…）`,
      });
      continue;
    }
    const rewritten = rewriteStructureJson(row.structureJson, entry);
    if (rewritten.noop) continue;
    if (!rewritten.ok) {
      revisionSkipped.push({ revisionId: row.revisionId, placeId: row.placeId, reason: rewritten.reason });
      continue;
    }
    updates.push({
      revisionId: row.revisionId,
      placeId: row.placeId,
      displayName: row.displayName,
      oldHash: row.contentHash,
      structureJson: rewritten.next,
      contentHash: placeContentHash({ ...row, structureJson: rewritten.next }),
    });
  }

  const byType = {};
  for (const item of inserts) byType[item.entityType] = (byType[item.entityType] ?? 0) + 1;
  const byMethod = {};
  for (const item of inserts) byMethod[item.method] = (byMethod[item.method] ?? 0) + 1;

  return {
    inserts,
    updates,
    skipped,
    revisionSkipped,
    existingNavCount,
    report: {
      inserts: inserts.length,
      byType,
      byMethod,
      primaryOne: inserts.filter((i) => i.isPrimary === 1).length,
      primaryZero: inserts.filter((i) => i.isPrimary === 0).length,
      revisions: updates.length,
      skipped: skipped.length,
      revisionSkipped: revisionSkipped.length,
    },
  };
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

/** 记录的精度：仿射不确定度与代表点误差里取大的那个量级，不假装比实际准。 */
function accuracyOf(record) {
  const uncertainty = record?.transformUncertaintyMeters?.p90;
  return Number.isFinite(uncertainty) ? Number(uncertainty.toFixed(1)) : null;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

export function renderRebuildSql(plan, { generatedAt = new Date().toISOString(), transforms } = {}) {
  if (plan.existingNavCount > 0) {
    throw new Error(
      `库里还有 ${plan.existingNavCount} 个 navigation_target。先跑清除（generate_navigation_purge.mjs），`
        + "否则唯一索引 one_active_navigation_target 会拒绝插入。",
    );
  }
  if (plan.skipped.length > 0) {
    const detail = plan.skipped.slice(0, 10)
      .map((item) => `${item.entityType}:${item.entityId}（${item.reason}）`).join("；");
    throw new Error(`有 ${plan.skipped.length} 个实体无法生成导航点：${detail}`);
  }
  if (plan.revisionSkipped.length > 0) {
    const detail = plan.revisionSkipped.slice(0, 10)
      .map((item) => `${item.revisionId}（${item.reason}）`).join("；");
    throw new Error(`有 ${plan.revisionSkipped.length} 条 revision 无法安全改写：${detail}`);
  }
  if (plan.inserts.length === 0) throw new Error("没有可重建的导航点");

  const uncertainty = Object.entries(transforms ?? {})
    .map(([key, value]) => `${key} p90 ${value.transformUncertaintyMeters?.p90 ?? "?"}m`)
    .join("、");

  const lines = [
    "-- 导航终点重建（已发布底图几何 → 新仿射参数逆变换 → GCJ-02）",
    `-- 由 scripts/generate_navigation_rebuild.mjs 生成于 ${generatedAt}。`,
    `-- 影响：${plan.report.inserts} 个实体 / ${plan.report.revisions} 条 revision。`,
    `-- 变换不确定度：${uncertainty}。代表点与主入口的差异另计，故 precision_level='${PRECISION_LEVEL}'。`,
    "-- 全部 insert or ignore + 以旧 content_hash 为前置条件的 update，可安全重跑。",
    `-- 执行：npx wrangler d1 execute shumap-v2 --remote --file=output/navigation-rebuild.sql`,
    "",
    "pragma foreign_keys = on;",
    "",
    "-- 0. 数据来源。",
    `insert or ignore into data_sources(id,source_type,title,reliability,metadata_json,created_at) values(${q(SOURCE_ID)},'derived','导航终点重建（已发布底图几何 + 校准器仿射参数）','unverified',${j({
      generator: "scripts/generate_navigation_rebuild.mjs",
      method: "representativePoint(map_features.geometry) → invertGeoTransform(data/geo-transform.json)",
      controlPoints: "data/geo-control-points.json",
      precisionLevel: PRECISION_LEVEL,
    })},${now});`,
    "",
    "-- 1. 锚点 + 绑定。",
  ];
  for (const item of plan.inserts) {
    lines.push(
      `-- ${item.entityType}:${item.entityId} ${item.campusCode} viewBox(${item.viewBoxPoint[0]}, ${item.viewBoxPoint[1]}) via ${item.method} ← ${item.source}`,
      `insert or ignore into location_anchors(id,campus_id,building_place_id,role,geometry_type,geometry_json,crs,precision_level,accuracy_meters,source_id,verification_status,created_at,updated_at) values(${q(item.anchorId)},${q(item.campusId)},${q(item.buildingPlaceId)},${q(ROLE)},'Point',${j({ type: "Point", coordinates: [item.longitude, item.latitude] })},'GCJ02',${q(PRECISION_LEVEL)},${item.accuracyMeters ?? "null"},${q(SOURCE_ID)},'unverified',${now},${now});`,
      `insert or ignore into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,created_at) values(${q(item.bindingId)},${q(item.entityType)},${q(item.entityId)},${q(item.anchorId)},${q(ROLE)},${item.isPrimary},${now});`,
    );
  }
  lines.push("", "-- 2. place_revisions.structure_json：插回导航点并重算 content_hash。");
  for (const item of plan.updates) {
    lines.push(
      `-- ${item.placeId} · ${item.displayName}`,
      `update place_revisions set structure_json=${q(item.structureJson)},content_hash=${q(item.contentHash)}`
        + ` where id=${q(item.revisionId)} and content_hash=${q(item.oldHash)};`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function printReport(plan) {
  const { report } = plan;
  console.log("\n=== 导航终点重建 dry-run ===");
  const types = Object.entries(report.byType).map(([t, n]) => `${t}×${n}`).join("、") || "无";
  console.log(`  待插入导航点：${report.inserts}（${types}）`);
  const methods = Object.entries(report.byMethod).map(([m, n]) => `${m}×${n}`).join("、");
  console.log(`  代表点取法：${methods}`);
  console.log(`  is_primary=1：${report.primaryOne}  is_primary=0：${report.primaryZero}`);
  console.log(`  待改写 revision：${report.revisions}`);
  console.log(`  库里现存导航点：${plan.existingNavCount}（必须为 0）`);
  if (plan.skipped.length > 0) {
    console.log(`  ⚠ 无法生成 ${plan.skipped.length} 个：`);
    for (const item of plan.skipped.slice(0, 20)) {
      console.log(`      ${item.entityType}:${item.entityId} — ${item.reason}`);
    }
  }
  if (plan.revisionSkipped.length > 0) {
    console.log(`  ⚠ 无法改写 ${plan.revisionSkipped.length} 条 revision：`);
    for (const item of plan.revisionSkipped.slice(0, 20)) {
      console.log(`      ${item.revisionId} — ${item.reason}`);
    }
  }
}

function readJsonArg(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const file = argv[index + 1];
  if (!file) throw new Error(`${flag} 需要一个文件路径`);
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

const QUERIES = {
  "--print-footprint-query": FOOTPRINT_QUERY,
  "--print-canvas-query": CANVAS_POINT_QUERY,
  "--print-primary-query": PRIMARY_TAKEN_QUERY,
  "--print-revision-query": REVISION_QUERY,
  "--print-existing-nav-query": EXISTING_NAV_QUERY,
};

async function main(argv) {
  for (const [flag, sql] of Object.entries(QUERIES)) {
    if (argv.includes(flag)) {
      process.stdout.write(sql);
      return 0;
    }
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`导航终点重建

先把五份查询结果取下来（--remote，本地库用 --local）：
  for f in footprint canvas primary revision existing-nav; do
    npx wrangler d1 execute shumap-v2 --remote --json \\
      --command="$(node scripts/generate_navigation_rebuild.mjs --print-\${f}-query)" \\
      > output/rebuild-\${f}.json
  done

生成 SQL（同时打印 dry-run 报告）：
  node scripts/generate_navigation_rebuild.mjs \\
    --footprints output/rebuild-footprint.json \\
    --canvas output/rebuild-canvas.json \\
    --primary output/rebuild-primary.json \\
    --revisions output/rebuild-revision.json \\
    --existing-nav output/rebuild-existing-nav.json

确认后执行：
  npx wrangler d1 execute shumap-v2 --remote --file=output/navigation-rebuild.sql
`);
    return 0;
  }

  const outIndex = argv.indexOf("--out");
  const output = outIndex === -1 ? DEFAULT_OUTPUT : path.resolve(argv[outIndex + 1]);
  const transforms = JSON.parse(fs.readFileSync(path.join(root, "data/geo-transform.json"), "utf8"));
  const publishedManifest = JSON.parse(
    fs.readFileSync(path.join(root, "data/published-maps/manifest.json"), "utf8"),
  );

  const plan = planNavigationRebuild({
    footprints: readJsonArg(argv, "--footprints") ?? [],
    canvasPoints: readJsonArg(argv, "--canvas") ?? [],
    primaryTaken: readJsonArg(argv, "--primary") ?? [],
    revisions: readJsonArg(argv, "--revisions") ?? [],
    existingNav: readJsonArg(argv, "--existing-nav") ?? [],
    transforms,
    publishedManifest,
  });
  printReport(plan);

  const sql = renderRebuildSql(plan, { transforms });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, sql, "utf8");
  console.log(`\n已写入 ${path.relative(root, output)}（${sql.split("\n").length} 行）`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`\n失败：${error.message}`);
      process.exit(1);
    },
  );
}
