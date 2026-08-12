// 管理端「画布选点绑定导航坐标」的纯逻辑自验（node 直跑）：
// 1. shared/geo-transform.mjs 的 viewBoxToGcj02：viewBox 点 → gcj02 经纬度，
//    对三校区真实拟合参数（data/geo-transform.json）做正/逆往返；
// 2. 模拟画布 round1 取整后的回填精度仍在亚米级；
// 3. LocationEditor 的接线钉住：navigation_target 进了画布工具表、走逆变换回填、
//    且 geoTransform 参数复用 release 端同一份（src/lib/release/mapData.ts），
//    不在 admin 侧复制第三份。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyGeoTransform, invertGeoTransform, viewBoxToGcj02 } from "../shared/geo-transform.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const CAMPUS_NAME_TO_KEY = { 宝山校区: "baoshan", 嘉定校区: "jiading", 延长校区: "yanchang" };
const fitted = JSON.parse(read("data/geo-transform.json"));
const picked = JSON.parse(read("data/campus-buildings.picked.json"));

test("viewBoxToGcj02 inverts applyGeoTransform for every campus transform", () => {
  for (const [campus, name] of Object.entries(CAMPUS_NAME_TO_KEY)) {
    const transform = fitted[name]?.transform;
    assert.ok(transform, `data/geo-transform.json missing transform for ${name}`);
    // 用该校区真实楼栋的 gcj02 控制点做样本，保证落点在校内。
    const samples = picked.filter((entry) => entry.campus === campus).slice(0, 5);
    assert.ok(samples.length > 0, `no control points for ${campus}`);
    for (const sample of samples) {
      const { longitude, latitude } = sample.navigation;
      const world = applyGeoTransform(transform, longitude, latitude);
      const gcj02 = viewBoxToGcj02(transform, world.x, world.y);
      assert.ok(Math.abs(gcj02.longitude - longitude) < 1e-6, `${name} longitude roundtrip`);
      assert.ok(Math.abs(gcj02.latitude - latitude) < 1e-6, `${name} latitude roundtrip`);
      // 回填结果约定保留 7 位小数（约 1 厘米），写入修订结构的就是这个值。
      assert.equal(gcj02.longitude, Math.round(gcj02.longitude * 1e7) / 1e7);
      assert.equal(gcj02.latitude, Math.round(gcj02.latitude * 1e7) / 1e7);
    }
  }
});

test("canvas round1 quantization keeps the refilled coordinate sub-meter", () => {
  // 画布提交前会把 viewBox 坐标 round1（CampusMapCanvas 的 toViewBox），
  // 模拟这层量化后回填误差仍应远小于仿射拟合残差（~10m）。
  const round1 = (n) => Math.round(n * 10) / 10;
  for (const name of Object.values(CAMPUS_NAME_TO_KEY)) {
    const transform = fitted[name].transform;
    const unitsPerDegree = Math.hypot(transform.a, transform.d);
    const sample = picked.find((entry) => CAMPUS_NAME_TO_KEY[entry.campus] === name);
    const { longitude, latitude } = sample.navigation;
    const world = applyGeoTransform(transform, longitude, latitude);
    const gcj02 = viewBoxToGcj02(transform, round1(world.x), round1(world.y));
    const errorDegrees = Math.hypot(gcj02.longitude - longitude, gcj02.latitude - latitude);
    assert.ok(
      errorDegrees < (0.15 / unitsPerDegree) * 2,
      `${name} round1 refill error ${errorDegrees}deg exceeds quantization budget`,
    );
  }
});

test("viewBoxToGcj02 rejects a degenerate transform", () => {
  const singular = { a: 1, b: 2, c: 0, d: 2, e: 4, f: 0 };
  assert.throws(() => invertGeoTransform(singular), /not invertible/);
  assert.throws(() => viewBoxToGcj02(singular, 100, 100), /not invertible/);
});

test("LocationEditor wires navigation_target canvas picking through the inverse transform", () => {
  const editor = read("src/admin/components/LocationEditor.tsx");
  // navigation_target 进了画布工具表，且只允许点。
  assert.match(editor, /navigation_target: \["point"\]/);
  // 逆变换回填经纬度，图钉由经纬度正向投影回来。
  assert.match(editor, /viewBoxToGcj02\(CAMPUS_GEO_TRANSFORMS\[campusKey\]/);
  assert.match(editor, /applyGeoTransform\(CAMPUS_GEO_TRANSFORMS\[campusKey\]/);
  // geoTransform 参数来自 release 端同一份数据源，不在 admin 复制。
  assert.match(editor, /import \{ CAMPUS_GEO_TRANSFORMS \} from "\.\.\/\.\.\/lib\/release\/mapData"/);
  assert.match(read("src/lib/release/mapData.ts"), /export const CAMPUS_GEO_TRANSFORMS: Record<CampusKey, GeoTransform>/);
});

test("facility / merchant / transit editors offer navigation_target", () => {
  assert.match(read("src/admin/pages/FacilityEditorPage.tsx"), /"accessible_entrance", "navigation_target", "other"/);
  assert.match(read("src/admin/pages/MerchantEditorPage.tsx"), /"service_position", "navigation_target", "other"/);
  assert.match(read("src/admin/pages/TransitPage.tsx"), /"boarding_point", "navigation_target"/);
});
