// 小程序端 Part 3 纯逻辑自验（不经微信开发者工具，直接在 node 里跑）。
//
// 用 esbuild 把 lib/release/search.ts、lib/recents.ts、lib/release/loader.ts 编成 cjs 后断言：
// 1. normalizeSearchText：NFKC / 大小写 / 空白折叠（与服务端 worker/modules/places.ts 同式）；
// 2. searchReleaseLocal：子串匹配、rankingWeight desc + title asc、campus 过滤、cap 50、空 query；
// 3. resolveSearchHits：楼宇折叠、商户折叠带 merchantId、visibility.search=false 跳过、去重保序；
// 4. recents：去重 / 上限 20 / 最新在前 / 坏缓存容错（storage 注入，同 loader 单测范式）。
//
// POI 装配用 tests/fixtures/release-manifest-live.json（真实 release 快照）+ 假 SVG，
// 与 tests/miniprogram-release.test.mjs 同一条装配路径。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "tmp/search-test");
mkdirSync(outDir, { recursive: true });

for (const [entry, out] of [
  ["miniprogram/miniprogram/lib/release/search.ts", "search.cjs"],
  ["miniprogram/miniprogram/lib/recents.ts", "recents.cjs"],
  ["miniprogram/miniprogram/lib/release/loader.ts", "loader.cjs"],
]) {
  execFileSync(join(repoRoot, "node_modules/.bin/esbuild"), [
    join(repoRoot, entry),
    "--bundle",
    "--format=cjs",
    "--platform=node",
    `--outfile=${join(outDir, out)}`,
  ]);
}

const require = createRequire(import.meta.url);
const search = require(join(outDir, "search.cjs"));
const recents = require(join(outDir, "recents.cjs"));
const loader = require(join(outDir, "loader.cjs"));

// ---------------------------------------------------------------------------
// 0. fixture 装配（真实 release 快照 → pois）
// ---------------------------------------------------------------------------
const liveRaw = JSON.parse(readFileSync(join(repoRoot, "tests/fixtures/release-manifest-live.json"), "utf8"));
const loaded = await loader.loadReleaseWithCache({
  storage: { get: () => null, set: () => {}, remove: () => {} },
  fetchManifestRaw: async () => liveRaw,
  fetchSvg: async () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 800"></svg>`,
});
assert.ok(loaded.pois.length > 0, "fixture 应装配出 POI");
const poiByKey = new Map(loaded.pois.map((poi) => [poi.poiKey, poi]));

// ---------------------------------------------------------------------------
// 1. normalizeSearchText
// ---------------------------------------------------------------------------
assert.equal(search.normalizeSearchText("  图书馆  "), "图书馆", "首尾空白应裁剪");
assert.equal(search.normalizeSearchText("A  B\tC"), "a b c", "大小写折叠 + 空白折叠");
assert.equal(search.normalizeSearchText("ＡＢＣ１２３"), "abc123", "NFKC：全角转半角");
assert.equal(search.normalizeSearchText("Ａ Ｂ"), "a b", "NFKC + 空白折叠组合");
assert.equal(search.normalizeSearchText(""), "");

// ---------------------------------------------------------------------------
// 2. searchReleaseLocal
// ---------------------------------------------------------------------------
const manifest = loaded.manifest;

assert.deepEqual(search.searchReleaseLocal(manifest, ""), [], "空 query 返回 []");
assert.deepEqual(search.searchReleaseLocal(manifest, "   "), [], "纯空白 query 返回 []");

{
  const hits = search.searchReleaseLocal(manifest, "图书馆");
  assert.equal(hits.length, 4, "图书馆应命中 4 条文档");
  assert.deepEqual(
    hits.map((doc) => doc.title),
    ["图书馆", "文荟图书馆", "本部图书馆", "钱伟长图书馆"],
    "同权重应按 title asc（UTF-16 码序，对齐 SQLite BINARY）",
  );
  assert.ok(hits.every((doc) => doc.rankingWeight === 10));
}

{
  // 大小写/全角不敏感：query 归一化后与 normalizedText 子串匹配
  const hits = search.searchReleaseLocal(manifest, " 图书馆 ");
  assert.equal(hits.length, 4, "query 带空白应归一化后匹配");
}

{
  const hits = search.searchReleaseLocal(manifest, "图书馆", "campus_baoshan");
  assert.deepEqual(
    hits.map((doc) => doc.title),
    ["本部图书馆", "钱伟长图书馆"],
    "campusId 过滤后只剩宝山两条",
  );
  const jiading = search.searchReleaseLocal(manifest, "图书馆", "campus_jiading");
  assert.deepEqual(jiading.map((doc) => doc.title), ["图书馆"]);
}

{
  // 权重排序：rankingWeight desc 优先于 title asc
  const stub = {
    searchDocuments: [
      { documentType: "merchant_outlet", entityId: "m1", title: "A 咖啡", subtitle: null, normalizedText: "a 咖啡", pinyin: null, campusId: null, buildingPlaceId: null, floorId: null, facets: [], mapTarget: { type: "merchant_outlet", id: "m1" }, rankingWeight: 7 },
      { documentType: "place", entityId: "p1", title: "Z 咖啡", subtitle: null, normalizedText: "z 咖啡", pinyin: null, campusId: null, buildingPlaceId: null, floorId: null, facets: [], mapTarget: { type: "place", id: "p1" }, rankingWeight: 10 },
      { documentType: "facility", entityId: "f1", title: "B 咖啡", subtitle: null, normalizedText: "b 咖啡", pinyin: null, campusId: null, buildingPlaceId: null, floorId: null, facets: [], mapTarget: { type: "facility", id: "f1" }, rankingWeight: 8 },
    ],
  };
  const hits = search.searchReleaseLocal(stub, "咖啡");
  assert.deepEqual(hits.map((doc) => doc.entityId), ["p1", "f1", "m1"], "place(10) > facility(8) > merchant(7)");
}

{
  // cap 50
  const stub = {
    searchDocuments: Array.from({ length: 60 }, (_, index) => ({
      documentType: "place",
      entityId: `p${index}`,
      title: `测试 ${String(index).padStart(2, "0")}`,
      subtitle: null,
      normalizedText: `测试 ${index}`,
      pinyin: null,
      campusId: null,
      buildingPlaceId: null,
      floorId: null,
      facets: [],
      mapTarget: { type: "place", id: `p${index}` },
      rankingWeight: 10,
    })),
  };
  assert.equal(search.searchReleaseLocal(stub, "测试").length, 50, "结果应截到 50 条");
}

// ---------------------------------------------------------------------------
// 3. resolveSearchHits
// ---------------------------------------------------------------------------
const mainLibrary = "place_baoshan_main-library";
assert.ok(poiByKey.has(mainLibrary), "fixture 应有本部图书馆楼宇");

{
  // 楼宇折叠：带 buildingPlaceId 的命中折叠到宿主楼宇（楼宇 bare id）
  const docs = search.searchReleaseLocal(manifest, "本部图书馆");
  const hits = search.resolveSearchHits(docs, loaded.pois);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].poi.poiKey, mainLibrary);
  assert.equal(hits[0].merchantId, null);
}

function fakeDoc(overrides) {
  return {
    documentType: "place",
    entityId: "x",
    title: "x",
    subtitle: null,
    normalizedText: "x",
    pinyin: null,
    campusId: null,
    buildingPlaceId: null,
    floorId: null,
    facets: [],
    mapTarget: { type: "place", id: "x" },
    rankingWeight: 10,
    ...overrides,
  };
}

{
  // 商户折叠到楼宇：poiKey = buildingPlaceId，带 merchantId
  const docs = [
    fakeDoc({ documentType: "merchant_outlet", entityId: "merchant_abc", buildingPlaceId: mainLibrary }),
  ];
  const hits = search.resolveSearchHits(docs, loaded.pois);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].poi.poiKey, mainLibrary);
  assert.equal(hits[0].merchantId, "merchant_abc", "商户折叠命中应记录 merchantId");
}

{
  // 去重保序：place 文档与商户文档折叠到同一楼宇，只出一次
  const docs = [
    fakeDoc({ entityId: mainLibrary, buildingPlaceId: mainLibrary }),
    fakeDoc({ documentType: "merchant_outlet", entityId: "merchant_abc", buildingPlaceId: mainLibrary }),
  ];
  const hits = search.resolveSearchHits(docs, loaded.pois);
  assert.equal(hits.length, 1, "同一 poiKey 应去重");
  assert.equal(hits[0].merchantId, null, "先命中的（place）排前面");
}

{
  // 找不到实体的命中跳过
  const docs = [fakeDoc({ entityId: "place_ghost", buildingPlaceId: null })];
  assert.deepEqual(search.resolveSearchHits(docs, loaded.pois), []);
}

{
  // visibility.search === false 跳过
  const poi = poiByKey.get(mainLibrary);
  const hidden = { ...poi, visibility: { ...poi.visibility, search: false } };
  const docs = [fakeDoc({ entityId: mainLibrary, buildingPlaceId: mainLibrary })];
  assert.deepEqual(search.resolveSearchHits(docs, [hidden]), [], "visibility.search=false 应跳过");
}

{
  // 独立设施/商户（无 buildingPlaceId）走前缀 poiKey
  const facilityPoi = { ...poiByKey.get(mainLibrary), poiKey: "facility:f1", entityType: "facility" };
  const docs = [fakeDoc({ documentType: "facility", entityId: "f1" })];
  const hits = search.resolveSearchHits(docs, [facilityPoi]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].poi.poiKey, "facility:f1");
  // 楼宇 bare id 直接命中（place 类型、无 buildingPlaceId）
  const buildingDocs = [fakeDoc({ entityId: mainLibrary })];
  const buildingHits = search.resolveSearchHits(buildingDocs, loaded.pois);
  assert.equal(buildingHits[0]?.poi.poiKey, mainLibrary, "楼宇 bare id 应直接匹配");
}

// ---------------------------------------------------------------------------
// 4. recents
// ---------------------------------------------------------------------------
function memoryStorage() {
  const map = new Map();
  return {
    map,
    get: (key) => (map.has(key) ? map.get(key) : null),
    set: (key, value) => map.set(key, value),
  };
}

{
  const storage = memoryStorage();
  assert.deepEqual(recents.readRecents(storage), [], "空存储读出 []");

  recents.addRecent("poi_a", storage);
  recents.addRecent("poi_b", storage);
  recents.addRecent("poi_a", storage); // 重复：应去重置顶而非新增
  const list = recents.readRecents(storage);
  assert.deepEqual(list.map((entry) => entry.poiKey), ["poi_a", "poi_b"], "最新在前 + 去重");
  assert.ok(list[0].viewedAt >= list[1].viewedAt);
}

{
  // 上限 20
  const storage = memoryStorage();
  for (let index = 0; index < 25; index += 1) recents.addRecent(`poi_${index}`, storage);
  const list = recents.readRecents(storage);
  assert.equal(list.length, 20, "记录应截到 20 条");
  assert.equal(list[0].poiKey, "poi_24", "最新一条在首位");
  assert.equal(list.at(-1).poiKey, "poi_5", "最旧的一条被截掉");
}

{
  // 坏缓存容错
  const storage = memoryStorage();
  storage.set(recents.RECENTS_KEY, "{not json");
  assert.deepEqual(recents.readRecents(storage), [], "坏 JSON 读出 []");
  storage.set(recents.RECENTS_KEY, JSON.stringify([{ poiKey: "ok", viewedAt: 1 }, { bad: true }, "junk"]));
  assert.deepEqual(recents.readRecents(storage), [{ poiKey: "ok", viewedAt: 1 }], "形状不对的条目应过滤");
}

console.log("miniprogram-search: all assertions passed");
