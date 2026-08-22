// 图标位图进素材库的契约测试。
//
// 背景：图标库原本把位图 base64 内联在 guide_revisions.content_json 里
// （icon.uri，以及给小程序派生的 icon.png）。实测线上第 9 版内容 753,679 字节，
// 其中 icons 占 725,673 字节 —— 96%；单看 metro-sh 一枚就是 3840×3840 的 PNG，
// base64 后 595,110 字节，而它在时间轴上只画 15px 高。内容是「一份文档」，
// 前台每次打开整份下发、每改一个字存一版新快照，位图会跟着复制 N 份。
//
// 现在图标位图和图示素材走同一条路：内容里只留 asset_key（icon-<id>），
// 位图落 R2、按 ETag 独立缓存、换图不必重新发一版内容。
//
// 这里钉住的东西，都是「改坏了网页端测试仍全绿」的那类：
//   1. 编辑器把位图光栅化后上传到 icon_png 通道，而不是塞进内容；
//   2. ensureIcons（注册表唯一入口）会触发 backfillIconAssets 补传存量；
//   3. 换图时作废 asset 键，让它重走上传落回同一个键（服务端语义即替换）；
//   4. 上传成功后删掉内联字段 —— 否则体积原样留在内容里，白改；
//   5. iconAssetKey 派生的键必须过服务端的 ASSET_KEY_PATTERN，否则 400；
//   6. 网页渲染层 asset 优先、uri 兜底（老稿仍要能显示）；
//   7. worker 与迁移都认 icon_png —— 少一边就是上传 400 或 CHECK 失败；
//   8. 小程序端按 asset 拼素材端点，且不套用图示那套 -png 派生
//      （图标素材本身就是 PNG，拼成 icon-metro-sh-png 会 404）。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

const editor = read("public", "guide", "editor.html");
const render = read("public", "guide", "assets", "guide-render.js");
const worker = read("worker", "modules", "guide.ts");
const migration = read("migrations-v2", "0022_guide_icon_assets.sql");
/* 迁移的注释里会写出「不用 create temporary table」这类说明，断言必须只看
   真正的 SQL，否则解释性文字会把 doesNotMatch 判成违规。 */
const migrationSql = migration.replace(/^\s*--.*$/gm, "");
const mpGuide = read("miniprogram", "miniprogram", "lib", "guide.ts");

/** 服务端 uploadGuideAsset 对 asset_key 的校验（worker/modules/guide.ts）。 */
const ASSET_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/** 求值渲染层，拿到 iconAssetKey / iconSrc 真身（而不是靠正则猜行为）。 */
function loadRender() {
  const noop = () => {};
  const sandbox = {
    window: { addEventListener: noop },
    document: { addEventListener: noop, getElementById: () => null, createElement: () => ({}) },
  };
  vm.runInNewContext(render, sandbox, { filename: "guide-render.js" });
  return sandbox.window.GuideRender;
}

test("editor uploads icon bitmaps to the icon_png channel instead of inlining them", () => {
  assert.match(editor, /function rasterizeIcon\(/, "editor.html 缺少 rasterizeIcon");
  assert.match(editor, /createElement\("canvas"\)/, "光栅化应走 canvas");
  assert.match(editor, /cv\.toBlob\(/, "应产出 Blob 直传，而不是 toDataURL 再内联");
  assert.match(
    editor,
    /"\/api\/admin\/guide\/assets\/" \+ encodeURIComponent\(key\) \+ "\?kind=icon_png"/,
    "图标位图必须传到 icon_png 通道",
  );
  assert.match(editor, /R\.iconAssetKey\(ic\.id\)/, "素材键应由渲染层的 iconAssetKey 统一派生");
});

test("uploading an icon asset drops the inline fields", () => {
  const m = editor.match(/function uploadIconAsset\([\s\S]*?\n  \}/);
  assert.ok(m, "找不到 uploadIconAsset 函数体");
  assert.match(m[0], /ic\.asset = key;/, "上传成功后要记下素材键");
  assert.match(m[0], /delete ic\.uri;/, "上传成功后必须删掉内联 uri —— 否则体积原样留在内容里");
  assert.match(m[0], /delete ic\.png;/, "上传成功后必须删掉旧派生 png");
});

test("ensureIcons backfills icon assets for existing inline content", () => {
  const m = editor.match(/function ensureIcons\(\) \{[\s\S]*?\n  \}/);
  assert.ok(m, "找不到 ensureIcons 函数体");
  assert.match(
    m[0],
    /backfillIconAssets\(data\.icons\)/,
    "ensureIcons 必须调用 backfillIconAssets —— 否则存量内联图标永远搬不走",
  );

  const b = editor.match(/function backfillIconAssets\([\s\S]*?\n  \}/);
  assert.ok(b, "找不到 backfillIconAssets 函数体");
  assert.match(b[0], /!ic\.asset/, "只补还没有 asset 键的图标");
  assert.match(b[0], /server\.online/, "离线时不该尝试上传");
});

test("replacing an icon graphic invalidates its asset key so the same key is re-uploaded", () => {
  assert.match(
    editor,
    /delete keep\.asset;/,
    "换图时必须 delete keep.asset，否则新图传不上去、旧图一直赖着",
  );
  assert.match(editor, /delete keep\.png;/, "旧派生位图同样作废");
});

test("iconAssetKey derives keys the server will accept", () => {
  const GR = loadRender();
  assert.equal(typeof GR.iconAssetKey, "function", "渲染层应导出 iconAssetKey");

  assert.equal(GR.iconAssetKey("metro-sh"), "icon-metro-sh");
  // id 已带 icon- 前缀时不叠加（编辑器上传时的默认 id 就是 icon-<时间戳>）
  assert.equal(GR.iconAssetKey("icon-msyr5107"), "icon-msyr5107");
  // 非法字符收敛成连字符，首尾连字符剥掉
  assert.equal(GR.iconAssetKey("Metro_SH!"), "icon-metro-sh");
  assert.equal(GR.iconAssetKey(""), null, "空 id 没有键");
  assert.equal(GR.iconAssetKey("---"), null, "全是分隔符时不该造出 icon- 这种残键");

  for (const id of ["metro-sh", "rail-sh", "icon-msyr5107", "a", "x".repeat(80)]) {
    const key = GR.iconAssetKey(id);
    if (key === null) continue;
    assert.match(key, ASSET_KEY_PATTERN, `iconAssetKey(${id}) → ${key} 过不了服务端校验`);
  }
});

test("web renderer prefers svg, then the asset key, then legacy inline uri", () => {
  const GR = loadRender();

  assert.equal(GR.iconSrc(null), null);
  assert.equal(GR.iconSrc({ id: "a", asset: "icon-metro-sh" }), "/api/public/guide-assets/icon-metro-sh");
  // 老稿（迁移前）仍要能显示
  assert.equal(GR.iconSrc({ id: "a", uri: "data:image/png;base64,AAA" }), "data:image/png;base64,AAA");
  // asset 优先于内联
  assert.equal(
    GR.iconSrc({ id: "a", asset: "icon-metro-sh", uri: "data:image/png;base64,AAA" }),
    "/api/public/guide-assets/icon-metro-sh",
  );
  assert.equal(GR.iconSrc({ id: "a", svg: "<svg/>" }), null, "矢量图标没有位图地址");

  const m = render.match(/function renderIcon\([\s\S]*?\n  \}/);
  assert.ok(m, "找不到 renderIcon 函数体");
  assert.match(m[0], /ic\.svg/, "renderIcon 应优先用矢量");
  assert.match(m[0], /iconSrc\(ic\)/, "位图分支应统一走 iconSrc");
});

test("icon_png is accepted end to end: worker kind list and the CHECK constraint", () => {
  assert.match(worker, /"figure_svg", "figure_png", "icon_svg", "icon_png"/, "worker 的 ASSET_KINDS 缺 icon_png");
  assert.match(worker, /icon_png: "image\/png"/, "icon_png 应映射到 image/png");

  assert.match(
    migration,
    /check \(asset_kind in \('figure_svg','figure_png','icon_svg','icon_png'\)\)/,
    "0022 迁移的 CHECK 必须含 icon_png",
  );
  // SQLite 改 CHECK 得重建表；D1 授权器拒 temporary table（见 validate_migration_applicability）
  assert.doesNotMatch(migrationSql, /create\s+temporary\s+table/i, "D1 拒绝 temporary table");
  assert.match(migrationSql, /alter table guide_assets_v2 rename to guide_assets/, "重建后要改回原表名");
  assert.match(migrationSql, /create index idx_guide_assets_kind/, "drop 表会带走索引，必须重建");
});

test("miniprogram resolves icon assets without the figure -png suffix dance", () => {
  assert.match(mpGuide, /export function iconSrc\(/, "小程序端应有 iconSrc");
  const m = mpGuide.match(/export function iconSrc\([\s\S]*?\n\}/);
  assert.ok(m, "找不到小程序端 iconSrc 函数体");
  assert.match(
    m[0],
    /\/api\/public\/guide-assets\/\$\{encodeURIComponent\(ic\.asset\)\}/,
    "asset 应拼成素材端点地址",
  );
  assert.doesNotMatch(m[0], /-png/, "图标素材本身就是 PNG，再派生 -png 会 404");
  assert.match(m[0], /ic\.png \|\| ic\.uri/, "老稿的内联位图仍要能显示");

  const li = mpGuide.match(/export function lineIcon\([\s\S]*?\n\}/);
  assert.ok(li, "找不到小程序端 lineIcon 函数体");
  assert.match(li[0], /iconSrc\(ic\)/, "lineIcon 应统一走 iconSrc，别自己拼一遍");
});
