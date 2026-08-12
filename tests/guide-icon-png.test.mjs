// 图标 PNG 派生的契约测试。
//
// 为什么要有这个测试：小程序的 <image> 不支持 SVG，而指南图标以 svg 内联
// 标记存在内容里。约定是编辑器在浏览器里用 canvas 给每个 SVG 图标派生一份
// PNG data URI（ic.png），随内容进修订，小程序端优先用 ic.png 渲染。
// 这个派生是「懒补」—— 一旦被改没（比如重构 ensureIcons 或替换流程），
// 小程序端图标会静默退化成文字徽标，网页端测试却全绿。
//
// 这里钉住四条：
//   1. 编辑器有 canvas 光栅化函数 rasterizeIconPng；
//   2. ensureIcons（图标注册表的唯一入口）会触发懒补 backfillIconPngs；
//   3. 替换图标图形时作废旧 png（delete keep.png），否则旧图永远赖着；
//   4. 网页渲染层 renderIcon 仍只用 svg/uri —— png 字段只是给小程序的，
//      不能反过来影响网页端渲染。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const editor = fs.readFileSync(path.join(root, "public", "guide", "editor.html"), "utf8");
const render = fs.readFileSync(path.join(root, "public", "guide", "assets", "guide-render.js"), "utf8");

test("editor rasterizes svg icons to png data uri via canvas", () => {
  assert.match(editor, /function rasterizeIconPng\(/, "editor.html 缺少 rasterizeIconPng");
  assert.match(editor, /createElement\("canvas"\)/, "rasterizeIconPng 应走 canvas 光栅化");
  assert.match(editor, /toDataURL\("image\/png"\)/, "rasterizeIconPng 应产出 png data URI");
});

test("ensureIcons triggers lazy png backfill", () => {
  const m = editor.match(/function ensureIcons\(\) \{[\s\S]*?\n  \}/);
  assert.ok(m, "找不到 ensureIcons 函数体");
  assert.match(m[0], /backfillIconPngs\(data\.icons\)/, "ensureIcons 必须调用 backfillIconPngs —— 否则种子图标永远没有 png 副本");
});

test("replacing an icon invalidates its derived png", () => {
  assert.match(editor, /delete keep\.png;/, "替换图标图形时必须 delete keep.png，否则旧派生图会一直残留");
});

test("web renderer keeps using svg/uri and ignores png", () => {
  const m = render.match(/function renderIcon\([\s\S]*?\n  \}/);
  assert.ok(m, "找不到 renderIcon 函数体");
  assert.match(m[0], /ic\.svg/, "renderIcon 应继续使用 svg");
  assert.doesNotMatch(m[0], /ic\.png/, "网页端 renderIcon 不应消费 png 字段（那是给小程序的）");
});
