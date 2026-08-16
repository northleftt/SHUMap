#!/usr/bin/env node
// 把「当前发版」里的校区底图抓下来钉进 data/published-maps/。
//
// 为什么需要这一步：前端渲染和管理端画布读的都是**已发布**底图（走
// /api/public/maps/:mapVersionId/asset），而配准脚本从前读 data/campus-map-assets.json
// 指向的仓库 SVG。两者已经不是同一个坐标空间了——实测宝山已发布底图 viewBox 是
// 921.6×1019.7、仓库里是 856×842，同一张画整体平移了约 65 个 viewBox 单位（≈107 米）。
// 于是用仓库 SVG 拟合出来的 geoTransform 作用在已发布底图上，定位蓝点系统性偏 100 米量级。
//
// 底图抓下来落盘而不是每次联网取：配准必须可复现、测试必须能离线跑。manifest 里记
// sha256 与 viewBox，底图换版时能立刻看出来。
//
// 用法：
//   node scripts/fetch_published_maps.mjs                     # 抓线上当前发版
//   node scripts/fetch_published_maps.mjs --base http://127.0.0.1:8787
//   node scripts/fetch_published_maps.mjs --check             # 只校验本地缓存与 manifest 是否一致
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSvgViewBox } from "../shared/svg-geometry.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(root, "data/published-maps");
const MANIFEST = join(OUT_DIR, "manifest.json");
// 正式站（公共账号 Worker）。个人号 workers.dev 域名已于 2026-08-15 下线（整站 410），
// 不要再改回去；本地起 worker 时用 --base http://127.0.0.1:8787。
const DEFAULT_BASE = "https://map.shutf.com";
const CAMPUS_KEYS = ["baoshan", "jiading", "yanchang"];

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

/** 读本地缓存的已发布底图。配准脚本与测试都走这里，不联网。 */
export function readPublishedMaps(repoRoot = root) {
  const manifestPath = join(repoRoot, "data/published-maps/manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      "缺少 data/published-maps/manifest.json。先跑 node scripts/fetch_published_maps.mjs 抓一次已发布底图。",
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const maps = {};
  for (const entry of manifest.campuses) {
    const file = join(repoRoot, "data/published-maps", entry.file);
    const svg = readFileSync(file, "utf8");
    const digest = sha256(svg);
    if (digest !== entry.sha256) {
      throw new Error(
        `${entry.file} 的 sha256 与 manifest 不符（${digest.slice(0, 12)}… vs ${entry.sha256.slice(0, 12)}…）。`
          + "底图被改过或抓取不完整，重跑 fetch_published_maps.mjs。",
      );
    }
    maps[entry.key] = { ...entry, svg };
  }
  return { manifest, maps };
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
  return response.json();
}

async function main(argv) {
  if (argv.includes("--check")) {
    const { manifest, maps } = readPublishedMaps();
    console.log(`已发布底图缓存校验通过（抓取于 ${manifest.fetchedAt}，来源 ${manifest.source}）：`);
    for (const key of CAMPUS_KEYS) {
      const entry = maps[key];
      if (!entry) throw new Error(`缓存里缺少校区 ${key}`);
      console.log(`  ${key.padEnd(9)} viewBox ${entry.viewBox.width}×${entry.viewBox.height}  ${entry.byteSize} 字节  ${entry.mapVersionId}`);
    }
    return 0;
  }

  const baseIndex = argv.indexOf("--base");
  const base = (baseIndex === -1 ? DEFAULT_BASE : argv[baseIndex + 1]).replace(/\/$/, "");

  console.log(`从 ${base} 读取当前发版…`);
  const release = await fetchJson(`${base}/api/public/releases/current`);
  if (!Array.isArray(release.maps)) throw new Error("发版数据里没有 maps 数组");

  // 只要校区底图：floor_id 为空、campusCode 是三校区之一。
  const campusMaps = release.maps.filter(
    (map) => !map.floor_id && CAMPUS_KEYS.includes(map.campusCode),
  );
  const missing = CAMPUS_KEYS.filter((key) => !campusMaps.some((map) => map.campusCode === key));
  if (missing.length > 0) throw new Error(`当前发版缺少校区底图：${missing.join("、")}`);

  mkdirSync(OUT_DIR, { recursive: true });
  const campuses = [];
  for (const key of CAMPUS_KEYS) {
    const map = campusMaps.find((candidate) => candidate.campusCode === key);
    const url = `${base}/api/public/maps/${map.id}/asset`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
    const svg = await response.text();
    const viewBox = parseSvgViewBox(svg);
    const file = `${key}.svg`;
    writeFileSync(join(OUT_DIR, file), svg, "utf8");
    campuses.push({
      key,
      file,
      campusId: map.campus_id,
      mapVersionId: map.id,
      versionLabel: map.version_label ?? null,
      coordinateSpaceType: map.coordinate_space_type ?? null,
      viewBox: { x: viewBox.x, y: viewBox.y, width: viewBox.width, height: viewBox.height },
      byteSize: Buffer.byteLength(svg, "utf8"),
      sha256: sha256(svg),
    });
    console.log(
      `  ${key.padEnd(9)} viewBox ${viewBox.width}×${viewBox.height}  ${Buffer.byteLength(svg, "utf8")} 字节  ${map.id}`,
    );
  }

  const manifest = {
    version: 1,
    fetchedAt: new Date().toISOString(),
    source: base,
    releaseId: release.release?.id ?? null,
    note:
      "已发布校区底图快照。配准（scripts/generate_geo_transform.mjs）必须用这一份，"
      + "因为前端与管理端画布渲染的就是它；仓库里的 地图/*.svg 是另一个坐标空间。",
    campuses,
  };
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`\n已写入 ${relative(root, MANIFEST)} 及 ${campuses.length} 个 SVG`);

  // 与仓库 SVG 对比，把坐标空间差异直接说出来。
  const repoAssets = JSON.parse(readFileSync(join(root, "data/campus-map-assets.json"), "utf8"));
  console.log("\n=== 已发布 vs 仓库 SVG 的 viewBox ===");
  for (const entry of campuses) {
    const asset = repoAssets.find((item) => item.key === entry.key);
    if (!asset) continue;
    const repoViewBox = parseSvgViewBox(readFileSync(join(root, asset.sourcePath), "utf8"));
    const same = repoViewBox.width === entry.viewBox.width && repoViewBox.height === entry.viewBox.height;
    console.log(
      `  ${entry.key.padEnd(9)} 已发布 ${entry.viewBox.width}×${entry.viewBox.height}`
        + `  仓库 ${repoViewBox.width}×${repoViewBox.height}  ${same ? "尺寸相同" : "← 尺寸不同，参数不可混用"}`,
    );
  }
  return 0;
}

if (process.argv[1] && join(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`\n失败：${error.message}`);
      process.exit(1);
    },
  );
}
