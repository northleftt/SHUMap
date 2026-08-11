// 校车页逻辑层回归：加载站点与班次、打开预览、核对站点导航可用性并截图。
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import automator from "miniprogram-automator";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "tmp/shuttle-test");
mkdirSync(outDir, { recursive: true });
const exceptions = [];
const miniProgram = await automator.connect({ wsEndpoint: "ws://localhost:9420" });
miniProgram.on("exception", (error) => exceptions.push(error.message ?? String(error)));

try {
  await miniProgram.reLaunch("/pages/shuttle/shuttle");
  let state = null;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    state = await miniProgram.evaluate(() => {
      const page = getCurrentPages()[getCurrentPages().length - 1];
      return {
        loading: page.data.loading,
        errorMessage: page.data.errorMessage,
        stopCount: page.stops.length,
        scheduleCount: page.schedules.length,
        navigableStopCount: page.stops.filter((stop) => Boolean(stop.navigationPoint)).length,
      };
    });
    if (!state.loading && state.stopCount > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(state.errorMessage, "");
  assert.ok(state.stopCount > 0, "应加载站点");
  if (state.scheduleCount > 0) {
    await miniProgram.evaluate(() => {
      const page = getCurrentPages()[getCurrentPages().length - 1];
      page.openPreview(page.schedules[0]);
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const preview = await miniProgram.evaluate(() => {
      const page = getCurrentPages()[getCurrentPages().length - 1];
      return {
        visible: page.data.previewVisible,
        loading: page.data.previewLoading,
        error: page.data.previewError,
      };
    });
    assert.equal(preview.visible, true);
    assert.equal(preview.loading, false);
    assert.equal(preview.error, "");
  }
  await miniProgram.screenshot({ path: path.join(outDir, "shuttle-page.png") });
  assert.deepEqual(exceptions, [], `运行时异常：${exceptions.join("; ")}`);
  console.log(`[ok] 校车页：${state.stopCount} 个站点，${state.navigableStopCount} 个可直接导航`);
} finally {
  await miniProgram.disconnect();
}
