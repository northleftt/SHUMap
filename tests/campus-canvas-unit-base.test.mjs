import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 后台校园画布的图形尺寸原先一律以 vb.w 为基准，但 preserveAspectRatio="meet" 的
// 实际缩放是 meet = min(容器宽/vb.w, 容器高/vb.h)，与 vb.w 脱钩。三个校区 viewBox
// 纵横比各不相同，于是同一容器里嘉定的选点比宝山大 ~1.4 倍（「嘉定的点异常大」）。
//
// canvasUnitBase(vb, container) = min(容器宽,容器高)/meet，使图形屏幕尺寸只随容器
// 变。注意 min(vb.w, vb.h) 是不够的：线上宝山底图较短轴是宽、meet 约束的是高，
// 两者不是同一根轴——这条 case 单独钉住，否则很容易「简化」回去。
//
// 既钉纯函数，也钉渲染层不再自己写 vb.w：后者退化不报错，只会让某校区的点又漂。

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

// CampusMapCanvas.tsx 真的 import 了 react / lucide-react，data: URL 解析不到
// node_modules，因此产物落到 tmp/ 再从那里 import。
const outFile = path.join(root, "tmp/canvas-test/campusMapCanvas.mjs");
fs.mkdirSync(path.dirname(outFile), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ["src/admin/components/CampusMapCanvas.tsx"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: outFile,
  external: ["react", "react-dom", "react-dom/*", "lucide-react"],
});
const { canvasUnitBase } = await import(`${outFile}?v=${Date.now()}`);

/**
 * 线上 /api/public/maps/:id/asset 实际下发的 viewBox（2026-08-13 实测）。
 * 宝山与仓库里 地图/宝山本部地图.svg（856×842）不同，且较短轴是**宽**——正是
 * min(vb.w,vb.h) 会翻车的那一种，所以基准数据必须用线上的这份。
 */
const VIEW_BOXES = {
  baoshan: { w: 921.6, h: 1019.7 },
  jiading: { w: 466, h: 362 },
  yanchang: { w: 1430, h: 1316 },
};

/** 后台面板的真实容器尺寸（h-[420px] 与几档面板宽度）。 */
const CONTAINERS = [
  { width: 720, height: 420 },
  { width: 560, height: 420 },
  { width: 900, height: 520 },
  { width: 1200, height: 760 },
];

/** preserveAspectRatio="xMidYMid meet" 的真实缩放：屏幕像素 / viewBox 单位。 */
function meetScale(viewBox, container) {
  return Math.min(container.width / viewBox.w, container.height / viewBox.h);
}

test("the drawn point has the same screen size on every campus", () => {
  for (const container of CONTAINERS) {
    const screenRadii = [];
    const oldScreenRadii = [];
    for (const viewBox of Object.values(VIEW_BOXES)) {
      const scale = meetScale(viewBox, container);
      // 渲染层的选点半径 = base / 200（见 CampusMapCanvas 的已完成位置点）。
      screenRadii.push((canvasUnitBase(viewBox, container) / 200) * scale);
      oldScreenRadii.push((viewBox.w / 200) * scale);
    }
    const spread = Math.max(...screenRadii) - Math.min(...screenRadii);
    assert.ok(
      spread < 1e-9,
      `容器 ${container.width}×${container.height}：各校区屏幕半径应一致，实测 ${screenRadii.map((r) => r.toFixed(4)).join(" / ")}`,
    );
    // 回归护栏：旧口径下确实有明显差异，别把这条测试改成恒真。
    assert.ok(
      Math.max(...oldScreenRadii) - Math.min(...oldScreenRadii) > 0.2,
      "旧口径应当有明显差异，否则这条测试没在测东西",
    );
  }
});

test("screen size tracks the container only, at the documented ratio", () => {
  for (const container of CONTAINERS) {
    for (const [campus, viewBox] of Object.entries(VIEW_BOXES)) {
      const px = (canvasUnitBase(viewBox, container) / 200) * meetScale(viewBox, container);
      // base/系数 × meet = min(容器宽,容器高)/系数
      assert.ok(
        Math.abs(px - Math.min(container.width, container.height) / 200) < 1e-9,
        `${campus} @ ${container.width}×${container.height}：应等于 min(容器轴)/200`,
      );
    }
  }
});

test("jiading was the outlier the old vb.w baseline inflated", () => {
  const container = { width: 720, height: 420 };
  const oldPx = (viewBox) => (viewBox.w / 200) * meetScale(viewBox, container);
  const ratio = oldPx(VIEW_BOXES.jiading) / oldPx(VIEW_BOXES.baoshan);
  // 嘉定 466×362 最「扁」，vb.w 口径下被放大得最多。
  assert.ok(ratio > 1.3 && ratio < 1.5, `旧口径嘉定/宝山 应约 1.4×，实测 ${ratio.toFixed(3)}`);
});

test("min(w,h) alone would still be wrong for the live baoshan map", () => {
  // 这条是给「以后有人想把 canvasUnitBase 简化成 min(vb.w,vb.h)」留的墓碑。
  const container = { width: 720, height: 420 };
  const naivePx = (viewBox) => (Math.min(viewBox.w, viewBox.h) / 200) * meetScale(viewBox, container);
  const ratio = naivePx(VIEW_BOXES.jiading) / naivePx(VIEW_BOXES.baoshan);
  assert.ok(
    ratio > 1.05,
    `min(w,h) 口径下宝山仍偏小（嘉定/宝山 ${ratio.toFixed(3)}），故必须带容器`,
  );
});

test("an unmeasured container still yields a positive finite base", () => {
  // 首帧容器尺寸未知：不能返回 0 / NaN，否则图形会消失或整块 svg 报错。
  for (const viewBox of Object.values(VIEW_BOXES)) {
    for (const container of [null, { width: 0, height: 0 }, { width: 720, height: 0 }]) {
      const base = canvasUnitBase(viewBox, container);
      assert.ok(Number.isFinite(base) && base > 0, `退化分支应返回正有限值，实测 ${base}`);
    }
  }
});

test("no canvas shape falls back to a raw viewBox width baseline", () => {
  const source = read("src/admin/components/CampusMapCanvas.tsx");
  // vb.w / vb.h 只应出现在 meet 反投影与 viewBox 属性里，不再用于尺寸。
  for (const match of source.matchAll(/vb\.w\s*\/\s*\d+/g)) {
    assert.fail(`渲染层仍按 viewBox 宽取尺寸基准：${match[0]}`);
  }
  assert.match(source, /const unitBase = vb \? canvasUnitBase\(vb, containerSize\) : null/, "基准必须带容器尺寸");
  assert.match(source, /unitBase: unitBase \?\? 0/, "基准要经 state 暴露给渲染层");
  assert.match(source, /unitBase: base/, "渲染层必须复用 hook 的基准，不能自己再算一份");
  // 容器尺寸必须进 state：只存 ref 不会重渲染，resize 后尺寸不更新。
  assert.match(source, /setContainerSize/, "容器尺寸要进 state");
});

test("the public map overlay is already container-only and stays that way", () => {
  // 前台图钉走 markerUnit(viewWindow)：viewWindow 由屏幕窗口换算，与 viewBox 尺寸
  // 无关，所以三校区本来就同样大——别为了「对齐」把它改成吃 viewBox。
  // 纯逻辑在 markerTiers.ts（无 React，release 装配与 node 单测直接引用）；
  // markerScale.ts 只剩用户档位 hook。
  const markerTiers = read("src/lib/map/markerTiers.ts");
  assert.match(markerTiers, /Math\.min\(view\.width, view\.height\)/);
  assert.doesNotMatch(markerTiers, /viewBox/, "前台基准不应引入 viewBox 尺寸");
});
