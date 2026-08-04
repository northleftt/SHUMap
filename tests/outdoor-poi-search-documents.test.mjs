import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundled = await build({
  absWorkingDir: root,
  entryPoints: ["worker/modules/releases.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`;
const { buildSearchDocuments } = await import(moduleUrl);

function place(id, isBuilding, campusId = "campus_1") {
  return {
    id,
    kindId: isBuilding ? "building" : "service_place",
    kindName: isBuilding ? "建筑" : "服务地点",
    campusId,
    parentPlaceId: null,
    lifecycleStatus: "active",
    isBuilding,
    revisionId: `revision_${id}`,
    displayName: id,
    summary: null,
    description: null,
    contentHash: `hash_${id}`,
    content: { detail: { facts: [], media: [] } },
    aliases: [],
  };
}

function facility(id, hostPlaceId) {
  return {
    id,
    facilityTypeId: "type_charge",
    hostPlaceId,
    floorId: null,
    indoorSpaceId: null,
    operationalStatus: "available",
    quantity: 1,
    revisionId: `revision_${id}`,
    displayName: id,
    facilityTypeStatus: "active",
    serviceHours: null,
    content: {},
    contentHash: `hash_${id}`,
    visibilityPolicy: {},
  };
}

function merchant(id, hostPlaceId) {
  return {
    id,
    organizationId: null,
    hostPlaceId,
    floorId: null,
    indoorSpaceId: null,
    revisionId: `revision_${id}`,
    displayName: id,
    businessType: null,
    openingHours: null,
    contact: null,
    content: {},
    contentHash: `hash_${id}`,
  };
}

function location(entityType, entityId, overrides = {}) {
  return {
    id: `location_${entityId}`,
    entityType,
    entityId,
    role: "primary_display",
    isPrimary: 1,
    campus_id: null,
    building_place_id: null,
    floor_id: null,
    indoor_space_id: null,
    geometry_type: "Point",
    geometry_json: '{"type":"Point","coordinates":[20,30]}',
    crs: "svg_viewbox",
    map_version_id: "map_1",
    map_feature_id: null,
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
    sourceElementId: null,
    featureKind: null,
    ...overrides,
  };
}

test("search documents reserve buildingPlaceId for actual buildings", () => {
  const places = [place("building_1", true), place("place_host", false)];
  const facilities = [
    facility("facility_building", "building_1"),
    facility("facility_place", "place_host"),
    facility("facility_free", null),
  ];
  const merchants = [
    merchant("merchant_building", "building_1"),
    merchant("merchant_place", "place_host"),
    merchant("merchant_free", null),
  ];
  const locations = [
    location("facility", "facility_place"),
    location("facility", "facility_free", { campus_id: "campus_1" }),
    location("merchant_outlet", "merchant_place"),
    location("merchant_outlet", "merchant_free", { campus_id: "campus_1" }),
  ];
  const documents = buildSearchDocuments(places, facilities, merchants, locations);
  const byKey = new Map(documents.map((document) => [`${document.documentType}:${document.entityId}`, document]));

  assert.deepEqual(
    ["facility:facility_building", "merchant_outlet:merchant_building"].map((key) => byKey.get(key)?.buildingPlaceId),
    ["building_1", "building_1"],
  );
  assert.deepEqual(
    ["facility:facility_place", "merchant_outlet:merchant_place"].map((key) => ({
      buildingPlaceId: byKey.get(key)?.buildingPlaceId,
      campusId: byKey.get(key)?.campusId,
    })),
    [
      { buildingPlaceId: null, campusId: "campus_1" },
      { buildingPlaceId: null, campusId: "campus_1" },
    ],
  );
  assert.deepEqual(
    ["facility:facility_free", "merchant_outlet:merchant_free"].map((key) => byKey.get(key)?.campusId),
    ["campus_1", "campus_1"],
  );
});

test("a location anchor that names a building folds the search result into that building", () => {
  const documents = buildSearchDocuments(
    [place("building_1", true)],
    [facility("facility_1", null)],
    [],
    [location("facility", "facility_1", { building_place_id: "building_1", campus_id: "campus_1" })],
  );
  const document = documents.find((item) => item.entityId === "facility_1");
  assert.equal(document?.buildingPlaceId, "building_1");
});

test("any location anchor that names a building folds the search result into that building", () => {
  const documents = buildSearchDocuments(
    [place("building_1", true)],
    [facility("facility_1", null)],
    [],
    [
      location("facility", "facility_1", { id: "location_primary", campus_id: "campus_1" }),
      location("facility", "facility_1", {
        id: "location_secondary",
        isPrimary: 0,
        role: "service_position",
        building_place_id: "building_1",
      }),
    ],
  );
  const document = documents.find((item) => item.entityId === "facility_1");
  assert.equal(document?.buildingPlaceId, "building_1");
  assert.equal(document?.mapTarget.id, "location_primary");
});

test("non-building places and hosted entities fold through the complete parent chain", () => {
  const parent = place("place_parent", false, null);
  parent.parentPlaceId = "building_1";
  const child = place("place_child", false, null);
  child.parentPlaceId = "place_parent";
  const documents = buildSearchDocuments(
    [place("building_1", true), parent, child],
    [facility("facility_child", "place_child")],
    [merchant("merchant_child", "place_child")],
    [],
  );
  const byKey = new Map(documents.map((document) => [`${document.documentType}:${document.entityId}`, document]));

  assert.deepEqual(
    ["place:place_parent", "place:place_child", "facility:facility_child", "merchant_outlet:merchant_child"]
      .map((key) => ({
        buildingPlaceId: byKey.get(key)?.buildingPlaceId,
        campusId: byKey.get(key)?.campusId,
      })),
    Array.from({ length: 4 }, () => ({ buildingPlaceId: "building_1", campusId: "campus_1" })),
  );
});

test("floor ownership and a host place anchor fold hosted entities into a building", () => {
  const host = place("place_host", false);
  const documents = buildSearchDocuments(
    [place("building_1", true), host],
    [facility("facility_floor", null)],
    [merchant("merchant_host", "place_host")],
    [location("place", "place_host", { building_place_id: "building_1" })],
    [{
      id: "floor_1",
      buildingPlaceId: "building_1",
      levelCode: "F1",
      levelOrder: 1,
      displayName: "一层",
      isPublic: 1,
    }],
  );
  const facilityDocument = documents.find((document) => document.entityId === "facility_floor");
  const merchantDocument = documents.find((document) => document.entityId === "merchant_host");
  assert.equal(facilityDocument?.buildingPlaceId, null);
  assert.equal(merchantDocument?.buildingPlaceId, "building_1");

  const floorFacility = facility("facility_floor_bound", null);
  floorFacility.floorId = "floor_1";
  const floorDocuments = buildSearchDocuments(
    [place("building_1", true)],
    [floorFacility],
    [],
    [],
    [{
      id: "floor_1",
      buildingPlaceId: "building_1",
      levelCode: "F1",
      levelOrder: 1,
      displayName: "一层",
      isPublic: 1,
    }],
  );
  assert.equal(floorDocuments.find((document) => document.entityId === "facility_floor_bound")?.buildingPlaceId, "building_1");
});
