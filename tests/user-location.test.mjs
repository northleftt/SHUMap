// 用户定位 dot 纯逻辑自验（node 直跑）：
// 1. wgs84ToViewBoxPoint = applyGeoTransform ∘ wgs84ToGcj02（上海点）；
// 2. metersToViewBoxUnits：米 → viewBox 单位换算与反算；
// 3. isPointInViewBox：含边界、含非零原点 viewBox；
// 4. 真实数据：宝山校区中心地标（wgs84 近似值）应落在宝山底图 viewBox 内。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyGeoTransform,
  invertGeoTransform,
  wgs84ToGcj02,
} from "../shared/geo-transform.mjs";
import { parseSvgViewBox } from "../shared/svg-geometry.mjs";
import {
  METERS_PER_DEGREE_LNG,
  campusKeyForGcj02Point,
  isPointInViewBox,
  metersToViewBoxUnits,
  wgs84ToViewBoxPoint,
} from "../shared/user-location.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// 与 data/geo-transform.json 一致的宝山拟合参数
const baoshan = {
  a: 58096.587722328324,
  b: -1364.8960867513201,
  c: -7009407.677731765,
  d: 74.66532399354122,
  e: -67597.59659141311,
  f: 2108281.4089938696,
};

// ---------------------------------------------------------------------------
// 1. wgs84 → gcj02 → viewBox 与手动两步同值
// ---------------------------------------------------------------------------
{
  const gcj = wgs84ToGcj02(121.395, 31.313);
  assert.deepEqual(
    wgs84ToViewBoxPoint(baoshan, 121.395, 31.313),
    applyGeoTransform(baoshan, gcj.longitude, gcj.latitude),
  );
}

// ---------------------------------------------------------------------------
// 2. 米 → viewBox 单位：公式值 + 反算回米
// ---------------------------------------------------------------------------
{
  const units = metersToViewBoxUnits(baoshan, 100);
  const expected = 100 / (METERS_PER_DEGREE_LNG / Math.hypot(baoshan.a, baoshan.d));
  assert.ok(Math.abs(units - expected) < 1e-9, `metersToViewBoxUnits formula: ${units}`);
  const back = units * (METERS_PER_DEGREE_LNG / Math.hypot(baoshan.a, baoshan.d));
  assert.ok(Math.abs(back - 100) < 1e-9, "roundtrip back to meters");
}

// ---------------------------------------------------------------------------
// 3. viewBox 范围判断
// ---------------------------------------------------------------------------
{
  const viewBox = { x: 0, y: 0, width: 1000, height: 800 };
  assert.equal(isPointInViewBox({ x: 500, y: 400 }, viewBox), true);
  assert.equal(isPointInViewBox({ x: 0, y: 800 }, viewBox), true, "边界算在内");
  assert.equal(isPointInViewBox({ x: -1, y: 400 }, viewBox), false);
  assert.equal(isPointInViewBox({ x: 500, y: 801 }, viewBox), false);
  const offsetBox = { x: -100, y: 50, width: 200, height: 200 };
  assert.equal(isPointInViewBox({ x: -50, y: 100 }, offsetBox), true);
  assert.equal(isPointInViewBox({ x: 101, y: 100 }, offsetBox), false);
}

// ---------------------------------------------------------------------------
// 4. 真实数据：上海大学宝山校区（wgs84 近似坐标）落在宝山底图 viewBox 内
// ---------------------------------------------------------------------------
{
  const assets = JSON.parse(readFileSync(join(repoRoot, "data/campus-map-assets.json"), "utf8"));
  const asset = assets.find((item) => item.key === "baoshan");
  const viewBox = parseSvgViewBox(readFileSync(join(repoRoot, asset.sourcePath), "utf8"));
  // 上大宝山校区图书馆一带（wgs84，公开地图坐标）
  const point = wgs84ToViewBoxPoint(baoshan, 121.3936, 31.3165);
  assert.ok(
    isPointInViewBox(point, viewBox),
    `SHU baoshan should project into viewBox, got (${point.x.toFixed(0)}, ${point.y.toFixed(0)}) ` +
      `vs viewBox ${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`,
  );
  // 校外点（人民广场一带）不应落在宝山 viewBox 内
  const offCampus = wgs84ToViewBoxPoint(baoshan, 121.4737, 31.2304);
  assert.equal(isPointInViewBox(offCampus, viewBox), false, "off-campus point must be outside");
}

// ---------------------------------------------------------------------------
// 5. campusKeyForGcj02Point：落在宝山/嘉定/校外三种情况（真实拟合参数 + 真实 viewBox）
// ---------------------------------------------------------------------------
{
  const assets = JSON.parse(readFileSync(join(repoRoot, "data/campus-map-assets.json"), "utf8"));
  const fitted = JSON.parse(readFileSync(join(repoRoot, "data/geo-transform.json"), "utf8"));
  const campuses = assets.map((asset) => ({
    key: asset.key,
    geoTransform: fitted[asset.key].transform,
    viewBox: parseSvgViewBox(readFileSync(join(repoRoot, asset.sourcePath), "utf8")),
  }));

  // 各校区的代表性 gcj02 点：viewBox 中心经逆变换取回（必落在本校区 viewBox 内）
  for (const campus of campuses) {
    const inverse = invertGeoTransform(campus.geoTransform);
    const center = applyGeoTransform(
      inverse,
      campus.viewBox.x + campus.viewBox.width / 2,
      campus.viewBox.y + campus.viewBox.height / 2,
    );
    assert.equal(
      campusKeyForGcj02Point(campuses, center.x, center.y),
      campus.key,
      `viewBox center should resolve to ${campus.key}`,
    );
  }

  // 上大宝山校区（wgs84 近似坐标转 gcj02）→ baoshan
  const shuGcj = wgs84ToGcj02(121.3936, 31.3165);
  assert.equal(campusKeyForGcj02Point(campuses, shuGcj.longitude, shuGcj.latitude), "baoshan");

  // 校外（人民广场一带）→ null
  const offGcj = wgs84ToGcj02(121.4737, 31.2304);
  assert.equal(campusKeyForGcj02Point(campuses, offGcj.longitude, offGcj.latitude), null);

  // 空列表 → null
  assert.equal(campusKeyForGcj02Point([], shuGcj.longitude, shuGcj.latitude), null);
}

console.log("user-location tests passed");
