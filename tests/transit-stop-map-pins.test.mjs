import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

// 校车站点原先只能靠绑定一个地点间接上图：站点的锚点在三个地方被挡住（发布过滤、
// manifest 白名单、buildMapPointPois 只有三轮循环）。这些关卡任缺其一都会让站点的
// 图钉静默消失，而不是报错，所以逐条钉住。

test("transit stop anchors survive the release location filter", () => {
  const source = read("worker/modules/releases.ts");
  assert.match(source, /candidateIds\.transit_stop\.has\(location\.entityId\)/);
  assert.match(source, /transit_stop: new Set\(stops\.map/);
  // operational_event / campaign 的位置走实时接口，不该跟着进快照。
  assert.doesNotMatch(source, /candidateIds\.operational_event/);
  assert.doesNotMatch(source, /candidateIds\.campaign/);
});

test("the manifest contract accepts transit_stop as a location owner", () => {
  const contract = read("src/lib/release/manifestContract.ts");
  const types = read("src/lib/api/types.ts");
  assert.match(contract, /"place", "facility", "merchant_outlet", "transit_stop"/);
  assert.match(types, /entityType: "place" \| "facility" \| "merchant_outlet" \| "transit_stop"/);
});

test("release validation refuses a pin it cannot place on a campus map", () => {
  const source = read("worker/modules/releases.ts");
  // buildMapPointPois 解析不出校区时抛错，那会让客户端整张地图打不开。
  assert.match(source, /has a campus map pin but no campus to place it on/);
  assert.match(source, /pin needs campus \$\{campusId\} to have a campus map in this release/);
  // 判定要与渲染层同一套条件，否则会漏放一个渲染时才炸的点位。
  assert.match(source, /location\.crs === CANVAS_CRS/);
  assert.match(source, /location\.floor_id === null/);
});

test("the projection has a transit stop loop that does not defer to buildings", () => {
  const source = read("src/lib/release/mapData.ts");
  assert.match(source, /for \(const stop of manifest\.transit\.stops\)/);
  assert.match(source, /entityType: "transit_stop"/);
  // 站点绑地点只是借照片与联系方式，候车位置本身仍在楼外，不能像设施那样跳过。
  const loop = source.slice(source.indexOf("for (const stop of manifest.transit.stops)"));
  assert.doesNotMatch(loop.slice(0, loop.indexOf("return result")), /if \(buildingPlaceId\) continue/);
});

test("a stop carries no revision id because it has no revision flow", () => {
  const types = read("src/lib/types.ts");
  const source = read("src/lib/release/mapData.ts");
  assert.match(types, /revisionId: string \| null/);
  assert.match(source, /revisionId: null/);
  // 楼宇仍然必有修订号，供稿要基于它提交。
  assert.match(types, /entityType: "building";\n\s+revisionId: string;/);
});

test("the client renders and labels the new POI kind", () => {
  assert.match(read("src/lib/types.ts"), /"building" \| "place" \| "facility" \| "merchant" \| "transit_stop"/);
  // 搜索列表与桌面侧栏都按 markerIconKey 取图标（站点固定 bus），否则会掉到通用图钉。
  assert.match(read("src/pages/map/SearchHomeSheet.tsx"), /poi\.entityType === "facility" \|\| poi\.entityType === "transit_stop"/);
  assert.match(read("src/pages/map/DesktopMapPanel.tsx"), /building\.entityType === "facility" \|\| building\.entityType === "transit_stop"/);
  // 运营事件本来就能以站点为对象，详情页要认这种命中。
  assert.match(read("src/pages/map/PoiDetailSheet.tsx"), /target\.targetType === "transit_stop"/);
});

test("a stop keeps a waiting point plus an optional navigation target", () => {
  const worker = read("worker/modules/transit.ts");
  assert.match(worker, /STOP_LOCATION_ROLES = \["boarding_point", "navigation_target"\]/);
  // 候车点与导航终点各一个，两个都允许；上 / 下车语义由线路方向的 pickup/dropoff 表达。
  assert.match(worker, /MAX_STOP_LOCATIONS = 2/);
  assert.match(worker, /seenRoles\.has\(location\.role\)/);
  assert.match(read("migrations-v2/0001_architecture_v2.sql"), /pickup_type/);
  // 管理端编辑器与 worker 同一份约束。
  const admin = read("src/admin/pages/TransitPage.tsx");
  assert.match(admin, /STOP_LOCATION_ROLES: readonly LocationRole\[\] = \["boarding_point", "navigation_target"\]/);
  assert.match(admin, /maxRows=\{2\}/);
  assert.match(admin, /hasBoardingPoint/);
});

test("a stop without its own anchor falls back to the bound place on both clients", () => {
  for (const file of ["src/lib/release/mapData.ts", "miniprogram/miniprogram/lib/release/mapData.ts"]) {
    const source = read(file);
    assert.match(source, /points\.get\(`transit_stop:\$\{stop\.id\}`\)\s*\?\? \(stop\.place_id \? points\.get\(`place:\$\{stop\.place_id\}`\) : undefined\)/, file);
    assert.match(source, /navigation\.get\(`transit_stop:\$\{stop\.id\}`\)\s*\?\? \(stop\.place_id \? navigation\.get\(`place:\$\{stop\.place_id\}`\) : undefined\)/, file);
  }
});
