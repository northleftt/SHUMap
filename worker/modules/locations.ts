import type { RevisionLocationInput } from "../../shared/revision-contract";
import type { EntityLocationType, SessionPrincipal } from "../domain/types";
import type { D1PreparedStatement, Env } from "../types/cloudflare";
import { all, assertExists, first, run } from "../lib/db";
import { HttpError } from "../lib/http";
import { isoNow, jsonString, makeId, parseJsonObject } from "../lib/values";

const ROLES = [
  "primary_display", "footprint", "centroid", "main_entrance", "accessible_entrance",
  "navigation_target", "service_position", "boarding_point", "alighting_point", "event_location",
  "impact_area", "route_shape", "other",
] as const;

const PRECISIONS = ["campus", "building", "floor", "space", "exact", "unknown"] as const;

interface StoredEntityLocation {
  bindingId: string;
  role: RevisionLocationInput["role"];
  isPrimary: number;
  campusId: string | null;
  buildingPlaceId: string | null;
  floorId: string | null;
  indoorSpaceId: string | null;
  geometryType: RevisionLocationInput["geometryType"];
  geometryJson: string | null;
  crs: string | null;
  mapVersionId: string | null;
  mapFeatureId: string | null;
  sourceElementId: string | null;
  locationHint: string | null;
  precisionLevel: RevisionLocationInput["precisionLevel"];
  accuracyMeters: number | null;
  sourceId: string | null;
  validFrom: string | null;
  validTo: string | null;
}

export async function listEntityLocations(
  env: Env,
  entityType: EntityLocationType,
  entityId: string,
): Promise<Array<RevisionLocationInput & { bindingId: string; sourceElementId: string | null }>> {
  const rows = await all<StoredEntityLocation>(
    env.DB,
    `select el.id as bindingId,el.role,el.is_primary as isPrimary,
            la.campus_id as campusId,la.building_place_id as buildingPlaceId,
            la.floor_id as floorId,la.indoor_space_id as indoorSpaceId,
            la.geometry_type as geometryType,la.geometry_json as geometryJson,la.crs,
            la.map_version_id as mapVersionId,la.map_feature_id as mapFeatureId,
            mf.source_element_id as sourceElementId,la.location_hint as locationHint,
            la.precision_level as precisionLevel,la.accuracy_meters as accuracyMeters,
            la.source_id as sourceId,la.valid_from as validFrom,la.valid_to as validTo
       from entity_locations el
       join location_anchors la on la.id=el.anchor_id
       left join map_features mf on mf.id=la.map_feature_id
      where el.entity_type=? and el.entity_id=? and el.valid_to is null
      order by el.is_primary desc,el.created_at,el.id`,
    [entityType, entityId],
  );
  return rows.map(({ geometryJson, isPrimary, ...row }) => {
    if (isPrimary !== 0 && isPrimary !== 1) throw new Error(`location ${row.bindingId} is_primary must be 0 or 1`);
    return {
      ...row,
      geometry: geometryJson === null ? null : parseJsonObject(geometryJson, `location ${row.bindingId} geometry_json`),
      isPrimary: isPrimary === 1,
    };
  });
}

/**
 * Same shape as {@link listEntityLocations} but for every entity of one type at
 * once, so a management list page can render each row's locations without one
 * request per entity. Kept as its own query rather than a parameter on
 * `listEntityLocations` so the single-entity payloads stay byte-identical.
 */
export async function listEntityLocationsByType(
  env: Env,
  entityType: EntityLocationType,
): Promise<Array<RevisionLocationInput & { entityId: string; bindingId: string; sourceElementId: string | null }>> {
  const rows = await all<StoredEntityLocation & { entityId: string }>(
    env.DB,
    `select el.id as bindingId,el.entity_id as entityId,el.role,el.is_primary as isPrimary,
            la.campus_id as campusId,la.building_place_id as buildingPlaceId,
            la.floor_id as floorId,la.indoor_space_id as indoorSpaceId,
            la.geometry_type as geometryType,la.geometry_json as geometryJson,la.crs,
            la.map_version_id as mapVersionId,la.map_feature_id as mapFeatureId,
            mf.source_element_id as sourceElementId,la.location_hint as locationHint,
            la.precision_level as precisionLevel,la.accuracy_meters as accuracyMeters,
            la.source_id as sourceId,la.valid_from as validFrom,la.valid_to as validTo
       from entity_locations el
       join location_anchors la on la.id=el.anchor_id
       left join map_features mf on mf.id=la.map_feature_id
      where el.entity_type=? and el.valid_to is null
      order by el.entity_id,el.is_primary desc,el.created_at,el.id`,
    [entityType],
  );
  return rows.map(({ geometryJson, isPrimary, ...row }) => {
    if (isPrimary !== 0 && isPrimary !== 1) throw new Error(`location ${row.bindingId} is_primary must be 0 or 1`);
    return {
      ...row,
      geometry: geometryJson === null ? null : parseJsonObject(geometryJson, `location ${row.bindingId} geometry_json`),
      isPrimary: isPrimary === 1,
    };
  });
}

/**
 * Validates a location input and returns the anchor + binding inserts without
 * running them, so callers can compose several locations into a single
 * transactional `DB.batch` (used by the operational event replace-all edit).
 */
export async function planLocation(
  env: Env,
  entityType: EntityLocationType,
  entityId: string,
  input: RevisionLocationInput,
  principal: SessionPrincipal,
  now: string,
): Promise<{ anchorId: string; bindingId: string; statements: D1PreparedStatement[] }> {
  validateInput(input);
  await validateHierarchy(env, input);

  const anchorId = makeId("anchor");
  const bindingId = makeId("eloc");
  const verificationStatus = principal.permissions.includes("review:content") || principal.permissions.includes("*")
    ? "reviewed"
    : "unverified";
  const geometryJson = input.geometry === null ? null : jsonString(input.geometry);

  const statements: D1PreparedStatement[] = [];
  statements.push(
    env.DB.prepare(
      `insert into location_anchors(
        id,campus_id,building_place_id,floor_id,indoor_space_id,role,geometry_type,geometry_json,crs,map_version_id,
        map_feature_id,location_hint,precision_level,accuracy_meters,source_id,verification_status,valid_from,valid_to,created_at,updated_at
      ) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      anchorId, input.campusId, input.buildingPlaceId, input.floorId, input.indoorSpaceId,
      input.role, input.geometryType, geometryJson, input.crs, input.mapVersionId, input.mapFeatureId,
      input.locationHint, input.precisionLevel, input.accuracyMeters, input.sourceId,
      verificationStatus, input.validFrom, input.validTo, now, now,
    ),
  );
  statements.push(
    env.DB.prepare(
      "insert into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,valid_from,valid_to,created_at) values(?,?,?,?,?,?,?,?,?)",
    ).bind(bindingId, entityType, entityId, anchorId, input.role, input.isPrimary ? 1 : 0, input.validFrom, input.validTo, now),
  );
  return { anchorId, bindingId, statements };
}

export async function validateLocation(env: Env, input: RevisionLocationInput): Promise<void> {
  validateInput(input);
  await validateHierarchy(env, input);
}

export async function retireEntityLocations(env: Env, entityType: EntityLocationType, entityId: string): Promise<void> {
  const now = isoNow();
  await run(
    env.DB,
    `update entity_locations set valid_to=coalesce(valid_to,?) where entity_type=? and entity_id=?`,
    [now, entityType, entityId],
  );
}

function validateInput(input: RevisionLocationInput): void {
  if (!ROLES.includes(input.role)) throw new HttpError(400, "validation_error", "Invalid location role");
  if (!PRECISIONS.includes(input.precisionLevel)) {
    throw new HttpError(400, "validation_error", "Invalid location precision");
  }
  if (input.geometry !== null && !input.crs && !input.mapVersionId) {
    throw new HttpError(400, "validation_error", "A coordinate reference system or map version is required for geometry");
  }
  if (input.mapFeatureId && !input.mapVersionId) {
    throw new HttpError(400, "validation_error", "A map feature must be bound to its map version");
  }
  if (!input.buildingPlaceId && !input.floorId && !input.indoorSpaceId && !input.mapFeatureId && input.geometry == null) {
    throw new HttpError(400, "validation_error", "Location must identify a spatial parent, map feature, or geometry");
  }
}

async function validateHierarchy(env: Env, input: RevisionLocationInput): Promise<void> {
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
  if (input.buildingPlaceId && input.campusId) {
    const building = await first<{ campus_id: string | null }>(
      env.DB,
      `select p.campus_id from buildings b join places p on p.id=b.place_id where b.place_id=?`,
      [input.buildingPlaceId],
    );
    if (building?.campus_id !== input.campusId) {
      throw new HttpError(400, "invalid_spatial_hierarchy", "Building does not belong to the selected campus");
    }
  }
  if (input.indoorSpaceId) {
    const space = await first<{ floor_id: string }>(env.DB, "select floor_id from indoor_spaces where id=?", [input.indoorSpaceId]);
    if (input.floorId && space?.floor_id !== input.floorId) {
      throw new HttpError(400, "invalid_spatial_hierarchy", "Space does not belong to the selected floor");
    }
  }
  if (input.mapFeatureId && input.mapVersionId) {
    const feature = await first<{ map_version_id: string; campus_id: string | null; floor_id: string | null }>(
      env.DB,
      `select mf.map_version_id,mv.campus_id,mv.floor_id
         from map_features mf join map_versions mv on mv.id=mf.map_version_id where mf.id=?`,
      [input.mapFeatureId],
    );
    if (feature?.map_version_id !== input.mapVersionId) {
      throw new HttpError(400, "invalid_map_binding", "Map feature does not belong to the selected map version");
    }
    if (input.campusId && feature?.campus_id && feature.campus_id !== input.campusId) {
      throw new HttpError(400, "invalid_map_binding", "Map feature does not belong to the selected campus");
    }
    if (input.floorId && feature?.floor_id !== input.floorId) {
      throw new HttpError(400, "invalid_map_binding", "Map feature does not belong to the selected floor");
    }
  }
}
