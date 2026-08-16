// 楼栋轮廓 → 导航终点自动推导（shared/navigation-target.mjs）自验。
//
// 这套逻辑的失败模式是「静默地给出一个错坐标」：用户端照常显示导航按钮，点下去
// 把人带到别的地方。所以下面几条都必须钉住：
// 1. 代表点一定落在楼的轮廓内（L 形、环形楼靠扫描线兜底）；
// 2. 参数与轮廓所属底图不同源时返回 null 而不是硬算（曾因此整体偏 107m）；
// 3. 逆变换往返一致：算出的经纬度正投回去要落在原代表点上。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applyGeoTransform } from "../shared/geo-transform.mjs";
import { parseSvgFeatures } from "../shared/svg-geometry.mjs";
import {
  CAMPUS_GEO_TRANSFORM_RECORDS,
  geoTransformRecordOf,
} from "../shared/campus-geo-records.mjs";
import {
  deriveNavigationTarget,
  representativePoint,
} from "../shared/navigation-target.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");

function inRing(ring, point) {
  let inside = false;
  for (let i = 0, k = ring.length - 1; i < ring.length; k = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xk, yk] = ring[k];
    if ((yi > point[1]) !== (yk > point[1])
      && point[0] < ((xk - xi) * (point[1] - yi)) / (yk - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------
// 代表点
// ---------------------------------------------------------------------------

test("凸多边形取质心，且落在面内", () => {
  const square = { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] };
  const result = representativePoint(square);
  assert.equal(result.method, "centroid");
  assert.deepEqual(result.point.map((v) => Math.round(v)), [5, 5]);
});

test("质心落在面外时走扫描线兜底，结果仍在面内（L 形楼）", () => {
  // L 形：质心落在缺口里。硬用质心会把导航点放到楼外的空地上。
  const shape = [[0, 0], [10, 0], [10, 3], [3, 3], [3, 10], [0, 10], [0, 0]];
  const result = representativePoint({ type: "Polygon", coordinates: [shape] });
  assert.equal(result.method, "scanline", "质心在面外时必须换扫描线");
  assert.ok(inRing(shape, result.point), `代表点 ${result.point} 必须落在 L 形内`);
});

test("带内院的环形楼，代表点不落在天井里", () => {
  const outer = [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]];
  const hole = [[6, 6], [14, 6], [14, 14], [6, 14], [6, 6]];
  const result = representativePoint({ type: "Polygon", coordinates: [outer, hole] });
  assert.ok(inRing(outer, result.point), "必须在外环内");
  assert.ok(!inRing(hole, result.point), "不能落在天井里");
});

test("MultiPolygon 取面积最大的那一块", () => {
  const small = [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]];
  const big = [[[50, 50], [70, 50], [70, 70], [50, 70], [50, 50]]];
  const result = representativePoint({ type: "MultiPolygon", coordinates: [small, big] });
  assert.ok(result.point[0] > 40 && result.point[1] > 40, `应落在大块里，实际 ${result.point}`);
});

test("Point 原样返回；无法识别的几何返回 null", () => {
  assert.deepEqual(representativePoint({ type: "Point", coordinates: [3, 4] }).point, [3, 4]);
  for (const geometry of [
    null,
    undefined,
    {},
    { type: "LineString", coordinates: [[0, 0], [1, 1]]},
    { type: "Polygon", coordinates: [[[0, 0], [1, 1]]] }, // 顶点不足
    { type: "Polygon", coordinates: [[[0, 0], [1, "x"], [2, 2], [0, 0]]] }, // 非数字
  ]) {
    assert.equal(representativePoint(geometry), null, `${JSON.stringify(geometry)} 应返回 null`);
  }
});

// ---------------------------------------------------------------------------
// 参数记录
// ---------------------------------------------------------------------------

test("参数记录与 data/geo-transform.json 逐位一致（含 mapVersionId）", () => {
  const fitted = JSON.parse(read("data/geo-transform.json"));
  for (const [key, record] of Object.entries(CAMPUS_GEO_TRANSFORM_RECORDS)) {
    const source = fitted[key];
    assert.ok(source, `data/geo-transform.json 缺少 ${key}`);
    assert.equal(record.mapVersionId, source.mapVersionId, `${key} mapVersionId 不一致`);
    assert.equal(record.viewBox.width, source.viewBox.width, `${key} viewBox 宽不一致`);
    assert.equal(record.viewBox.height, source.viewBox.height, `${key} viewBox 高不一致`);
    for (const coefficient of ["a", "b", "c", "d", "e", "f"]) {
      assert.equal(
        record.transform[coefficient],
        Number(source.transform[coefficient].toFixed(6)),
        `${key}.${coefficient} 与配准结果不一致（重跑配准后要同步这个文件）`,
      );
    }
  }
});

test("geoTransformRecordOf 只认三个校区，其余返回 null", () => {
  assert.ok(geoTransformRecordOf("baoshan"));
  for (const key of ["", "nope", null, undefined, 42]) {
    assert.equal(geoTransformRecordOf(key), null, `${String(key)} 不应有参数`);
  }
});

// ---------------------------------------------------------------------------
// 推导
// ---------------------------------------------------------------------------

test("参数与轮廓底图不同源时返回 null（回归：曾因此整体偏 107m）", () => {
  const params = geoTransformRecordOf("baoshan");
  const geometry = { type: "Polygon", coordinates: [[[100, 100], [200, 100], [200, 200], [100, 200], [100, 100]]] };
  // 仓库图的 map_version 与发版图坐标空间相差约 65 个 viewBox 单位≈107m。
  assert.equal(
    deriveNavigationTarget({ geometry, mapVersionId: "map_version_campus_baoshan", params }),
    null,
    "底图版本不匹配必须拒绝，不能硬算",
  );
  // 同源时正常出结果。
  assert.ok(deriveNavigationTarget({ geometry, mapVersionId: params.mapVersionId, params }));
  // 不传 mapVersionId 时不做这项检查（调用方自己保证），但仍要能算。
  assert.ok(deriveNavigationTarget({ geometry, mapVersionId: null, params }));
});

test("缺参数 / 几何不可用时返回 null", () => {
  const geometry = { type: "Polygon", coordinates: [[[100, 100], [200, 100], [200, 200], [100, 200], [100, 100]]] };
  assert.equal(deriveNavigationTarget({ geometry, mapVersionId: null, params: null }), null);
  assert.equal(deriveNavigationTarget({ geometry, mapVersionId: null, params: {} }), null);
  assert.equal(
    deriveNavigationTarget({ geometry: { type: "LineString", coordinates: [] }, mapVersionId: null, params: geoTransformRecordOf("baoshan") }),
    null,
  );
});

test("推导结果带上仿射不确定度作为 accuracyMeters，而不是谎报 exact", () => {
  const params = geoTransformRecordOf("baoshan");
  const geometry = { type: "Polygon", coordinates: [[[100, 100], [200, 100], [200, 200], [100, 200], [100, 100]]] };
  const derived = deriveNavigationTarget({ geometry, mapVersionId: params.mapVersionId, params });
  assert.equal(derived.accuracyMeters, Number(params.transformUncertaintyMeters.p90.toFixed(1)));
  assert.ok(derived.accuracyMeters > 0 && derived.accuracyMeters < 30, "不确定度应是个小的正数");
});

test("逆变换往返一致：算出的经纬度正投回去落在原代表点上", () => {
  for (const key of ["baoshan", "jiading", "yanchang"]) {
    const params = geoTransformRecordOf(key);
    const box = params.viewBox;
    const x0 = box.width * 0.3, y0 = box.height * 0.3;
    const geometry = {
      type: "Polygon",
      coordinates: [[[x0, y0], [x0 + 40, y0], [x0 + 40, y0 + 30], [x0, y0 + 30], [x0, y0]]],
    };
    const derived = deriveNavigationTarget({ geometry, mapVersionId: params.mapVersionId, params });
    assert.ok(derived, `${key} 应能推导`);
    const back = applyGeoTransform(params.transform, derived.longitude, derived.latitude);
    const expected = representativePoint(geometry).point;
    // 7 位小数经纬度约 1cm，远小于 0.1 个 viewBox 单位。
    assert.ok(Math.hypot(back.x - expected[0], back.y - expected[1]) < 0.05,
      `${key} 往返偏差过大：${back.x},${back.y} vs ${expected}`);
    // 经纬度必须落在上海范围内。
    assert.ok(derived.longitude > 121.2 && derived.longitude < 121.5, `${key} 经度离谱 ${derived.longitude}`);
    assert.ok(derived.latitude > 31.2 && derived.latitude < 31.4, `${key} 纬度离谱 ${derived.latitude}`);
  }
});

test("对真实发版底图的全部楼栋轮廓，代表点都落在自己的轮廓内", () => {
  // 这是最贴近实际的一条：直接吃已发布底图里的真实几何。
  const manifest = JSON.parse(read("data/published-maps/manifest.json"));
  let checked = 0, outside = 0, scanline = 0;
  for (const campus of manifest.campuses) {
    const params = geoTransformRecordOf(campus.key);
    for (const feature of parseSvgFeatures(read(`data/published-maps/${campus.file}`))) {
      const geometry = feature.geometry;
      if (!geometry || (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")) continue;
      const representative = representativePoint(geometry);
      if (!representative) continue;
      if (representative.method === "scanline") scanline += 1;
      const derived = deriveNavigationTarget({
        geometry, mapVersionId: params.mapVersionId, params,
      });
      assert.ok(derived, `${campus.key}/${feature.sourceElementId} 应能推导出导航点`);
      // 正投回去，必须落在自己的轮廓内
      const back = applyGeoTransform(params.transform, derived.longitude, derived.latitude);
      const rings = geometry.type === "Polygon"
        ? [geometry.coordinates[0]]
        : geometry.coordinates.map((p) => p[0]);
      checked += 1;
      if (!rings.some((ring) => inRing(ring, [back.x, back.y]))) outside += 1;
    }
  }
  assert.ok(checked > 150, `只比到 ${checked} 个轮廓，底图元素可能变了`);
  assert.equal(outside, 0, `${outside} 个代表点回投落在自己轮廓外`);
  assert.ok(scanline > 0, "真实底图里应当存在需要扫描线兜底的楼（L 形/环形）");
});

// ---------------------------------------------------------------------------
// 编辑器接线
// ---------------------------------------------------------------------------

test("编辑器选中轮廓时自动补导航终点，且人工改过就不再覆盖", () => {
  const source = read("src/admin/components/LocationEditor.tsx");
  // 走 shared 模块，不在组件里另抄一份代表点算法。
  assert.match(source, /from "\.\.\/\.\.\/\.\.\/shared\/navigation-target\.mjs"/);
  assert.match(source, /deriveNavigationTarget\(/);
  assert.doesNotMatch(source, /function ringCentroid/, "代表点算法不该在组件里重现");

  // 只对 footprint 行触发推导。
  assert.match(source, /row\.role === "footprint"[\s\S]{0,120}withDerivedNavigation/);
  // 人工填过的导航点不动。
  assert.match(source, /existingNav\.derived !== true/);
  // 人一改经纬度就摘掉 derived 标记，之后永不自动覆盖。
  assert.match(source, /derived: false/);
  // 导航点要 isPrimary=1 才会渲染「导航到这里」（buildMapBuildings 的要求），
  // 且只点亮推导的那一行——按 role 全点亮会在「推导行 + 手动导航行」并存时
  // 同时亮两行，违反「恰好一个主要位置」契约（见 location-editor-derived-nav.test.mjs）。
  assert.match(source, /const primaryIndex = existingNav \? navIndex : withNav\.length - 1;/);
  assert.match(source, /isPrimary: i === primaryIndex/);
});

test("楼栋路径确实要求导航点 isPrimary===1，推导行才必须占主要位置", () => {
  // 这条钉住上一条测试里 isPrimary 赋值的理由；渲染层改了要求，这里会失败。
  const source = read("src/lib/release/mapData.ts");
  assert.match(source, /location\.role === "navigation_target" && location\.isPrimary === 1/);
});
