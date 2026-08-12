// 存量点位导航坐标回填脚本（scripts/generate_navigation_backfill.mjs）纯逻辑自验。
// 合成 entity_locations × location_anchors 查询行喂入 plan/render，断言：
// 1. 生成的 SQL 坐标与手动 invertGeoTransform 计算一致；
// 2. 跳过/异常分类正确（已有导航点、无画布点、无校区、几何非法、坐标越界）；
// 3. SQL 形状符合 0015 契约（GCJ02 Point、navigation_target、is_primary=0）。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applyGeoTransform, invertGeoTransform } from "../shared/geo-transform.mjs";
import {
  COMPANION_QUERY,
  normalizeRows,
  planNavigationBackfill,
  renderBackfillSql,
  SOURCE_ID,
} from "../scripts/generate_navigation_backfill.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const geoTransforms = JSON.parse(readFileSync(join(root, "data/geo-transform.json"), "utf8"));

// 用手动逆变换反推一个画布点，保证 (x, y) 落在真实校区坐标附近。
const backfillPoint = (campusKey) => {
  const inverse = invertGeoTransform(geoTransforms[campusKey].transform);
  return applyGeoTransform(inverse, 400, 300);
};

const row = (overrides) => ({
  entityType: "place",
  entityId: "place_baoshan_test-a",
  bindingValidTo: null,
  anchorId: "anchor_src_1",
  anchorRole: "centroid",
  crs: "svg_viewbox",
  geometryType: "Point",
  geometryJson: JSON.stringify({ type: "Point", coordinates: [400, 300] }),
  campusId: "campus_baoshan",
  anchorValidTo: null,
  ...overrides,
});

test("normalizeRows 兼容 wrangler --json 包装、单结果集与裸行数组", () => {
  const rows = [row()];
  assert.deepEqual(normalizeRows([{ results: rows, success: true }, { results: [row({ entityId: "x" })] }]).length, 2);
  assert.deepEqual(normalizeRows({ results: rows }), rows);
  assert.deepEqual(normalizeRows(rows), rows);
  assert.throws(() => normalizeRows({ nope: 1 }), /Unrecognized input/);
});

test("无导航点的画布点实体生成正确 GCJ02 坐标与契约字段", () => {
  const plan = planNavigationBackfill([row()], geoTransforms);
  assert.equal(plan.inserts.length, 1);
  assert.equal(plan.report.place.backfilled, 1);

  const expected = backfillPoint("baoshan");
  const insert = plan.inserts[0];
  assert.ok(Math.abs(insert.longitude - Number(expected.x.toFixed(7))) < 1e-9, "longitude 与手动逆变换一致");
  assert.ok(Math.abs(insert.latitude - Number(expected.y.toFixed(7))) < 1e-9, "latitude 与手动逆变换一致");

  const sql = renderBackfillSql(plan);
  assert.match(sql, new RegExp(`insert or ignore into data_sources\\(id,source_type,title,reliability,metadata_json,created_at\\) values\\('${SOURCE_ID}','derived'`));
  assert.match(sql, /'navigation_target','Point','\{"type":"Point","coordinates":\[/);
  assert.match(sql, /'GCJ02','building'/);
  assert.match(sql, new RegExp(`,${geoTransforms.baoshan.meanResidualMeters.toFixed(1)},'${SOURCE_ID}','unverified'`));
  assert.match(sql, /insert or ignore into entity_locations\(id,entity_type,entity_id,anchor_id,role,is_primary,created_at\) values\('eloc_[0-9a-f]{24}','place','place_baoshan_test-a','anchor_[0-9a-f]{24}','navigation_target',0/);
  // 同一实体锚点与绑定 id 哈希同源，绑定里引用的 anchor id 必须等于锚点行的 id。
  const anchorId = sql.match(/values\('(anchor_[0-9a-f]{24})'/)[1];
  assert.ok(sql.includes(`'${anchorId}','navigation_target',0`));
});

test("已有 navigation_target 的实体被跳过", () => {
  const plan = planNavigationBackfill([
    row(),
    row({ anchorId: "anchor_nav_old", anchorRole: "navigation_target", crs: "GCJ02",
      geometryJson: JSON.stringify({ type: "Point", coordinates: [121.39, 31.31] }) }),
  ], geoTransforms);
  assert.equal(plan.inserts.length, 0);
  assert.equal(plan.report.place.skippedExistingNavigation, 1);
  assert.equal(plan.report.place.backfilled, 0);
});

test("无画布点 / 无校区 / 几何非法分别归入对应异常桶", () => {
  const plan = planNavigationBackfill([
    // facility 只有 footprint（map_feature 引用，无几何、无 crs）→ 无画布点
    row({ entityType: "facility", entityId: "fac_1", anchorRole: "footprint", crs: null,
      geometryType: "Polygon", geometryJson: null }),
    // merchant_outlet 有画布点但锚点无 campus_id → 无校区
    row({ entityType: "merchant_outlet", entityId: "mo_1", campusId: null }),
    // 未知校区 id 也归入无校区
    row({ entityType: "merchant_outlet", entityId: "mo_2", campusId: "campus_nowhere" }),
    // transit_stop 的 geometry_json 不是合法 Point → 几何非法
    row({ entityType: "transit_stop", entityId: "stop_1", geometryJson: "{\"type\":\"Point\"}" }),
    row({ entityType: "transit_stop", entityId: "stop_1", anchorId: "anchor_src_2", geometryJson: "not-json" }),
  ], geoTransforms);
  assert.equal(plan.inserts.length, 0);
  assert.equal(plan.report.facility.errorNoViewboxPoint, 1);
  assert.equal(plan.report.merchant_outlet.errorNoCampus, 2);
  assert.equal(plan.report.transit_stop.errorInvalidGeometry, 1);
  assert.equal(plan.anomalies.length, 4);
});

test("同一实体多个画布点按角色优先级与 anchorId 确定性取舍", () => {
  const plan = planNavigationBackfill([
    row({ anchorId: "anchor_src_b", anchorRole: "service_position", geometryJson: JSON.stringify({ type: "Point", coordinates: [500, 350] }) }),
    row({ anchorId: "anchor_src_a", anchorRole: "main_entrance" }),
  ], geoTransforms);
  assert.equal(plan.inserts.length, 1);
  // main_entrance 优先于 service_position，即使 anchorId 排序靠后
  assert.equal(plan.inserts[0].sourceAnchorId, "anchor_src_a");
  const expected = backfillPoint("baoshan"); // 坐标来自 400,300 的那个点
  assert.ok(Math.abs(plan.inserts[0].longitude - Number(expected.x.toFixed(7))) < 1e-9);
});

test("嘉定校区实体用嘉定变换参数，id 派生确定", () => {
  const rows = [row({ entityType: "transit_stop", entityId: "stop_jd", campusId: "campus_jiading" })];
  const first = planNavigationBackfill(rows, geoTransforms);
  const second = planNavigationBackfill(rows, geoTransforms);
  assert.deepEqual(first.inserts, second.inserts);
  assert.equal(first.inserts[0].campusId, "campus_jiading");
  const expected = backfillPoint("jiading");
  assert.ok(Math.abs(first.inserts[0].longitude - Number(expected.x.toFixed(7))) < 1e-9);
  assert.equal(first.inserts[0].accuracyMeters, Number(geoTransforms.jiading.meanResidualMeters.toFixed(1)));
});

test("已失效的绑定或锚点不参与判定", () => {
  // 画布点绑定已失效、旧导航点锚点已失效，只剩一个有效 footprint
  // → 旧导航点不构成"已有导航点"跳过；有效行里没有画布点 → 无画布点异常
  const plan = planNavigationBackfill([
    row({ bindingValidTo: "2026-01-01T00:00:00Z" }),
    row({ anchorId: "anchor_nav_old", anchorRole: "navigation_target", crs: "GCJ02", anchorValidTo: "2026-01-01T00:00:00Z" }),
    row({ anchorId: "anchor_fp", anchorRole: "footprint", crs: null, geometryType: "Polygon", geometryJson: null }),
  ], geoTransforms);
  assert.equal(plan.inserts.length, 0);
  assert.equal(plan.report.place.skippedExistingNavigation, 0);
  assert.equal(plan.report.place.errorNoViewboxPoint, 1);
});

test("配套查询覆盖四类实体且 join 锚点表", () => {
  assert.match(COMPANION_QUERY, /from entity_locations el/);
  assert.match(COMPANION_QUERY, /join location_anchors la/);
  for (const type of ["place", "facility", "merchant_outlet", "transit_stop"]) {
    assert.ok(COMPANION_QUERY.includes(`'${type}'`));
  }
});
