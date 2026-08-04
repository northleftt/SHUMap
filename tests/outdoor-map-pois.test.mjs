import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundled = await build({
  absWorkingDir: root,
  entryPoints: ["src/lib/release/mapData.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
  external: ["react", "react-dom", "react-router-dom"],
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`;
const { buildMapPointPois } = await import(moduleUrl);

const campus = {
  id: "campus_1",
  key: "baoshan",
  label: "宝山校区",
  mapVersionId: "map_1",
  svgRaw: '<svg viewBox="0 0 100 100"/>',
  focusPoint: { x: 0.5, y: 0.5 },
  scaleMultiplier: 1,
  minScaleMultiplier: 1,
  edgePaddingRatio: 0.1,
  selectionEdgePaddingRatio: 0.1,
  selectionScaleMultiplier: 2,
};

function location(entityType, entityId, id, overrides = {}) {
  return {
    entityType,
    entityId,
    role: "primary_display",
    isPrimary: 1,
    id,
    campus_id: "campus_1",
    building_place_id: null,
    floor_id: null,
    indoor_space_id: null,
    geometry_type: "Point",
    geometry_json: '{"type":"Point","coordinates":[25,40]}',
    crs: "svg_viewbox",
    map_version_id: "map_1",
    map_feature_id: null,
    sourceElementId: null,
    featureKind: null,
    location_hint: null,
    precision_level: "exact",
    accuracy_meters: null,
    source_id: null,
    verification_status: "reviewed",
    verified_by: null,
    verified_at: null,
    valid_from: null,
    valid_to: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function manifest() {
  return {
    places: [
      {
        id: "building_1", kindId: "building", kindName: "建筑", isBuilding: true,
        campusId: "campus_1", parentPlaceId: null, lifecycleStatus: "active", revisionId: "pr_building",
        displayName: "教学楼", summary: null, description: null,
        content: { detail: { facts: [], media: [] } }, contentHash: "h1", aliases: [],
      },
      {
        id: "place_free", kindId: "service_place", kindName: "服务地点", isBuilding: false,
        campusId: "campus_1", parentPlaceId: null, lifecycleStatus: "active", revisionId: "pr_free",
        displayName: "室外服务点", summary: "简介", description: null,
        content: { detail: { facts: [], media: [] } }, contentHash: "h2", aliases: [],
      },
      {
        id: "place_child", kindId: "service_place", kindName: "服务地点", isBuilding: false,
        campusId: "campus_1", parentPlaceId: "building_1", lifecycleStatus: "active", revisionId: "pr_child",
        displayName: "楼内服务点", summary: null, description: null,
        content: { detail: { facts: [], media: [] } }, contentHash: "h3", aliases: [],
      },
    ],
    facilities: [
      {
        id: "facility_free", facilityTypeId: "type_charge", hostPlaceId: null, floorId: null, indoorSpaceId: null,
        operationalStatus: "available", quantity: 1, revisionId: "fr_free", displayName: "室外充电桩",
        facilityTypeStatus: "active", serviceHours: null, content: {}, contentHash: "hf1",
        visibilityPolicy: {
          searchable: true,
          filterable: true,
          campusDefault: false,
          showOnSearch: true,
          showOnFilter: false,
          showWhenUnavailable: false,
        },
      },
      {
        id: "facility_bound", facilityTypeId: "type_charge", hostPlaceId: "building_1", floorId: null, indoorSpaceId: null,
        operationalStatus: "available", quantity: 1, revisionId: "fr_bound", displayName: "楼内充电桩",
        facilityTypeStatus: "active", serviceHours: null, content: {}, contentHash: "hf2",
        visibilityPolicy: {
          searchable: true,
          filterable: true,
          campusDefault: true,
          showOnSearch: true,
          showOnFilter: true,
          showWhenUnavailable: true,
        },
      },
    ],
    merchants: [
      {
        id: "merchant_free", organizationId: null, hostPlaceId: null, floorId: null, indoorSpaceId: null,
        revisionId: "mr_free", displayName: "室外咖啡", businessType: "咖啡", openingHours: null,
        contact: null, content: {}, contentHash: "hm1",
      },
      {
        id: "merchant_bound", organizationId: null, hostPlaceId: "building_1", floorId: null, indoorSpaceId: null,
        revisionId: "mr_bound", displayName: "楼内咖啡", businessType: "咖啡", openingHours: null,
        contact: null, content: {}, contentHash: "hm2",
      },
    ],
    facilityTypes: [{ id: "type_charge", code: "charging_station", name: "充电桩", category: "transport", iconKey: "charging", status: "active" }],
    floors: [],
    mapFilters: [
      { id: "filter_service", key: "service", label: "服务", sortOrder: 1, placeKindIds: ["service_place"], facilityTypeIds: [], includesMerchants: false },
      { id: "filter_charge", key: "charging", label: "充电桩", sortOrder: 2, placeKindIds: [], facilityTypeIds: ["type_charge"], includesMerchants: false },
      { id: "filter_merchant", key: "merchant", label: "商业", sortOrder: 3, placeKindIds: [], facilityTypeIds: [], includesMerchants: true },
    ],
    locations: [
      location("place", "place_free", "point_place_free"),
      location("place", "place_child", "point_place_child", { building_place_id: "building_1" }),
      location("facility", "facility_free", "point_facility_free", { geometry_json: '{"type":"Point","coordinates":[30,45]}' }),
      location("facility", "facility_bound", "point_facility_bound", { building_place_id: "building_1" }),
      location("merchant_outlet", "merchant_free", "point_merchant_free", { geometry_json: '{"type":"Point","coordinates":[35,50]}' }),
      location("merchant_outlet", "merchant_bound", "point_merchant_bound", { building_place_id: "building_1" }),
    ],
  };
}

test("only entities outside buildings become independent campus-map POIs", () => {
  const pois = buildMapPointPois(manifest(), [campus]);
  assert.deepEqual(pois.map((poi) => poi.poiKey), [
    "place:place_free",
    "facility:facility_free",
    "merchant:merchant_free",
  ]);
  assert.deepEqual(pois.map((poi) => poi.markerPoint), [
    { x: 25, y: 40 },
    { x: 30, y: 45 },
    { x: 35, y: 50 },
  ]);
});

test("facility marker icon, filter, and visibility policy come from published dictionaries", () => {
  const poi = buildMapPointPois(manifest(), [campus]).find((item) => item.poiKey === "facility:facility_free");
  assert.ok(poi);
  assert.equal(poi.markerIconKey, "charging");
  assert.deepEqual(poi.filterGroups, ["charging"]);
  assert.deepEqual(poi.visibility, {
    default: false,
    searchable: true,
    filterable: true,
    search: true,
    filter: false,
    whenUnavailable: false,
  });
});

test("facility search and filter eligibility remain separate from marker display switches", () => {
  const value = manifest();
  value.facilities[0].visibilityPolicy = {
    searchable: false,
    filterable: false,
    campusDefault: true,
    showOnSearch: true,
    showOnFilter: true,
    showWhenUnavailable: true,
  };
  const poi = buildMapPointPois(value, [campus]).find((item) => item.poiKey === "facility:facility_free");
  assert.ok(poi);
  assert.equal(poi.visibility.searchable, false);
  assert.equal(poi.visibility.filterable, false);
  assert.equal(poi.visibility.search, true);
  assert.equal(poi.visibility.filter, true);
});

test("a point tied to an actual building stays hidden even when the structural host is empty", () => {
  const value = manifest();
  value.facilities[0].hostPlaceId = null;
  value.locations.find((item) => item.entityId === "facility_free").building_place_id = "building_1";
  const pois = buildMapPointPois(value, [campus]);
  assert.equal(pois.some((poi) => poi.poiKey === "facility:facility_free"), false);
});

test("an entity hosted by a non-building place stays independent and inherits its campus", () => {
  const value = manifest();
  value.facilities[0].hostPlaceId = "place_free";
  value.locations.find((item) => item.entityId === "facility_free").campus_id = null;
  value.locations.find((item) => item.entityId === "facility_free").map_version_id = null;
  value.merchants[0].hostPlaceId = "place_free";
  value.locations.find((item) => item.entityId === "merchant_free").campus_id = null;
  value.locations.find((item) => item.entityId === "merchant_free").map_version_id = null;

  const pois = buildMapPointPois(value, [campus]);
  assert.equal(pois.find((poi) => poi.poiKey === "facility:facility_free")?.campusKey, "baoshan");
  assert.equal(pois.find((poi) => poi.poiKey === "merchant:merchant_free")?.campusKey, "baoshan");
});

test("a building reference on any location anchor suppresses the independent marker", () => {
  const value = manifest();
  value.locations.push(location(
    "facility",
    "facility_free",
    "secondary_facility_building_anchor",
    {
      building_place_id: "building_1",
      geometry_json: '{"type":"Point","coordinates":[31,46]}',
      isPrimary: 0,
      role: "service_position",
    },
  ));

  const pois = buildMapPointPois(value, [campus]);
  assert.equal(pois.some((poi) => poi.poiKey === "facility:facility_free"), false);
});

test("a building ancestor suppresses places and hosted entities through the full parent chain", () => {
  const value = manifest();
  value.places.push({
    id: "place_nested", kindId: "service_place", kindName: "服务地点", isBuilding: false,
    campusId: null, parentPlaceId: "place_child", lifecycleStatus: "active", revisionId: "pr_nested",
    displayName: "楼内子地点", summary: null, description: null,
    content: { detail: { facts: [], media: [] } }, contentHash: "h4", aliases: [],
  });
  value.locations.push(location("place", "place_nested", "point_place_nested"));
  value.facilities[0].hostPlaceId = "place_nested";
  value.merchants[0].hostPlaceId = "place_nested";

  const pois = buildMapPointPois(value, [campus]);
  assert.equal(pois.some((poi) => poi.poiKey === "place:place_nested"), false);
  assert.equal(pois.some((poi) => poi.poiKey === "facility:facility_free"), false);
  assert.equal(pois.some((poi) => poi.poiKey === "merchant:merchant_free"), false);
});

test("a parent hierarchy cycle fails the release projection deterministically", () => {
  const value = manifest();
  value.places.find((place) => place.id === "place_free").parentPlaceId = "place_cycle";
  value.places.push({
    id: "place_cycle", kindId: "service_place", kindName: "服务地点", isBuilding: false,
    campusId: null, parentPlaceId: "place_free", lifecycleStatus: "active", revisionId: "pr_cycle",
    displayName: "循环地点", summary: null, description: null,
    content: { detail: { facts: [], media: [] } }, contentHash: "h5", aliases: [],
  });

  assert.throws(
    () => buildMapPointPois(value, [campus]),
    /place hierarchy contains a cycle/,
  );
});

test("floor ownership and a host place anchor both count as building bindings", () => {
  const value = manifest();
  value.floors.push({
    id: "floor_1",
    buildingPlaceId: "building_1",
    levelCode: "F1",
    levelOrder: 1,
    displayName: "一层",
    isPublic: 1,
  });
  value.facilities[0].floorId = "floor_1";
  value.merchants[0].hostPlaceId = "place_free";
  value.locations.push(location(
    "place",
    "place_free",
    "place_free_building_anchor",
    { building_place_id: "building_1", isPrimary: 0, role: "other" },
  ));

  const pois = buildMapPointPois(value, [campus]);
  assert.equal(pois.some((poi) => poi.poiKey === "facility:facility_free"), false);
  assert.equal(pois.some((poi) => poi.poiKey === "merchant:merchant_free"), false);
});
