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

test("an unknown stored value falls back to standard instead of drawing a broken pin", () => {
  // localStorage 可被用户手改，也可能残留旧版本写的档位键；0027 起数值（含数值
  // 字符串）是合法系数，只有解析不出来的才回落。
  for (const dirty of ["", "huge", "SMALL", null, undefined]) {
    assert.equal(markerScaleValue(dirty), 1, `脏值 ${JSON.stringify(dirty)} 应回落标准档`);
  }
});

test("continuous scales parse and clamp to range; legacy tiers keep their factors", () => {
  // 0027：管理端 per-POI 图钉大小从三档枚举改为 0.5~2.0 连续系数；
  // 0026 的存量三档字符串（DB / content / localStorage）仍按原系数读出。
  assert.equal(markerScaleValue(1.2), 1.2);
  assert.equal(markerScaleValue("1.2"), 1.2);
  assert.equal(markerScaleValue("small"), 0.72, "存量小档 = 0.72");
  assert.equal(markerScaleValue("large"), 1.35, "存量大档 = 1.35");
  assert.equal(markerScaleValue(5), 2, "超出上限夹紧");
  assert.equal(markerScaleValue(0.1), 0.5, "低于下限夹紧");
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

// ---------------------------------------------------------------------------
// 管理端 per-POI 档位（content.marker.size）：2026-08-23 新增。地点/设施/商户
// 编辑器可给单个图钉定大小，随修订→发布进 manifest 的 content，两端装配时解析。
// ---------------------------------------------------------------------------

const { markerScaleFromContent } = await import(moduleUrl);

test("admin marker scale resolves from content.marker.size with dirty-value fallback", () => {
  assert.equal(markerScaleFromContent(undefined), 1);
  assert.equal(markerScaleFromContent(null), 1);
  assert.equal(markerScaleFromContent({}), 1, "没有 marker 键 = 标准系数");
  assert.equal(markerScaleFromContent({ marker: {} }), 1);
  assert.equal(markerScaleFromContent({ marker: "large" }), 1, "marker 不是对象时回落");
  assert.equal(markerScaleFromContent({ marker: { size: "huge" } }), 1, "未知值回落标准");
  assert.equal(markerScaleFromContent({ marker: { size: "standard" } }), 1, "存量三档字符串仍按原系数读出");
  assert.ok(Math.abs(markerScaleFromContent({ marker: { size: "small" } }) - 0.72) < 1e-9);
  assert.ok(Math.abs(markerScaleFromContent({ marker: { size: "large" } }) - 1.35) < 1e-9);
  // 0027 起连续系数：数值与数值字符串直读，超出 0.5~2.0 夹紧。
  assert.ok(Math.abs(markerScaleFromContent({ marker: { size: 1.35 } }) - 1.35) < 1e-9);
  assert.ok(Math.abs(markerScaleFromContent({ marker: { size: 1.234 } }) - 1.23) < 1e-9);
  assert.equal(markerScaleFromContent({ marker: { size: 9 } }), 2);
});

test("the poi overlay applies the admin tier per pin, not globally", () => {
  const overlay = read("src/components/map/MapPoiOverlay.tsx");
  assert.match(overlay, /poi\.markerScale/, "每个图钉要乘自己的管理端系数");
  const mapData = read("src/lib/release/mapData.ts");
  for (const entity of ["place", "facility", "merchant"]) {
    assert.match(mapData, new RegExp(`markerScaleFromContent\\(${entity}\\.content\\)`), `${entity} 应从 content 解析档位`);
  }
});

test("all three admin editors expose the scale control and persist it into content", () => {
  for (const page of ["PlaceEditorPage", "FacilityEditorPage", "MerchantEditorPage"]) {
    const source = read(`src/admin/pages/${page}.tsx`);
    assert.match(source, /markerScaleFromContent/, `${page} 应从 content 回填系数`);
    assert.match(source, /MarkerScaleField/, `${page} 应复用统一滑杆控件`);
    assert.match(source, /content\.marker = \{ size: markerSize \}|next\.marker = \{ size: markerSize \}/, `${page} 保存时应写回 content.marker.size`);
  }
});
