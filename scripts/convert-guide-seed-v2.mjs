// 返校指南种子数据 v1 → v2 迁移脚本。
//
// 做什么：
//   1. 读 public/guide/data/guide-seed.js（v1，IIFE + 录入助手），
//      在带假 window 的沙箱里求值拿到纯数据；
//   2. 转成 schema v2：
//      - 删除 cover / groups；cover.hubs 提升为顶层 hubs（去掉 page/entries/tail，
//        补 guideFigure / guideVideo / remark）；
//      - 每张卡片按 v1 groups[] 反查，直接挂 hub / campus 两个 id，删掉 group / page；
//      - 卡片里原有的 hub 对象 {name,note} 改名 origin，让位给 hub id 字符串；
//      - 路线卡补 note:"" 与 schedule:[]，并把线路 notes 里的「发车时刻表」
//        提取成 schedule 条目；
//      - meta 去掉 footnote / sourceNote；
//   3. 以纯数据（window.GUIDE_DATA = {...}，无助手函数）写回原文件，
//      文件头注释保留并更新到 v2 口径。
//
// 用法：node scripts/convert-guide-seed-v2.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEED = path.join(root, "public", "guide", "data", "guide-seed.js");

/* ── 读入 v1 ─────────────────────────────────────────────── */
const source = fs.readFileSync(SEED, "utf8");
const sandbox = { window: {} };
vm.runInNewContext(source, sandbox, { filename: SEED });
const v1 = sandbox.window.GUIDE_DATA;
if (!v1 || !Array.isArray(v1.cards)) {
  throw new Error("未能从 guide-seed.js 求值出 window.GUIDE_DATA");
}

/* ── meta：去掉 footnote / sourceNote ───────────────────── */
const { footnote, sourceNote, ...meta } = v1.meta;

/* ── hubs：cover.hubs 去掉 page/entries/tail，补媒体与备注字段 ── */
const hubs = v1.cover.hubs.map((h, index) => ({
  id: h.id,
  name: h.name,
  note: h.note ?? null,
  color: h.color,
  order: index + 1,
  guideFigure: null,
  guideVideo: null,
  remark: "",
}));

/* ── groups 反查表：卡片 group id → { hub, campus } ─────── */
const groupById = new Map(v1.groups.map((g) => [g.id, g]));

/* ── 发车时刻表提取 ────────────────────────────────────────
 * 两种既有写法都要吃：
 *   A. 单行："发车时刻表: 08:30  11:00  18:15  20:30"
 *   B. 多行："发车时刻表：" 后跟若干行纯时刻
 * 时刻行判定：去掉空白与冒号后只剩数字（如 "08:30  11:00"）。 */
const SCHEDULE_HEAD = /^发车时刻表\s*[:：]\s*(.*)$/;
const TIME_ROW = /^[\d\s:：]+$/;

function extractSchedule(notes, lineNo, schedules) {
  const kept = [];
  for (let i = 0; i < notes.length; i += 1) {
    const head = notes[i].match(SCHEDULE_HEAD);
    if (!head) {
      kept.push(notes[i]);
      continue;
    }
    const rows = [];
    if (head[1].trim()) rows.push(head[1].trim());
    while (i + 1 < notes.length && TIME_ROW.test(notes[i + 1]) && notes[i + 1].trim()) {
      i += 1;
      rows.push(notes[i].trim());
    }
    schedules.push({ label: `${lineNo} 发车时刻`, times: rows.join("\n") });
  }
  return kept;
}

/* ── 卡片转换 ────────────────────────────────────────────── */
let scheduleCount = 0;
const cards = v1.cards.map((card) => {
  const group = groupById.get(card.group);
  if (!group) throw new Error(`卡片 ${card.id} 引用了不存在的 group "${card.group}"`);

  const { group: _group, page: _page, ...rest } = card;
  const out = { id: rest.id, kind: rest.kind };
  if (rest.hub && typeof rest.hub === "object") out.origin = rest.hub;
  out.hub = group.hub;
  out.campus = group.campus;
  for (const key of Object.keys(rest)) {
    if (key === "id" || key === "kind" || key === "hub") continue;
    out[key] = rest[key];
  }

  if (out.kind === "route") {
    const schedules = [];
    for (const leg of out.legs || []) {
      for (const line of leg.lines || []) {
        if (!Array.isArray(line.notes)) continue;
        const kept = extractSchedule(line.notes, line.no, schedules);
        if (kept.length > 0) line.notes = kept;
        else delete line.notes;
      }
    }
    scheduleCount += schedules.length;
    out.note = "";
    out.schedule = schedules;
  }
  return out;
});

/* ── 组装 v2 ─────────────────────────────────────────────── */
const v2 = {
  schema: 2,
  meta,
  lineColors: v1.lineColors,
  campuses: v1.campuses,
  hubs,
  cards,
};

/* ── 文件头：保留数据来源/核对说明，更新到 v2 口径 ────────── */
const header = `/*
 * guide-seed.js — 返校指南电子版内容数据（schema v2 · 原子卡片架构 · 全量重录版）
 *
 * 架构要点（v2）：cards 是一个扁平数组，一张卡片只承载一条路线（或一张图示 /
 * 一组实景步骤），卡片顺序即展示与打印顺序。v1 的 groups 分段层已删除：
 * 每张卡片直接携带 hub / campus 两个 id，供顶部 Tab 二维切换与目录索引。
 * 顶层 hubs 由 v1 cover.hubs 提升而来（去掉了 PDF 目录用的 page/entries/tail），
 * 新增 guideFigure / guideVideo / remark 三个枢纽级媒体与备注字段。
 * 路线卡里 v1 的 hub 对象 {name,note} 已改名 origin，hub 现在是枢纽 id 字符串。
 *
 * 三个出口（前台展示 / 可视化编辑器 / 导出渲染）共读这一份数据。
 * 用 .js 而不是 .json 是为了 file:// 直接打开时也能加载（fetch 会被 CORS 拦）。
 *
 * ── 数据来源与核对方式（重要）─────────────────────────────────────
 * 原稿：~/Documents/返校指南/*.ai 共 21 页（导出版本/ 下有对应 PDF）。
 * 提取时发现原稿的**数字全部取不出来**：页面里的数字用 Rockwell / MyriadPro
 * 子集字体，没有 ToUnicode 表，pdftotext 一律吐 U+FFFD。所以本文件的录入方式是：
 *   1. pdftotext -layout 取版面结构（站名、方向、中文说明、线路号的拉丁数字）
 *   2. pdftocairo -png -r 200 渲染整页，再逐栏裁切、逐页目视核对
 *      所有「耗时/票价」「步行米数」「发车时刻」「出站口编号」
 * 两条通道交叉验证：结构来自文字层，数字来自渲染图。
 * 页 02 与重录前的旧数据完全一致，可作为该方法的对照样本。
 *
 * ── 尚未录入的部分（不臆造，明确标注）───────────────────────────
 * · 附表 1（原稿 18-21 页）的**车次号表**：约 60 个 D/G 字头车次，
 *   数字同样只能目视识别。车次录错会直接导致学生错过中转，风险高于其它字段，
 *   因此这里只录入教程正文，车次表标为 pending，待专门一轮双人复核后再补。
 *   见 cards 里 id="sj-appendix-transfer" 的 pending 字段。
 * · 除页 02 外各页的「示意图 / 枢纽图」矢量素材尚未裁切
 *   （scripts/extract-figures.sh 的裁切框需逐页校准），因此暂不生成图示卡片，
 *   避免出现指向缺失素材的空卡。
 */
`;

/* ── 写出：纯数据，无助手函数 ─────────────────────────────── */
const body = `window.GUIDE_DATA = ${JSON.stringify(v2, null, 2)};\n`;
fs.writeFileSync(SEED, header + body);

console.log(`v1 → v2 转换完成：`);
console.log(`  hubs:      ${hubs.length}`);
console.log(`  cards:     ${cards.length}（route ${cards.filter((c) => c.kind === "route").length} / figure ${cards.filter((c) => c.kind === "figure").length} / steps ${cards.filter((c) => c.kind === "steps").length}）`);
console.log(`  schedules: 提取 ${scheduleCount} 条发车时刻表`);
for (const c of cards) {
  for (const s of c.schedule || []) console.log(`    - ${c.id}: ${s.label}`);
}
