#!/usr/bin/env node
// generate_transit_route_split.mjs — 生成「线路按预约性拆分」的 SQL
//
// 背景见 migrations-v2/0024_transit_route_booking.sql 的头注释。预约/非预约是两条
// 不同的线路，但历史数据把它们混排在同一条 route 上（如宝山→嘉定 22 非预约 + 7 预约）。
// 本脚本读一份 D1 dump，对每条 route：
//   * 班次预约性单一 → 直接给 route 打上该 booking_policy；
//   * 混合 → 新建 <code>-reservation 的 route + pattern（复制停靠序列），把 required
//     班次整体移过去；原 route 标 not_required，新 route 标 required。
//
// 用法：
//   node scripts/generate_transit_route_split.mjs <dump.sql> [输出.sql]
// 默认输出 output/transit-route-split.sql。生成的 SQL 假定 0024 已应用
// （transit_routes.booking_policy 已存在），请先在 dump 副本上验证再应用到生产。

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const [dumpPath, outPath = "output/transit-route-split.sql"] = process.argv.slice(2);
if (!dumpPath) {
  console.error("usage: node scripts/generate_transit_route_split.mjs <dump.sql> [输出.sql]");
  process.exit(1);
}

const database = new DatabaseSync(":memory:");
database.exec(fs.readFileSync(dumpPath, "utf8"));
database.exec(fs.readFileSync(path.join("migrations-v2", "0024_transit_route_booking.sql"), "utf8"));

const q = (value) => (value === null || value === undefined ? "null" : `'${String(value).replaceAll("'", "''")}'`);

const routes = database.prepare(
  `select r.id, r.code, r.name, r.booking_policy as currentPolicy
     from transit_routes r where r.status='active' order by r.code`,
).all();

const lines = [
  "-- transit-route-split.sql — 由 scripts/generate_transit_route_split.mjs 生成",
  `-- 数据源：${dumpPath}`,
  "-- 前置：migrations-v2/0024_transit_route_booking.sql 已应用。",
  "",
  "pragma foreign_keys = on;",
  "",
];
const summary = [];

for (const route of routes) {
  const patterns = database.prepare(
    "select id, direction_id as directionId, name from transit_patterns where route_id=? order by id",
  ).all(route.id);
  if (patterns.length !== 1) {
    throw new Error(`route ${route.code} 有 ${patterns.length} 个 pattern，脚本假设每条线路恰好一个，请先人工处理`);
  }
  const pattern = patterns[0];
  const policies = database.prepare(
    "select distinct booking_policy as policy from transit_trips where pattern_id=? and status='active'",
  ).all(pattern.id).map((row) => row.policy);
  if (policies.length === 0) {
    summary.push(`${route.code}: 无 active 班次，标 not_required`);
    lines.push(`update transit_routes set booking_policy='not_required' where id=${q(route.id)};`);
    continue;
  }
  if (policies.length === 1) {
    summary.push(`${route.code}: 纯 ${policies[0]}，直接打标`);
    lines.push(`update transit_routes set booking_policy=${q(policies[0])} where id=${q(route.id)};`);
    continue;
  }

  // 混合：required 班次移到新的预约线。
  const newRouteId = `${route.id}-reservation`;
  const newPatternId = `${pattern.id}-reservation`;
  const moved = database.prepare(
    "select count(*) as n from transit_trips where pattern_id=? and status='active' and booking_policy='required'",
  ).get(pattern.id).n;
  summary.push(`${route.code}: 混合，${moved} 条 required 班次拆到 ${newRouteId}`);
  const stops = database.prepare(
    "select stop_id as stopId, stop_sequence as stopSequence, pickup_type as pickupType, dropoff_type as dropoffType from transit_pattern_stops where pattern_id=? order by stop_sequence",
  ).all(pattern.id);
  lines.push(
    `insert into transit_routes(id,code,name,status,booking_policy,created_at,updated_at) select ${q(newRouteId)},${q(`${route.code}-reservation`)},${q(`${route.name}（预约）`)},'active','required',created_at,updated_at from transit_routes where id=${q(route.id)};`,
    `insert into transit_patterns(id,route_id,direction_id,name) values(${q(newPatternId)},${q(newRouteId)},${pattern.directionId},${q(`${pattern.name}（预约）`)});`,
    ...stops.map((stop) =>
      `insert into transit_pattern_stops(pattern_id,stop_id,stop_sequence,pickup_type,dropoff_type) values(${q(newPatternId)},${q(stop.stopId)},${stop.stopSequence},${q(stop.pickupType)},${q(stop.dropoffType)});`
    ),
    `update transit_trips set pattern_id=${q(newPatternId)} where pattern_id=${q(pattern.id)} and status='active' and booking_policy='required';`,
    `update transit_routes set booking_policy='not_required' where id=${q(route.id)};`,
  );
}

database.close();

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${lines.join("\n")}\n`);
console.log(`已生成 ${outPath}（${lines.length - 6} 条语句）`);
for (const line of summary) console.log(`  ${line}`);
