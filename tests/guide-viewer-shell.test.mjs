// 指南前台外壳（public/guide/index.html）的三条行为约束。
//
//   1. 前台不给编辑器入口 —— 编辑只从管理端进，公开页不该出现 editor.html 链接；
//   2. 标题/版次等标识以管理端发布记录为准，且接口回答 404（未发布/已下线）时
//      不许拿打包种子冒充线上内容（种子只在接口够不着时兜底，并标注「离线稿」）；
//   3. 打印/PDF 字号不得退回纸质不可读的小字号（曾有 9–11px 的版本）。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viewer = fs.readFileSync(path.join(root, "public", "guide", "index.html"), "utf8");
const styles = fs.readFileSync(path.join(root, "public", "guide", "assets", "guide-styles.js"), "utf8");

test("the public viewer has no editor entry", () => {
  assert.doesNotMatch(viewer, /editor\.html/, "前台页面不得出现编辑器链接");
});

test("the viewer reads its branding from the admin-published payload", () => {
  // 顶栏大标题、版次、浏览器标签页标题、页脚版次全部优先取接口字段，
  // content.meta 只是种子兜底。
  assert.match(viewer, /info && info\.title/);
  assert.match(viewer, /info && info\.edition/);
  assert.match(viewer, /document\.title = title \+ subtitle/);
  assert.match(viewer, /info\.revisionNo === 'number'.*第 ' \+ info\.revisionNo \+ ' 版发布稿/s);
});

test("a 404 from the guide API means unpublished, never a seed fallback", () => {
  assert.match(viewer, /res\.status === 404/);
  assert.match(viewer, /该指南暂未发布或已下线/);
  assert.match(viewer, /err\.unpublished\) return splash/, "404 必须先于种子兜底返回");
  // 种子只在「接口够不着」时使用，且必须标注。
  assert.match(viewer, /setStatus\('离线稿', 'warn'\)/);
});

test("print styles stay at paper-readable sizes", () => {
  const printBlock = styles.slice(styles.indexOf("@media print"));
  const sizes = [...printBlock.matchAll(/font-size:(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
  assert.ok(sizes.length > 10, "打印样式里应有一批显式字号");
  const min = Math.min(...sizes);
  assert.ok(min >= 11, `打印最小字号 ${min}px 低于纸质可读下限 11px（≈8pt）`);
  const body = sizes.filter((n) => n >= 11 && n <= 13);
  assert.ok(body.length >= 5, "正文级字号（11–13px）应占多数");
});
