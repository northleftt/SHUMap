// 生成小程序端校车离线快照：data/shuttle-schedule.json → miniprogram/miniprogram/data/shuttle-schedule.ts
//
// 0024 校区对校区改版后的新结构：
// - endpoints[]：校区对校区模型的可选端点（校区用 campus_id，陈太公寓用 stop:<stopId> 伪端点），
//   顺序对齐 listTransitEndpoints（manifest.campuses 顺序 + 无校区站点在后）；
// - pairs：键 `fromEndpointId>toEndpointId`（保留方向），值是该校区对的 lines[]；
// - 每条 line：{ routeName, bookingPolicy, bookingUrl, schedules: { bucket: string[] } }。
//   源数据 isReservation=true 的时刻进预约线（bookingPolicy "required"），false 的进普通线
//   （"not_required"）；命名对齐服务端 generate_transit_route_split.mjs：只有混合预约的
//   方向才给预约线加「（预约）」后缀，纯预约方向保留原名。某方向没有某类班次就不出那条线。
// 快照没有站点粒度数据，lines 不带上下车点（离线态 UI 不渲染站点 chips）。
//
// 用法：node scripts/generate_miniprogram_shuttle_snapshot.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = JSON.parse(readFileSync(join(repoRoot, "data/shuttle-schedule.json"), "utf8"));

// 校区名 → 端点 id（与 release manifest 的 campuses[].id / transit_stops.id 一致）。
const ENDPOINT_ID_BY_NAME = {
  宝山校区: "campus_baoshan",
  嘉定校区: "campus_jiading",
  延长校区: "campus_yanchang",
  陈太公寓: "stop:stop_陈太公寓",
};
// 端点顺序对齐 listTransitEndpoints：manifest.campuses 顺序，无校区站点追加在后。
const ENDPOINT_ORDER = ["campus_baoshan", "campus_jiading", "campus_yanchang", "stop:stop_陈太公寓"];

const BUCKETS = ["weekday", "weekend", "holiday", "winterBreak", "summerBreak"];

const endpointNameById = new Map();
const pairs = {};

for (const route of source.routes) {
  const fromId = ENDPOINT_ID_BY_NAME[route.from];
  const toId = ENDPOINT_ID_BY_NAME[route.to];
  if (!fromId || !toId) throw new Error(`未知校区名：${route.from} → ${route.to}`);
  endpointNameById.set(fromId, route.from);
  endpointNameById.set(toId, route.to);

  const key = `${fromId}>${toId}`;
  const lines = pairs[key] ?? [];
  pairs[key] = lines;

  // 服务端拆分（generate_transit_route_split.mjs）只给「混合预约」线路造「（预约）」副本，
  // 纯预约线路保留原名（仅 booking_policy=required）；快照命名对齐这个规则。
  const totals = [false, true].map(
    (reservation) =>
      BUCKETS.reduce(
        (sum, bucket) => sum + (route.schedules[bucket] ?? []).filter((entry) => entry.isReservation === reservation).length,
        0,
      ),
  );
  const mixed = totals[0] > 0 && totals[1] > 0;

  for (const reservation of [false, true]) {
    const index = reservation ? 1 : 0;
    if (totals[index] === 0) continue; // 这个方向没有该类班次，不出这条线
    const schedules = {};
    for (const bucket of BUCKETS) {
      schedules[bucket] = (route.schedules[bucket] ?? [])
        .filter((entry) => entry.isReservation === reservation)
        .map((entry) => entry.departureTime);
    }
    lines.push({
      routeName: `${route.from} → ${route.to}${reservation && mixed ? "（预约）" : ""}`,
      bookingPolicy: reservation ? "required" : "not_required",
      bookingUrl: null,
      schedules,
    });
  }
}

const endpoints = ENDPOINT_ORDER.filter((id) => endpointNameById.has(id)).map((id) => ({
  id,
  name: endpointNameById.get(id),
}));

const snapshot = { version: source.version, endpoints, pairs };

const output = `// 数据文件（.ts 模块 export default，小程序编译器不打包 .json，见 miniprogram/AGENTS.md 坑 #2）
// 由 scripts/generate_miniprogram_shuttle_snapshot.mjs 生成，请勿手改。
// 0024 校区对校区改版结构：pairs 的键是「fromEndpointId>toEndpointId」，值是 lines[]
// （线路级预约；快照无站点粒度，上下车点以线上 campus-lines 接口为准）。
export default ${JSON.stringify(snapshot, null, 2)} as const;
`;

writeFileSync(join(repoRoot, "miniprogram/miniprogram/data/shuttle-schedule.ts"), output);

const lineCount = Object.values(pairs).reduce((sum, lines) => sum + lines.length, 0);
console.log(`生成完成：${endpoints.length} 个端点，${Object.keys(pairs).length} 个校区对，${lineCount} 条线路`);
