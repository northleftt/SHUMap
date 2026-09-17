#!/usr/bin/env node
// audit_legacy_floor_data.mjs — 盘查楼内平面图旧链路（SVG 导入）的遗留数据。
//
// 只读：全部是 SELECT，不写库、不碰 R2。给 0032/0033/0034 迁移上线前后的盘点用。
//
// 用法（在有 Cloudflare 凭证的机器上，仓库根目录）：
//   node scripts/audit_legacy_floor_data.mjs            # 线上库（--remote）
//   node scripts/audit_legacy_floor_data.mjs --local    # 本地 dev 库
//   node scripts/audit_legacy_floor_data.mjs --db 别的库名
//
// 输出：每一类旧数据的行数与明细（量大的只打前 20 行），末尾汇总。

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const local = args.includes("--local");
const dbFlag = args.indexOf("--db");
const db = dbFlag >= 0 ? args[dbFlag + 1] : "shumap-v2";

/** 跑一条只读 SQL，返回行数组。 */
function query(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", db, local ? "--local" : "--remote", "--json", "--command", sql],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  // wrangler 可能往 stdout 打横幅（agent skills 提示等），JSON 从第一个 '[' 开始。
  const start = out.indexOf("[");
  const parsed = JSON.parse(start >= 0 ? out.slice(start) : out);
  // wrangler --json 输出 [{ results: [...], ... }]
  return Array.isArray(parsed) ? parsed.flatMap((chunk) => chunk.results ?? []) : [];
}

function section(title, rows, { limit = 20 } = {}) {
  console.log(`\n== ${title}: ${rows.length} 行 ==`);
  for (const row of rows.slice(0, limit)) console.log("  " + JSON.stringify(row));
  if (rows.length > limit) console.log(`  … 其余 ${rows.length - limit} 行从略`);
  return rows.length;
}

const floorsSchema = query("select sql from sqlite_master where type='table' and name='floors'")[0]?.sql ?? "";
const hasImageColumn = floorsSchema.includes("image_media_id");
const applied = query("select name from d1_migrations order by name").map((row) => row.name);

console.log(`库: ${db} (${local ? "local" : "remote"})`);
console.log(`迁移状态: 0032_floor_plan_image ${applied.includes("0032_floor_plan_image.sql") ? "已应用" : "未应用"}，0033_legacy_floor_data_purge ${applied.includes("0033_legacy_floor_data_purge.sql") ? "已应用（楼层 SVG 与测试楼层已清除）" : "未应用"}，0034_indoor_spaces_drop ${applied.includes("0034_indoor_spaces_drop.sql") ? "已应用（indoor_spaces 已删表）" : "未应用"}`);

const summary = {};

// ── floors：新方案继续用的骨架，不算垃圾，但要知道哪些层还没图 ─────────────
summary.floors = section(
  "floors（楼层骨架，保留）",
  query(
    `select f.id,f.level_code as levelCode,f.display_name as displayName,f.lifecycle_status as status,
            p.campus_id as campusId,coalesce(r.display_name,f.building_place_id) as building
            ${hasImageColumn ? ",(f.image_media_id is not null) as hasImage" : ",0 as hasImage"}
       from floors f join places p on p.id=f.building_place_id
       left join place_revisions r on r.id=p.current_revision_id
      order by p.campus_id,building,f.level_order`,
  ),
);

// ── 旧链路主目标：楼层 SVG 图纸 ──────────────────────────────────────────
summary.floorMapVersions = section(
  "map_versions.floor_id 非空（楼层 SVG 图纸，0033 删除对象）",
  query(
    `select mv.id,mv.lifecycle_status as status,mv.version_label as label,mv.created_at as createdAt,
            f.level_code as levelCode,coalesce(r.display_name,f.building_place_id) as building,
            (select count(*) from map_features mf where mf.map_version_id=mv.id) as featureCount,
            (select count(*) from release_map_versions rmv where rmv.map_version_id=mv.id) as releaseRefs,
            (select count(*) from location_anchors la where la.map_version_id=mv.id) as anchorRefs
       from map_versions mv join floors f on f.id=mv.floor_id
       join places p on p.id=f.building_place_id
       left join place_revisions r on r.id=p.current_revision_id
      order by mv.created_at`,
  ),
);

summary.floorMapAssets = section(
  "map_assets(floor_svg/floor_image) 与 media_assets（R2 对象键在这里）",
  query(
    `select ma.id as mapAssetId,ma.asset_type as assetType,me.id as mediaId,
            me.object_key as objectKey,me.byte_size as byteSize,me.status
       from map_assets ma join media_assets me on me.id=ma.media_asset_id
      where ma.asset_type in ('floor_svg','floor_image')`,
  ),
);

summary.floorImportJobs = section(
  "jobs(floor_import) 任务记录（0033 删除对象）",
  query("select id,status,created_at as createdAt,substr(payload_json,1,120) as payload from jobs where job_type='floor_import'"),
);

// ── indoor_spaces：0034 已删表，之后这些查询会报 no such table，直接跳过 ──
const indoorSpacesDropped = applied.includes("0034_indoor_spaces_drop.sql");
if (indoorSpacesDropped) {
  console.log("\n== indoor_spaces：0034 已删表（含三张表的 indoor_space_id 列），跳过 ==");
  summary.indoorSpaces = 0;
  summary.spaceRefs = 0;
} else {
  summary.indoorSpaces = section(
    "indoor_spaces（楼内空间，0034 删除对象）",
    query(
      `select s.id,s.space_type as type,s.display_name as displayName,s.lifecycle_status as status,
              f.level_code as levelCode,coalesce(r.display_name,f.building_place_id) as building
         from indoor_spaces s join floors f on f.id=s.floor_id
         join places p on p.id=f.building_place_id
         left join place_revisions r on r.id=p.current_revision_id
        order by building,f.level_order,s.display_name`,
    ),
  );

  summary.spaceRefs = section(
    "indoor_space_id 引用计数（设施/商户/锚点）",
    query(
      `select (select count(*) from facility_instances where indoor_space_id is not null) as facilities,
              (select count(*) from merchant_outlets where indoor_space_id is not null) as merchants,
              (select count(*) from location_anchors where indoor_space_id is not null) as anchors`,
    ),
  );
}

console.log("\n== 汇总 ==");
for (const [key, count] of Object.entries(summary)) console.log(`  ${key}: ${count}`);
if ((summary.floorMapAssets ?? 0) > 0) {
  console.log("\n注意：上面列出的 objectKey 在 R2 里有对应对象。0033 只删数据库行，");
  console.log("R2 对象（private/imports/ 下）会成为孤儿，可在控制台按这些键删除。");
}
