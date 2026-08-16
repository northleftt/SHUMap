import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 楼外图钉尺寸原先写死在 MapPoiOverlay 里（min(视轴)/52 与几个魔数系数），调一次
// 要改代码。现在基准与档位收在 src/lib/map/markerScale.ts，这里钉住两件事：
// 1. 换算与脏值兜底的纯逻辑；
// 2. 三处接线（叠加层用同一基准、浮卡有档位控件、MapPage 把档位传下去）——
//    任缺其一都会退回「尺寸不可控」或「两个叠加层基准漂移」，且不会报错。

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const bundled = await build({
  absWorkingDir: root,
  entryPoints: ["src/lib/map/markerScale.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`;
const {
  DEFAULT_MARKER_SCALE,
  MARKER_SCALE_OPTIONS,
  MARKER_UNIT_DIVISOR,
  markerScaleValue,
  markerUnit,
} = await import(moduleUrl);

test("marker unit tracks the shorter view axis so aspect ratio does not change pin size", () => {
  const landscape = markerUnit({ width: 1000, height: 400 });
  const portrait = markerUnit({ width: 400, height: 1000 });
  assert.equal(landscape, portrait, "较短视轴相同的两个窗口应得到同一基准");
  assert.equal(landscape, 400 / MARKER_UNIT_DIVISOR);
});

test("the scale factor multiplies the base unit", () => {
  const view = { width: 520, height: 520 };
  assert.equal(markerUnit(view), 10, "标准档基准 = 520/52");
  // 浮点乘法不给整值（10 × 0.72 = 7.199999999999999），按容差比。
  assert.ok(Math.abs(markerUnit(view, 1.35) - 13.5) < 1e-9);
  assert.ok(Math.abs(markerUnit(view, 0.72) - 7.2) < 1e-9);
  assert.equal(markerUnit(view, 1), markerUnit(view), "省略档位等于标准档");
});

test("the standard tier is neutral and the tiers are ordered small to large", () => {
  const values = MARKER_SCALE_OPTIONS.map((option) => option.value);
  assert.deepEqual([...values].sort((a, b) => a - b), values, "档位系数必须递增");
  assert.equal(markerScaleValue("standard"), 1, "标准档不缩放，否则默认视觉会变");
  assert.equal(markerScaleValue(DEFAULT_MARKER_SCALE), 1, "默认档必须是标准档");
  assert.ok(values.every((value) => value > 0), "系数必须为正，否则图钉会翻转或消失");
});

test("an unknown stored tier falls back to standard instead of drawing a broken pin", () => {
  // localStorage 可被用户手改，也可能残留旧版本写的档位键。
  for (const dirty of ["", "huge", "0.5", "SMALL"]) {
    assert.equal(markerScaleValue(dirty), 1, `脏值 ${JSON.stringify(dirty)} 应回落标准档`);
  }
});

test("both map overlays derive their size from the shared base unit", () => {
  const poiOverlay = read("src/components/map/MapPoiOverlay.tsx");
  const userOverlay = read("src/components/map/MapUserLocationOverlay.tsx");
  assert.match(poiOverlay, /markerUnit\(viewWindow, scale\)/);
  assert.match(userOverlay, /markerUnit\(viewWindow\)/);
  // 两处曾各写一遍 /52；任一处留着字面量，改基准就会只生效一半。
  for (const [file, source] of [["MapPoiOverlay", poiOverlay], ["MapUserLocationOverlay", userOverlay]]) {
    assert.doesNotMatch(source, /\/\s*52/, `${file} 不应再自己写死基准除数`);
  }
});

test("the layer panel exposes the tier control and MapPage feeds it to the overlay", () => {
  const panel = read("src/pages/map/LayerPanel.tsx");
  assert.match(panel, /MARKER_SCALE_OPTIONS\.map/, "浮卡应遍历档位而不是手写三个按钮");
  assert.match(panel, /role="radiogroup"/);
  assert.match(panel, /aria-checked=\{markerScale === option\.key\}/);
  assert.match(panel, /onSelectMarkerScale\(option\.key\)/);

  const page = read("src/pages/map/MapPage.tsx");
  assert.match(page, /useMarkerScale\(\)/);
  assert.match(page, /scale=\{markerScaleValue\(markerScale\)\}/, "档位必须真的传到叠加层");
  assert.match(page, /markerScale=\{markerScale\}/);
  assert.match(page, /onSelectMarkerScale=\{setMarkerScale\}/);
});

test("the tier is persisted under a namespaced key like the other local stores", () => {
  const source = read("src/lib/map/markerScale.ts");
  assert.match(source, /"shumap\.map-marker-scale"/);
  assert.match(source, /useLocalStore/, "复用 localStore 才能多处消费者同步");
});
