#!/usr/bin/env node
// 存量导航终点清除：把随手标的 navigation_target 从库里删干净，
// 为「校准器重建仿射 → 重算导航点」腾出干净的起点。
//
// 为什么需要脚本而不是一条迁移：导航点存在两处，且其中一处的完整性由 sha256 保护。
//   1) 关系表 —— entity_locations + location_anchors，纯 delete，SQL 能表达；
//   2) place_revisions.structure_json.locations[] —— 管理端地点编辑器读的是这一份
//      （src/admin/pages/PlaceEditorPage.tsx:131），不是关系表。只删关系表的话，
//      编辑器里那一行还在，下次保存会把旧坐标原样写回去。
// 而 content_hash = sha256(displayName\nsummary\ndescription\ncontent_json\nstructure_json)
// （worker/modules/places.ts:83），改了 structure_json 就必须重算哈希，D1 的 SQL 里
// 没有 sha256，所以只能在 Node 里算好再生成 update。
//
// 两处并不是一一对应的，远端实测（2026-08-14）：
//   * 124 个 nav 锚点：122 place + 1 facility + 1 transit_stop；
//   * 124 条 place_revisions 的 structure_json 含 nav（121 条当前版本 + 3 条历史版本）；
//   * facility_revisions / merchant_revisions 里 0 条含 nav，transit_stops 没有修订表。
// 所以按两个独立集合处理：锚点/绑定按实体全删；structure_json 只有 place 需要重写。
// 「有锚点但 structure_json 没有」是正常情形（非 place 实体、回填生成的点），
// 归入 relationalOnly 而不是错误。
//
// 用法：
//   1) 三条查询各取一次（--json 输出）：
//        npx wrangler d1 execute shumap-v2 --remote --json \
//          --command="$(node scripts/generate_navigation_purge.mjs --print-anchor-query)" \
//          > output/purge-anchors.json
//        npx wrangler d1 execute shumap-v2 --remote --json \
//          --command="$(node scripts/generate_navigation_purge.mjs --print-revision-query)" \
//          > output/purge-revisions.json
//        npx wrangler d1 execute shumap-v2 --remote --json \
//          --command="$(node scripts/generate_navigation_purge.mjs --print-guard-query)" \
//          > output/purge-guards.json
//      本地库把 --remote 换成 --local。
//   2) 生成 SQL（同时打印 dry-run 报告，此时不写库）：
//        node scripts/generate_navigation_purge.mjs \
//          --anchors output/purge-anchors.json \
//          --revisions output/purge-revisions.json \
//          --guards output/purge-guards.json
//   3) 核对报告无误后执行：
//        npx wrangler d1 execute shumap-v2 --remote --file=output/navigation-purge.sql
//
// 安全性：每条 update 都用旧 content_hash 做前置条件，每条 delete 都带 role 限定。
// 库里的行如果和生成 SQL 时看到的不一致，那条语句自然匹配 0 行而不是改坏数据，
// 因此可以安全重跑。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = path.join(root, "output/navigation-purge.sql");

export const ROLE = "navigation_target";

/** 全部 nav 锚点 + 绑定，不限实体类型。 */
export const ANCHOR_QUERY = `select el.id as bindingId,
       el.anchor_id as anchorId,
       el.entity_type as entityType,
       el.entity_id as entityId,
       la.source_id as sourceId
  from entity_locations el
  join location_anchors la on la.id = el.anchor_id
 where el.role='${ROLE}'
 order by el.entity_type, el.entity_id, el.id;`;

/**
 * structure_json 里含 nav 的 place 修订（含哈希输入全字段）。
 * 用 like 预筛，真正的判定在 rewriteStructureJson 里按 role 精确做。
 * 历史版本也要改：它们是 based_on 的源，留着会在下次基于旧版建新修订时复活。
 */
export const REVISION_QUERY = `select r.id as revisionId,
       r.place_id as placeId,
       r.display_name as displayName,
       r.summary as summary,
       r.description as description,
       r.content_json as contentJson,
       r.structure_json as structureJson,
       r.content_hash as contentHash
  from place_revisions r
 where r.structure_json like '%${ROLE}%'
 order by r.place_id, r.id;`;

/**
 * 守卫：facility / merchant 的修订表里若也存了 nav，本脚本不处理（哈希公式不同），
 * 必须先确认处置方式。远端实测两者都是 0。
 */
export const GUARD_QUERY = `select
  (select count(*) from facility_revisions where structure_json like '%${ROLE}%') as facilityRevisionNav,
  (select count(*) from merchant_revisions where structure_json like '%${ROLE}%') as merchantRevisionNav;`;

const sha256 = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex");
const q = (value) =>
  value === null || value === undefined ? "null" : `'${String(value).replaceAll("'", "''")}'`;

/** wrangler --json 的包装有三种形态，都归一成裸行数组。 */
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

const field = (row, camel, snake) => (row[camel] !== undefined ? row[camel] : row[snake]);

/**
 * 重算 content_hash。必须与 worker/modules/places.ts:83 逐字一致：
 * sha256(displayName\nsummary\ndescription\ncontentJson\nstructureJson)，
 * null 的 summary / description 参与拼接时是空串。
 */
export function placeContentHash({ displayName, summary, description, contentJson, structureJson }) {
  return sha256(
    `${displayName}\n${summary ?? ""}\n${description ?? ""}\n${contentJson}\n${structureJson}`,
  );
}

/**
 * 从 structure_json 里摘掉 navigation_target。
 *
 * 先做一次 parse→stringify 的往返自检：只有原文与重新序列化完全一致时才动手。
 * 不一致说明库里的文本有本脚本无法忠实复现的写法（浮点记法、键序、转义差异），
 * 这时候重写会连带改动与导航点无关的字节，一律跳过交给人看。
 */
export function rewriteStructureJson(structureJson) {
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
  const kept = parsed.locations.filter((item) => !(item && typeof item === "object" && item.role === ROLE));
  const removed = parsed.locations.length - kept.length;
  // like 预筛会命中 "navigation_target" 出现在别处的情况（如 locationHint 文本）。
  // 那种修订不需要改，归入 noop 而不是错误。
  if (removed === 0) return { ok: false, noop: true, reason: "locations 里没有导航终点（like 误命中）" };
  return { ok: true, removed, next: JSON.stringify({ ...parsed, locations: kept }) };
}

/**
 * 生成计划。
 * @param {{ anchors?:unknown, revisions?:unknown, guards?:unknown }} input
 */
export function planNavigationPurge(input = {}) {
  const anchorRows = normalizeRows(input.anchors ?? []).map((row) => ({
    bindingId: field(row, "bindingId", "id"),
    anchorId: field(row, "anchorId", "anchor_id"),
    entityType: field(row, "entityType", "entity_type"),
    entityId: field(row, "entityId", "entity_id"),
    sourceId: field(row, "sourceId", "source_id") ?? null,
  }));
  const revisionRows = normalizeRows(input.revisions ?? []).map((row) => ({
    revisionId: field(row, "revisionId", "id"),
    placeId: field(row, "placeId", "place_id"),
    displayName: field(row, "displayName", "display_name"),
    summary: field(row, "summary", "summary") ?? null,
    description: field(row, "description", "description") ?? null,
    contentJson: field(row, "contentJson", "content_json"),
    structureJson: field(row, "structureJson", "structure_json"),
    contentHash: field(row, "contentHash", "content_hash"),
  }));
  const guardRows = normalizeRows(input.guards ?? []);

  const updates = [];
  const skipped = [];
  const noops = [];
  const seenRevisions = new Set();

  for (const row of revisionRows) {
    if (!row.revisionId || seenRevisions.has(row.revisionId)) continue;
    seenRevisions.add(row.revisionId);
    if (typeof row.structureJson !== "string" || typeof row.contentJson !== "string") {
      skipped.push({ revisionId: row.revisionId, placeId: row.placeId, reason: "缺少 content_json 或 structure_json" });
      continue;
    }
    if (typeof row.displayName !== "string" || typeof row.contentHash !== "string") {
      skipped.push({ revisionId: row.revisionId, placeId: row.placeId, reason: "缺少 display_name 或 content_hash" });
      continue;
    }
    // 先验证库里的哈希与现有内容自洽。不自洽说明哈希公式或数据已经漂了，
    // 此时用同一公式算出的新哈希也是错的，必须停手。
    const currentHash = placeContentHash(row);
    if (currentHash !== row.contentHash) {
      skipped.push({
        revisionId: row.revisionId,
        placeId: row.placeId,
        reason: `现有 content_hash 与内容不自洽（算得 ${currentHash.slice(0, 12)}…，库里 ${row.contentHash.slice(0, 12)}…）`,
      });
      continue;
    }
    const rewritten = rewriteStructureJson(row.structureJson);
    if (rewritten.noop) {
      noops.push({ revisionId: row.revisionId, placeId: row.placeId, reason: rewritten.reason });
      continue;
    }
    if (!rewritten.ok) {
      skipped.push({ revisionId: row.revisionId, placeId: row.placeId, reason: rewritten.reason });
      continue;
    }
    updates.push({
      revisionId: row.revisionId,
      placeId: row.placeId,
      displayName: row.displayName,
      removedLocations: rewritten.removed,
      oldHash: row.contentHash,
      structureJson: rewritten.next,
      contentHash: placeContentHash({ ...row, structureJson: rewritten.next }),
    });
  }

  // 锚点按 anchorId 去重（同一锚点理论上只有一条绑定，但去重让重复输入无害）。
  const anchors = new Map();
  for (const row of anchorRows) {
    if (!row.anchorId) continue;
    anchors.set(row.anchorId, row);
  }
  const deletes = [...anchors.values()];

  // 有 structure_json 副本的 place 集合；不在其中的锚点是「只删关系表」。
  const placesWithStructureNav = new Set(updates.map((item) => item.placeId));
  const relationalOnly = deletes.filter(
    (item) => item.entityType !== "place" || !placesWithStructureNav.has(item.entityId),
  );

  const guards = guardRows[0] ?? null;
  const guardFailures = [];
  if (guards) {
    const facility = Number(field(guards, "facilityRevisionNav", "facility_revision_nav") ?? 0);
    const merchant = Number(field(guards, "merchantRevisionNav", "merchant_revision_nav") ?? 0);
    if (facility > 0) guardFailures.push(`facility_revisions 有 ${facility} 条 structure_json 含导航终点`);
    if (merchant > 0) guardFailures.push(`merchant_revisions 有 ${merchant} 条 structure_json 含导航终点`);
  }

  const byType = {};
  for (const item of deletes) byType[item.entityType] = (byType[item.entityType] ?? 0) + 1;

  return {
    updates,
    deletes,
    relationalOnly,
    skipped,
    noops,
    guardFailures,
    guardsProvided: guards !== null,
    report: {
      anchors: deletes.length,
      anchorsByType: byType,
      revisionsSeen: seenRevisions.size,
      rewritten: updates.length,
      places: placesWithStructureNav.size,
      relationalOnly: relationalOnly.length,
      skipped: skipped.length,
      noops: noops.length,
    },
  };
}

/** 渲染 SQL。有跳过项、守卫未通过、或没提供守卫输入时抛错，不出半成品。 */
export function renderPurgeSql(plan, { generatedAt = new Date().toISOString() } = {}) {
  if (!plan.guardsProvided) {
    throw new Error(
      "缺少守卫输入（--guards）。必须先确认 facility_revisions / merchant_revisions 里没有导航终点副本，"
        + "否则删了关系表而它们的 structure_json 还留着，编辑器一保存就复活。",
    );
  }
  if (plan.guardFailures.length > 0) {
    throw new Error(
      `守卫未通过：${plan.guardFailures.join("；")}。这些表的哈希公式与 place 不同，本脚本不处理。`,
    );
  }
  if (plan.skipped.length > 0) {
    const detail = plan.skipped.map((item) => `${item.revisionId}（${item.reason}）`).join("；");
    throw new Error(`有 ${plan.skipped.length} 条 revision 无法安全重写：${detail}`);
  }
  if (plan.updates.length === 0 && plan.deletes.length === 0) {
    throw new Error("没有可清除的导航终点");
  }

  const typeSummary = Object.entries(plan.report.anchorsByType)
    .map(([type, n]) => `${type}×${n}`)
    .join("、");
  const lines = [
    "-- 存量导航终点清除（关系表 delete + structure_json 重写 + content_hash 重算）",
    `-- 由 scripts/generate_navigation_purge.mjs 生成于 ${generatedAt}。`,
    `-- 锚点/绑定：${plan.deletes.length} 个（${typeSummary}）。`,
    `-- structure_json：重写 ${plan.updates.length} 条 revision（覆盖 ${plan.report.places} 个地点）。`,
    `-- 其中 ${plan.relationalOnly.length} 个锚点没有 structure_json 副本（非 place 实体或回填生成），只删关系表。`,
    "-- 每条 update 以旧 content_hash 为前置条件，每条 delete 带 role 限定，可安全重跑。",
    "-- 执行：npx wrangler d1 execute shumap-v2 --remote --file=output/navigation-purge.sql",
    "",
    "pragma foreign_keys = on;",
    "",
    "-- 1. 关系表：先删绑定再删锚点（entity_locations.anchor_id 是 on delete cascade，",
    "--    显式先删绑定是为了让每条语句都带 role 限定，避免误删同锚点的其他角色绑定）。",
  ];
  for (const item of plan.deletes) {
    if (item.bindingId) {
      lines.push(
        `delete from entity_locations where id=${q(item.bindingId)} and role=${q(ROLE)};`,
      );
    }
    lines.push(`delete from location_anchors where id=${q(item.anchorId)} and role=${q(ROLE)};`);
  }
  lines.push("", "-- 2. place_revisions.structure_json：摘掉导航终点并重算 content_hash。");
  for (const item of plan.updates) {
    lines.push(
      `-- ${item.placeId} · ${item.displayName}（移除 ${item.removedLocations} 处导航终点）`,
      `update place_revisions set structure_json=${q(item.structureJson)},content_hash=${q(item.contentHash)}`
        + ` where id=${q(item.revisionId)} and content_hash=${q(item.oldHash)};`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function printReport(plan) {
  const { report } = plan;
  console.log("\n=== 导航终点清除 dry-run ===");
  const types = Object.entries(report.anchorsByType).map(([t, n]) => `${t}×${n}`).join("、") || "无";
  console.log(`  待删锚点/绑定：${report.anchors}（${types}）`);
  console.log(`  待重写 revision：${report.rewritten} / ${report.revisionsSeen}（覆盖 ${report.places} 个地点）`);
  console.log(`  只删关系表（无 structure_json 副本）：${report.relationalOnly}`);
  for (const item of plan.relationalOnly) {
    console.log(`      ${item.entityType} ${item.entityId}  source=${item.sourceId ?? "?"}`);
  }
  if (report.noops > 0) {
    console.log(`  like 误命中、无需改动：${report.noops}`);
  }
  if (!plan.guardsProvided) console.log("  ⚠ 未提供守卫输入（--guards），不会出 SQL");
  for (const failure of plan.guardFailures) console.log(`  ⚠ 守卫未通过：${failure}`);
  if (plan.skipped.length > 0) {
    console.log(`  ⚠ 跳过 ${plan.skipped.length} 条：`);
    for (const item of plan.skipped.slice(0, 20)) {
      console.log(`      ${item.revisionId} — ${item.reason}`);
    }
    if (plan.skipped.length > 20) console.log(`      …其余 ${plan.skipped.length - 20} 条略`);
  }
}

function readJsonArg(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const file = argv[index + 1];
  if (!file) throw new Error(`${flag} 需要一个文件路径`);
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

async function main(argv) {
  if (argv.includes("--print-anchor-query")) {
    process.stdout.write(ANCHOR_QUERY);
    return 0;
  }
  if (argv.includes("--print-revision-query")) {
    process.stdout.write(REVISION_QUERY);
    return 0;
  }
  if (argv.includes("--print-guard-query")) {
    process.stdout.write(GUARD_QUERY);
    return 0;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 45).join("\n"));
    return 0;
  }

  const outIndex = argv.indexOf("--out");
  const output = outIndex === -1 ? DEFAULT_OUTPUT : path.resolve(argv[outIndex + 1]);
  const plan = planNavigationPurge({
    anchors: readJsonArg(argv, "--anchors") ?? [],
    revisions: readJsonArg(argv, "--revisions") ?? [],
    guards: readJsonArg(argv, "--guards"),
  });
  printReport(plan);

  const sql = renderPurgeSql(plan);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, sql, "utf8");
  console.log(`\n已写入 ${path.relative(root, output)}（${sql.split("\n").length} 行）`);
  console.log(`执行：npx wrangler d1 execute shumap-v2 --remote --file=${path.relative(root, output)}`);
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
