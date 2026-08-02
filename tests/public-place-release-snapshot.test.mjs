import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await build({
  stdin: {
    contents: `export { listPublicPlaces, publicPlace } from "./worker/modules/public.ts";`,
    resolveDir: root,
    sourcefile: "public-place-release-snapshot-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`;
const { listPublicPlaces, publicPlace } = await import(moduleUrl);

function manifestFixture() {
  return {
    schemaVersion: 2,
    release: { id: "release_snapshot", version: "snapshot-v1", createdAt: "2026-08-01T00:00:00.000Z" },
    campuses: [],
    places: [{
      id: "place_snapshot",
      kindId: "library",
      kindName: "图书馆",
      campusId: "campus_snapshot",
      parentPlaceId: null,
      lifecycleStatus: "active",
      isBuilding: true,
      revisionId: "revision_snapshot",
      displayName: "发布时名称",
      summary: "发布时摘要",
      description: "发布时介绍",
      content: { detail: { facts: [], media: [] } },
      contentHash: "snapshot_hash",
      aliases: ["发布时别名"],
    }],
    facilities: [{
      id: "facility_snapshot",
      facilityTypeId: "facility_type_snapshot",
      hostPlaceId: "place_snapshot",
      floorId: "floor_snapshot",
      indoorSpaceId: null,
      operationalStatus: "available",
      quantity: 1,
      revisionId: "facility_revision_snapshot",
      displayName: "发布时设施",
      contentHash: "facility_hash",
      facilityTypeStatus: "active",
      serviceHours: null,
      content: { locationDescription: "发布时位置" },
      visibilityPolicy: {},
    }],
    merchants: [],
    maps: [],
    locations: [{
      id: "anchor_snapshot",
      entityType: "place",
      entityId: "place_snapshot",
      role: "navigation_target",
      isPrimary: 1,
      campus_id: "campus_snapshot",
      building_place_id: "place_snapshot",
      floor_id: null,
      indoor_space_id: null,
      geometry_type: "Point",
      geometry_json: '{"type":"Point","coordinates":[121.4,31.3]}',
      crs: "GCJ02",
      map_version_id: null,
      map_feature_id: null,
      location_hint: "发布时导航点",
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
    }],
    floors: [{
      id: "floor_snapshot",
      buildingPlaceId: "place_snapshot",
      levelCode: "F1",
      levelOrder: 1,
      displayName: "发布时一层",
      isPublic: 1,
    }],
    facilityTypes: [{
      id: "facility_type_snapshot",
      code: "snapshot",
      name: "发布时设施类型",
      category: "service",
      iconKey: null,
      status: "active",
    }],
    mapFilters: [],
    transit: { stops: [] },
    searchDocuments: [],
    generatedAt: "2026-08-01T00:00:00.000Z",
  };
}

class Statement {
  constructor(sql, values = []) {
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new Statement(this.sql, values);
  }

  async first() {
    assert.match(this.sql, /^select id,artifact_key,artifact_sha256,version from releases where status='active'$/);
    assert.deepEqual(this.values, []);
    return {
      id: "release_snapshot",
      artifact_key: "release/snapshot.json",
      artifact_sha256: "a".repeat(64),
      version: "snapshot-v1",
    };
  }
}

function environment(manifest = manifestFixture()) {
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  return {
    DB: { prepare: (sql) => new Statement(sql) },
    SHUMAP_BUCKET: {
      get: async (key) => {
        assert.equal(key, "release/snapshot.json");
        return {
          key,
          size: bytes.byteLength,
          body: new ReadableStream(),
          bodyUsed: false,
          text: async () => new TextDecoder().decode(bytes),
          arrayBuffer: async () => bytes.buffer,
          json: async () => structuredClone(manifest),
        };
      },
    },
  };
}

test("public place detail is assembled entirely from the active release artifact", async () => {
  const response = await publicPlace(environment(), "place_snapshot");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    releaseId: "release_snapshot",
    place: {
      id: "place_snapshot",
      kindId: "library",
      kindName: "图书馆",
      isBuilding: true,
      campusId: "campus_snapshot",
      lifecycleStatus: "active",
      displayName: "发布时名称",
      summary: "发布时摘要",
      description: "发布时介绍",
      content: { detail: { facts: [], media: [] } },
      aliases: ["发布时别名"],
    },
    locations: [manifestFixture().locations[0]],
    facilities: [{
      id: "facility_snapshot",
      typeCode: "snapshot",
      typeName: "发布时设施类型",
      displayName: "发布时设施",
      operationalStatus: "available",
      floorId: "floor_snapshot",
      content: { locationDescription: "发布时位置" },
    }],
    floors: [{
      id: "floor_snapshot",
      levelCode: "F1",
      levelOrder: 1,
      displayName: "发布时一层",
    }],
  });
});

test("public place index is assembled and sorted from the active release artifact", async () => {
  const manifest = manifestFixture();
  manifest.places.push({
    ...manifest.places[0],
    id: "place_second",
    revisionId: "revision_second",
    displayName: "阿尔法地点",
    aliases: [],
  });
  const response = await listPublicPlaces(environment(manifest));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.releaseId, "release_snapshot");
  assert.deepEqual(body.items.map((item) => item.id), ["place_second", "place_snapshot"]);
  assert.equal(body.items[1].displayName, "发布时名称");
});

test("public place detail rejects an id absent from the active release artifact", async () => {
  await assert.rejects(
    () => publicPlace(environment(), "place_current_only"),
    (error) => error?.status === 404 && error?.code === "not_found",
  );
});
