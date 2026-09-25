// 小程序端 release 装配逻辑自验（不经微信开发者工具，直接在 node 里跑）。
//
// 用 esbuild 把 miniprogram/miniprogram/lib/release/loader.ts 编成 cjs 后断言：
// 1. parseReleaseManifest 对真实响应（tests/fixtures/release-manifest-live.json，
//    curl http://localhost:8788/api/public/releases/current 抓取）的校验；
// 2. loadReleaseWithCache 全流水线（注入内存 storage 与假 fetcher，不依赖 wx）：
//    首次装配拉 SVG、二次装配全走缓存、release 切换清旧缓存；
// 3. selectCampus 对三校区按 id / campusKey 两种入参返回正确 mapVersionId 与合法 viewBox；
// 4. 缓存 key 规则。
//
// 健康 manifest 是合成的最小数据集（真实 release 只验证解析，不驱动装配——
// 当前本地 active release 是边界测试数据，没有校区底图，见 miniprogram/AGENTS.md）。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "tmp/release-test");
mkdirSync(outDir, { recursive: true });

execFileSync(join(repoRoot, "node_modules/.bin/esbuild"), [
  join(repoRoot, "miniprogram/miniprogram/lib/release/loader.ts"),
  "--bundle",
  "--format=cjs",
  "--platform=node",
  `--outfile=${join(outDir, "loader.cjs")}`,
]);
execFileSync(join(repoRoot, "node_modules/.bin/esbuild"), [
  join(repoRoot, "miniprogram/miniprogram/lib/release/manifestContract.ts"),
  "--bundle",
  "--format=cjs",
  "--platform=node",
  `--outfile=${join(outDir, "manifestContract.cjs")}`,
]);

const require = createRequire(import.meta.url);
const loader = require(join(outDir, "loader.cjs"));
const manifestContract = require(join(outDir, "manifestContract.cjs"));

// ---------------------------------------------------------------------------
// 0. 合成健康 manifest：三校区底图 + 1 楼宇（含 footprint）+ 1 独立地点 + 1 独立设施
// ---------------------------------------------------------------------------
const CAMPUS_ROWS = [
  { id: "campus_baoshan", code: "baoshan", name: "宝山校区" },
  { id: "campus_jiading", code: "jiading", name: "嘉定校区" },
  { id: "campus_yanchang", code: "yanchang", name: "延长校区" },
];
const MAP_VERSIONS = CAMPUS_ROWS.map((campus) => ({
  id: `map_version_campus_${campus.code}`,
  campus_id: campus.id,
  floor_id: null,
  map_asset_id: `asset_${campus.code}`,
  parent_version_id: null,
  campusCode: campus.code,
  campusName: campus.name,
  version_label: "v1",
  coordinate_space_type: "svg_viewbox",
  coordinate_space_json: "{}",
  parser_version: null,
  lifecycle_status: "published",
  created_by: null,
  created_at: "2026-08-01T00:00:00.000Z",
  checksum: "x",
  assetKey: `private/${campus.code}.svg`,
}));
const SVG_BY_MAP_VERSION = Object.fromEntries(
  CAMPUS_ROWS.map((campus, index) => [
    `map_version_campus_${campus.code}`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${index * 10} ${index * 20} ${1000 + index} ${800 + index}"><g id="b1"><path d="M0 0L10 0L10 10Z"/></g></svg>`,
  ]),
);

function healthyManifest(releaseId = "release_test_1") {
  return {
    schemaVersion: 2,
    release: { id: releaseId, version: "test-1", createdAt: "2026-08-01T00:00:00.000Z" },
    campuses: CAMPUS_ROWS.map((campus) => ({ ...campus, timezone: "Asia/Shanghai" })),
    places: [
      {
        id: "place_building_a",
        kindId: "building",
        kindName: "教学楼",
        campusId: "campus_baoshan",
        parentPlaceId: null,
        lifecycleStatus: "active",
        revisionId: "prev_a",
        displayName: "A 楼",
        summary: null,
        description: null,
        contentHash: "h1",
        isBuilding: true,
        content: { detail: { facts: [], media: [] } },
        aliases: [],
      },
      {
        id: "place_square",
        kindId: "sports_venue",
        kindName: "体育场馆",
        campusId: "campus_jiading",
        parentPlaceId: null,
        lifecycleStatus: "active",
        revisionId: "prev_b",
        displayName: "风雨操场",
        summary: null,
        description: null,
        contentHash: "h2",
        isBuilding: false,
        content: { detail: { facts: [], media: [] } },
        aliases: [],
      },
    ],
    facilities: [
      {
        id: "facility_atm_1",
        facilityTypeId: "facility_type_atm",
        hostPlaceId: null,
        floorId: null,
        indoorSpaceId: null,
        operationalStatus: "available",
        quantity: null,
        revisionId: "frev_a",
        displayName: "ATM 机",
        contentHash: "h3",
        facilityTypeStatus: "active",
        serviceHours: null,
        content: {},
        visibilityPolicy: {},
      },
    ],
    merchants: [],
    maps: MAP_VERSIONS,
    locations: [
      {
        entityType: "place",
        entityId: "place_building_a",
        role: "footprint",
        isPrimary: 0,
        id: "anchor_footprint_a",
        campus_id: "campus_baoshan",
        building_place_id: "place_building_a",
        floor_id: null,
        indoor_space_id: null,
        geometry_type: "Polygon",
        geometry_json: null,
        crs: "svg_viewbox",
        map_version_id: "map_version_campus_baoshan",
        map_feature_id: "map_feature_baoshan_a",
        sourceElementId: "building-a",
        featureKind: "building_footprint",
        location_hint: null,
        precision_level: "exact",
        accuracy_meters: null,
        source_id: null,
        verification_status: "verified",
        verified_by: null,
        verified_at: null,
        valid_from: null,
        valid_to: null,
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-01T00:00:00.000Z",
      },
      {
        entityType: "place",
        entityId: "place_square",
        role: "primary_display",
        isPrimary: 1,
        id: "anchor_square",
        campus_id: "campus_jiading",
        building_place_id: null,
        floor_id: null,
        indoor_space_id: null,
        geometry_type: "Point",
        geometry_json: JSON.stringify({ type: "Point", coordinates: [100, 200] }),
        crs: "svg_viewbox",
        map_version_id: "map_version_campus_jiading",
        map_feature_id: null,
        sourceElementId: null,
        featureKind: null,
        location_hint: null,
        precision_level: "exact",
        accuracy_meters: null,
        source_id: null,
        verification_status: "verified",
        verified_by: null,
        verified_at: null,
        valid_from: null,
        valid_to: null,
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-01T00:00:00.000Z",
      },
      {
        entityType: "facility",
        entityId: "facility_atm_1",
        role: "service_position",
        isPrimary: 1,
        id: "anchor_atm",
        campus_id: "campus_yanchang",
        building_place_id: null,
        floor_id: null,
        indoor_space_id: null,
        geometry_type: "Point",
        geometry_json: JSON.stringify({ type: "Point", coordinates: [50, 60] }),
        crs: "svg_viewbox",
        map_version_id: "map_version_campus_yanchang",
        map_feature_id: null,
        sourceElementId: null,
        featureKind: null,
        location_hint: null,
        precision_level: "exact",
        accuracy_meters: null,
        source_id: null,
        verification_status: "verified",
        verified_by: null,
        verified_at: null,
        valid_from: null,
        valid_to: null,
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-01T00:00:00.000Z",
      },
    ],
    floors: [],
    facilityTypes: [
      {
        id: "facility_type_atm",
        code: "atm",
        name: "ATM 机",
        category: "life",
        iconKey: "atm",
        status: "active",
      },
    ],
    mapFilters: [
      {
        id: "filter_all",
        key: "all",
        label: "全部",
        sortOrder: 0,
        placeKindIds: ["building", "sports_venue"],
        facilityTypeIds: ["facility_type_atm"],
        includesMerchants: true,
      },
    ],
    transit: { stops: [] },
    searchDocuments: [],
    generatedAt: "2026-08-01T00:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// 1. parseReleaseManifest：真实响应 + 负例
// ---------------------------------------------------------------------------
const liveRaw = JSON.parse(readFileSync(join(repoRoot, "tests/fixtures/release-manifest-live.json"), "utf8"));

// fixture 是 localhost:8788 releases/current 的快照。本地 active release 若是旧契约
// 工件（2026-08 初的边界测试数据，places 没有 kindName/isBuilding），严格校验必须拒绝它；
// 重新发版后重新抓取 fixture，这里则要求严格校验通过。两个分支都是确定性断言。
const liveIsCurrentContract =
  Array.isArray(liveRaw.places) && liveRaw.places.every((p) => "kindName" in p && "isBuilding" in p);
if (liveIsCurrentContract) {
  const manifest = manifestContract.parseReleaseManifest(liveRaw);
  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(
    manifest.campuses.map((c) => c.code).sort(),
    ["baoshan", "jiading", "yanchang"],
    "真实响应应含三校区",
  );
} else {
  assert.throws(
    () => manifestContract.parseReleaseManifest(liveRaw),
    /kindName|isBuilding/,
    "旧契约工件应被严格校验拒绝",
  );
  console.warn("note: fixture 是旧契约 release（无 kindName/isBuilding），已验证校验拒绝；重新发版后请更新 fixture");
}

// 负例：schemaVersion 不是 2
{
  const bad = { ...liveRaw, schemaVersion: 3 };
  assert.throws(() => manifestContract.parseReleaseManifest(bad), /schemaVersion/, "schemaVersion=3 应被校验拒绝");
}

// 合成健康 manifest 也必须能过真实校验（下游装配的前提）
manifestContract.parseReleaseManifest(healthyManifest());

// ---------------------------------------------------------------------------
// 2. loadReleaseWithCache 全流水线 + 缓存行为
// ---------------------------------------------------------------------------
function memoryStorage() {
  const map = new Map();
  return {
    map,
    get: (key) => (map.has(key) ? map.get(key) : null),
    set: (key, value) => map.set(key, value),
    remove: (key) => map.delete(key),
  };
}

const storage = memoryStorage();
const counts = { manifest: 0, svg: 0 };
const deps = {
  storage,
  fetchManifestRaw: async () => {
    counts.manifest += 1;
    return healthyManifest();
  },
  fetchSvg: async (mapVersionId) => {
    counts.svg += 1;
    const svg = SVG_BY_MAP_VERSION[mapVersionId];
    assert.ok(svg, `不应请求未知底图 ${mapVersionId}`);
    return svg;
  },
};

storage.set("release-release_test_1", JSON.stringify({ brokenLegacyCache: true }));
const loaded = await loader.loadReleaseWithCache(deps);
assert.equal(loaded.manifest.brokenLegacyCache, undefined, "new contract must not consume pre-upgrade cache");
assert.equal(loaded.releaseId, "release_test_1");
assert.equal(loaded.version, "test-1");
assert.equal(loaded.campuses.length, 3, "应装配出三校区");
assert.deepEqual(loaded.campuses.map((c) => c.key), ["baoshan", "jiading", "yanchang"]);
assert.equal(loaded.pois.length, 3, "1 楼宇 + 1 独立地点 + 1 独立设施");
assert.equal(loaded.buildings.length, 1);
assert.equal(loaded.filters.length, 1);
assert.equal(counts.manifest, 1);
assert.equal(counts.svg, 3, "首装应拉三张校区 SVG");

// 缓存落盘检查
assert.ok(storage.get(loader.releaseCacheKey("release_test_1")), "manifest 应写入缓存");
assert.equal(storage.get(loader.CURRENT_RELEASE_KEY), "release_test_1");
for (const campus of CAMPUS_ROWS) {
  assert.ok(storage.get(loader.mapAssetCacheKey(`map_version_campus_${campus.code}`)), "SVG 应写入缓存");
}

// 二次装配：manifest 仍每次拉（靠它发现 release 切换），但校验与 SVG 全走缓存
const again = await loader.loadReleaseWithCache(deps);
assert.equal(counts.manifest, 2, "manifest 每次都拉");
assert.equal(counts.svg, 3, "SVG 命中缓存不应重拉");
assert.equal(again.pois.length, 3);

// release 切换：新 releaseId 覆盖写入，旧 release-* 键被清掉，SVG 缓存保留复用
const depsV2 = {
  ...deps,
  fetchManifestRaw: async () => {
    counts.manifest += 1;
    return healthyManifest("release_test_2");
  },
};
const switched = await loader.loadReleaseWithCache(depsV2);
assert.equal(switched.releaseId, "release_test_2");
assert.equal(storage.get(loader.releaseCacheKey("release_test_1")), null, "旧 release 缓存应被清理");
assert.equal(storage.get(loader.CURRENT_RELEASE_KEY), "release_test_2");
assert.equal(counts.svg, 3, "底图版本未变，SVG 缓存应跨 release 复用");

// ---------------------------------------------------------------------------
// 3. selectCampus：id / campusKey 两种入参，三校区各自的 mapVersionId 与 viewBox
// ---------------------------------------------------------------------------
for (const [index, campus] of CAMPUS_ROWS.entries()) {
  const mapVersionId = `map_version_campus_${campus.code}`;
  const expectedViewBox = { x: index * 10, y: index * 20, width: 1000 + index, height: 800 + index };
  for (const input of [campus.id, campus.code]) {
    const selection = loader.selectCampus(loaded, input);
    assert.equal(selection.campus.id, campus.id, `入参 ${input} 应选中 ${campus.name}`);
    assert.equal(selection.mapVersionId, mapVersionId);
    assert.deepEqual(selection.viewBox, expectedViewBox, `${campus.code} viewBox 应来自 SVG 原文`);
  }
}
assert.throws(() => loader.selectCampus(loaded, "qingpu"), /未知校区/, "未知校区应抛错");

// ---------------------------------------------------------------------------
// 4. 缓存 key 规则
// ---------------------------------------------------------------------------
assert.equal(loader.CURRENT_RELEASE_KEY, "release-prod-map-2026-09-current-id");
assert.equal(loader.releaseCacheKey("release_abc"), "release-prod-map-2026-09-release_abc");
assert.equal(loader.mapAssetCacheKey("mapver_xyz"), "map-asset-prod-map-2026-09-mapver_xyz");

console.log("miniprogram-release: all assertions passed");
