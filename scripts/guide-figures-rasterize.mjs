#!/usr/bin/env node
// 存量指南 SVG 素材补传 PNG 副本（小程序端用）。
//
// 背景：小程序 <image> 不支持 SVG。指南图示（figure 卡 / 枢纽指引图）以 SVG
// 存在素材库，网页端用原件；小程序端按约定优先取「{assetKey}-png」键的位图副本
// （超长按 60 位截断再接 -png，与 public/guide/editor.html 的 figurePngKey 一致）。
// 编辑器增量上传已在浏览器里自动光栅化补副本，这个脚本只补存量。
//
// 做法：从线上公开接口取已发布内容 → 收集 figure 引用键 → 逐个查 content-type，
// 是 SVG 且副本不存在就用 sharp 光栅化（2x、封顶 2048px 宽），然后走 wrangler
// 直写 R2 + D1（等价于 worker/modules/guide.ts uploadGuideAsset 的写入路径，
// 区别是绕过了管理端鉴权 —— 所以脚本要在有 wrangler 登录态的维护机上跑）。
//
// 用法：
//   node scripts/guide-figures-rasterize.mjs [--dry-run] [--api https://host]
//
// 依赖：sharp（node_modules 已有）、wrangler 登录态、D1 库名 shumap-v2、
// R2 bucket shumap-assets。

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const apiIdx = args.indexOf("--api");
const API = apiIdx >= 0 ? args[apiIdx + 1] : "https://map.shutf.com";
const SLUG = process.env.GUIDE_SLUG || "freshman-transit";
const DB = "shumap-v2";
const BUCKET = "shumap-assets";
const OBJECT_PREFIX = "public/guide-assets/";

/** 与 public/guide/editor.html 的 figurePngKey 保持一致。 */
function figurePngKey(key) {
  return (key.length > 60 ? key.slice(0, 60).replace(/-+$/, "") : key) + "-png";
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.json();
}

/** 公开素材端点：返回 { contentType, bytes }；404 返回 null。 */
async function fetchAsset(key) {
  const res = await fetch(`${API}/api/public/guide-assets/${encodeURIComponent(key)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET asset ${key} → HTTP ${res.status}`);
  return { contentType: res.headers.get("content-type") || "", bytes: Buffer.from(await res.arrayBuffer()) };
}

/** 从已发布内容里收集所有 figure 引用键（figure 卡 + 枢纽指引图）。 */
function collectFigureKeys(content) {
  const keys = new Set();
  for (const card of content.cards || []) {
    if (card.kind === "figure" && typeof card.figure === "string") keys.add(card.figure);
  }
  for (const hub of content.hubs || []) {
    for (const fig of hub.guideFigures || []) {
      if (fig && typeof fig.src === "string") keys.add(fig.src);
    }
    if (typeof hub.guideFigure === "string") keys.add(hub.guideFigure); // 旧单图字段
  }
  return [...keys];
}

function wrangler(argsList) {
  return execFileSync("npx", ["wrangler", ...argsList], { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
}

async function main() {
  const payload = await fetchJson(`${API}/api/public/guide/${SLUG}`);
  const content = payload.content || payload;
  const keys = collectFigureKeys(content);
  console.log(`共收集 ${keys.length} 个 figure 引用键：${keys.join(", ") || "(无)"}`);

  let done = 0, skipped = 0;
  for (const key of keys) {
    const pngKey = figurePngKey(key);
    const existing = await fetchAsset(pngKey);
    if (existing) {
      console.log(`跳过 ${key}：副本 ${pngKey} 已存在（${existing.contentType}）`);
      skipped++;
      continue;
    }
    const svg = await fetchAsset(key);
    if (!svg) {
      console.log(`跳过 ${key}：素材不存在`);
      skipped++;
      continue;
    }
    if (svg.contentType.includes("png") || svg.contentType.includes("jpeg")) {
      console.log(`跳过 ${key}：本身就是位图（${svg.contentType}），小程序可直接用`);
      skipped++;
      continue;
    }
    if (!svg.contentType.includes("svg")) {
      console.log(`跳过 ${key}：未知类型 ${svg.contentType}`);
      skipped++;
      continue;
    }

    const meta = await sharp(svg.bytes).metadata();
    const w0 = meta.width || 800;
    /* 矢量图放大重绘没有质量损失：至少 1200px 宽（手机 2x 屏约 750px、桌面更宽），
       2x intrinsic 更大就用 2x，封顶 2048 */
    const targetW = Math.min(Math.max(w0 * 2, 1200), 2048);
    const png = await sharp(svg.bytes, { density: 300 }).resize({ width: targetW }).png().toBuffer();
    const pngMeta = await sharp(png).metadata();
    const sha = crypto.createHash("sha256").update(png).digest("hex");
    console.log(`${key} → ${pngKey}：${w0}px → ${targetW}px，${png.length} 字节`);
    if (DRY_RUN) continue;

    const uuid = crypto.randomUUID().replaceAll("-", "");
    const mediaId = `media_${uuid}`;
    const objectKey = `${OBJECT_PREFIX}${mediaId}.png`;
    const now = new Date().toISOString();
    const tmpFile = path.join(os.tmpdir(), `${mediaId}.png`);
    fs.writeFileSync(tmpFile, png);
    try {
      wrangler(["r2", "object", "put", `${BUCKET}/${objectKey}`, "--file", tmpFile, "--content-type", "image/png", "--remote"]);
      const metadata = JSON.stringify({ pixelWidth: pngMeta.width, pixelHeight: pngMeta.height });
      wrangler(["d1", "execute", DB, "--remote", "--command",
        `insert into media_assets(id,bucket_scope,object_key,original_name,content_type,byte_size,sha256,status,uploaded_by,created_at,approved_at) ` +
        `values('${mediaId}','public','${objectKey}','${pngKey}','image/png',${png.length},'${sha}','published',null,'${now}','${now}')`]);
      wrangler(["d1", "execute", DB, "--remote", "--command",
        `insert into guide_assets(id,asset_key,asset_kind,media_asset_id,metadata_json,created_by,created_at,updated_at) ` +
        `values('gasset_${uuid}','${pngKey}','figure_png','${mediaId}','${metadata}',null,'${now}','${now}')`]);
      const check = await fetchAsset(pngKey);
      if (!check || !check.contentType.includes("png")) throw new Error(`回读 ${pngKey} 校验失败`);
      console.log(`✓ ${pngKey} 已上线（${check.contentType}，${check.bytes.length} 字节）`);
      done++;
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  }
  console.log(`完成：补传 ${done}，跳过 ${skipped}${DRY_RUN ? "（dry-run，未写入）" : ""}`);
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
