// release 本地搜索：复刻服务端 publicSearch 的匹配/排序规则（worker/modules/public.ts），
// 数据源是 manifest 里随 release 冻结的 searchDocuments，不再打 /api/public/search。
//
// poiKey 折叠规则对齐 Web 端 useMapPageState.poiKeyForSearchResult：
//   - 带 buildingPlaceId 的命中折叠到宿主楼宇（poiKey = buildingPlaceId）；
//   - place：楼宇 bare id 正好匹配，独立地点补 place: 前缀；
//   - facility / merchant_outlet：facility: / merchant: 前缀；
//   - 商户折叠到楼宇时记下 merchantId，打开详情直接展开该商户视图；
//   - 找不到实体或 poi.visibility.search === false 的命中跳过，按 poiKey 去重。

import type { MapPoi, ReleaseManifest, SearchDocument } from "./types";

export const SEARCH_RESULT_LIMIT = 50;

/** 与服务端 worker/modules/places.ts normalizeSearchText 同式。 */
export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * manifest 内搜索：normalizedText 子串匹配；campusId 非空时按校区过滤；
 * 排序 rankingWeight desc、title asc（对齐 SQL order by ranking_weight desc,title），cap 50。
 */
export function searchReleaseLocal(
  manifest: ReleaseManifest,
  query: string,
  campusId?: string | null,
): SearchDocument[] {
  const normalized = normalizeSearchText(query);
  if (!normalized) return [];
  return manifest.searchDocuments
    .filter(
      (doc) =>
        (campusId === undefined || campusId === null || campusId === "" || doc.campusId === campusId)
        && doc.normalizedText.includes(normalized),
    )
    .sort(
      (left, right) =>
        right.rankingWeight - left.rankingWeight
        || (left.title < right.title ? -1 : left.title > right.title ? 1 : 0),
    )
    .slice(0, SEARCH_RESULT_LIMIT);
}

export interface SearchHit {
  poi: MapPoi;
  /** 商户命中折叠到楼宇时带上的商户 id；其余为 null。 */
  merchantId: string | null;
}

/** 单条搜索文档折叠出的 poiKey（resolveSearchHits 与页面取副标题共用，避免两处漂移）。 */
export function foldDocPoiKey(doc: SearchDocument, knownKeys?: ReadonlySet<string>): string {
  if (doc.buildingPlaceId) return doc.buildingPlaceId;
  if (doc.documentType === "place") {
    return knownKeys && !knownKeys.has(doc.entityId) ? `place:${doc.entityId}` : doc.entityId;
  }
  return `${doc.documentType === "facility" ? "facility" : "merchant"}:${doc.entityId}`;
}

/** 搜索文档 → 地图 POI。保持输入顺序去重（先命中的排前面）。 */
export function resolveSearchHits(docs: SearchDocument[], pois: MapPoi[]): SearchHit[] {
  const byKey = new Map(pois.map((poi) => [poi.poiKey, poi]));
  const knownKeys = new Set(byKey.keys());
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const doc of docs) {
    const poiKey = foldDocPoiKey(doc, knownKeys);
    if (seen.has(poiKey)) continue;
    const poi = byKey.get(poiKey);
    if (!poi || poi.visibility.search === false) continue;
    seen.add(poiKey);
    hits.push({
      poi,
      merchantId: doc.documentType === "merchant_outlet" && doc.buildingPlaceId ? doc.entityId : null,
    });
  }
  return hits;
}
