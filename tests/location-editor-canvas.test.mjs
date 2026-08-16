import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const canvasBundle = await build({
  absWorkingDir: root,
  entryPoints: ["src/admin/components/CampusMapCanvas.tsx"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const canvasModuleUrl = `data:text/javascript;base64,${Buffer.from(canvasBundle.outputFiles[0].contents).toString("base64")}`;
const { campusMapVersions } = await import(canvasModuleUrl);

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
  // 被静默丢弃。画布写回时清空经纬度，反之锁住画布。navigation_target 例外：它的
  // 存库形态就是经纬度，画布选点逆变换回填，因此经纬度已填时画布照常展示。
  assert.match(source, /longitude: "",\n\s+latitude: "",\n\s+origin: \{\n\s+geometryType: shape\.geometryType/);
  assert.match(source, /typedPoint && row\.role !== "navigation_target" \? \([\s\S]*?已手填经纬度/);
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
  // 0015 的触发器要求 navigation_target 必须是 GCJ02 Point：画布选点经
  // viewBoxToGcj02 逆变换回填经纬度后仍以 GCJ02 Point 存库，因此它允许点画，
  // 但只允许点，且这一行不存画布几何（见 navTargetCanvasValue / applyCanvas）。
  assert.match(table, /navigation_target: \["point"\]/);
  // footprint 必须 geometry 为空并绑已导入 feature，自由绘制仍写不进去。
  assert.doesNotMatch(table, /footprint/);
});

test("the panel heading follows the title prop", () => {
  const source = read("src/admin/components/LocationEditor.tsx");
  // 「楼外位置」「门店位置」「上车 / 下车点」三个调用方都传了 title；写死
  // <Panel title="地图位置"> 会让三处标题一起失效。
  assert.match(source, /<Panel title=\{title\}/);
  assert.doesNotMatch(source, /<Panel title="地图位置"/);
});

test("the campus canvas binds to the newest campus map, matching the release default", () => {
  // 发布中心默认选图是每校区 created_at desc, id desc 最新一张；画布曾经用列表
  // 顺序的 .find()，旧图（campus-source-v1）建得早排在前面，画出来的轮廓全绑到
  // 旧图上，发布校验直接拒。两处必须保持同一规则。
  const row = (id, campusId, createdAt, overrides = {}) => ({
    id,
    campusId,
    floorId: null,
    versionLabel: id,
    coordinateSpaceType: "svg_viewbox",
    lifecycleStatus: "published",
    createdAt,
    featureCount: 0,
    ...overrides,
  });
  const versions = campusMapVersions([
    row("map_old", "campus_jiading", "2026-07-18T00:00:00.000Z"),
    row("map_floor", "campus_jiading", "2026-08-09T00:00:00.000Z", { floorId: "floor_1" }),
    row("map_draft", "campus_jiading", "2026-08-10T00:00:00.000Z", { lifecycleStatus: "draft" }),
    row("map_other_campus", "campus_baoshan", "2026-08-11T00:00:00.000Z"),
    row("map_new", "campus_jiading", "2026-08-07T00:00:00.000Z"),
  ]);
  assert.deepEqual(
    versions.map((map) => map.id),
    ["map_other_campus", "map_new", "map_old"],
    "楼层图与草稿不参与，排序按 createdAt 倒序（与发布默认选图同规则，全局排序即可）",
  );
  const jiading = versions.find((map) => map.campusId === "campus_jiading");
  assert.equal(jiading.id, "map_new", "campusMapBinding 的 .find() 必须落到最新校园图");
});

const editorBundle = await build({
  absWorkingDir: root,
  entryPoints: ["src/admin/components/LocationEditor.tsx"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
  external: ["react", "react-dom", "react/jsx-runtime", "lucide-react", "react-router-dom"],
});
const editorFile = path.join(root, "tests", ".cache", "LocationEditor.bundle.mjs");
fs.mkdirSync(path.dirname(editorFile), { recursive: true });
fs.writeFileSync(editorFile, editorBundle.outputFiles[0].contents);
const { locationDraftFromApi } = await import(editorFile);

function rebuildNavLocation(isPrimary) {
  return {
    campusId: "campus_baoshan",
    buildingPlaceId: "place_baoshan_1st-canteen",
    role: "navigation_target",
    geometryType: "Point",
    geometry: { type: "Point", coordinates: [121.3892323, 31.3163785] },
    crs: "GCJ02",
    precisionLevel: "building",
    sourceId: "source_navigation_rebuild_calibrated_v1",
    isPrimary,
  };
}

test("locationDraftFromApi accepts the 0/1 isPrimary written by navigation rebuild", () => {
  // 生产库被 rebuild SQL 写成 "isPrimary":1。编辑器若只认 boolean，地点页
  // 一打开就是「locations[0].isPrimary must be a boolean」，全部地点都打不开。
  const fromOne = locationDraftFromApi(rebuildNavLocation(1), 0);
  const fromZero = locationDraftFromApi(rebuildNavLocation(0), 0);
  const fromTrue = locationDraftFromApi(rebuildNavLocation(true), 0);
  assert.equal(fromOne.isPrimary, true);
  assert.equal(fromZero.isPrimary, false);
  assert.equal(fromTrue.isPrimary, true);
  assert.throws(
    () => locationDraftFromApi(rebuildNavLocation("yes"), 0),
    /locations\[0\]\.isPrimary must be a boolean/,
  );
});
