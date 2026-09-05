import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await build({
  absWorkingDir: root,
  entryPoints: ["src/lib/release/manifestContract.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`;
const { parseReleaseManifest } = await import(moduleUrl);

function manifestFixture() {
  return {
    schemaVersion: 2,
    release: { id: "release_1", version: "2026.08.01", createdAt: "2026-08-01T00:00:00.000Z" },
    campuses: [{ id: "campus_1", code: "baoshan", name: "宝山校区", timezone: "Asia/Shanghai" }],
    places: [{
      id: "place_1",
      kindId: "library",
      kindName: "图书馆",
      campusId: "campus_1",
      parentPlaceId: null,
      lifecycleStatus: "active",
      revisionId: "place_revision_1",
      displayName: "图书馆",
      summary: null,
      description: null,
      contentHash: "place_hash",
      isBuilding: true,
      content: { detail: { facts: [], media: [] }, address: "上大路 99 号" },
      aliases: ["本部图书馆"],
    }],
    facilities: [{
      id: "facility_1",
      facilityTypeId: "facility_type_printer",
      hostPlaceId: "place_1",
      floorId: null,
      indoorSpaceId: null,
      operationalStatus: "available",
      quantity: 1,
      revisionId: "facility_revision_1",
      displayName: "打印机",
      contentHash: "facility_hash",
      facilityTypeStatus: "active",
      serviceHours: { text: "08:00-22:00" },
      content: {},
      visibilityPolicy: {},
    }],
    merchants: [{
      id: "merchant_1",
      organizationId: null,
      hostPlaceId: "place_1",
      floorId: null,
      indoorSpaceId: null,
      revisionId: "merchant_revision_1",
      displayName: "咖啡店",
      businessType: "coffee",
      contentHash: "merchant_hash",
      openingHours: { text: "08:00-20:00" },
      contact: { phone: "021-12345678" },
      content: { summary: "一层" },
    }],
    maps: [{
      id: "map_version_1",
      campus_id: "campus_1",
      floor_id: null,
      map_asset_id: "map_asset_1",
      parent_version_id: null,
      version_label: "2026.08",
      coordinate_space_type: "svg_viewbox",
      coordinate_space_json: '{"x":0,"y":0,"width":100,"height":100}',
      parser_version: "svg-geometry-v3",
      lifecycle_status: "ready",
      created_by: null,
      created_at: "2026-08-01T00:00:00.000Z",
      checksum: "map_hash",
      assetKey: "maps/map.svg",
      campusCode: "baoshan",
      campusName: "宝山校区",
    }],
    locations: [{
      entityType: "place",
      entityId: "place_1",
      role: "footprint",
      isPrimary: 0,
      id: "anchor_1",
      campus_id: "campus_1",
      building_place_id: "place_1",
      floor_id: null,
      indoor_space_id: null,
      geometry_type: "Polygon",
      geometry_json: null,
      crs: null,
      map_version_id: "map_version_1",
      map_feature_id: "map_feature_1",
      location_hint: null,
      precision_level: "exact",
      accuracy_meters: null,
      source_id: null,
      verification_status: "verified",
      verified_by: null,
      verified_at: "2026-08-01T00:00:00.000Z",
      valid_from: null,
      valid_to: null,
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
      sourceElementId: "library",
      featureKind: "building_footprint",
    }],
    floors: [{
      id: "floor_1",
      buildingPlaceId: "place_1",
      levelCode: "1F",
      levelOrder: 1,
      displayName: "一层",
      isPublic: 1,
      imageUrl: null,
    }],
    facilityTypes: [{
      id: "facility_type_printer",
      code: "printer",
      name: "打印机",
      category: "service",
      iconKey: null,
      status: "active",
    }],
    mapFilters: [{
      id: "filter_service",
      key: "service",
      label: "服务",
      sortOrder: 10,
      placeKindIds: ["library"],
      facilityTypeIds: ["facility_type_printer"],
      includesMerchants: true,
    }],
    transit: {
      stops: [{
        id: "stop_1",
        place_id: "place_1",
        campus_id: "campus_1",
        code: "BS",
        name: "宝山校区",
        status: "active",
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-01T00:00:00.000Z",
      }],
    },
    searchDocuments: [{
      documentType: "place",
      entityId: "place_1",
      title: "图书馆",
      subtitle: null,
      normalizedText: "图书馆 本部图书馆",
      pinyin: null,
      campusId: "campus_1",
      buildingPlaceId: "place_1",
      floorId: null,
      facets: ["place", "library"],
      mapTarget: { type: "locationAnchor", id: "anchor_1" },
      rankingWeight: 10,
    }],
    generatedAt: "2026-08-01T00:00:00.000Z",
  };
}

test("release manifest parser accepts the complete contract", () => {
  assert.deepEqual(parseReleaseManifest(manifestFixture()), manifestFixture());
});

test("release manifest parser rejects missing fields", () => {
  const value = manifestFixture();
  delete value.places[0].aliases;
  assert.throws(() => parseReleaseManifest(value), /places\[0\]\.aliases is required/);
});

test("release manifest parser rejects database flags encoded with the wrong type", () => {
  const value = manifestFixture();
  value.locations[0].isPrimary = false;
  assert.throws(() => parseReleaseManifest(value), /isPrimary must be 0 or 1/);
});

test("release manifest parser allows an independent merchant without a host place", () => {
  const value = manifestFixture();
  value.merchants[0].hostPlaceId = null;
  assert.equal(parseReleaseManifest(value).merchants[0].hostPlaceId, null);

  const missing = manifestFixture();
  delete missing.merchants[0].hostPlaceId;
  assert.throws(() => parseReleaseManifest(missing), /merchants\[0\]\.hostPlaceId is required/);
});

test("transit stop marker size is optional and parsed tolerantly", () => {
  // 0027 起连续系数：worker 只在 ≠1 时输出 marker_size（保护旧版客户端的 exactObject
  // 白名单），缺失即 1；0026 的三档字符串存量按原系数读出，脏值回落而不是整份解析失败。
  const value = manifestFixture();
  assert.equal(parseReleaseManifest(value).transit.stops[0].marker_size, undefined);

  const scaled = manifestFixture();
  scaled.transit.stops[0].marker_size = 1.35;
  assert.equal(parseReleaseManifest(scaled).transit.stops[0].marker_size, 1.35);

  const legacy = manifestFixture();
  legacy.transit.stops[0].marker_size = "large";
  assert.equal(parseReleaseManifest(legacy).transit.stops[0].marker_size, 1.35, "0026 三档存量按原系数读出");

  const dirty = manifestFixture();
  dirty.transit.stops[0].marker_size = "huge";
  assert.equal(parseReleaseManifest(dirty).transit.stops[0].marker_size, 1, "脏值回落标准而不是解析失败");
});

test("release manifest parser rejects malformed service hours and contacts", () => {
  const serviceHours = manifestFixture();
  serviceHours.facilities[0].serviceHours = "08:00-22:00";
  assert.throws(() => parseReleaseManifest(serviceHours), /serviceHours must be an object/);

  const contact = manifestFixture();
  contact.merchants[0].contact = { phone: "021-12345678", note: "前台" };
  assert.throws(() => parseReleaseManifest(contact), /contact\.note is not supported/);
});

test("release manifest parser rejects unknown top-level fields", () => {
  const value = { ...manifestFixture(), compatibilityData: [] };
  assert.throws(() => parseReleaseManifest(value), /compatibilityData is not supported/);
});

test("release manifest parser accepts only GCJ02 navigation points", () => {
  const valid = manifestFixture();
  valid.locations.push({
    ...valid.locations[0],
    id: "anchor_navigation",
    role: "navigation_target",
    isPrimary: 1,
    geometry_type: "Point",
    geometry_json: '{"type":"Point","coordinates":[121.4,31.3]}',
    crs: "GCJ02",
    map_version_id: null,
    map_feature_id: null,
    sourceElementId: null,
    featureKind: null,
  });
  assert.equal(parseReleaseManifest(valid).locations[1].crs, "GCJ02");

  const wrongCrs = manifestFixture();
  wrongCrs.locations.push({ ...valid.locations[1], crs: "EPSG:4326" });
  assert.throws(() => parseReleaseManifest(wrongCrs), /navigation_target must use GCJ02/);

  const invalidCoordinates = manifestFixture();
  invalidCoordinates.locations.push({
    ...valid.locations[1],
    geometry_json: '{"type":"Point","coordinates":[181,31.3]}',
  });
  assert.throws(() => parseReleaseManifest(invalidCoordinates), /invalid longitude or latitude/);
});
