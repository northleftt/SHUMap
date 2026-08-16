import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 隔离区照片清理的判定逻辑（worker/modules/maintenance.ts 的 classifyQuarantineRows）。
// 判定比 SQL 更容易写错：保留期边界、未决反馈保护、墓碑 vs 删行三条规则
// 各自错一个都是数据事故（误删审核人还要看的照片 / 该删的没删）。

const bundle = await build({
  absWorkingDir: root,
  entryPoints: ["worker/modules/maintenance.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`;
const { classifyQuarantineRows, QUARANTINE_RETENTION_DAYS } = await import(moduleUrl);

const NOW = new Date("2026-08-16T00:00:00.000Z");
const old = (days) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
const row = (overwrites = {}) => ({
  id: `media_${Math.random().toString(36).slice(2)}`,
  objectKey: "quarantine/submissions/x.jpg",
  createdAt: old(QUARANTINE_RETENTION_DAYS + 1),
  submissionStatuses: [],
  ...overwrites,
});

test("未挂任何反馈的过期孤儿上传：R2 对象删 + 行删", () => {
  const plan = classifyQuarantineRows([row()], NOW);
  assert.equal(plan.delete.length, 1);
  assert.equal(plan.tombstone.length, 0);
  assert.equal(plan.protectedRows, 0);
});

test("挂在已决反馈上的过期照片：只删 R2 对象，行留墓碑（外键 restrict）", () => {
  const plan = classifyQuarantineRows([row({ submissionStatuses: ["rejected"] })], NOW);
  assert.equal(plan.tombstone.length, 1);
  assert.equal(plan.delete.length, 0);
});

test("挂在未决反馈（pending / in_review）上的照片不删：审核人还要看图", () => {
  for (const status of ["pending", "in_review"]) {
    const plan = classifyQuarantineRows([row({ submissionStatuses: [status] })], NOW);
    assert.equal(plan.tombstone.length + plan.delete.length, 0, status);
    assert.equal(plan.protectedRows, 1, status);
  }
});

test("保留期内的行不动（边界：恰好等于保留期尚未过期）", () => {
  const boundary = new Date(NOW.getTime() - QUARANTINE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const plan = classifyQuarantineRows([row({ createdAt: boundary })], NOW);
  assert.equal(plan.tombstone.length + plan.delete.length + plan.protectedRows, 0);
});

test("object_key 不在 quarantine/submissions/ 前缀下的行不动（防误伤其他 scope）", () => {
  const plan = classifyQuarantineRows([row({ objectKey: "public/media/x.jpg" })], NOW);
  assert.equal(plan.tombstone.length + plan.delete.length + plan.protectedRows, 0);
});

test("同一行挂多条反馈：任一未决即整体保护", () => {
  const plan = classifyQuarantineRows([row({ submissionStatuses: ["rejected", "in_review"] })], NOW);
  assert.equal(plan.protectedRows, 1);
  assert.equal(plan.tombstone.length + plan.delete.length, 0);
});

test("单次运行条数封顶：积压多时第二天继续", () => {
  const rows = Array.from({ length: 400 }, () => row());
  const plan = classifyQuarantineRows(rows, NOW);
  assert.equal(plan.delete.length, 300);
});
