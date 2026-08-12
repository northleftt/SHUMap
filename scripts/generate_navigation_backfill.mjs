#!/usr/bin/env node
// 存量点位导航坐标回填：把画布上画的 svg_viewbox Point 锚点仿射逆变换成 GCJ02，
// 为尚无 navigation_target 的实体生成 location_anchors + entity_locations 的 insert or ignore SQL。
//
// 用法：
//   1) 先用 wrangler 把存量绑定/锚点查出来（--json 输出）：
//        npx wrangler d1 execute shumap-v2 --remote --json \
//          --command="$(node scripts/generate_navigation_backfill.mjs --print-query)" \
//          > output/navigation-backfill-input.json
//   2) 生成回填 SQL（控制台同时打印 dry-run 报告，此时不写库）：
//        node scripts/generate_navigation_backfill.mjs output/navigation-backfill-input.json
//      也可从 stdin 喂入：cat input.json | node scripts/generate_navigation_backfill.mjs
//   3) 确认报告无误后执行：
//        npx wrangler d1 execute shumap-v2 --remote --file=output/navigation-backfill.sql
//
// 输入 JSON 兼容三种形态：wrangler --json 的 [{results:[...]}]、单个 {results:[...]}、
// 或直接就是行数组。行字段以 --print-query 打印的查询别名（camelCase）为准，
// 同时兼容 snake_case 列名。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyGeoTransform, invertGeoTransform } from "../shared/geo-transform.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = path.join(root, "output/navigation-backfill.sql");

export const ENTITY_TYPES = ["place", "facility", "merchant_outlet", "transit_stop"];
export const SOURCE_ID = "source_navigation_backfill_affine_v1";
// location_anchors.precision_level 枚举：('campus','building','floor','space','exact','unknown')。
// 仿射回填残差约 10–17m（见 data/geo-transform.json meanResidualMeters），取 'building'。
export const PRECISION_LEVEL = "building";

// 配套查询：拉出四类实体的全部绑定+锚点，由本脚本在内存里分组判定，
// 这样 dry-run 报告能区分"已有导航点 / 无画布点 / 无校区"等各种情形。
export const COMPANION_QUERY = `select el.entity_type as entityType,
       el.entity_id as entityId,
       el.valid_to as bindingValidTo,
       la.id as anchorId,
       la.role as anchorRole,
       la.crs as crs,
       la.geometry_type as geometryType,
       la.geometry_json as geometryJson,
       la.campus_id as campusId,
       la.valid_to as anchorValidTo
  from entity_locations el
  join location_anchors la on la.id = el.anchor_id
 where el.entity_type in ('place','facility','merchant_outlet','transit_stop');`;

// 同一实体有多个画布点时的取舍顺序，其余角色排最后，再按 anchorId 保证确定性。
const ROLE_PRIORITY = new Map(
  ["main_entrance", "centroid", "primary_display", "service_position"].map((role, index) => [role, index]),
);

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const q = (value) => value === null || value === undefined ? "null" : `'${String(value).replaceAll("'", "''")}'`;
const j = (value) => q(JSON.stringify(value));
const now = "datetime('now')";
const round7 = (value) => Number(value.toFixed(7));

/** 解析输入 JSON：兼容 wrangler --json 包装、单结果集、裸行数组。 */
export function normalizeRows(payload) {
  if (Array.isArray(payload)) {
    // wrangler --json：[{ results: [...], success, meta }, ...]；也可能直接是行数组。
    if (payload.every((entry) => entry && typeof entry === "object" && Array.isArray(entry.results))) {
      return payload.flatMap((entry) => entry.results);
    }
    return payload;
  }
  if (payload && typeof payload === "object" && Array.isArray(payload.results)) return payload.results;
  throw new Error("Unrecognized input JSON shape: expected [{results:[...]}], {results:[...]}, or a row array");
}

const field = (row, ...names) => {
  for (const name of names) {
    if (row[name] !== undefined) return row[name];
  }
  return null;
};

function parseViewboxPoint(geometryJson) {
  if (geometryJson === null || geometryJson === undefined) return null;
  let geometry = geometryJson;
  if (typeof geometryJson === "string") {
    try {
      geometry = JSON.parse(geometryJson);
    } catch {
      return null;
    }
  }
  const coordinates = geometry?.coordinates;
  if (geometry?.type !== "Point" || !Array.isArray(coordinates) || coordinates.length !== 2) return null;
  const [x, y] = coordinates;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/** campusId（'campus_baoshan'）→ geo-transform.json 的 key（'baoshan'）。 */
function campusKeyOf(campusId, campusKeys) {
  if (typeof campusId !== "string" || !campusId) return null;
  if (campusKeys.has(campusId)) return campusId;
  const stripped = campusId.replace(/^campus_/, "");
  return campusKeys.has(stripped) ? stripped : null;
}

const emptyBucket = () => ({
  backfilled: 0,
  skippedExistingNavigation: 0,
  errorNoViewboxPoint: 0,
  errorNoCampus: 0,
  errorInvalidGeometry: 0,
  errorOutOfRange: 0,
});

/**
 * 纯逻辑：对查询行分组判定，产出回填计划与 dry-run 报告。
 * geoTransforms 为 data/geo-transform.json 解析结果（{key: {transform, meanResidualMeters, ...}}）。
 */
export function planNavigationBackfill(rows, geoTransforms) {
  const campusKeys = new Set(Object.keys(geoTransforms));
  const entities = new Map(); // `${entityType}${entityId}` → { entityType, entityId, hasNavigation, candidates[] }
  const report = {};
  for (const type of ENTITY_TYPES) report[type] = emptyBucket();
  const anomalies = [];

  for (const row of rows) {
    const entityType = field(row, "entityType", "entity_type");
    const entityId = field(row, "entityId", "entity_id");
    if (!ENTITY_TYPES.includes(entityType) || typeof entityId !== "string" || !entityId) continue;
    if (field(row, "bindingValidTo", "binding_valid_to") || field(row, "anchorValidTo", "anchor_valid_to")) continue;

    const key = `${entityType}${entityId}`;
    if (!entities.has(key)) {
      entities.set(key, { entityType, entityId, hasNavigation: false, candidates: [] });
    }
    const entity = entities.get(key);
    const anchorRole = field(row, "anchorRole", "anchor_role");
    if (anchorRole === "navigation_target") {
      entity.hasNavigation = true;
      continue;
    }
    if (field(row, "crs") !== "svg_viewbox" || field(row, "geometryType", "geometry_type") !== "Point") continue;
    entity.candidates.push({
      anchorId: field(row, "anchorId", "anchor_id"),
      anchorRole,
      campusId: field(row, "campusId", "campus_id"),
      point: parseViewboxPoint(field(row, "geometryJson", "geometry_json")),
    });
  }

  const inserts = [];
  for (const entity of [...entities.values()].sort((a, b) => `${a.entityType}:${a.entityId}`.localeCompare(`${b.entityType}:${b.entityId}`))) {
    const bucket = report[entity.entityType];
    const label = `${entity.entityType}/${entity.entityId}`;
    if (entity.hasNavigation) {
      bucket.skippedExistingNavigation += 1;
      continue;
    }
    if (entity.candidates.length === 0) {
      bucket.errorNoViewboxPoint += 1;
      anomalies.push(`${label}: 无 svg_viewbox Point 锚点`);
      continue;
    }
    const usable = entity.candidates.filter((candidate) => candidate.point !== null);
    if (usable.length === 0) {
      bucket.errorInvalidGeometry += 1;
      anomalies.push(`${label}: svg_viewbox 锚点 geometry_json 无法解析为 Point`);
      continue;
    }
    usable.sort((a, b) =>
      (ROLE_PRIORITY.get(a.anchorRole) ?? ROLE_PRIORITY.size) - (ROLE_PRIORITY.get(b.anchorRole) ?? ROLE_PRIORITY.size)
      || String(a.anchorId).localeCompare(String(b.anchorId)));
    const chosen = usable[0];
    const campusKey = campusKeyOf(chosen.campusId, campusKeys);
    if (!campusKey) {
      bucket.errorNoCampus += 1;
      anomalies.push(`${label}: 锚点 ${chosen.anchorId} 无校区或校区未知（campus_id=${chosen.campusId ?? "null"}）`);
      continue;
    }
    const campus = geoTransforms[campusKey];
    const inverse = invertGeoTransform(campus.transform);
    const gcj = applyGeoTransform(inverse, chosen.point.x, chosen.point.y);
    const longitude = round7(gcj.x);
    const latitude = round7(gcj.y);
    if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
      bucket.errorOutOfRange += 1;
      anomalies.push(`${label}: 逆变换结果越界（${longitude}, ${latitude}），变换参数或源坐标存疑`);
      continue;
    }
    const idKey = `${entity.entityType}:${entity.entityId}:navigation`;
    inserts.push({
      entityType: entity.entityType,
      entityId: entity.entityId,
      campusId: chosen.campusId,
      anchorId: `anchor_${hash(idKey).slice(0, 24)}`,
      bindingId: `eloc_${hash(idKey).slice(0, 24)}`,
      longitude,
      latitude,
      accuracyMeters: Number.isFinite(campus.meanResidualMeters) ? Number(campus.meanResidualMeters.toFixed(1)) : null,
      sourceAnchorId: chosen.anchorId,
    });
    bucket.backfilled += 1;
  }
  return { inserts, report, anomalies };
}

/** 把回填计划渲染成可执行 SQL（insert or ignore，幂等可重跑）。 */
export function renderBackfillSql(plan) {
  const lines = [
    "-- 存量点位导航坐标回填（svg_viewbox 画布点 → GCJ02，仿射逆变换）",
    `-- 由 scripts/generate_navigation_backfill.mjs 生成于 ${new Date().toISOString()}，共 ${plan.inserts.length} 条。`,
    "-- 变换参数：data/geo-transform.json（baoshan/jiading/yanchang），invertGeoTransform 求逆。",
    "-- 全部 insert or ignore，可安全重跑；已有 navigation_target 的实体不在本文件内。",
    "-- 执行：npx wrangler d1 execute shumap-v2 --remote --file=output/navigation-backfill.sql",
    "--",
    "-- 配套查询（先生成输入 JSON）：",
    ...COMPANION_QUERY.split("\n").map((line) => `--   ${line}`),
    "",
    `insert or ignore into data_sources(id,source_type,title,reliability,metadata_json,created_at) values(${q(SOURCE_ID)},'derived',${q("存量画布点位导航坐标仿射回填（svg_viewbox → GCJ02）")},'unverified',${j({ generator: "scripts/generate_navigation_backfill.mjs", method: "invertGeoTransform(data/geo-transform.json)", precisionLevel: PRECISION_LEVEL })},${now});`,
  ];
  for (const insert of plan.inserts) {
    lines.push(
      `insert or ignore into location_anchors(id,campus_id,building_place_id,role,geometry_type,geometry_json,crs,precision_level,accuracy_meters,source_id,verification_status,created_at,updated_at) values(${q(insert.anchorId)},${q(insert.campusId)},null,'navigation_target','Point',${j({ type: "Point", coordinates: [insert.longitude, insert.latitude] })},'GCJ02',${q(PRECISION_LEVEL)},${insert.accuracyMeters ?? "null"},${q(SOURCE_ID)},'unverified',${now},${now});`,
      // is_primary=0：回填对象已经有一个主位置（画布图钉本身），导航终点只是
      // 补充的导航链接。entity_locations 有唯一部分索引
      //   unique(entity_type, entity_id) where is_primary = 1，
      // 再写 1 会被 insert or ignore 静默吞掉，只剩一个孤立的锚点。
      // 楼宇（buildMapBuildings 需要 navigation_target isPrimary=1）没有画布 Point，
      // 不在回填候选内，所以这里恒写 0 不会漏掉楼宇导航。
      `insert or ignore into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,created_at) values(${q(insert.bindingId)},${q(insert.entityType)},${q(insert.entityId)},${q(insert.anchorId)},'navigation_target',0,${now});`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function formatReport(report, anomalies) {
  const lines = ["== 导航坐标回填 dry-run 报告（未写库）=="];
  for (const type of ENTITY_TYPES) {
    const bucket = report[type];
    lines.push(
      `${type.padEnd(15)} 回填 ${bucket.backfilled}`
      + `，跳过(已有导航点) ${bucket.skippedExistingNavigation}`
      + `，异常(无画布点) ${bucket.errorNoViewboxPoint}`
      + `，异常(无校区) ${bucket.errorNoCampus}`
      + `，异常(几何非法) ${bucket.errorInvalidGeometry}`
      + `，异常(坐标越界) ${bucket.errorOutOfRange}`,
    );
  }
  if (anomalies.length > 0) {
    lines.push("-- 异常明细 --", ...anomalies.map((anomaly) => `  ${anomaly}`));
  }
  return lines.join("\n");
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

async function main(argv) {
  const args = argv.slice(2);
  if (args.includes("--print-query")) {
    process.stdout.write(`${COMPANION_QUERY}\n`);
    return;
  }
  let outputPath = DEFAULT_OUTPUT;
  const outputIndex = args.indexOf("--output");
  if (outputIndex !== -1) {
    outputPath = path.resolve(args[outputIndex + 1]);
    args.splice(outputIndex, 2);
  }
  const inputPath = args[0];
  let raw;
  if (inputPath && inputPath !== "-") {
    raw = fs.readFileSync(path.resolve(inputPath), "utf8");
  } else if (!process.stdin.isTTY) {
    raw = await readStdin();
  } else {
    process.stderr.write(
      `缺少输入。先跑查询：\n  npx wrangler d1 execute shumap-v2 --remote --json --command="$(node scripts/generate_navigation_backfill.mjs --print-query)" > output/navigation-backfill-input.json\n再跑：node scripts/generate_navigation_backfill.mjs output/navigation-backfill-input.json\n`,
    );
    process.exitCode = 1;
    return;
  }
  const rows = normalizeRows(JSON.parse(raw));
  const geoTransforms = JSON.parse(fs.readFileSync(path.join(root, "data/geo-transform.json"), "utf8"));
  const plan = planNavigationBackfill(rows, geoTransforms);
  process.stdout.write(`${formatReport(plan.report, plan.anomalies)}\n`);
  if (plan.inserts.length === 0) {
    process.stdout.write("无可回填记录，未生成 SQL 文件。\n");
    return;
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, renderBackfillSql(plan));
  process.stdout.write(`已生成 ${path.relative(root, outputPath)}（${plan.inserts.length} 条锚点 + 绑定 + 1 条 data_source）。\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv).catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
