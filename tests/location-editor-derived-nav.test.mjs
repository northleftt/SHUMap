import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 楼栋轮廓 → 自动推导导航终点（LocationEditor 的 withDerivedNavigation）。
// isPrimary 的分配是这里最容易错的一步：契约要求每个实体恰好一个主要位置，
// 曾经的实现对「role === navigation_target」全点亮——编辑者手动加第二个导航行时
// 两行同亮，保存被拒。钉住：只有推导的那一行拿主要位置。

const bundle = await build({
  absWorkingDir: root,
  entryPoints: ["src/admin/components/LocationEditor.tsx"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
  jsx: "automatic",
  loader: { ".tsx": "tsx" },
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`;
const { withDerivedNavigation, emptyLocation } = await import(moduleUrl);

// derivedNavigationRow 需要 feature.geometryJson 可解析且能逆变换出合法经纬度；
// 构造一个多边形 + 极简恒等仿射参数（campusKey 对应 records 里有），保证推导成功。
const FEATURE = {
  id: "mf_test",
  mapVersionId: "mapver_4ba7a816ef2f46f2be71a0845330eee6",
  geometryJson: JSON.stringify({
    type: "Polygon",
    coordinates: [[[121.39, 31.31], [121.40, 31.31], [121.40, 31.32], [121.39, 31.32], [121.39, 31.31]]],
  }),
};

const campusKey = "baoshan";
const campusId = "campus_baoshan";

function rows(...overrides) {
  return overrides.map((over) => ({ ...emptyLocation(over.role ?? "primary_display"), ...over }));
}

test("从零推导：追加导航行且只有它是主要位置", () => {
  const result = withDerivedNavigation(rows({ id: "a" }), FEATURE, campusKey, campusId);
  assert.equal(result.length, 2);
  const nav = result.find((r) => r.role === "navigation_target");
  assert.ok(nav, "应追加导航终点行");
  assert.equal(nav.derived, true);
  assert.equal(result.filter((r) => r.isPrimary).length, 1, "恰好一个主要位置");
  assert.equal(nav.isPrimary, true, "主要位置是导航行");
  assert.notEqual(nav.longitude, "", "经度应由推导填入");
});

test("推导行之外又手动加了第二个导航行：重算后仍然只有推导行是主要位置", () => {
  // 真实时序：先选轮廓（产生推导行），之后编辑者手动再加一个导航行。
  // emptyLocation 默认 isPrimary=true，手动行进数组前先压成 false（契约：恰好一个）。
  const withNav = withDerivedNavigation(rows({ id: "a" }), FEATURE, campusKey, campusId);
  const manual = { ...emptyLocation("navigation_target"), id: "manual", longitude: "121.39", latitude: "31.31", isPrimary: false };
  const result = withDerivedNavigation([...withNav, manual], FEATURE, campusKey, campusId);
  const primaries = result.filter((r) => r.isPrimary);
  assert.equal(primaries.length, 1, "两行导航不能同时点亮主要位置");
  assert.equal(primaries[0].derived, true, "点亮的是推导行");
});

test("换轮廓：已存在的推导行被原地重算（保 id），不新增行", () => {
  const first = withDerivedNavigation(rows({ id: "a" }), FEATURE, campusKey, campusId);
  const navId = first.find((r) => r.role === "navigation_target").id;
  const second = withDerivedNavigation(first, FEATURE, campusKey, campusId);
  assert.equal(second.length, first.length);
  assert.equal(second.find((r) => r.role === "navigation_target").id, navId);
});

test("清空轮廓：推导行撤掉，主要位置还给剩下第一行", () => {
  const withNav = withDerivedNavigation(rows({ id: "a" }, { id: "b" }), FEATURE, campusKey, campusId);
  const cleared = withDerivedNavigation(withNav, null, campusKey, campusId);
  assert.equal(cleared.length, 2, "导航行应被撤掉");
  assert.equal(cleared.find((r) => r.role === "navigation_target"), undefined);
  assert.deepEqual(cleared.filter((r) => r.isPrimary).map((r) => r.id), ["a"]);
});

test("人工填过的导航点不被覆盖", () => {
  const manual = {
    ...emptyLocation("navigation_target"),
    id: "manual",
    longitude: "121.1234567",
    latitude: "31.1234567",
    derived: false,
  };
  const result = withDerivedNavigation(rows({ id: "a" }, manual), FEATURE, campusKey, campusId);
  assert.equal(result.length, 2, "不追加新行");
  assert.equal(result.find((r) => r.id === "manual").longitude, "121.1234567", "人工坐标原样保留");
});
