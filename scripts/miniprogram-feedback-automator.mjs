// 原生意见反馈页回归：加载发布目标、切换反馈类型、校验提交门槛与照片状态机。
// 服务端提交会产生真实投稿，本脚本只验证提交按钮前的完整逻辑，不发送投稿。

import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import automator from "miniprogram-automator";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "tmp/feedback-test");
mkdirSync(outDir, { recursive: true });

const exceptions = [];
const consoleMessages = [];
const miniProgram = await automator.connect({ wsEndpoint: "ws://localhost:9420" });
miniProgram.on("exception", (error) => exceptions.push(error.message ?? String(error)));
miniProgram.on("console", (message) => consoleMessages.push(`${message.type}: ${message.args?.map(String).join(" ")}`));

try {
  await miniProgram.reLaunch("/pages/feedback/feedback");
  let state = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    state = await miniProgram.evaluate(() => {
      const page = getCurrentPages()[getCurrentPages().length - 1];
      return {
        loading: page.data.loading,
        error: page.data.loadError,
        buildingCount: page.buildings.length,
        stopCount: page.stops.length,
      };
    });
    if (!state.loading || state.error) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(state.error, "");
  assert.ok(state.buildingCount > 0, "反馈页应加载地点目标");
  assert.ok(state.stopCount > 0, "反馈页应加载校车站点");

  const gate = await miniProgram.evaluate(() => {
    const page = getCurrentPages()[getCurrentPages().length - 1];
    page.syncTypes("new_place");
    page.onContentInput({ detail: { value: "新增地点反馈测试" } });
    const newPlaceReady = page.data.canSubmit;
    page.syncTypes("correction");
    page.onContentInput({ detail: { value: "地点信息反馈测试" } });
    const missingTarget = page.data.canSubmit;
    page.onTargetChange({ detail: { value: 0 } });
    const targetReady = page.data.canSubmit;
    return { newPlaceReady, missingTarget, targetReady };
  });
  assert.equal(gate.newPlaceReady, true, "新增地点有足够描述时应可提交");
  assert.equal(gate.missingTarget, false, "信息纠错缺少关联地点时应禁止提交");
  assert.equal(gate.targetReady, true, "选定关联地点后应可提交");

  const photoState = await miniProgram.evaluate(() => {
    const page = getCurrentPages()[getCurrentPages().length - 1];
    page.syncPhotoState([
      { key: "p1", path: "mock://one", status: "done", mediaId: "media_one", error: "" },
      { key: "p2", path: "mock://two", status: "error", mediaId: null, error: "上传失败" },
      { key: "p3", path: "mock://three", status: "uploading", mediaId: null, error: "" },
    ]);
    const blocked = page.data.canSubmit;
    page.removePhoto({ currentTarget: { dataset: { key: "p3" } } });
    return {
      blocked,
      afterRemove: page.data.canSubmit,
      count: page.data.photos.length,
      failed: page.data.failedPhotoCount,
      canChoose: page.data.canChoosePhotos,
    };
  });
  assert.equal(photoState.blocked, false, "照片上传中应阻止提交");
  assert.equal(photoState.afterRemove, true, "移除上传中照片后应恢复提交");
  assert.equal(photoState.count, 2);
  assert.equal(photoState.failed, 1);
  assert.equal(photoState.canChoose, true);

  await miniProgram.screenshot({ path: path.join(outDir, "feedback-page.png") });
  assert.deepEqual(exceptions, [], `运行时异常：${exceptions.join("; ")}`);
  console.log(`[ok] 反馈页：${state.buildingCount} 个地点、${state.stopCount} 个站点，表单与照片状态机正常`);
  console.log(`[console] 共 ${consoleMessages.length} 条 console 消息`);
} finally {
  await miniProgram.disconnect();
}
