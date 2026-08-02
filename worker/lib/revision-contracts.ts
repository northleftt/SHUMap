import type {
  FacilityContent,
  FacilityRevisionWrite,
  FacilityStructure,
  GeometryType,
  JsonObject,
  MerchantContent,
  MerchantRevisionWrite,
  MerchantStructure,
  PlaceBuildingStructure,
  PlaceContent,
  PlaceRevisionWrite,
  PlaceStructure,
  RevisionLocationInput,
  RevisionMediaItem,
} from "../../shared/revision-contract";
import { NAVIGATION_CRS } from "../../shared/revision-contract";
import type { Env } from "../types/cloudflare";
import { assertExists, first } from "./db";
import { HttpError } from "./http";
import { parseJsonObject } from "./values";
import { assertActiveFacilityType, assertActiveMerchantMapFilter, assertActivePlaceKind } from "./taxonomy";
import { validateLocation } from "../modules/locations";

const LOCATION_ROLES = [
  "primary_display", "footprint", "centroid", "main_entrance", "accessible_entrance",
  "navigation_target", "service_position", "boarding_point", "alighting_point", "event_location",
  "impact_area", "route_shape", "other",
] as const;

const LOCATION_PRECISIONS = ["campus", "building", "floor", "space", "exact", "unknown"] as const;
const GEOMETRY_TYPES = ["Point", "LineString", "Polygon", "MultiPolygon"] as const;
const OPERATIONAL_STATUSES = ["available", "partially_available", "unavailable", "unknown"] as const;
const PUBLIC_ACCESS_LEVELS = ["public", "restricted", "private", "unknown"] as const;

export type RevisionContract = PlaceRevisionWrite | FacilityRevisionWrite | MerchantRevisionWrite;
export type RevisionContractType = "place" | "facility" | "merchant";

function validation(message: string): never {
  throw new HttpError(400, "validation_error", message);
}

function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) validation(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function exactRecord(value: unknown, field: string, fields: readonly string[]): Record<string, unknown> {
  const record = recordValue(value, field);
  const allowed = new Set(fields);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) validation(`${field}.${key} is not supported`);
  }
  for (const key of fields) {
    if (!Object.hasOwn(record, key)) validation(`${field}.${key} is required`);
  }
  return record;
}

function exactOptionalRecord(value: unknown, field: string, fields: readonly string[]): Record<string, unknown> {
  const record = recordValue(value, field);
  const allowed = new Set(fields);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) validation(`${field}.${key} is not supported`);
  }
  return record;
}

function text(value: unknown, field: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string") validation(`${field} must be a string`);
  const normalized = value.trim();
  if (!allowEmpty && !normalized) validation(`${field} must be a non-empty string`);
  if (normalized.length > maximum) validation(`${field} must be at most ${maximum} characters`);
  return allowEmpty && !normalized ? "" : normalized;
}

function nullableText(value: unknown, field: string, maximum: number): string | null {
  if (value === null) return null;
  return text(value, field, maximum);
}

function optionalText(record: Record<string, unknown>, key: string, field: string, maximum: number, allowEmpty = false): string | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  return text(record[key], field, maximum, allowEmpty);
}

function optionalNullableText(record: Record<string, unknown>, key: string, field: string, maximum: number): string | null {
  if (!Object.hasOwn(record, key) || record[key] === null) return null;
  return text(record[key], field, maximum);
}

function enumValue<const T extends readonly string[]>(value: unknown, field: string, allowed: T): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    validation(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T[number];
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") validation(`${field} must be a boolean`);
  return value;
}

function nullablePositiveInteger(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    validation(`${field} must be a positive integer or null`);
  }
  return value;
}

function nullableFiniteNonNegative(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    validation(`${field} must be a finite non-negative number or null`);
  }
  return value;
}

function stringArray(value: unknown, field: string, maximumItems: number): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    validation(`${field} must be an array with at most ${maximumItems} items`);
  }
  const result = value.map((item, index) => text(item, `${field}[${index}]`, 200));
  if (new Set(result).size !== result.length) validation(`${field} must not contain duplicates`);
  return result;
}

function coordinates(value: unknown, field: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2 || value.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    validation(`${field} must contain two finite numbers`);
  }
  return [value[0] as number, value[1] as number];
}

function polygonCoordinates(value: unknown, field: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    validation(`${field} must contain at least one ring`);
  }
  value.forEach((ring, ringIndex) => {
    if (!Array.isArray(ring) || ring.length < 4) {
      validation(`${field}[${ringIndex}] must contain at least four points`);
    }
    const points = ring.map((point, pointIndex) => coordinates(point, `${field}[${ringIndex}][${pointIndex}]`));
    const first = points[0];
    const last = points[points.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      validation(`${field}[${ringIndex}] must be closed`);
    }
  });
}

function geometryValue(value: unknown, field: string, geometryType: GeometryType): JsonObject | null {
  if (value === null || value === undefined) return null;
  const geometry = exactRecord(value, field, ["type", "coordinates"]);
  if (geometry.type !== geometryType) validation(`${field}.type must match geometryType`);
  if (geometryType === "Point") {
    coordinates(geometry.coordinates, `${field}.coordinates`);
  } else if (geometryType === "LineString") {
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2) {
      validation(`${field}.coordinates must contain at least two points`);
    }
    geometry.coordinates.forEach((point, index) => coordinates(point, `${field}.coordinates[${index}]`));
  } else if (geometryType === "Polygon") {
    polygonCoordinates(geometry.coordinates, `${field}.coordinates`);
  } else {
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) {
      validation(`${field}.coordinates must contain at least one polygon`);
    }
    geometry.coordinates.forEach((polygon, polygonIndex) => {
      polygonCoordinates(polygon, `${field}.coordinates[${polygonIndex}]`);
    });
  }
  return geometry;
}

export function normalizeLocationInput(value: unknown, field: string): RevisionLocationInput {
  const location = exactOptionalRecord(value, field, [
    "campusId", "buildingPlaceId", "floorId", "indoorSpaceId", "role", "geometryType", "geometry", "crs",
    "mapVersionId", "mapFeatureId", "locationHint", "precisionLevel", "accuracyMeters", "sourceId", "validFrom",
    "validTo", "isPrimary",
  ]);
  for (const required of ["role", "geometryType", "precisionLevel", "isPrimary"] as const) {
    if (!Object.hasOwn(location, required)) validation(`${field}.${required} is required`);
  }
  const campusId = optionalNullableText(location, "campusId", `${field}.campusId`, 100);
  const buildingPlaceId = optionalNullableText(location, "buildingPlaceId", `${field}.buildingPlaceId`, 100);
  const floorId = optionalNullableText(location, "floorId", `${field}.floorId`, 100);
  const indoorSpaceId = optionalNullableText(location, "indoorSpaceId", `${field}.indoorSpaceId`, 100);
  const role = enumValue(location.role, `${field}.role`, LOCATION_ROLES);
  const geometryType = enumValue(location.geometryType, `${field}.geometryType`, GEOMETRY_TYPES);
  const geometry = geometryValue(location.geometry, `${field}.geometry`, geometryType);
  const crs = optionalNullableText(location, "crs", `${field}.crs`, 100);
  const mapVersionId = optionalNullableText(location, "mapVersionId", `${field}.mapVersionId`, 100);
  const mapFeatureId = optionalNullableText(location, "mapFeatureId", `${field}.mapFeatureId`, 100);
  const locationHint = optionalNullableText(location, "locationHint", `${field}.locationHint`, 500);
  const sourceId = optionalNullableText(location, "sourceId", `${field}.sourceId`, 100);
  const validFrom = optionalNullableText(location, "validFrom", `${field}.validFrom`, 100);
  const validTo = optionalNullableText(location, "validTo", `${field}.validTo`, 100);
  if (floorId && !buildingPlaceId) validation(`${field}.floorId requires buildingPlaceId`);
  if (indoorSpaceId && !floorId) validation(`${field}.indoorSpaceId requires floorId`);
  if (mapFeatureId && !mapVersionId) validation(`${field}.mapFeatureId requires mapVersionId`);
  if (geometry && !crs && !mapVersionId) validation(`${field}.geometry requires crs or mapVersionId`);
  if (!buildingPlaceId && !floorId && !indoorSpaceId && !mapFeatureId && !geometry) {
    validation(`${field} must identify a spatial parent, map feature, or geometry`);
  }
  if (role === "navigation_target") {
    if (geometryType !== "Point" || geometry === null) {
      validation(`${field} navigation_target must contain a Point geometry`);
    }
    if (crs !== NAVIGATION_CRS) {
      validation(`${field} navigation_target.crs must be ${NAVIGATION_CRS}`);
    }
    const [longitude, latitude] = geometry.coordinates as [number, number];
    if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
      validation(`${field} navigation_target coordinates must be valid longitude and latitude`);
    }
  }
  return {
    campusId,
    buildingPlaceId,
    floorId,
    indoorSpaceId,
    role,
    geometryType,
    geometry,
    crs,
    mapVersionId,
    mapFeatureId,
    locationHint,
    precisionLevel: enumValue(location.precisionLevel, `${field}.precisionLevel`, LOCATION_PRECISIONS),
    accuracyMeters: nullableFiniteNonNegative(location.accuracyMeters, `${field}.accuracyMeters`),
    sourceId,
    validFrom,
    validTo,
    isPrimary: booleanValue(location.isPrimary, `${field}.isPrimary`),
  };
}

export function normalizeLocationInputs(value: unknown, field: string, maximumItems = 20): RevisionLocationInput[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    validation(`${field} must be an array with at most ${maximumItems} items`);
  }
  const locations = value.map((item, index) => normalizeLocationInput(item, `${field}[${index}]`));
  const primaryCount = locations.filter((location) => location.isPrimary).length;
  if (locations.length > 0 && primaryCount !== 1) validation(`${field} must contain exactly one primary location`);
  return locations;
}

function mediaValue(value: unknown, field: string): RevisionMediaItem[] {
  if (!Array.isArray(value) || value.length > 100) validation(`${field} must be an array with at most 100 items`);
  return value.map((item, index) => {
    const itemField = `${field}[${index}]`;
    const media = exactOptionalRecord(item, itemField, ["id", "role", "url", "alt", "caption", "floorLevelCode"]);
    for (const required of ["role", "url"] as const) {
      if (!Object.hasOwn(media, required)) validation(`${itemField}.${required} is required`);
    }
    const id = optionalText(media, "id", `${itemField}.id`, 100);
    const alt = optionalText(media, "alt", `${itemField}.alt`, 500, true);
    const caption = optionalText(media, "caption", `${itemField}.caption`, 1_000, true);
    const floorLevelCode = optionalText(media, "floorLevelCode", `${itemField}.floorLevelCode`, 50);
    return {
      role: enumValue(media.role, `${itemField}.role`, ["cover", "gallery"] as const),
      url: text(media.url, `${itemField}.url`, 2_000),
      ...(id === undefined ? {} : { id }),
      ...(alt === undefined ? {} : { alt }),
      ...(caption === undefined ? {} : { caption }),
      ...(floorLevelCode === undefined ? {} : { floorLevelCode }),
    };
  });
}

function validateOptionalMedia(content: Record<string, unknown>, field: string): void {
  if (Object.hasOwn(content, "media")) mediaValue(content.media, `${field}.media`);
}

export function normalizePlaceContent(value: unknown, field = "content"): PlaceContent {
  const content = recordValue(value, field);
  if (!Object.hasOwn(content, "detail")) validation(`${field}.detail is required`);
  const detail = recordValue(content.detail, `${field}.detail`);
  for (const required of ["facts", "media"] as const) {
    if (!Object.hasOwn(detail, required)) validation(`${field}.detail.${required} is required`);
  }
  if (!Array.isArray(detail.facts) || detail.facts.length > 100) {
    validation(`${field}.detail.facts must be an array with at most 100 items`);
  }
  detail.facts.forEach((item, index) => {
    const itemField = `${field}.detail.facts[${index}]`;
    const fact = exactOptionalRecord(item, itemField, ["id", "label", "value"]);
    for (const required of ["label", "value"] as const) {
      if (!Object.hasOwn(fact, required)) validation(`${itemField}.${required} is required`);
    }
    optionalText(fact, "id", `${itemField}.id`, 100);
    text(fact.label, `${itemField}.label`, 200);
    text(fact.value, `${itemField}.value`, 2_000);
  });
  mediaValue(detail.media, `${field}.detail.media`);
  if (Object.hasOwn(content, "address")) text(content.address, `${field}.address`, 1_000);
  return content as PlaceContent;
}

export function normalizeFacilityContent(value: unknown, field = "content"): FacilityContent {
  const content = recordValue(value, field);
  validateOptionalMedia(content, field);
  for (const key of ["fee", "locationDescription", "note"] as const) {
    if (Object.hasOwn(content, key)) text(content[key], `${field}.${key}`, 2_000);
  }
  return content as FacilityContent;
}

export function normalizeMerchantContent(value: unknown, field = "content"): MerchantContent {
  const content = recordValue(value, field);
  validateOptionalMedia(content, field);
  for (const key of ["avgPrice", "stallCode", "summary"] as const) {
    if (Object.hasOwn(content, key)) text(content[key], `${field}.${key}`, 2_000);
  }
  if (Object.hasOwn(content, "menu")) {
    if (!Array.isArray(content.menu) || content.menu.length > 200) {
      validation(`${field}.menu must be an array with at most 200 items`);
    }
    content.menu.forEach((item, index) => {
      const itemField = `${field}.menu[${index}]`;
      const menuItem = exactOptionalRecord(item, itemField, ["name", "price", "description"]);
      if (!Object.hasOwn(menuItem, "name")) validation(`${itemField}.name is required`);
      text(menuItem.name, `${itemField}.name`, 200);
      optionalText(menuItem, "price", `${itemField}.price`, 100);
      optionalText(menuItem, "description", `${itemField}.description`, 2_000);
    });
  }
  return content as MerchantContent;
}

function buildingValue(value: unknown, field: string): PlaceBuildingStructure | null {
  if (value === null) return null;
  const building = exactRecord(value, field, ["buildingCode", "managingOrganizationId", "publicAccessLevel"]);
  return {
    buildingCode: nullableText(building.buildingCode, `${field}.buildingCode`, 100),
    managingOrganizationId: nullableText(building.managingOrganizationId, `${field}.managingOrganizationId`, 100),
    publicAccessLevel: enumValue(building.publicAccessLevel, `${field}.publicAccessLevel`, PUBLIC_ACCESS_LEVELS),
  };
}

function placeStructureValue(value: unknown, field: string): PlaceStructure {
  const structure = exactRecord(value, field, [
    "kindId", "campusId", "parentPlaceId", "stableCode", "aliases", "building", "locations",
  ]);
  return {
    kindId: text(structure.kindId, `${field}.kindId`, 80),
    campusId: nullableText(structure.campusId, `${field}.campusId`, 100),
    parentPlaceId: nullableText(structure.parentPlaceId, `${field}.parentPlaceId`, 100),
    stableCode: nullableText(structure.stableCode, `${field}.stableCode`, 100),
    aliases: stringArray(structure.aliases, `${field}.aliases`, 20),
    building: buildingValue(structure.building, `${field}.building`),
    locations: normalizeLocationInputs(structure.locations, `${field}.locations`),
  };
}

function facilityStructureValue(value: unknown, field: string): FacilityStructure {
  const structure = exactRecord(value, field, [
    "facilityTypeId", "hostPlaceId", "floorId", "indoorSpaceId", "quantity", "operationalStatus", "locations",
  ]);
  return {
    facilityTypeId: text(structure.facilityTypeId, `${field}.facilityTypeId`, 100),
    hostPlaceId: nullableText(structure.hostPlaceId, `${field}.hostPlaceId`, 100),
    floorId: nullableText(structure.floorId, `${field}.floorId`, 100),
    indoorSpaceId: nullableText(structure.indoorSpaceId, `${field}.indoorSpaceId`, 100),
    quantity: nullablePositiveInteger(structure.quantity, `${field}.quantity`),
    operationalStatus: enumValue(structure.operationalStatus, `${field}.operationalStatus`, OPERATIONAL_STATUSES),
    locations: normalizeLocationInputs(structure.locations, `${field}.locations`),
  };
}

function merchantStructureValue(value: unknown, field: string): MerchantStructure {
  const structure = exactRecord(value, field, ["organizationId", "hostPlaceId", "floorId", "indoorSpaceId", "locations"]);
  return {
    organizationId: nullableText(structure.organizationId, `${field}.organizationId`, 100),
    hostPlaceId: text(structure.hostPlaceId, `${field}.hostPlaceId`, 100),
    floorId: nullableText(structure.floorId, `${field}.floorId`, 100),
    indoorSpaceId: nullableText(structure.indoorSpaceId, `${field}.indoorSpaceId`, 100),
    locations: normalizeLocationInputs(structure.locations, `${field}.locations`),
  };
}

function singleTextObject(value: unknown, field: string, key: string): Record<string, string> | null {
  if (value === null) return null;
  const record = exactRecord(value, field, [key]);
  return { [key]: text(record[key], `${field}.${key}`, 2_000) };
}

export function normalizePlaceRevision(value: unknown): PlaceRevisionWrite {
  const input = exactRecord(value, "revision", ["displayName", "summary", "description", "content", "sourceId", "structure"]);
  return {
    displayName: text(input.displayName, "displayName", 200),
    summary: nullableText(input.summary, "summary", 500),
    description: nullableText(input.description, "description", 10_000),
    content: normalizePlaceContent(input.content, "content"),
    sourceId: nullableText(input.sourceId, "sourceId", 100),
    structure: placeStructureValue(input.structure, "structure"),
  };
}

export function normalizeFacilityRevision(value: unknown): FacilityRevisionWrite {
  const input = exactRecord(value, "revision", ["displayName", "serviceHours", "content", "sourceId", "structure"]);
  const serviceHours = singleTextObject(input.serviceHours, "serviceHours", "text");
  return {
    displayName: text(input.displayName, "displayName", 200),
    serviceHours: serviceHours as { text: string } | null,
    content: normalizeFacilityContent(input.content, "content"),
    sourceId: nullableText(input.sourceId, "sourceId", 100),
    structure: facilityStructureValue(input.structure, "structure"),
  };
}

export function normalizeMerchantRevision(value: unknown): MerchantRevisionWrite {
  const input = exactRecord(value, "revision", [
    "displayName", "businessType", "openingHours", "contact", "content", "sourceId", "structure",
  ]);
  return {
    displayName: text(input.displayName, "displayName", 200),
    businessType: nullableText(input.businessType, "businessType", 100),
    openingHours: singleTextObject(input.openingHours, "openingHours", "text") as { text: string } | null,
    contact: singleTextObject(input.contact, "contact", "phone") as { phone: string } | null,
    content: normalizeMerchantContent(input.content, "content"),
    sourceId: nullableText(input.sourceId, "sourceId", 100),
    structure: merchantStructureValue(input.structure, "structure"),
  };
}

export function normalizeStoredRevision(type: "place", row: Record<string, unknown>): PlaceRevisionWrite;
export function normalizeStoredRevision(type: "facility", row: Record<string, unknown>): FacilityRevisionWrite;
export function normalizeStoredRevision(type: "merchant", row: Record<string, unknown>): MerchantRevisionWrite;
export function normalizeStoredRevision(type: RevisionContractType, row: Record<string, unknown>): RevisionContract {
  if (type === "place") {
    return normalizePlaceRevision({
      displayName: row.display_name,
      summary: row.summary,
      description: row.description,
      content: parseJsonObject(row.content_json, "place_revisions.content_json"),
      sourceId: row.source_id,
      structure: parseJsonObject(row.structure_json, "place_revisions.structure_json"),
    });
  }
  if (type === "facility") {
    return normalizeFacilityRevision({
      displayName: row.display_name,
      serviceHours: row.service_hours_json === null
        ? null
        : parseJsonObject(row.service_hours_json, "facility_revisions.service_hours_json"),
      content: parseJsonObject(row.content_json, "facility_revisions.content_json"),
      sourceId: row.source_id,
      structure: parseJsonObject(row.structure_json, "facility_revisions.structure_json"),
    });
  }
  return normalizeMerchantRevision({
    displayName: row.display_name,
    businessType: row.business_type,
    openingHours: row.opening_hours_json === null
      ? null
      : parseJsonObject(row.opening_hours_json, "merchant_revisions.opening_hours_json"),
    contact: row.contact_json === null
      ? null
      : parseJsonObject(row.contact_json, "merchant_revisions.contact_json"),
    content: parseJsonObject(row.content_json, "merchant_revisions.content_json"),
    sourceId: row.source_id,
    structure: parseJsonObject(row.structure_json, "merchant_revisions.structure_json"),
  });
}

async function validateHierarchy(
  env: Env,
  hostPlaceId: string | null,
  floorId: string | null,
  indoorSpaceId: string | null,
): Promise<void> {
  if (floorId && !hostPlaceId) validation("floorId requires hostPlaceId");
  if (indoorSpaceId && !floorId) validation("indoorSpaceId requires floorId");
  if (floorId) {
    const floor = await first<{ building_place_id: string }>(env.DB, "select building_place_id from floors where id=?", [floorId]);
    if (floor?.building_place_id !== hostPlaceId) {
      throw new HttpError(400, "invalid_spatial_hierarchy", "Floor does not belong to host place");
    }
  }
  if (indoorSpaceId) {
    const space = await first<{ floor_id: string }>(env.DB, "select floor_id from indoor_spaces where id=?", [indoorSpaceId]);
    if (space?.floor_id !== floorId) {
      throw new HttpError(400, "invalid_spatial_hierarchy", "Space does not belong to floor");
    }
  }
}

async function validateLocations(env: Env, locations: RevisionLocationInput[]): Promise<void> {
  for (const location of locations) await validateLocation(env, location);
}

function validatePlaceLocationContract(structure: PlaceStructure, placeId: string | null): void {
  const navigationTargets = structure.locations.filter((location) => location.role === "navigation_target");
  if (navigationTargets.length > 1) validation("A place can have at most one navigation target");
  if (!structure.building) return;
  if (!structure.campusId) validation("A building must belong to a campus");
  for (const location of structure.locations) {
    if (location.campusId !== structure.campusId) validation("Every building location must use the building campus");
    if (placeId === null && location.buildingPlaceId !== null) {
      validation("New building locations must leave buildingPlaceId empty until the place id is allocated");
    }
    if (placeId !== null && location.buildingPlaceId !== placeId) {
      validation("Every building location must reference its owning place");
    }
  }
  const footprints = structure.locations.filter((location) => location.role === "footprint");
  if (footprints.length !== 1) validation("A building must have exactly one footprint location");
  const [footprint] = footprints;
  if (footprint.campusId !== structure.campusId) validation("A building footprint must use the building campus");
  if (footprint.floorId || footprint.indoorSpaceId) validation("A building footprint cannot belong to a floor or indoor space");
  if (footprint.geometry !== null || footprint.crs !== null) validation("A building footprint must use imported map feature geometry");
  if (!footprint.mapVersionId || !footprint.mapFeatureId) {
    validation("A building footprint must reference a map feature and map version");
  }
}

async function validateBuildingFootprintFeature(env: Env, structure: PlaceStructure, placeId: string | null): Promise<void> {
  if (!structure.building) return;
  const footprint = structure.locations.find((location) => location.role === "footprint");
  if (!footprint?.mapFeatureId || !footprint.mapVersionId || !structure.campusId) {
    throw new Error("Normalized building footprint is incomplete");
  }
  const feature = await first<{
    featureKind: string;
    sourceElementId: string | null;
    geometryType: string | null;
    campusId: string | null;
    floorId: string | null;
    lifecycleStatus: string;
    footprintPlaceId: string | null;
  }>(
    env.DB,
    `select mf.feature_kind as featureKind,mf.source_element_id as sourceElementId,
            json_extract(mf.geometry_json,'$.type') as geometryType,
            mv.campus_id as campusId,mv.floor_id as floorId,mv.lifecycle_status as lifecycleStatus,
            (select el.entity_id
               from location_anchors la join entity_locations el on el.anchor_id=la.id
              where la.map_feature_id=mf.id and la.role='footprint' and la.valid_to is null
                and el.entity_type='place' and el.role='footprint' and el.valid_to is null
              limit 1) as footprintPlaceId
       from map_features mf join map_versions mv on mv.id=mf.map_version_id
      where mf.id=? and mv.id=?`,
    [footprint.mapFeatureId, footprint.mapVersionId],
  );
  if (!feature) validation("A building footprint map feature does not exist in its map version");
  if (feature.featureKind !== "building_footprint" && feature.featureKind !== "other") {
    validation("A building footprint must use an unclassified or building_footprint feature");
  }
  if (!feature.sourceElementId) validation("A building footprint feature must have a source element id");
  if (feature.geometryType !== "Polygon" && feature.geometryType !== "MultiPolygon") {
    validation("A building footprint feature must contain Polygon or MultiPolygon geometry");
  }
  if (feature.floorId !== null || feature.campusId !== structure.campusId) {
    validation("A building footprint map version must belong to the building campus");
  }
  if (feature.lifecycleStatus !== "ready" && feature.lifecycleStatus !== "published") {
    validation("A building footprint map version must be ready or published");
  }
  if (feature.footprintPlaceId !== null && feature.footprintPlaceId !== placeId) {
    validation("A building footprint feature already belongs to another place");
  }
}

export async function validatePlaceRevision(
  env: Env,
  revision: PlaceRevisionWrite,
  placeId: string | null,
): Promise<void> {
  const { structure } = revision;
  if (placeId && structure.parentPlaceId === placeId) validation("A place cannot be its own parent");
  validatePlaceLocationContract(structure, placeId);
  await Promise.all([
    assertActivePlaceKind(env, structure.kindId),
    assertExists(env.DB, "campuses", structure.campusId, "Campus"),
    assertExists(env.DB, "places", structure.parentPlaceId, "Parent place"),
    assertExists(env.DB, "organizations", structure.building?.managingOrganizationId, "Managing organization"),
    assertExists(env.DB, "data_sources", revision.sourceId, "Data source"),
  ]);
  if (structure.stableCode) {
    const duplicate = await first<{ id: string }>(
      env.DB,
      "select id from places where stable_code=? and coalesce(campus_id,'')=coalesce(?,'') limit 1",
      [structure.stableCode, structure.campusId],
    );
    if (duplicate && duplicate.id !== placeId) {
      throw new HttpError(409, "duplicate_stable_code", "Another place in this campus already uses this code");
    }
  }
  if (placeId && !structure.building) await assertBuildingCanBeRemoved(env, placeId);
  await validateLocations(env, structure.locations);
  await validateBuildingFootprintFeature(env, structure, placeId);
}

export async function validateFacilityRevision(env: Env, revision: FacilityRevisionWrite): Promise<void> {
  const { structure } = revision;
  await Promise.all([
    assertActiveFacilityType(env, structure.facilityTypeId),
    assertExists(env.DB, "places", structure.hostPlaceId, "Host place"),
    assertExists(env.DB, "floors", structure.floorId, "Floor"),
    assertExists(env.DB, "indoor_spaces", structure.indoorSpaceId, "Indoor space"),
    assertExists(env.DB, "data_sources", revision.sourceId, "Data source"),
  ]);
  await validateHierarchy(env, structure.hostPlaceId, structure.floorId, structure.indoorSpaceId);
  await validateLocations(env, structure.locations);
}

export async function validateMerchantRevision(env: Env, revision: MerchantRevisionWrite): Promise<void> {
  const { structure } = revision;
  await Promise.all([
    assertActiveMerchantMapFilter(env),
    assertExists(env.DB, "organizations", structure.organizationId, "Organization"),
    assertExists(env.DB, "places", structure.hostPlaceId, "Host place"),
    assertExists(env.DB, "floors", structure.floorId, "Floor"),
    assertExists(env.DB, "indoor_spaces", structure.indoorSpaceId, "Indoor space"),
    assertExists(env.DB, "data_sources", revision.sourceId, "Data source"),
  ]);
  await validateHierarchy(env, structure.hostPlaceId, structure.floorId, structure.indoorSpaceId);
  await validateLocations(env, structure.locations);
}

export async function assertBuildingCanBeRemoved(env: Env, placeId: string): Promise<void> {
  const building = await first<{ placeId: string }>(env.DB, "select place_id as placeId from buildings where place_id=?", [placeId]);
  if (!building) return;
  const [floor, anchor, searchDocument] = await Promise.all([
    first<{ id: string }>(env.DB, "select id from floors where building_place_id=? limit 1", [placeId]),
    first<{ id: string }>(env.DB, "select id from location_anchors where building_place_id=? limit 1", [placeId]),
    first<{ entityId: string }>(env.DB, "select entity_id as entityId from search_documents where building_place_id=? limit 1", [placeId]),
  ]);
  if (floor || anchor || searchDocument) {
    throw new HttpError(409, "building_in_use", "Building structure is referenced by floors, locations, or released search data");
  }
}
