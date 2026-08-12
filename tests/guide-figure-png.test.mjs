// figure 素材 PNG 副本的契约测试。
//
// 为什么要有这个测试：小程序 <image> 不支持 SVG，而指南图示（figure 卡、
// 枢纽指引图）以 SVG 存在素材库。约定是每张 SVG 素材都有一个同源的位图副本，
// 键为「{assetKey}-png」（超长按 60 位截断再接 -png），小程序端优先取副本、
// 失败回落原键再失败显示占位。副本有两条产生路径，缺一不可：
//   1. 增量：编辑器上传 SVG 成功后浏览器 canvas 光栅化同步上传（两条上传
//      入口 —— 图示卡 ge-figfile 与枢纽指引图 uploadHubFigure —— 都要挂）；
//   2. 存量：scripts/guide-figures-rasterize.mjs 用 sharp 批量补传，
//      键规则必须与编辑器完全一致，否则同一批图两套键，小程序端对不上。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const editor = fs.readFileSync(path.join(root, "public", "guide", "editor.html"), "utf8");
const script = fs.readFileSync(path.join(root, "scripts", "guide-figures-rasterize.mjs"), "utf8");

test("editor has the svg→png companion uploader with the shared key rule", () => {
  assert.match(editor, /function figurePngKey\(/, "editor.html 缺少 figurePngKey");
  assert.match(editor, /key\.slice\(0, 60\)[\s\S]*?\+ "-png"/, "figurePngKey 规则应是 60 位截断 + -png");
  assert.match(editor, /function uploadSvgPngCompanion\(/, "editor.html 缺少 uploadSvgPngCompanion");
  assert.match(editor, /cv\.toBlob\([\s\S]*?"image\/png"/, "副本应走 canvas.toBlob 产 PNG");
});

test("both svg upload paths trigger the companion upload", () => {
  const figfile = editor.match(/ge-figfile[\s\S]*?uploadSvgPngCompanion\(key, String\(fr\.result\)\)/);
  assert.ok(figfile, "图示卡上传（ge-figfile）成功后必须补传 PNG 副本");
  const hubfig = editor.match(/function uploadHubFigure[\s\S]*?uploadSvgPngCompanion\(key, String\(fr\.result\)\)/);
  assert.ok(hubfig, "枢纽指引图上传（uploadHubFigure）成功后必须补传 PNG 副本");
});

test("batch script uses the identical key rule and only touches svg assets", () => {
  assert.match(script, /key\.slice\(0, 60\)[\s\S]*?\+ "-png"/, "脚本的 figurePngKey 规则必须与编辑器一致");
  assert.match(script, /contentType\.includes\("svg"\)/, "脚本必须只对 SVG 素材补副本");
  assert.match(script, /fetchAsset\(pngKey\)/, "脚本必须先查副本是否已存在（幂等）");
});
