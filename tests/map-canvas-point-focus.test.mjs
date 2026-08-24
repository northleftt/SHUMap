import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundled = await build({
  absWorkingDir: root,
  entryPoints: ["src/components/map/MapCanvas.tsx"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`;
const { clampWindow, focusPointWindow } = await import(moduleUrl);

test("point focus centers a selected outdoor POI inside the unobscured map area", () => {
  const result = focusPointWindow({
    point: { x: 500, y: 400 },
    currentWindow: { x: 0, y: 0, width: 1000, height: 800 },
    viewBox: { width: 1000, height: 800 },
    container: { width: 400, height: 800 },
    selectionScaleMultiplier: 2,
    selectionEdgePaddingRatio: 0.3,
    selectionFocusBounds: { top: 80, bottom: 480 },
  });

  assert.deepEqual(result, { x: 250, y: 50, width: 500, height: 1000 });
  const selectedScreenY = ((400 - result.y) / result.height) * 800;
  assert.equal(selectedScreenY, 280);
});

test("point focus keeps an edge POI inside the configured map padding", () => {
  const result = focusPointWindow({
    point: { x: 5, y: 5 },
    currentWindow: { x: 0, y: 0, width: 500, height: 500 },
    viewBox: { width: 1000, height: 1000 },
    container: { width: 500, height: 500 },
    selectionScaleMultiplier: 2,
    selectionEdgePaddingRatio: 0.1,
  });

  assert.equal(result.x, -100);
  assert.equal(result.y, -100);
  assert.equal(result.width, 500);
  assert.equal(result.height, 500);
});

/**
 * 最小缩放档的留白必须四边对称。
 *
 * 三个校区底图的纵横比都和手机屏不同，最小缩放时短轴装不满容器，必然有留白。
 * 旧式 clampWindow 把纵轴允许区间写成 [-padY, max(0, viewBox-window)+padY]，
 * 而窗口比 viewBox 高时 max(...) 为 0，区间 [-padY, padY] 的中心是 0 —— 也就是
 * 把 viewBox 顶边钉在容器顶边，留白全被挤到下方。实测就是延长/宝山最小缩放时
 * 「下面一大片空白能拖，上面没有」。
 *
 * 这里直接钉住上下（左右）两端的拖动极限所露出的空白相等。
 */
test("at minimum zoom the draggable padding is symmetric on all four sides", () => {
  // 延长校区量级的底图：viewBox 比窗口矮，纵轴放不满
  const viewBox = { width: 1430, height: 1316 };
  const window = { x: 0, y: 0, width: 1430, height: 2000 };
  const padRatio = 0.2;

  const top = clampWindow({ ...window, y: -1e6 }, viewBox, padRatio);
  const bottom = clampWindow({ ...window, y: 1e6 }, viewBox, padRatio);
  // 顶端拖到极限时 viewBox 上方露出的空白 = -y；底端拖到极限时下方露出的空白
  const topGap = -top.y;
  const bottomGap = bottom.y + window.height - viewBox.height;
  assert.ok(
    Math.abs(topGap - bottomGap) < 1e-9,
    `上下两个拖动极限应对称：上端露白 ${topGap}，下端露白 ${bottomGap}`,
  );
  // 且极限位置本身对称于「viewBox 居中」那一点
  const center = (viewBox.height - window.height) / 2;
  assert.ok(Math.abs((top.y + bottom.y) / 2 - center) < 1e-9, "两个极限的中点应是居中位");

  // 横轴同理（宽度也放不满时）
  const narrow = { x: 0, y: 0, width: 2000, height: 1316 };
  const left = clampWindow({ ...narrow, x: -1e6 }, viewBox, padRatio);
  const right = clampWindow({ ...narrow, x: 1e6 }, viewBox, padRatio);
  assert.ok(
    Math.abs(-left.x - (right.x + narrow.width - viewBox.width)) < 1e-9,
    "左右两个拖动极限应对称",
  );
});

/**
 * 放大态（窗口比 viewBox 小）的边界一个数都不能变：那是日常平移的手感，
 * 上面的居中改法只应影响「装不满」的最小缩放档。
 */
test("when zoomed in the pan limits keep the historical padding bounds", () => {
  const viewBox = { width: 921.6, height: 1019.7 };
  const window = { x: 0, y: 0, width: 400, height: 700 };
  const padRatio = 0.18;

  const min = clampWindow({ ...window, x: -1e6, y: -1e6 }, viewBox, padRatio);
  assert.equal(min.x, -viewBox.width * padRatio);
  assert.equal(min.y, -viewBox.height * padRatio);

  const max = clampWindow({ ...window, x: 1e6, y: 1e6 }, viewBox, padRatio);
  assert.equal(max.x, viewBox.width - window.width + viewBox.width * padRatio);
  assert.equal(max.y, viewBox.height - window.height + viewBox.height * padRatio);
});
