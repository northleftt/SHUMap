// 指南静态页的引用完整性。
//
// 为什么要有这个测试：编辑器曾整页失效，问题来自静态资源引用，
// editor.html 引用了两个已被删改名的文件（guide-figures.js / guide-data.js）。
// 更隐蔽的是 Cloudflare Assets 对未命中路径回落 SPA 的 index.html ——
// 请求返回 200 + text/html，浏览器把 HTML 当 JS 解析报 Unexpected token '<'，
// 之后整个初始化中断。当时 34 条 guide 测试全绿，但页面是死的：这就是盲区。
//
// 这里钉住三条：
//   1. 页面引用的每个相对资源必须真实存在；
//   2. public/guide/ 下的每个 .js 至少被一个页面引用（防孤儿文件）；
//   3. 前台与编辑器引用同一份渲染层与样式（三出口共用渲染层的约束）。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUIDE_DIR = path.join(root, "public", "guide");

const pages = fs.readdirSync(GUIDE_DIR).filter((f) => f.endsWith(".html"));
assert.ok(pages.length >= 2, "public/guide/ 下应至少有前台与编辑器两个页面");

/** 页面里引用的相对资源（script src / link href），跳过绝对地址与协议地址。 */
function referencedAssets(file) {
  const html = fs.readFileSync(path.join(GUIDE_DIR, file), "utf8");
  const refs = [];
  for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) refs.push(m[1]);
  for (const m of html.matchAll(/<link[^>]+href="([^"]+)"/g)) refs.push(m[1]);
  return refs.filter((r) => !/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(r) && !r.startsWith("/"));
}

test("every asset referenced by a guide page exists on disk", () => {
  for (const page of pages) {
    for (const ref of referencedAssets(page)) {
      const p = path.join(GUIDE_DIR, ref);
      assert.ok(
        fs.existsSync(p),
        `${page} 引用了不存在的 ${ref} —— 线上会拿到 SPA 回落的 HTML 而不是 JS，整页初始化中断`,
      );
    }
  }
});

test("no page references the retired data files", () => {
  for (const page of pages) {
    const html = fs.readFileSync(path.join(GUIDE_DIR, page), "utf8");
    for (const retired of ["guide-figures.js", "data/guide-data.js"]) {
      assert.ok(
        !html.includes(retired),
        `${page} 仍引用已废弃的 ${retired}（图示走 /api/public/guide-assets/，种子改名 guide-seed.js）`,
      );
    }
  }
});

test("every js under public/guide is referenced by at least one page", () => {
  const allRefs = new Set(pages.flatMap(referencedAssets));
  const onDisk = [];
  for (const sub of ["assets", "data"]) {
    const dir = path.join(GUIDE_DIR, sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
      onDisk.push(`${sub}/${f}`);
    }
  }
  for (const file of onDisk) {
    assert.ok(allRefs.has(file), `${file} 没有被任何页面引用，是孤儿文件`);
  }
});

test("viewer and editor share the same render layer and styles", () => {
  for (const shared of ["assets/guide-render.js", "assets/guide-styles.js"]) {
    for (const page of pages) {
      assert.ok(
        referencedAssets(page).includes(shared),
        `${page} 未引用 ${shared} —— 前台 / 编辑器 / 导出必须共读同一份渲染层`,
      );
    }
  }
});
