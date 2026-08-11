#!/usr/bin/env node
/*
 * move-scene-cards-to-hubs.mjs — 把「实景指引 / 换乘指南」步骤卡绑回枢纽
 *
 * 背景：v1 时代实景指引是 campus=scene 的独立 steps 卡片（前台有「实景指引」到达项），
 * 松江站换乘指南是 hub=appendix, campus=all 的 steps 卡。产品决定：这些内容属于枢纽本身，
 * 挂在枢纽的「实况指引」区块（hub.sceneGuide），不再作为卡片存在。
 *
 * 做的事：
 *   1. cards 里所有 kind=steps 的卡片 → 按 card.hub 摘到 hubs[].sceneGuide
 *      （保留 intro/sections/pending；同一枢纽多张时 sections 顺延合并）
 *   2. 从 cards 删除这些卡片
 *   3. campus=scene 从此没有卡片 → 从 campuses 删除「实景指引」
 * 幂等：没有 steps 卡时只报告，不改文件。
 */
import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";

const SEED = new URL("../public/guide/data/guide-seed.js", import.meta.url);
const src = readFileSync(SEED, "utf8");
const sandbox = { window: {} };
vm.runInNewContext(src, sandbox);
const data = sandbox.window.GUIDE_DATA;
if (!data || !Array.isArray(data.cards)) throw new Error("seed 数据加载失败");

const stepsCards = data.cards.filter((c) => c.kind === "steps");
if (!stepsCards.length) {
  console.log("没有 steps 卡片，无需迁移。");
  process.exit(0);
}

const hubById = new Map(data.hubs.map((h) => [h.id, h]));
let moved = 0;
for (const card of stepsCards) {
  const hub = hubById.get(card.hub);
  if (!hub) throw new Error(`steps 卡 ${card.id} 引用了不存在的枢纽 ${card.hub}`);
  if (!hub.sceneGuide) hub.sceneGuide = {};
  const sg = hub.sceneGuide;
  if (card.intro) sg.intro = sg.intro ? sg.intro + "\n" + card.intro : card.intro;
  sg.sections = (sg.sections || []).concat(card.sections || []);
  if (card.pending) sg.pending = card.pending;
  moved += 1;
  console.log(`✓ ${card.id} → hub ${hub.id}（${hub.name}），小节 ${card.sections?.length ?? 0}`);
}

data.cards = data.cards.filter((c) => c.kind !== "steps");

const beforeCampuses = data.campuses.map((c) => c.id);
data.campuses = data.campuses.filter((c) => c.id !== "scene" ||
  data.cards.some((card) => card.campus === "scene"));
if (beforeCampuses.length !== data.campuses.length) console.log("✓ 删除到达校区「实景指引」(scene)");

/* 保留文件头注释块（到第一个非注释行为止），数据体重写为纯 JSON */
const header = src.match(/^\/\*[\s\S]*?\*\//)?.[0] || "/* guide-seed.js — schema v2 */";
const body = JSON.stringify(data, null, 2);
writeFileSync(SEED, `${header}\n\nwindow.GUIDE_DATA = ${body};\n`);
console.log(`完成：迁移 ${moved} 张步骤卡，剩余卡片 ${data.cards.length} 张。`);
