import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundled = await build({
  absWorkingDir: root,
  entryPoints: ["src/pages/map/useMapPageState.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`;
const { poiKeyForSearchResult, shouldRenderPointPoi } = await import(moduleUrl);

function facilityPoi(overrides = {}) {
  return {
    poiKey: "facility:facility_1",
    entityType: "facility",
    entityId: "facility_1",
    markerPoint: { x: 20, y: 30 },
    facilityOperationalStatus: "available",
    visibility: {
      default: false,
      searchable: true,
      filterable: true,
      search: true,
      filter: true,
      whenUnavailable: false,
    },
    ...overrides,
  };
}

function decision(poi, overrides = {}) {
  return shouldRenderPointPoi({
    poi,
    selectedPoiKey: null,
    queryActive: false,
    activeFilter: null,
    matched: false,
    facilityStatus: { status: "loading" },
    ...overrides,
  });
}

test("a selected point remains visible when its default policy is off", () => {
  const poi = facilityPoi();
  assert.equal(decision(poi), false);
  assert.equal(decision(poi, { selectedPoiKey: poi.poiKey }), true);
});

test("live facility status overrides the release snapshot for unavailable visibility", () => {
  const poi = facilityPoi({
    facilityOperationalStatus: "available",
    visibility: { ...facilityPoi().visibility, default: true, whenUnavailable: false },
  });
  assert.equal(decision(poi), true);
  assert.equal(decision(poi, {
    facilityStatus: { status: "ready", statuses: { facility_1: "unavailable" } },
  }), false);
  assert.equal(decision(poi, {
    selectedPoiKey: poi.poiKey,
    facilityStatus: { status: "ready", statuses: { facility_1: "unavailable" } },
  }), false);
});

test("search and filter marker switches apply independently", () => {
  const poi = facilityPoi({
    visibility: { ...facilityPoi().visibility, search: false, filter: true },
  });
  assert.equal(decision(poi, { queryActive: true, matched: true }), false);
  assert.equal(decision(poi, { activeFilter: "charging", matched: true }), true);
});

test("a non-building place search hit folds into its resolved building", () => {
  const keys = new Set(["building_1", "place:place_free"]);
  assert.equal(poiKeyForSearchResult({
    type: "place",
    id: "place_inside",
    buildingPlaceId: "building_1",
  }, keys), "building_1");
  assert.equal(poiKeyForSearchResult({
    type: "place",
    id: "place_free",
    buildingPlaceId: null,
  }, keys), "place:place_free");
});
