import type { EntityLocationType, LocationInput, SessionPrincipal } from "../domain/types";
import type { Env } from "../types/cloudflare";
import { assertExists, first, run } from "../lib/db";
import { HttpError } from "../lib/http";
import { isoNow, jsonString, makeId } from "../lib/values";

const ROLES = [
  "primary_display", "footprint", "centroid", "main_entrance", "accessible_entrance",
  "navigation_target", "service_position", "boarding_point", "alighting_point", "event_location",
  "impact_area", "route_shape", "other",
] as const;

const PRECISIONS = ["campus", "building", "floor", "space", "exact", "unknown"] as const;

export async function createLocation(
  env: Env,
  entityType: EntityLocationType,
  entityId: string,
  input: LocationInput,
  principal: SessionPrincipal,
  isPrimary: boolean,
): Promise<{ anchorId: string; bindingId: string }> {
  validateInput(input);
  await validateHierarchy(env, input);

  const now = isoNow();
  const anchorId = makeId("anchor");
  const bindingId = makeId("eloc");
  const geometryType = input.geometryType ?? "Point";
  const verificationStatus = principal.permissions.includes("review:content") || principal.permissions.includes("*")
    ? "reviewed"
    : "unverified";
  const geometryJson = input.geometry === undefined || input.geometry === null ? null : jsonString(input.geometry);

  const statements = [];
  if (isPrimary) {
    statements.push(env.DB.prepare("update entity_locations set is_primary=0 where entity_type=? and entity_id=?").bind(entityType, entityId));
  }
  statements.push(
    env.DB.prepare(
      `insert into location_anchors(
        id,campus_id,building_place_id,floor_id,indoor_space_id,role,geometry_type,geometry_json,crs,map_version_id,
        map_feature_id,location_hint,precision_level,accuracy_meters,source_id,verification_status,valid_from,valid_to,created_at,updated_at
      ) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      anchorId, input.campusId ?? null, input.buildingPlaceId ?? null, input.floorId ?? null, input.indoorSpaceId ?? null,
      input.role, geometryType, geometryJson, input.crs ?? null, input.mapVersionId ?? null, input.mapFeatureId ?? null,
      input.locationHint ?? null, input.precisionLevel ?? "unknown", input.accuracyMeters ?? null, input.sourceId ?? null,
      verificationStatus, input.validFrom ?? null, input.validTo ?? null, now, now,
    ),
  );
  statements.push(
    env.DB.prepare(
      "insert into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,valid_from,valid_to,created_at) values(?,?,?,?,?,?,?,?,?)",
    ).bind(bindingId, entityType, entityId, anchorId, input.role, isPrimary ? 1 : 0, input.validFrom ?? null, input.validTo ?? null, now),
  );
  await env.DB.batch(statements);
  return { anchorId, bindingId };
}

export async function retireEntityLocations(env: Env, entityType: EntityLocationType, entityId: string): Promise<void> {
  const now = isoNow();
  await run(
    env.DB,
    `update entity_locations set valid_to=coalesce(valid_to,?) where entity_type=? and entity_id=?`,
    [now, entityType, entityId],
  );
}

function validateInput(input: LocationInput): void {
  if (!ROLES.includes(input.role)) throw new HttpError(400, "validation_error", "Invalid location role");
  if (input.precisionLevel && !PRECISIONS.includes(input.precisionLevel)) {
    throw new HttpError(400, "validation_error", "Invalid location precision");
  }
  if (input.geometry !== undefined && input.geometry !== null && !input.crs && !input.mapVersionId) {
    throw new HttpError(400, "validation_error", "A coordinate reference system or map version is required for geometry");
  }
  if (input.mapFeatureId && !input.mapVersionId) {
    throw new HttpError(400, "validation_error", "A map feature must be bound to its map version");
  }
  if (!input.buildingPlaceId && !input.floorId && !input.indoorSpaceId && !input.mapFeatureId && input.geometry == null) {
    throw new HttpError(400, "validation_error", "Location must identify a spatial parent, map feature, or geometry");
  }
}

async function validateHierarchy(env: Env, input: LocationInput): Promise<void> {
  await Promise.all([
    assertExists(env.DB, "campuses", input.campusId, "Campus"),
    assertExists(env.DB, "buildings", input.buildingPlaceId, "Building"),
    assertExists(env.DB, "floors", input.floorId, "Floor"),
    assertExists(env.DB, "indoor_spaces", input.indoorSpaceId, "Indoor space"),
    assertExists(env.DB, "map_versions", input.mapVersionId, "Map version"),
    assertExists(env.DB, "map_features", input.mapFeatureId, "Map feature"),
    assertExists(env.DB, "data_sources", input.sourceId, "Data source"),
  ]);

  if (input.floorId) {
    const floor = await first<{ building_place_id: string }>(env.DB, "select building_place_id from floors where id=?", [input.floorId]);
    if (input.buildingPlaceId && floor?.building_place_id !== input.buildingPlaceId) {
      throw new HttpError(400, "invalid_spatial_hierarchy", "Floor does not belong to the selected building");
    }
  }
  if (input.indoorSpaceId) {
    const space = await first<{ floor_id: string }>(env.DB, "select floor_id from indoor_spaces where id=?", [input.indoorSpaceId]);
    if (input.floorId && space?.floor_id !== input.floorId) {
      throw new HttpError(400, "invalid_spatial_hierarchy", "Space does not belong to the selected floor");
    }
  }
  if (input.mapFeatureId && input.mapVersionId) {
    const feature = await first<{ map_version_id: string }>(env.DB, "select map_version_id from map_features where id=?", [input.mapFeatureId]);
    if (feature?.map_version_id !== input.mapVersionId) {
      throw new HttpError(400, "invalid_map_binding", "Map feature does not belong to the selected map version");
    }
  }
}
