#!/usr/bin/env node
/*
 * wire-scene-figures.mjs — 给 sceneGuide 的步骤/小节接上实景照片
 *
 * 照片来自原稿 PDF（返校指南2025秋/上海大学新生入校交通指南 2025秋季版.pdf，
 * pdfimages -j 提取，p5/9/13/17），已拷入 public/guide/figures/scene/。
 * 接线规则（与原稿版面逐张目核）：
 *   step.figure   = 静态路径字符串或字符串数组（一步多图，如南站第 6 步两张）
 *   section.figures = [{ src, caption }]（上海站：三张照片是小节级，不属于某一步）
 * 幂等：重复运行只是覆盖同样的字段。
 */
import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";

const SEED = new URL("../public/guide/data/guide-seed.js", import.meta.url);
const B = "/guide/figures/scene/";
const src = readFileSync(SEED, "utf8");
const sandbox = { window: {} };
vm.runInNewContext(src, sandbox);
const data = sandbox.window.GUIDE_DATA;

const hub = (id) => data.hubs.find((h) => h.id === id);
const sec = (id, i) => hub(id).sceneGuide.sections[i];

/* 虹桥：8 张与 8 步一一对应 */
sec("hongqiao", 0).steps.forEach((st, i) => (st.figure = `${B}hongqiao-west-${i + 1}.jpg`));
sec("hongqiao", 1).steps.forEach((st, i) => (st.figure = `${B}hongqiao-east-${i + 1}.jpg`));

/* 上海站：三张照片是小节级（出站口指示牌），配说明 */
sec("shanghai-railway", 0).figures = [
  { src: `${B}shanghai-exit-ne-1.jpg`, caption: "↑ 东北、东南出口" },
  { src: `${B}shanghai-exit-ne-2.jpg`, caption: "↑ 东北、东南出口" },
  { src: `${B}shanghai-exit-sw.jpg`, caption: "↑ 西北、西南出口" },
];

/* 上海南站：种子步骤顺序与原稿版面不同（2↔4 等），按内容对应；第 6 步两张 */
sec("shanghai-south", 0).steps.forEach((st, i) => {
  st.figure = [`${B}south-1.jpg`, `${B}south-2.jpg`, `${B}south-3.jpg`, `${B}south-4.jpg`,
    `${B}south-5.jpg`, [`${B}south-6a.jpg`, `${B}south-6b.jpg`]][i];
});

/* 浦东机场：第 3 步两张（地铁 B 厅 + 联络通道中庭），出入口小节首步一张 */
const pd1 = sec("pudong-airport", 0).steps;
pd1[0].figure = `${B}pudong-1.jpg`;
pd1[1].figure = `${B}pudong-2.jpg`;
pd1[2].figure = [`${B}pudong-3a.jpg`, `${B}pudong-3b.jpg`];
sec("pudong-airport", 1).steps[0].figure = `${B}pudong-gate.jpg`;

const header = src.match(/^\/\*[\s\S]*?\*\//)?.[0] || "/* guide-seed.js — schema v2 */";
writeFileSync(SEED, `${header}\n\nwindow.GUIDE_DATA = ${JSON.stringify(data, null, 2)};\n`);

let stepFigs = 0;
for (const h of data.hubs)
  for (const s of h.sceneGuide?.sections || [])
    stepFigs += s.steps.filter((st) => st.figure).length;
console.log(`完成：${stepFigs} 个步骤配图 + 上海站小节 ${sec("shanghai-railway", 0).figures.length} 张。`);
