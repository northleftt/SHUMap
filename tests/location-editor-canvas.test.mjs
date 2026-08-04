import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

// 校区图选点是 svg_viewbox 坐标的唯一录入口，也是楼外 POI 能不能出现在地图上的
// 那一步。它曾经以「import 了画布但从不渲染」的形态在仓库里待着，tsconfig 没开
// noUnusedLocals，typecheck 不会报，跑起来才发现整条链路没有入口。

test("the location editor renders the campus canvas rather than only importing it", () => {
  const source = read("src/admin/components/LocationEditor.tsx");
  assert.match(source, /<CampusMapCanvas/, "位置编辑器必须真的渲染画布");
  assert.match(source, /CANVAS_TOOLS_BY_ROLE\[row\.role\]/, "可用工具必须按当前用途决定");
  assert.match(source, /onChange=\{applyCanvas\}/, "画布产出必须写回位置行");
});

test("canvas geometry is written with the canvas CRS and its map version", () => {
  const source = read("src/admin/components/LocationEditor.tsx");
  // 渲染层只认 crs === "svg_viewbox" 且不挂楼层的点；写库时 crs 必须与
  // mapVersionId 同时给出，否则 normalizeLocationInput 直接拒。
  assert.match(source, /crs: CANVAS_CRS/);
  assert.match(source, /mapVersionId: canvasBinding\.mapVersionId/);
  assert.match(source, /campusId: canvasBinding\.campusId/);
});

test("a canvas point and typed coordinates cannot both survive on one row", () => {
  const source = read("src/admin/components/LocationEditor.tsx");
  // 两者落到同一处几何：locationInput 里手填经纬度优先，留着能同时改必然有一个
  // 被静默丢弃。画布写回时清空经纬度，反之锁住画布。
  assert.match(source, /longitude: "",\n\s+latitude: "",\n\s+origin: \{\n\s+geometryType: shape\.geometryType/);
  assert.match(source, /typedPoint \? \([\s\S]*?已手填经纬度/);
  assert.match(source, /disabled=\{disabled \|\| Boolean\(row\.mapFeatureId\) \|\| drawn\}/);
});

test("changing role or campus drops geometry that no longer applies", () => {
  const source = read("src/admin/components/LocationEditor.tsx");
  // 影响范围→主要展示位置是面变点；换校区是换坐标系。两种情况下旧几何都不再成立。
  assert.match(source, /stillAllowed/);
  assert.match(source, /withoutCanvasGeometry/);
  assert.match(source, /const patchCampus = \(campusId: string\) => patch\(index, drawn/);
});

test("roles the storage contract forbids drawing are absent from the canvas table", () => {
  const source = read("src/admin/components/LocationEditor.tsx");
  const table = source.slice(
    source.indexOf("const CANVAS_TOOLS_BY_ROLE"),
    source.indexOf("/** 该行是否已经存着画布画出来的几何。 */"),
  );
  assert.ok(table.length > 0, "找不到 CANVAS_TOOLS_BY_ROLE");
  // 0015 的触发器要求 navigation_target 必须是 GCJ02 Point，而仓库里没有
  // svg_viewbox → GCJ-02 的换算；footprint 必须 geometry 为空并绑已导入 feature。
  assert.doesNotMatch(table, /navigation_target/);
  assert.doesNotMatch(table, /footprint/);
});

test("the panel heading follows the title prop", () => {
  const source = read("src/admin/components/LocationEditor.tsx");
  // 「楼外位置」「门店位置」「上车 / 下车点」三个调用方都传了 title；写死
  // <Panel title="地图位置"> 会让三处标题一起失效。
  assert.match(source, /<Panel title=\{title\}/);
  assert.doesNotMatch(source, /<Panel title="地图位置"/);
});
