// 小程序端用户定位 dot 纯逻辑自验（不经微信开发者工具，直接在 node 里跑）。
//
// 用 esbuild 把 miniprogram/miniprogram/lib/map/user-location.ts 编成 cjs 后断言：
// 1. isInsideViewBox：viewBox 范围判断（含边界、非有限值）；
// 2. metersToViewBoxUnits：米 → viewBox 单位（经度方向近似，1° 经度 ≈ 95150m）；
// 3. computeUserLocationMarker：校区内出 dot、校区外隐藏、accuracy 精度圈规则
//    （>500m / NaN / ≤0 不画圈，半径按米换算）；
// 4. campusKeyForGcj02Point：落在宝山/嘉定（含非零原点 viewBox）/校外三种情况。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "tmp/map-test");
mkdirSync(outDir, { recursive: true });

execFileSync(join(repoRoot, "node_modules/.bin/esbuild"), [
  join(repoRoot, "miniprogram/miniprogram/lib/map/user-location.ts"),
  "--bundle",
  "--format=cjs",
  "--platform=node",
  `--outfile=${join(outDir, "user-location.cjs")}`,
]);

const require = createRequire(import.meta.url);
const userLocation = require(join(outDir, "user-location.cjs"));

// 测试用仿射：viewBox 1000×800；x 只随经度（1° → 10000 单位），y 只随纬度（1° → -10000 单位）。
// 校内参考点：lng 121.05 → x=500，lat 31.14 → y=400。
const T = { a: 10000, b: 0, c: -1210000, d: 0, e: -10000, f: 311800 };
const VIEW_BOX = { width: 1000, height: 800 };

// ---------------------------------------------------------------------------
// 1. isInsideViewBox
// ---------------------------------------------------------------------------
{
  assert.equal(userLocation.isInsideViewBox({ x: 500, y: 400 }, VIEW_BOX), true, "范围内命中");
  assert.equal(userLocation.isInsideViewBox({ x: 0, y: 0 }, VIEW_BOX), true, "左上角边界含入");
  assert.equal(userLocation.isInsideViewBox({ x: 1000, y: 800 }, VIEW_BOX), true, "右下角边界含入");
  assert.equal(userLocation.isInsideViewBox({ x: -1, y: 400 }, VIEW_BOX), false, "左界外不命中");
  assert.equal(userLocation.isInsideViewBox({ x: 500, y: 801 }, VIEW_BOX), false, "下界外不命中");
  assert.equal(userLocation.isInsideViewBox({ x: NaN, y: 400 }, VIEW_BOX), false, "NaN 不命中");
}

// ---------------------------------------------------------------------------
// 2. metersToViewBoxUnits
// ---------------------------------------------------------------------------
{
  // hypot(a, d) = 10000（1° 经度 = 10000 viewBox 单位 ≈ 95150m）
  assert.ok(
    Math.abs(userLocation.metersToViewBoxUnits(95150, T) - 10000) < 1e-9,
    "1° 经度的地面距离应换算为 hypot(a,d) 个单位",
  );
  assert.ok(
    Math.abs(userLocation.metersToViewBoxUnits(50, T) - 50 * 10000 / 95150) < 1e-9,
    "50m 应按比例换算",
  );
  // 只有 y 随经度变化（a=0, d≠0）时同样成立：公式用 hypot(t.a, t.d)
  const TD = { a: 0, b: 0, c: 0, d: 3, e: 0, f: 0 };
  assert.ok(
    Math.abs(userLocation.metersToViewBoxUnits(95150, TD) - 3) < 1e-9,
    "经度方向尺度取 hypot(a, d)",
  );
}

// ---------------------------------------------------------------------------
// 3. computeUserLocationMarker
// ---------------------------------------------------------------------------
{
  // 校区内 + 正常精度：dot 坐标 = applyGeoTransform 结果，半径按米换算
  const marker = userLocation.computeUserLocationMarker({
    transform: T,
    longitude: 121.05,
    latitude: 31.14,
    accuracyMeters: 50,
    viewBox: VIEW_BOX,
  });
  assert.ok(marker, "校区内应返回 marker");
  assert.ok(Math.abs(marker.x - 500) < 1e-6 && Math.abs(marker.y - 400) < 1e-6, "dot 坐标应落在 viewBox 参考点");
  assert.ok(Math.abs(marker.radius - 50 * 10000 / 95150) < 1e-6, "精度圈半径按米→viewBox 换算");

  // 精度超过 500m：只画点不画圈
  const coarse = userLocation.computeUserLocationMarker({
    transform: T,
    longitude: 121.05,
    latitude: 31.14,
    accuracyMeters: 600,
    viewBox: VIEW_BOX,
  });
  assert.equal(coarse.radius, 0, "accuracy > 500m 时不画精度圈");

  // 边界值：恰好 500m 仍画圈
  const edge = userLocation.computeUserLocationMarker({
    transform: T,
    longitude: 121.05,
    latitude: 31.14,
    accuracyMeters: userLocation.MAX_ACCURACY_CIRCLE_METERS,
    viewBox: VIEW_BOX,
  });
  assert.ok(edge.radius > 0, "accuracy = 500m 边界仍画圈");

  // 非法精度（NaN / 0 / 负数）：不画圈但 dot 照出
  for (const bad of [NaN, 0, -5]) {
    const m = userLocation.computeUserLocationMarker({
      transform: T,
      longitude: 121.05,
      latitude: 31.14,
      accuracyMeters: bad,
      viewBox: VIEW_BOX,
    });
    assert.equal(m.radius, 0, `accuracy=${bad} 时不画精度圈`);
  }

  // 校区外（不在当前校区 viewBox 内）：隐藏 dot
  const outside = userLocation.computeUserLocationMarker({
    transform: T,
    longitude: 121.5, // x = 5000 > 1000
    latitude: 31.14,
    accuracyMeters: 50,
    viewBox: VIEW_BOX,
  });
  assert.equal(outside, null, "定位不在当前校区时应返回 null（dot 隐藏）");

  // 非法经纬度：隐藏 dot
  const invalid = userLocation.computeUserLocationMarker({
    transform: T,
    longitude: NaN,
    latitude: 31.14,
    accuracyMeters: 50,
    viewBox: VIEW_BOX,
  });
  assert.equal(invalid, null, "非法经纬度应返回 null");
}

// ---------------------------------------------------------------------------
// 4. campusKeyForGcj02Point：gcj02 坐标 → 属于哪个校区
// ---------------------------------------------------------------------------
{
  // 嘉定用另一组仿射 + 非零原点 viewBox：lng 121.2/lat 31.3 → 绝对坐标 (400,350)，
  // viewBox {x:100,y:50} 下相对 (300,300) 在内；宝山坐标在两组仿射下都在外。
  const T_JIADING = { a: 10000, b: 0, c: -1211600, d: 0, e: -10000, f: 313350 };
  const bounds = [
    { key: "baoshan", geoTransform: T, viewBox: { ...VIEW_BOX } },
    { key: "jiading", geoTransform: T_JIADING, viewBox: { x: 100, y: 50, width: 1000, height: 800 } },
  ];

  assert.equal(
    userLocation.campusKeyForGcj02Point(bounds, 121.05, 31.14),
    "baoshan",
    "宝山校内坐标应落在宝山",
  );
  assert.equal(
    userLocation.campusKeyForGcj02Point(bounds, 121.2, 31.3),
    "jiading",
    "嘉定校内坐标应落在嘉定（含非零原点 viewBox）",
  );
  assert.equal(
    userLocation.campusKeyForGcj02Point(bounds, 121.5, 31.14),
    null,
    "校外坐标不在任何校区",
  );
  assert.equal(
    userLocation.campusKeyForGcj02Point(bounds, NaN, 31.14),
    null,
    "非法经纬度返回 null",
  );
  assert.equal(
    userLocation.campusKeyForGcj02Point([], 121.05, 31.14),
    null,
    "空校区列表返回 null",
  );
}

console.log("miniprogram-user-location: all assertions passed");
