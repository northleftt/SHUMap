import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await build({
  absWorkingDir: root,
  entryPoints: ["src/lib/api/publicContract.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`;
const { parseFacilityStatusResponse, parseOperationalEventsResponse } = await import(moduleUrl);

function operationFixture() {
  return {
    items: [{
      id: "event_1",
      eventType: "maintenance",
      severity: "warning",
      color: null,
      editorialStatus: "approved",
      operationalStatus: "active",
      title: "道路维修",
      description: null,
      startsAt: "2026-08-01T01:00:00.000Z",
      expectedEndsAt: "2026-08-02T01:00:00.000Z",
      autoExpireAt: null,
      resolvedAt: null,
      lastVerifiedAt: "2026-08-01T02:00:00.000Z",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T02:00:00.000Z",
      targets: [{ targetType: "place", targetId: "place_1", impactType: "affected" }],
      updates: [{
        id: "event_update_1",
        status: "active",
        message: "施工已开始",
        createdAt: "2026-08-01T02:00:00.000Z",
      }],
      locations: [{
        id: "anchor_1",
        role: "impact_area",
        geometryType: "Polygon",
        geometryJson: '{"type":"Polygon","coordinates":[[[0,0],[10,0],[10,10],[0,0]]]}',
        crs: "svg_viewbox",
        campusId: "campus_baoshan",
      }],
    }],
  };
}

test("public live-data parsers accept their complete contracts", () => {
  const operations = operationFixture();
  assert.deepEqual(parseOperationalEventsResponse(operations), operations);
  assert.deepEqual(parseFacilityStatusResponse({
    statuses: {
      facility_1: "available",
      facility_2: "partially_available",
      facility_3: "unavailable",
      facility_4: "unknown",
    },
  }), {
    statuses: {
      facility_1: "available",
      facility_2: "partially_available",
      facility_3: "unavailable",
      facility_4: "unknown",
    },
  });
});

test("facility status parser rejects unknown operational states", () => {
  assert.throws(
    () => parseFacilityStatusResponse({ statuses: { facility_1: "working" } }),
    /facility_1 must be one of available, partially_available, unavailable, unknown/,
  );
});

test("operational event parser rejects unknown enum values", () => {
  const value = operationFixture();
  value.items[0].eventType = "temporary";
  assert.throws(
    () => parseOperationalEventsResponse(value),
    /eventType must be one of maintenance, activity, closure, notice/,
  );
});

test("operational event parser passes through a custom marker color", () => {
  const value = operationFixture();
  value.items[0].color = "#7c3aed";
  const parsed = parseOperationalEventsResponse(value);
  assert.equal(parsed.items[0].color, "#7c3aed");
});

test("operational event parser requires geometry to match its location role", () => {
  const value = operationFixture();
  value.items[0].locations[0].geometryType = "LineString";
  value.items[0].locations[0].geometryJson = '{"type":"LineString","coordinates":[[0,0],[10,10]]}';
  assert.throws(
    () => parseOperationalEventsResponse(value),
    /locations\[0\] geometry must match its role/,
  );
});
