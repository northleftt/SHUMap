#!/usr/bin/env node
// 存量指南内容里的内联图标位图搬进素材库。
//
// 背景：图标库原本把位图 base64 内联在 guide_revisions.content_json 里
// （icon.uri，以及给小程序派生的 icon.png）。实测线上第 9 版内容 753,679 字节，
// icons 占 725,673 —— 96%。单看 metro-sh 一枚：3840×3840 的 PNG，base64 后
// 595,110 字节，而它在时间轴上只画 15px 高。内容是「一份文档」，前台每次打开
// 整份下发、每改一个字存一版新快照，位图会跟着复制 N 份。
//
// 迁移后：内容里每枚图标只留 asset 键（icon-<id>），位图落 R2 走素材端点
// （ETag + 独立缓存），换图连内容都不必重新发一版。
//
// 这个脚本只补存量。编辑器已内建同样的迁移（ensureIcons → backfillIconAssets）：
// 有 write:content 的人打开一次编辑器就会自动补传并写进草稿。脚本是给不想
// 开浏览器、或想先看清楚会改成什么样的场合。
//
// 做法与 guide-figures-rasterize.mjs 一致：位图用 sharp 光栅化到 96px 高
// （显示 15–34px，3x 屏够用），然后 wrangler 直写 R2 + D1 —— 等价于
// worker/modules/guide.ts uploadGuideAsset 的写入路径，区别是绕过管理端鉴权，
// 所以要在有 wrangler 登录态的维护机上跑。
//
// 内容本身不由脚本改写线上库：guide_revisions 是走「存草稿 → 送审 → 发布」
// 的，绕过去直接 update content_json 会让审核记录对不上正在线上的内容。
// 脚本产出改写后的 JSON，由有权限的人在编辑器里「载入 JSON」→ 保存 → 送审。
//
// 用法：
//   node scripts/guide-icons-to-assets.mjs --dry-run
//   node scripts/guide-icons-to-assets.mjs --from tmp/guide-rev10.json --dry-run
//   node scripts/guide-icons-to-assets.mjs --out tmp/guide-icons-migrated.json
//   node scripts/guide-icons-to-assets.mjs --self-test
//
//   --from <file>  从本地文件读内容（导出的修订 JSON 或内容本体），不打线上
//   --out <file>   写出改写后的内容 JSON（默认 output/guide-icons-migrated.json）
//   --dry-run      只算不写：不传 R2/D1，也不写出文件
//   --api <url>    线上站点（默认 https://map.shutf.com）
//   --self-test    离线自检：合成一枚真 PNG 跑完整改写，断言键/比例/字段/体积
//
// 为什么要有 --self-test：改写内容形状的代码，跑一次真迁移才能发现写错，而真
// 迁移要 wrangler 登录态 + 线上库。自检把「派生键、回算 ratio、删内联字段、
// 体积确实降下来」这几条钉在 npm test 里（同 diagnose_split_completeness 的做法）。
//
// 依赖：sharp、wrangler 登录态、D1 库名 shumap-v2、R2 bucket shumap-assets。

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

const DRY_RUN = args.includes("--dry-run");
const FROM = flag("--from");
const OUT = flag("--out") || "output/guide-icons-migrated.json";
const API = flag("--api") || "https://map.shutf.com";
const SLUG = process.env.GUIDE_SLUG || "freshman-transit";
const DB = "shumap-v2";
const BUCKET = "shumap-assets";
const OBJECT_PREFIX = "public/guide-assets/";

/** 位图光栅化后的高度。与编辑器的 ICON_RASTER_H 一致（显示 15–34px，3x 屏够用）。 */
const ICON_RASTER_H = 96;

/** 与 public/guide/assets/guide-render.js 的 iconAssetKey 保持一致。 */
function iconAssetKey(id) {
  const base = String(id || "").toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!base) return null;
  let key = /^icon-/.test(base) ? base : `icon-${base}`;
  if (key.length > 64) key = key.slice(0, 64);
  key = key.replace(/-+$/, "");
  return key.length >= 3 ? key : null;
}

function wrangler(argsList) {
  return execFileSync("npx", ["wrangler", ...argsList], {
    cwd: root,
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
  });
}

/**
 * 从任意信封里挖出指南内容。支持：
 *   内容本体                        {schema:2, cards:[…]}
 *   公开接口 / 编辑器导出的修订      {content:{…}} / {meta,data}
 *   wrangler d1 execute --json 的输出 [{results:[{content_json:"…"}]}]
 */
function unwrapContent(value) {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = unwrapContent(item);
      if (found) return found;
    }
    return null;
  }
  if (Array.isArray(value.cards)) return value;
  if (typeof value.content_json === "string") return unwrapContent(JSON.parse(value.content_json));
  for (const key of ["content", "data", "results"]) {
    if (value[key] !== undefined) {
      const found = unwrapContent(value[key]);
      if (found) return found;
    }
  }
  return null;
}

function dataUriToBuffer(uri) {
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/i.exec(String(uri || ""));
  if (!m) return null;
  return m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8");
}

/** 一枚图标的位图源：内联 uri 优先（原始上传件），其次编辑器派生的 png。 */
function iconBitmap(ic) {
  for (const field of ["uri", "png"]) {
    if (typeof ic[field] === "string" && ic[field].startsWith("data:")) {
      const buf = dataUriToBuffer(ic[field]);
      if (buf && buf.length) return { field, bytes: buf };
    }
  }
  return null;
}

async function loadContent() {
  if (FROM) {
    const raw = fs.readFileSync(path.isAbsolute(FROM) ? FROM : path.join(root, FROM), "utf8");
    const content = unwrapContent(JSON.parse(raw));
    if (!content) throw new Error(`${FROM} 里找不到指南内容（要有 cards 数组）`);
    return { content, source: FROM };
  }
  const res = await fetch(`${API}/api/public/guide/${SLUG}`);
  if (!res.ok) throw new Error(`GET /api/public/guide/${SLUG} → HTTP ${res.status}`);
  const content = unwrapContent(await res.json());
  if (!content) throw new Error("线上内容里找不到 cards 数组");
  return { content, source: `${API}/api/public/guide/${SLUG}` };
}

/** 素材是否已在线上（幂等：重跑不重复上传）。 */
async function assetExists(key) {
  const res = await fetch(`${API}/api/public/guide-assets/${encodeURIComponent(key)}`);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`GET asset ${key} → HTTP ${res.status}`);
  return true;
}

function uploadAsset(key, png, meta) {
  const uuid = crypto.randomUUID().replaceAll("-", "");
  const mediaId = `media_${uuid}`;
  const objectKey = `${OBJECT_PREFIX}${mediaId}.png`;
  const now = new Date().toISOString();
  const sha = crypto.createHash("sha256").update(png).digest("hex");
  const tmpFile = path.join(os.tmpdir(), `${mediaId}.png`);
  fs.writeFileSync(tmpFile, png);
  try {
    wrangler(["r2", "object", "put", `${BUCKET}/${objectKey}`,
      "--file", tmpFile, "--content-type", "image/png", "--remote"]);
    wrangler(["d1", "execute", DB, "--remote", "--command",
      "insert into media_assets(id,bucket_scope,object_key,original_name,content_type," +
      "byte_size,sha256,status,uploaded_by,created_at,approved_at) " +
      `values('${mediaId}','public','${objectKey}','${key}','image/png',${png.length},` +
      `'${sha}','published',null,'${now}','${now}')`]);
    wrangler(["d1", "execute", DB, "--remote", "--command",
      "insert into guide_assets(id,asset_key,asset_kind,media_asset_id,metadata_json," +
      "created_by,created_at,updated_at) " +
      `values('gasset_${uuid}','${key}','icon_png','${mediaId}',` +
      `'${JSON.stringify({ pixelWidth: meta.width, pixelHeight: meta.height })}',` +
      `null,'${now}','${now}')`]);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

/**
 * 就地把 content.icons 里的内联位图改成素材引用。
 *
 * publish(key, png, meta) 是唯一的副作用出口：真迁移传「查重 + wrangler 直写」，
 * dry-run 与自检传空实现。内容改写与上传因此能分开验证 —— 自检不碰网络也能
 * 断言改写后的形状对不对。
 *
 * 返回逐枚的处理结果，调用方负责打印（脚本要人读，自检要断言）。
 */
async function migrateIcons(content, publish) {
  const icons = Array.isArray(content.icons) ? content.icons : [];
  const results = [];

  for (const ic of icons) {
    const inlineBytes = ["uri", "png"].reduce(
      (sum, f) => sum + (typeof ic[f] === "string" ? ic[f].length : 0), 0);

    if (ic.asset) {
      results.push({ id: ic.id, skipped: `已引用素材 ${ic.asset}` });
      continue;
    }
    const bitmap = iconBitmap(ic);
    if (!bitmap) {
      /* 只有 svg 的图标本来就不占体积（矢量标记通常几百字节），留在内容里
         反而更好：网页端能跟随 currentColor。小程序端由编辑器补 asset。 */
      results.push({ id: ic.id, skipped: `没有内联位图（${ic.svg ? "矢量图标" : "无图形"}）` });
      continue;
    }
    const key = iconAssetKey(ic.id);
    if (!key) {
      results.push({ id: ic.id, skipped: "派生不出合规素材键" });
      continue;
    }

    const srcMeta = await sharp(bitmap.bytes).metadata();
    const ratio = srcMeta.height ? srcMeta.width / srcMeta.height : 1;
    const png = await sharp(bitmap.bytes)
      .resize({ height: ICON_RASTER_H, width: Math.max(1, Math.round(ICON_RASTER_H * ratio)) })
      .png()
      .toBuffer();
    const pngMeta = await sharp(png).metadata();

    await publish(key, png, pngMeta);

    /* 先上传后改写：上传抛错时内容里的内联位图还在，重跑即可；
       反过来会得到一份引用着不存在素材的内容。 */
    ic.asset = key;
    ic.ratio = +ratio.toFixed(4);
    delete ic.uri;
    delete ic.png;

    results.push({
      id: ic.id, key, ratio: ic.ratio, inlineBytes, assetBytes: png.length,
      from: `${srcMeta.width}×${srcMeta.height}`, to: `${pngMeta.width}×${pngMeta.height}`,
    });
  }
  return results;
}

async function main() {
  const { content, source } = await loadContent();
  const before = bytesOf(content);
  const icons = Array.isArray(content.icons) ? content.icons : [];
  console.log(`内容来自 ${source}：${before.toLocaleString()} 字节，${icons.length} 枚图标`);
  if (!icons.length) {
    console.log("内容里没有图标注册表，无需迁移。");
    return;
  }

  const publish = DRY_RUN ? async () => {} : async (key, png, meta) => {
    if (await assetExists(key)) console.log(`  ${key} 已存在，跳过上传（内容仍改成引用它）`);
    else uploadAsset(key, png, meta);
  };

  const results = await migrateIcons(content, publish);
  for (const r of results) {
    if (r.skipped) { console.log(`跳过 ${r.id}：${r.skipped}`); continue; }
    console.log(
      `${r.id} → ${r.key}：${r.from} → ${r.to}，` +
      `内联 ${r.inlineBytes.toLocaleString()} 字节 → 素材 ${r.assetBytes.toLocaleString()} 字节`,
    );
  }

  const moved = results.filter((r) => !r.skipped).length;
  const after = bytesOf(content);
  console.log(
    `\n迁移 ${moved} 枚，跳过 ${results.length - moved} 枚。内容 ` +
    `${before.toLocaleString()} → ${after.toLocaleString()} 字节` +
    `（省 ${(before - after).toLocaleString()}，${((1 - after / before) * 100).toFixed(1)}%）`,
  );

  if (DRY_RUN) {
    console.log("dry-run：未上传素材，也未写出文件。");
    return;
  }
  const outPath = path.isAbsolute(OUT) ? OUT : path.join(root, OUT);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(content, null, 2));
  console.log(`已写出 ${path.relative(root, outPath)} —— 在编辑器里「载入 JSON」后保存、送审。`);
}

/**
 * 离线自检。合成一枚真 PNG（480×240，比 1:1 更能验出 ratio 回算），跑完整
 * 改写路径，断言：派生键合规、ratio 按原始宽高比、内联字段清空、asset 指向
 * 上传过的键、体积确实降下来。矢量图标与已迁移图标应原样跳过。
 */
async function selfTest() {
  const assert = (await import("node:assert/strict")).default;

  const wide = await sharp({
    create: { width: 480, height: 240, channels: 4, background: { r: 228, g: 0, b: 43, alpha: 1 } },
  }).png().toBuffer();

  const content = {
    schema: 2,
    cards: [{ id: "c1", kind: "route", legs: [{ type: "ride", lines: [{ icon: "metro-sh" }] }] }],
    icons: [
      { id: "metro-sh", name: "上海地铁", uri: `data:image/png;base64,${wide.toString("base64")}` },
      { id: "icon-msyr5107", name: "已带前缀", uri: `data:image/png;base64,${wide.toString("base64")}` },
      { id: "vector-only", name: "矢量", svg: '<svg viewBox="0 0 14 14"/>' },
      { id: "already", name: "已迁移", asset: "icon-already", ratio: 1 },
    ],
  };
  const before = bytesOf(content);

  const uploaded = [];
  const results = await migrateIcons(content, async (key, png, meta) => {
    uploaded.push({ key, bytes: png.length, width: meta.width, height: meta.height });
  });

  const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;   // worker 的 ASSET_KEY_PATTERN
  assert.deepEqual(uploaded.map((u) => u.key), ["icon-metro-sh", "icon-msyr5107"],
    "只该上传两枚有内联位图的图标，且 id 已带 icon- 前缀时不叠加");
  for (const u of uploaded) {
    assert.match(u.key, KEY_PATTERN, `素材键 ${u.key} 过不了服务端校验，上传会 400`);
    assert.equal(u.height, ICON_RASTER_H, "位图应统一光栅化到 96px 高");
    assert.equal(u.width, ICON_RASTER_H * 2, "480×240 的源图应按 2:1 保持宽高比");
  }

  const byId = Object.fromEntries(content.icons.map((ic) => [ic.id, ic]));
  assert.equal(byId["metro-sh"].asset, "icon-metro-sh");
  assert.equal(byId["metro-sh"].ratio, 2, "ratio 应按原始宽高比回算（渲染层据它定宽度）");
  assert.equal(byId["metro-sh"].uri, undefined, "内联 uri 必须删掉，否则体积原样留着");
  assert.equal(byId["metro-sh"].png, undefined, "派生 png 同样要删");
  assert.equal(byId["vector-only"].svg, '<svg viewBox="0 0 14 14"/>', "矢量图标应原样留在内容里");
  assert.equal(byId["vector-only"].asset, undefined);
  assert.equal(byId["already"].asset, "icon-already", "已迁移的图标不应被改动");

  assert.equal(results.filter((r) => r.skipped).length, 2, "矢量与已迁移各跳过一枚");
  const after = bytesOf(content);
  assert.ok(after < before / 2, `改写后应显著变小，实际 ${before} → ${after}`);

  console.log(
    `guide-icons-to-assets self-test: ${uploaded.length} 枚迁移、` +
    `${results.length - uploaded.length} 枚跳过，内容 ${before.toLocaleString()} → ` +
    `${after.toLocaleString()} 字节，全部断言通过。`,
  );
}

const entry = args.includes("--self-test") ? selfTest : main;
entry().catch((err) => { console.error(err.message || err); process.exit(1); });
