// 导航终点重建脚本（scripts/generate_navigation_rebuild.mjs）纯逻辑自验。
//
// 这个脚本往库里写 219 个导航坐标，写错的后果是「导航把人带到别处」——而且不报错。
// 所以钉住四件事：
// 1. 代表点必须落在楼的轮廓内（L 形 / 环形楼的质心在面外，必须走扫描线兜底）；
// 2. 参数必须拟合自当前发版底图，否则逆变换出来的经纬度整体偏移（曾偏 107m）；
// 3. 哈希公式与 worker/modules/places.ts 逐字一致；
// 4. 库里已有导航点时一律拒绝出 SQL（重建的前提是先清空，否则唯一索引撞车）。

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applyGeoTransform } from "../shared/geo-transform.mjs";
import {
  CANVAS_POINT_QUERY,
  FOOTPRINT_QUERY,
  placeContentHash,
  planNavigationRebuild,
  PRECISION_LEVEL,
  renderRebuildSql,
  representativePoint,
  REVISION_QUERY,
  rewriteStructureJson,
  ROLE,
  SOURCE_ID,
} from "../scripts/generate_navigation_rebuild.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");
const transforms = JSON.parse(read("data/geo-transform.json"));
const publishedManifest = JSON.parse(read("data/published-maps/manifest.json"));

/** 正方形，质心在面内。 */
const square = (x, y, w = 20) => ({
  type: "Polygon",
  coordinates: [[[x, y], [x + w, y], [x + w, y + w], [x, y + w], [x, y]]],
});

const baseInput = (overrides = {}) => ({
  transforms,
  publishedManifest,
  footprints: [],
  canvasPoints: [],
  primaryTaken: [],
  revisions: [],
  existingNav: [{ n: 0 }],
  ...overrides,
});

const footprintRow = (overrides = {}) => ({
  placeId: "place_baoshan_test",
  campusCode: "baoshan",
  campusId: "campus_baoshan",
  geometryJson: JSON.stringify(square(400, 400)),
  sourceElementId: "test_el",
  ...overrides,
});

test("代表点：凸多边形取质心，且落在面内", () => {
  const result = representativePoint(square(100, 200, 40));
  assert.equal(result.method, "centroid");
  assert.deepEqual(result.point.map(Math.round), [120, 220]);
});

test("代表点：质心落在面外时走扫描线兜底，结果仍在面内（L 形楼）", () => {
  // L 形：质心落在缺口里
  const L = {
    type: "Polygon",
    coordinates: [[[0, 0], [60, 0], [60, 20], [20, 20], [20, 60], [0, 60], [0, 0]]],
  };
  const result = representativePoint(L);
  assert.equal(result.method, "scanline", "质心在面外必须走扫描线");
  // 用射线法独立验证落在面内
  const ring = L.coordinates[0];
  let inside = false;
  const [px, py] = result.point;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  assert.ok(inside, `扫描线取的点 ${result.point} 必须落在 L 形内`);
});

test("代表点：MultiPolygon 取面积最大的那一块", () => {
  const geometry = {
    type: "MultiPolygon",
    coordinates: [square(0, 0, 10).coordinates, square(500, 500, 80).coordinates],
  };
  const result = representativePoint(geometry);
  assert.ok(result.point[0] > 400, "必须落在大的那一块里，而不是小的");
});

test("代表点：Point 原样返回，无法识别的几何返回 null", () => {
  assert.deepEqual(representativePoint({ type: "Point", coordinates: [12, 34] }).point, [12, 34]);
  assert.equal(representativePoint(null), null);
  assert.equal(representativePoint({ type: "LineString", coordinates: [[0, 0], [1, 1]] }), null);
  assert.equal(representativePoint({ type: "Point", coordinates: [Number.NaN, 1] }), null);
});

test("逆变换出的经纬度，正投回去必须落在原代表点上（往返一致）", () => {
  const plan = planNavigationRebuild(baseInput({ footprints: [footprintRow()] }));
  assert.equal(plan.inserts.length, 1);
  const insert = plan.inserts[0];
  const back = applyGeoTransform(transforms.baoshan.transform, insert.longitude, insert.latitude);
  // round7 的经纬度约 1cm，远小于 0.1 viewBox 单位
  assert.ok(Math.abs(back.x - insert.viewBoxPoint[0]) < 0.2, `x 往返 ${back.x} vs ${insert.viewBoxPoint[0]}`);
  assert.ok(Math.abs(back.y - insert.viewBoxPoint[1]) < 0.2, `y 往返 ${back.y} vs ${insert.viewBoxPoint[1]}`);
  // 宝山校区的合理经纬度范围
  assert.ok(insert.longitude > 121.38 && insert.longitude < 121.41, `经度 ${insert.longitude}`);
  assert.ok(insert.latitude > 31.30 && insert.latitude < 31.33, `纬度 ${insert.latitude}`);
});

test("参数拟合自别的底图时直接抛错（回归：曾因此整体偏 107m）", () => {
  const stale = JSON.parse(JSON.stringify(transforms));
  stale.baoshan.mapVersionId = "mapver_STALE";
  assert.throws(
    () => planNavigationRebuild(baseInput({ transforms: stale, footprints: [footprintRow()] })),
    /拟合自 mapver_STALE/,
  );
});

test("库里已有导航点时拒绝出 SQL（必须先清空，否则唯一索引撞车）", () => {
  const plan = planNavigationRebuild(
    baseInput({ footprints: [footprintRow()], existingNav: [{ n: 3 }] }),
  );
  assert.equal(plan.existingNavCount, 3);
  assert.throws(() => renderRebuildSql(plan, { transforms }), /还有 3 个 navigation_target/);
});

test("is_primary：已被别的角色占用时降为 0，否则取 1", () => {
  const taken = planNavigationRebuild(baseInput({
    footprints: [footprintRow()],
    primaryTaken: [{ entityType: "place", entityId: "place_baoshan_test" }],
  }));
  assert.equal(taken.inserts[0].isPrimary, 0, "已占用必须降为 0，否则撞 one_primary 唯一索引");

  const free = planNavigationRebuild(baseInput({ footprints: [footprintRow()] }));
  assert.equal(free.inserts[0].isPrimary, 1, "没占用时取 1，楼栋路径才出「导航到这里」");
});

test("代表点落在 viewBox 外的几何被跳过而不是硬写进去", () => {
  const plan = planNavigationRebuild(baseInput({
    footprints: [footprintRow({ geometryJson: JSON.stringify(square(50000, 50000)) })],
  }));
  assert.equal(plan.inserts.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /viewBox 外/);
});

test("同一实体重复出现只取一条；canvas 点不覆盖已有 footprint", () => {
  const plan = planNavigationRebuild(baseInput({
    footprints: [footprintRow(), footprintRow()],
    canvasPoints: [{
      entityType: "place",
      entityId: "place_baoshan_test",
      campusCode: "baoshan",
      campusId: "campus_baoshan",
      geometryJson: JSON.stringify({ type: "Point", coordinates: [700, 700] }),
      sourceRole: "boarding_point",
    }],
  }));
  assert.equal(plan.inserts.length, 1, "同一实体只能有一个导航点");
  assert.match(plan.inserts[0].source, /^footprint:/, "footprint 优先于 canvas");
});

test("structure_json：导航点插在开头，其余字段逐字节不动", () => {
  const structure = {
    kindId: "building",
    campusId: "campus_baoshan",
    locations: [{ role: "footprint", mapFeatureId: "mf_1" }],
  };
  const result = rewriteStructureJson(JSON.stringify(structure), {
    campusId: "campus_baoshan",
    buildingPlaceId: "place_x",
    longitude: 121.39,
    latitude: 31.31,
    isPrimary: 1,
  });
  assert.equal(result.ok, true);
  const after = JSON.parse(result.next);
  assert.equal(after.locations[0].role, ROLE, "导航点必须在开头（与 seed 原顺序一致）");
  assert.equal(after.locations[0].crs, "GCJ02");
  assert.equal(after.locations[0].precisionLevel, PRECISION_LEVEL);
  assert.equal(after.locations[0].sourceId, SOURCE_ID);
  assert.deepEqual(after.locations[1], structure.locations[0], "原有位置逐字节不动");
  assert.equal(after.kindId, "building");
});

test("structure_json：isPrimary 必须是 JSON boolean，不能写 0/1", () => {
  // 管理端 locationDraftFromApi 读这一列。写成 1/0 之后每个被重建过的地点
  // 编辑页都会红字「locations[0].isPrimary must be a boolean」。
  for (const [input, expected] of [[1, true], [0, false], [true, true], [false, false]]) {
    const result = rewriteStructureJson(JSON.stringify({ locations: [] }), {
      campusId: "c",
      longitude: 1,
      latitude: 2,
      isPrimary: input,
    });
    assert.equal(result.ok, true);
    const after = JSON.parse(result.next);
    assert.equal(typeof after.locations[0].isPrimary, "boolean", `input ${input} 必须落成 boolean`);
    assert.equal(after.locations[0].isPrimary, expected);
    assert.match(result.next, expected ? /"isPrimary":true/ : /"isPrimary":false/);
    assert.doesNotMatch(result.next, /"isPrimary":[01]/);
  }
});

test("structure_json：已有导航点归 noop；无法忠实往返一律拒绝", () => {
  const entry = { campusId: "c", longitude: 1, latitude: 2, isPrimary: 1 };
  const withNav = JSON.stringify({ locations: [{ role: ROLE }] });
  assert.equal(rewriteStructureJson(withNav, entry).noop, true);
  // 键序与 stringify 不一致
  assert.match(rewriteStructureJson('{ "locations":[] }', entry).reason, /逐字节往返/);
  assert.match(rewriteStructureJson("not json", entry).reason, /不是合法 JSON/);
  assert.match(rewriteStructureJson('{"locations":null}', entry).reason, /不是数组/);
});

test("哈希公式与 worker/modules/places.ts 逐字一致", () => {
  const source = read("worker/modules/places.ts");
  assert.match(
    source,
    /sha256\(\s*`\$\{[^}]*displayName\}\\n\$\{[^}]*summary \?\? ""\}\\n\$\{[^}]*description \?\? ""\}\\n\$\{contentJson\}\\n\$\{structureJson\}`/,
  );
  const expected = crypto.createHash("sha256").update('A 楼\n\n\n{"a":1}\n{"b":2}', "utf8").digest("hex");
  assert.equal(
    placeContentHash({ displayName: "A 楼", summary: null, description: null, contentJson: '{"a":1}', structureJson: '{"b":2}' }),
    expected,
    "null 的 summary/description 必须拼成空串",
  );
});

test("SQL 形态：GCJ02 Point + role 一致 + 旧哈希前置条件 + insert or ignore", () => {
  const structure = { kindId: "building", campusId: "campus_baoshan", locations: [] };
  const structureJson = JSON.stringify(structure);
  const revision = {
    revisionId: "prev_x",
    placeId: "place_baoshan_test",
    displayName: "测试楼",
    summary: null,
    description: null,
    contentJson: '{"detail":{"facts":[],"media":[]}}',
    structureJson,
  };
  revision.contentHash = placeContentHash(revision);
  const plan = planNavigationRebuild(baseInput({
    footprints: [footprintRow()],
    revisions: [revision],
  }));
  assert.equal(plan.updates.length, 1);
  const sql = renderRebuildSql(plan, { generatedAt: "2026-08-14T00:00:00.000Z", transforms });

  // 0015 触发器要求：Point + GCJ02
  assert.match(sql, /'navigation_target','Point','\{"type":"Point","coordinates":\[[-0-9.]+,[-0-9.]+\]\}','GCJ02'/);
  // role 匹配触发器：绑定 role 必须与锚点一致
  assert.match(sql, /'navigation_target',(0|1),datetime\('now'\)\)/);
  // 可安全重跑
  assert.match(sql, /insert or ignore into location_anchors/);
  assert.match(sql, /insert or ignore into entity_locations/);
  // update 带旧哈希前置条件
  assert.match(sql, new RegExp(`and content_hash='${revision.contentHash}';`));
  // 先插锚点再插绑定（外键方向）
  assert.ok(sql.indexOf("into location_anchors") < sql.indexOf("into entity_locations"));
  // 新哈希必须由新 structure_json 按真实公式算出
  const update = plan.updates[0];
  assert.equal(
    update.contentHash,
    placeContentHash({ ...revision, structureJson: update.structureJson }),
  );
  assert.notEqual(update.contentHash, revision.contentHash);
});

test("三条配套查询取齐所需字段", () => {
  for (const column of ["display_name", "summary", "description", "content_json", "structure_json", "content_hash"]) {
    assert.match(REVISION_QUERY, new RegExp(`r\\.${column}`), `修订查询必须取 ${column}`);
  }
  // footprint 查询必须带几何与校区，否则无法取代表点
  assert.match(FOOTPRINT_QUERY, /geometry_json/);
  assert.match(FOOTPRINT_QUERY, /role='footprint'/);
  assert.match(FOOTPRINT_QUERY, /valid_to is null/);
  assert.match(CANVAS_POINT_QUERY, /svg_viewbox/);
});

test("空输入不出 SQL", () => {
  assert.throws(() => renderRebuildSql(planNavigationRebuild(baseInput()), { transforms }), /没有可重建/);
});
