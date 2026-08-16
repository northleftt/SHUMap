import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 2026-08-12 的 ef76f54 为了给发布校验更好的报错，在取位置的 SQL 上多 select 了四个
// boundMap* 别名。那条查询的结果同时还是**发布快照**的位置数组，于是校验的中间产物
// 跟着进了 manifest；客户端 manifestContract 的 location() 用 exactObject 校验，多一个
// 键就整份解析失败 → 线上地图「加载失败」。08-13 切的 release 一激活就炸了。
//
// 当时没有任何测试跨过 worker（生产快照）→ client（读快照）这条边界：契约测试的
// locations 是手写字面量（永远只含允许的键），线上夹具是改动之前存的。这个文件就是
// 补这条边界——用 worker 真正的查询行形状过一遍客户端契约。

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// worker 模块编成文件再 import：它有相对 import，data: URL 解析不了。
const workerOut = path.join(root, "tmp/release-projection-test/releases.mjs");
fs.mkdirSync(path.dirname(workerOut), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ["worker/modules/releases.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: workerOut,
});
const { releaseLocation } = await import(`${workerOut}?v=${Date.now()}`);

const clientBundle = await build({
  absWorkingDir: root,
  entryPoints: ["src/lib/release/manifestContract.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const { parseReleaseManifest } = await import(
  `data:text/javascript;base64,${Buffer.from(clientBundle.outputFiles[0].contents).toString("base64")}`
);

/**
 * worker 那条 SQL 真正产出的行形状：快照字段 + 只供发布校验用的 boundMap*。
 * 字段名与 releases.ts 的 LocationCandidate 一致。
 */
function queryRow(overrides = {}) {
  return {
    entityType: "place",
    entityId: "place_1",
    role: "primary_display",
    isPrimary: 1,
    id: "anchor_1",
    campus_id: "campus_1",
    building_place_id: null,
    floor_id: null,
    indoor_space_id: null,
    geometry_type: "Point",
    geometry_json: '{"type":"Point","coordinates":[25,40]}',
    crs: "svg_viewbox",
    map_version_id: "map_1",
    map_feature_id: null,
    location_hint: null,
    precision_level: "exact",
    accuracy_meters: null,
    source_id: null,
    verification_status: "reviewed",
    verified_by: null,
    verified_at: null,
    valid_from: null,
    valid_to: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    sourceElementId: null,
    featureKind: null,
    // 只给校验用，绝不能进快照
    boundMapVersionLabel: "20260807",
    boundMapCampusId: "campus_1",
    boundMapFloorId: null,
    boundMapCampusName: "宝山校区",
    ...overrides,
  };
}

/** 拿线上夹具做壳，只替换 locations——其余字段照旧满足契约。 */
function manifestWith(locations) {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(root, "tests/fixtures/release-manifest-live.json"), "utf8"),
  );
  const manifest = fixture.manifest ?? fixture;
  return { ...manifest, locations };
}

test("a projected query row satisfies the client manifest contract", () => {
  const parsed = parseReleaseManifest(manifestWith([releaseLocation(queryRow())]));
  assert.equal(parsed.locations.length, 1);
  assert.equal(parsed.locations[0].id, "anchor_1");
});

test("the raw query row does NOT satisfy it — this is the bug that broke production", () => {
  // 这条是反向护栏：如果哪天 exactObject 变成「忽略未知键」，或有人把 boundMap* 加进
  // 客户端白名单，这里会失败，提醒「投影」这层已经不是唯一防线了。
  assert.throws(
    () => parseReleaseManifest(manifestWith([queryRow()])),
    /boundMapVersionLabel is not supported/,
  );
});

test("the projection drops every validation-only field and keeps the rest verbatim", () => {
  const row = queryRow();
  const projected = releaseLocation(row);
  for (const leaked of ["boundMapVersionLabel", "boundMapCampusId", "boundMapFloorId", "boundMapCampusName"]) {
    assert.ok(!(leaked in projected), `${leaked} 不应进入快照`);
  }
  // 其余字段逐字保留：投影只做删减，不改值。
  for (const [key, value] of Object.entries(projected)) {
    assert.deepEqual(value, row[key], `${key} 应逐字保留`);
  }
});

test("a future column added by la.* cannot leak into the snapshot", () => {
  // 取位置的 SQL 用 la.*，给 location_anchors 加列会自动出现在查询行里。
  // 逐字段投影的意义就在这里：新列落不进快照，客户端不会因为一次加列而全线打不开。
  const projected = releaseLocation(queryRow({ some_new_anchor_column: "x" }));
  assert.ok(!("some_new_anchor_column" in projected));
  parseReleaseManifest(manifestWith([projected]));
});

test("the worker's snapshot field set matches the client whitelist exactly", () => {
  // 两侧字段集必须逐字一致：少一个 → 客户端报 required 缺失；多一个 → 报 not supported。
  const clientSource = fs.readFileSync(path.join(root, "src/lib/release/manifestContract.ts"), "utf8");
  const whitelist = clientSource
    .slice(clientSource.indexOf("function location("))
    .match(/exactObject\(value, field, \[([\s\S]*?)\]\)/)[1]
    .match(/"([^"]+)"/g)
    .map((quoted) => quoted.slice(1, -1));
  assert.deepEqual(
    Object.keys(releaseLocation(queryRow())).sort(),
    [...whitelist].sort(),
    "worker 投影与客户端白名单必须逐字一致",
  );
});

test("the snapshot is built from the projection, not the raw rows", () => {
  const source = fs.readFileSync(path.join(root, "worker/modules/releases.ts"), "utf8");
  // manifest 的 locations 必须经投影；写成 `locations,` 就是把查询行原样塞进去。
  assert.match(source, /locations: locations\.map\(releaseLocation\)/);
  assert.match(source, /locations: ReleaseLocation\[\]/, "manifest 类型应是快照行而非查询行");
  // 校验侧仍需拿到完整行（boundMap* 是它的输入），所以 buildCandidate 照旧返回原始行。
  assert.match(source, /return \{ manifest,[^}]*\blocations,/);
});
