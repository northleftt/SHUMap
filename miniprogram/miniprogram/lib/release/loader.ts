// Release 装配流水线 + 本地缓存。入口 loadReleaseWithCache()：
//   1. GET /api/public/releases/current 拿 manifest 原文（releaseId 就在里面）；
//   2. 缓存命中（同一 releaseId 已校验过）则读缓存的解析结果，跳过 parseReleaseManifest
//      的逐字段严格校验；未命中则校验后写入缓存；
//   3. 三校区 SVG 按 mapVersionId 缓存，命中不重拉（SVG 是大头，校区图各数百 KB）；
//   4. buildMapPois 装配，输出与 Web 端 LoadedRelease 一致的结构。
//
// 缓存 key 约定（wx storage）：
//   release-current-id        → 上次成功装配的 releaseId（指针，便于排查与清理）
//   release-<releaseId>       → 该 release 的 manifest（JSON.stringify 后的解析结果）
//   map-asset-<mapVersionId>  → 该底图版本的 SVG 原文
//
// 失效逻辑：release 与 map version 都是不可变工件（id 变即内容变），
// 按 id 作 key 天然失效，不做 TTL。releaseId 变化时清掉旧 release-* 键；
// map-asset-* 保留（跨 release 复用同一底图版本是常态）。
//
// 容量：小程序 storage 单 key 上限 1MB、总 10MB。实测 manifest 约 230~310KB、
// 校区 SVG 各数百 KB，均在限内。写入一律 try/catch——缓存是优化不是正确性依赖，
// 超限就当没缓存，下次重拉。

import { apiGet, apiGetText } from "../api";
import { parseReleaseManifest } from "./manifestContract";
import {
  buildMapPois,
  campusConfigFromMap,
  campusMapVersions,
  type LoadedRelease,
} from "./mapData";
import { parseSvgViewBox, type SvgViewBox } from "../svg-geometry";
import type { CampusConfig, MapBuilding, ReleaseManifest } from "./types";

export const CURRENT_RELEASE_KEY = "release-current-id";

export function releaseCacheKey(releaseId: string): string {
  return `release-${releaseId}`;
}

export function mapAssetCacheKey(mapVersionId: string): string {
  return `map-asset-${mapVersionId}`;
}

/** 字符串 KV 存储抽象：小程序里是 wx.*StorageSync，单测里注入内存 Map。 */
export interface KeyValueStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** 默认存储：wx storage（取值只接受 string，其他类型视为未命中）。 */
const wxStorage: KeyValueStorage = {
  get(key) {
    const value = wx.getStorageSync(key);
    return typeof value === "string" && value !== "" ? value : null;
  },
  set(key, value) {
    try {
      wx.setStorageSync(key, value);
    } catch {
      // 超容量等写入失败：静默降级为不缓存（见文件头注释）。
    }
  },
  remove(key) {
    try {
      wx.removeStorageSync(key);
    } catch {
      // 同上，清理失败不影响主流程。
    }
  },
};

export interface LoadReleaseDeps {
  storage?: KeyValueStorage;
  /** 默认 apiGet('/api/public/releases/current')；单测注入 fixture。 */
  fetchManifestRaw?: () => Promise<unknown>;
  /** 默认 apiGetText('/api/public/maps/:id/asset')；单测注入 fixture。 */
  fetchSvg?: (mapVersionId: string) => Promise<string>;
}

/** 浅读 releaseId，避免为了拿 id 先跑一遍完整校验。形状不对时返回 null，走完整校验报错。 */
function peekReleaseId(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const release = (raw as Record<string, unknown>).release;
  if (!release || typeof release !== "object" || Array.isArray(release)) return null;
  const id = (release as Record<string, unknown>).id;
  return typeof id === "string" && id !== "" ? id : null;
}

function manifestFromCache(storage: KeyValueStorage, releaseId: string): ReleaseManifest | null {
  const cached = storage.get(releaseCacheKey(releaseId));
  if (!cached) return null;
  try {
    return JSON.parse(cached) as ReleaseManifest;
  } catch {
    // 缓存损坏（半包写入等）：删掉重拉，不让坏缓存卡死启动。
    storage.remove(releaseCacheKey(releaseId));
    return null;
  }
}

export async function loadReleaseWithCache(deps: LoadReleaseDeps = {}): Promise<LoadedRelease> {
  const storage = deps.storage ?? wxStorage;
  const fetchManifestRaw = deps.fetchManifestRaw ?? (() => apiGet<unknown>("/api/public/releases/current"));
  const fetchSvg = deps.fetchSvg ?? ((id: string) => apiGetText(`/api/public/maps/${encodeURIComponent(id)}/asset`));

  // manifest 每次都拉（200~300KB，release 切换靠它发现）；省掉的是重复校验与 SVG 重拉。
  const raw = await fetchManifestRaw();
  const releaseId = peekReleaseId(raw);

  let manifest: ReleaseManifest;
  if (releaseId) {
    const cached = manifestFromCache(storage, releaseId);
    if (cached) {
      manifest = cached;
    } else {
      manifest = parseReleaseManifest(raw);
      storage.set(releaseCacheKey(manifest.release.id), JSON.stringify(manifest));
      const previousId = storage.get(CURRENT_RELEASE_KEY);
      if (previousId && previousId !== manifest.release.id) {
        storage.remove(releaseCacheKey(previousId));
      }
      storage.set(CURRENT_RELEASE_KEY, manifest.release.id);
    }
  } else {
    // releaseId 都读不出来，直接完整校验，让 parseReleaseManifest 抛出准确错误。
    manifest = parseReleaseManifest(raw);
  }

  const campuses = await Promise.all(
    campusMapVersions(manifest).map(async (map) => {
      const cacheKey = mapAssetCacheKey(map.id);
      let svgRaw = storage.get(cacheKey);
      if (svgRaw === null) {
        svgRaw = await fetchSvg(map.id);
        storage.set(cacheKey, svgRaw);
      }
      return campusConfigFromMap(map, svgRaw);
    }),
  ) as [CampusConfig, ...CampusConfig[]];

  const pois = buildMapPois(manifest, campuses);
  const buildings = pois.filter((poi): poi is MapBuilding => poi.entityType === "building");
  return {
    releaseId: manifest.release.id,
    version: manifest.release.version,
    manifest,
    campuses,
    buildings,
    pois,
    filters: manifest.mapFilters.map((filter) => ({ key: filter.key, label: filter.label })),
  };
}

export interface CampusSelection {
  campus: CampusConfig;
  mapVersionId: string;
  /** 初始视口：底图 SVG 根节点的 viewBox（x/y/width/height）。 */
  viewBox: SvgViewBox;
}

/**
 * 按校区取底图与初始视口。
 *
 * 入参两种都接受（注释里约定清楚）：
 *   - campus id（release 数据主键，如 "campus_baoshan"）
 *   - campusKey（ campuses[].code 归一化后的三值："baoshan" / "jiading" / "yanchang"）
 * 都不匹配时抛错并列出可用值。
 */
export function selectCampus(loaded: LoadedRelease, campusIdOrKey: string): CampusSelection {
  const campus = loaded.campuses.find((item) => item.id === campusIdOrKey || item.key === campusIdOrKey);
  if (!campus) {
    const available = loaded.campuses.map((item) => `${item.id}(${item.key})`).join(", ");
    throw new Error(`未知校区 ${JSON.stringify(campusIdOrKey)}，可用：${available}`);
  }
  return {
    campus,
    mapVersionId: campus.mapVersionId,
    viewBox: parseSvgViewBox(campus.svgRaw),
  };
}
