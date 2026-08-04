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
const { focusPointWindow } = await import(moduleUrl);

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
