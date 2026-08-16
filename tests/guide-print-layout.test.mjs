// 打印排版模块（guide-print-layout.js）的分页契约 + 编辑器/前台的接线约束。
//
// 为什么钉这个：PDF 错版的根因是分页曾整个交给浏览器打印引擎 —— 双列卡片靠
// inline-block + nth-child 奇偶配对，某张卡被 break-inside:avoid 挤到下一页后
// 配对整体漂移。现在分页由 pack() 显式完成（卡片在 JS 里配成行、行是最小分页
// 单位），编辑器「排版预览」与真实打印共用同一棵分页后的 DOM。这里钉住：
//   1. pack 纯函数的配对 / breakBefore / keepWithNext / 超高告警行为；
//   2. 样式表里这套机制赖以工作的类名与 @media print 的显隐切换；
//   3. 编辑器与前台确实接了排版模块，打印路径都走 GuidePrintLayout.layout。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const layoutFile = path.join(root, "public", "guide", "assets", "guide-print-layout.js");
const stylesFile = path.join(root, "public", "guide", "assets", "guide-styles.js");
const renderFile = path.join(root, "public", "guide", "assets", "guide-render.js");
const editorFile = path.join(root, "public", "guide", "editor.html");
const viewerFile = path.join(root, "public", "guide", "index.html");

const PAGE = 273;   // A4 297 − 12mm×2 页边距

function loadLayout() {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(layoutFile, "utf8"), sandbox, { filename: layoutFile });
  return sandbox.window.GuidePrintLayout;
}

const card = (id, hmm, extra) => ({ type: "card", id, hmm, ...extra });
/* 模块在 vm 里求值，返回的数组原型与本域不同 —— JSON 过一遍再比 */
const plain = (v) => JSON.parse(JSON.stringify(v));
const rowIds = (u) => plain(u.cards.map((c) => c.id));

test("guide-print-layout.js exposes pack/layout and the page constants", () => {
  const PL = loadLayout();
  assert.ok(PL, "应求值出 window.GuidePrintLayout");
  assert.equal(typeof PL.pack, "function");
  assert.equal(typeof PL.layout, "function");
  assert.equal(PL.PAGE_W_MM, 186);
  assert.equal(PL.PAGE_H_MM, 273);
});

test("pack pairs cards into rows; row height = max + gap; full rows move to next page", () => {
  const r = loadLayout().pack([
    { type: "band", id: "hub:h", hmm: 20, keepWithNext: true },
    card("a", 100), card("b", 150),   // 行高 150 + 4 = 154
    card("c", 100),                   // 落单行 104
  ], PAGE);
  // 20 + 154 + 104 = 278 > 273 → 最后一行整行推到第 2 页，不拆行
  assert.equal(r.pages.length, 2);
  assert.deepEqual(rowIds(r.pages[0][1]), ["a", "b"]);
  assert.equal(r.pages[0][1].hmm, 154);
  assert.deepEqual(rowIds(r.pages[1][0]), ["c"]);
});

test("pack: breakBefore on a card starts a new row on a new page", () => {
  const r = loadLayout().pack([
    card("a", 50), card("b", 50, { breakBefore: true }), card("c", 50),
  ], PAGE);
  assert.equal(r.pages.length, 2);
  assert.deepEqual(rowIds(r.pages[0][0]), ["a"], "b 的 breakBefore 让 a 落单行");
  assert.deepEqual(rowIds(r.pages[1][0]), ["b", "c"], "b 从新的一页起，与 c 正常配对");
});

test("pack: span:2 card takes a row of its own", () => {
  const r = loadLayout().pack([
    card("a", 40), card("fig", 100, { span: 2 }), card("b", 40), card("c", 40),
  ], PAGE);
  const rows = r.pages[0].filter((u) => u.type === "row");
  assert.deepEqual(plain(rows.map(rowIds)), [["a"], ["fig"], ["b", "c"]]);
});

test("pack: band with keepWithNext is not stranded at a page bottom", () => {
  const r = loadLayout().pack([
    card("a", 240),
    { type: "band", id: "hub:x", hmm: 20, keepWithNext: true },
    card("b", 50),
  ], PAGE);
  // 244 + 20 + 54 = 318 > 273：页 1 剩余 29mm 放不下「色带 + 下一行」，
  // 色带必须跟随后继内容去第 2 页，不许孤悬页尾
  assert.equal(r.pages.length, 2);
  assert.deepEqual(plain(r.pages[0].map((u) => u.type)), ["row"]);
  assert.deepEqual(plain(r.pages[1].map((u) => u.type)), ["band", "row"]);
});

test("pack: the title page always stands alone as page 1", () => {
  const r = loadLayout().pack([{ type: "title", hmm: 100 }, card("a", 50)], PAGE);
  assert.deepEqual(plain(r.pages.map((p) => p.map((u) => u.type))), [["title"], ["row"]]);
});

test("pack: blocks taller than a page are placed anyway and reported as overflows", () => {
  const r = loadLayout().pack([{ type: "block", id: "sec:1", hmm: 300 }, card("a", 50)], PAGE);
  assert.equal(r.overflows.length, 1);
  assert.equal(r.overflows[0].id, "sec:1");
  assert.equal(r.overflows[0].hmm, 300);
  assert.equal(r.pages.length, 2, "超高块照放，后续内容正常续排");
});

test("guide-styles.js carries the paged-print vocabulary", () => {
  const css = fs.readFileSync(stylesFile, "utf8");
  for (const sel of [".gc-print-page", ".gc-print-page__no", ".gc-print-overflow",
    'data-span="2"', ".gc-print-root.gc-on", "@page"]) {
    assert.ok(css.includes(sel), `CSS 缺少 ${sel}`);
  }
  const printBlock = css.slice(css.lastIndexOf("@media print"));
  assert.ok(printBlock.includes("#gc-screen"), "打印时必须隐藏屏幕 UI");
  assert.ok(printBlock.includes(".gc-print-root{display:block!important}"),
    "打印时必须显示打印树");
  assert.ok(printBlock.includes(".gc-print-page{break-after:page"),
    "每个页容器末尾应强制断页");
  assert.ok(printBlock.includes(".ge-pgtool"), "排版工具条不得出现在 PDF 里");
  // 版式规则必须常显（排版预览在屏幕上测量），不能缩回 @media print 里
  // （注意用 lastIndexOf：段头注释里提到了 @media print 字样）
  assert.ok(css.indexOf(".gc-print-cards>.gc-card") < css.lastIndexOf("@media print"),
    "卡片版式规则应在 @media print 之外");
});

test("buildPrintRoot annotates back-reference ids for the layout tool", () => {
  const render = fs.readFileSync(renderFile, "utf8");
  assert.ok(render.includes('"data-hub-id"'), "打印树枢纽节应带 data-hub-id");
  assert.ok(render.includes("dataset.cardId"), "打印卡片应带 data-card-id");
});

test("editor wires the layout preview mode and writes settings back to data", () => {
  const editor = fs.readFileSync(editorFile, "utf8");
  assert.ok(editor.includes("guide-print-layout.js"), "编辑器应加载排版模块");
  assert.ok(editor.includes('id="ge-layout"'), "顶栏应有「排版预览」按钮");
  assert.ok(editor.includes("renderLayoutPreview"), "编辑器应有排版预览渲染");
  assert.ok(editor.includes("GuidePrintLayout.layout"), "打印路径应走显式分页");
  assert.ok(editor.includes("printBreakBefore"), "「新起一页」应写回 hub/card 数据");
  assert.ok(editor.includes("printSpan"), "「独占整行」应写回 card 数据");
  assert.ok(editor.includes("printDensity"), "「密度」应写回 card 数据");
  assert.ok(editor.includes("printImgW"), "「图片大小」应写回 card 数据");
});

test("per-card print prefs: density classes in CSS, applied before measurement", () => {
  const css = fs.readFileSync(stylesFile, "utf8");
  assert.ok(css.includes('[data-density="compact"]'), "CSS 应有紧凑密度规则");
  assert.ok(css.includes('[data-density="loose"]'), "CSS 应有宽松密度规则");
  const layoutSrc = fs.readFileSync(layoutFile, "utf8");
  assert.ok(layoutSrc.includes("applyPrintPrefs"), "排版模块应应用 per-card 偏好");
  assert.ok(layoutSrc.includes("printDensity") && layoutSrc.includes("printImgW"));
  // 偏好必须先于测量应用，否则量到的高度不是打印高度
  assert.ok(layoutSrc.indexOf("applyPrintPrefs(raw, data)") < layoutSrc.indexOf("collectUnits(raw"),
    "applyPrintPrefs 必须先于 collectUnits 测量");
});

test("empty remark (whitespace-only HTML) is not rendered", () => {
  const render = fs.readFileSync(renderFile, "utf8");
  // renderRemark 判空要看可见内容（文字或图片），而不是 HTML 字符串 trim
  assert.ok(/probe\.textContent\.trim\(\)\s*\|\|\s*!!probe\.querySelector\("img"\)/.test(render),
    "renderRemark 应按可见内容判空");
});

test("scene guide images carry size fields and back-reference paths", () => {
  const render = fs.readFileSync(renderFile, "utf8");
  assert.ok(render.includes("figPath"), "sceneGuide 图片应带 data-fig-path 回溯标注");
  assert.ok(render.includes("figW"), "步骤配图应支持 figW 宽度字段");
  assert.ok(/f\.w\s*&&\s*f\.w\s*<\s*100/.test(render), "小节照片应支持 w 宽度字段");
  // 尺寸在渲染层直接生效：前台 / 编辑器 / PDF 同一棵树
  assert.ok(render.includes('hubId + "|" + si + "|figures|" + fi'), "小节照片应标注回溯路径");
  const editor = fs.readFileSync(editorFile, "utf8");
  assert.ok(editor.includes("attachFigResize"), "编辑器应有实况指引图片缩放工具");
  assert.ok(/attachHotDrag\(body\);\s*\n\s*attachFigResize\(body\)/.test(editor),
    "组合预览（web）应挂图片缩放工具");
  assert.ok(editor.includes("attachFigResize(res.root)"), "排版预览（PDF）应挂图片缩放工具");
});

test("viewer exports PDF through the layout module", () => {
  const viewer = fs.readFileSync(viewerFile, "utf8");
  assert.ok(viewer.includes("guide-print-layout.js"), "前台应加载排版模块");
  assert.ok(viewer.includes("GuidePrintLayout.layout"), "前台导出 PDF 应走显式分页");
});

test("step figures: multi-photo layout wraps and crops uniformly", () => {
  const css = fs.readFileSync(stylesFile, "utf8");
  assert.ok(css.includes(".gc-step__figs{display:flex;flex-wrap:wrap"),
    "步骤多图应允许换行");
  assert.ok(/\.gc-step__fig\{flex:1 1 30%[^}]*aspect-ratio:4\/3/.test(css),
    "步骤多图应统一 4/3 裁切对齐（点开灯效看原图）");
  const render = fs.readFileSync(renderFile, "utf8");
  assert.ok(render.includes("Array.isArray(ref)"), "渲染层应支持 figure 为字符串数组");
});

test("editor step figures: multi-photo management UI and append upload", () => {
  const editor = fs.readFileSync(editorFile, "utf8");
  assert.ok(editor.includes("+ 再加一张"), "步骤配图应有「再加一张」按钮");
  assert.ok(editor.includes("dataset.stepFigArray"), "应有步骤多图追加上传模式");
  assert.ok(editor.includes('pickFigure(Array.isArray(cur) ? path + "." + i : path)'),
    "多图模式下应能逐张替换");
  assert.ok(editor.includes("cur.splice(i, 1)"), "多图模式下应能逐张删除");
  // 上传回填：figure 字段规范成数组后 push 字符串 key
  assert.ok(/setPath\(stepFigArray, list\);\s*\n\s*list\.push\(key\)/.test(editor),
    "追加模式应规范成数组再 push");
  // 旧模式不受影响：单值替换与 sections figures 数组追加都在
  assert.ok(editor.includes("list.push({ src: key, caption: \"\" })"), "小节照片追加模式应保持");
});
