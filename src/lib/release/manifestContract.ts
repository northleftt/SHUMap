import {
  arrayValue,
  objectValue,
  oneOf,
  requiredBoolean,
  requiredString,
} from "../dataContract";
import type {
  ReleaseCampus,
  ReleaseFacility,
  ReleaseFacilityType,
  ReleaseFloor,
  ReleaseLocation,
  ReleaseManifest,
  ReleaseMapFilter,
  ReleaseMapVersion,
  ReleaseMerchant,
  ReleasePlace,
  ReleaseTransit,
  SearchDocument,
  TransitStop,
} from "../api/types";
import { NAVIGATION_CRS } from "../../../shared/revision-contract";

function exactObject(value: unknown, field: string, fields: readonly string[]): Record<string, unknown> {
  const record = objectValue(value, field);
  const allowed = new Set(fields);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`${field}.${key} is not supported`);
  }
  for (const key of fields) {
    if (!Object.hasOwn(record, key)) throw new Error(`${field}.${key} is required`);
  }
  return record;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string or null`);
  return value;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be a finite number`);
  return value;
}

function nullableFiniteNumber(value: unknown, field: string): number | null {
  if (value === null) return null;
  return finiteNumber(value, field);
}

function integerFlag(value: unknown, field: string): 0 | 1 {
  if (value !== 0 && value !== 1) throw new Error(`${field} must be 0 or 1`);
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  return arrayValue(value, field).map((item, index) => requiredString(item, `${field}[${index}]`));
}

function jsonObjectValue(value: unknown, field: string): Record<string, unknown> {
  const record = objectValue(value, field);
  for (const [key, item] of Object.entries(record)) validateJsonValue(item, `${field}.${key}`);
  return record;
}

function validateJsonValue(value: unknown, field: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${field} must contain a finite JSON number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateJsonValue(item, `${field}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      validateJsonValue(item, `${field}.${key}`);
    }
    return;
  }
  throw new Error(`${field} must contain a JSON value`);
}

function objectArray<T>(value: unknown, field: string, parse: (item: unknown, itemField: string) => T): T[] {
  return arrayValue(value, field).map((item, index) => parse(item, `${field}[${index}]`));
}

function nullableSingleTextObject(
  value: unknown,
  field: string,
  property: "text" | "phone",
): { text: string } | { phone: string } | null {
  if (value === null) return null;
  const record = exactObject(value, field, [property]);
  const text = requiredString(record[property], `${field}.${property}`);
  return property === "text" ? { text } : { phone: text };
}

function campus(value: unknown, field: string): ReleaseCampus {
  const row = exactObject(value, field, ["id", "code", "name", "timezone"]);
  return {
    id: requiredString(row.id, `${field}.id`),
    code: requiredString(row.code, `${field}.code`),
    name: requiredString(row.name, `${field}.name`),
    timezone: requiredString(row.timezone, `${field}.timezone`),
  };
}

function place(value: unknown, field: string): ReleasePlace {
  const row = exactObject(value, field, [
    "id", "kindId", "kindName", "campusId", "parentPlaceId", "lifecycleStatus", "revisionId", "displayName",
    "summary", "description", "contentHash", "isBuilding", "content", "aliases",
  ]);
  return {
    id: requiredString(row.id, `${field}.id`),
    kindId: requiredString(row.kindId, `${field}.kindId`),
    kindName: requiredString(row.kindName, `${field}.kindName`),
    campusId: nullableString(row.campusId, `${field}.campusId`),
    parentPlaceId: nullableString(row.parentPlaceId, `${field}.parentPlaceId`),
    lifecycleStatus: requiredString(row.lifecycleStatus, `${field}.lifecycleStatus`),
    revisionId: requiredString(row.revisionId, `${field}.revisionId`),
    displayName: requiredString(row.displayName, `${field}.displayName`),
    summary: nullableString(row.summary, `${field}.summary`),
    description: nullableString(row.description, `${field}.description`),
    contentHash: requiredString(row.contentHash, `${field}.contentHash`),
    isBuilding: requiredBoolean(row.isBuilding, `${field}.isBuilding`),
    content: jsonObjectValue(row.content, `${field}.content`),
    aliases: stringArray(row.aliases, `${field}.aliases`),
  };
}

function facility(value: unknown, field: string): ReleaseFacility {
  const row = exactObject(value, field, [
    "id", "facilityTypeId", "hostPlaceId", "floorId", "indoorSpaceId", "operationalStatus", "quantity",
    "revisionId", "displayName", "contentHash", "facilityTypeStatus", "serviceHours", "content", "visibilityPolicy",
  ]);
  const serviceHours = nullableSingleTextObject(row.serviceHours, `${field}.serviceHours`, "text");
  return {
    id: requiredString(row.id, `${field}.id`),
    facilityTypeId: requiredString(row.facilityTypeId, `${field}.facilityTypeId`),
    hostPlaceId: nullableString(row.hostPlaceId, `${field}.hostPlaceId`),
    floorId: nullableString(row.floorId, `${field}.floorId`),
    indoorSpaceId: nullableString(row.indoorSpaceId, `${field}.indoorSpaceId`),
    operationalStatus: oneOf(row.operationalStatus, `${field}.operationalStatus`, [
      "available", "partially_available", "unavailable", "unknown",
    ] as const),
    quantity: nullableFiniteNumber(row.quantity, `${field}.quantity`),
    revisionId: requiredString(row.revisionId, `${field}.revisionId`),
    displayName: requiredString(row.displayName, `${field}.displayName`),
    contentHash: requiredString(row.contentHash, `${field}.contentHash`),
    facilityTypeStatus: oneOf(row.facilityTypeStatus, `${field}.facilityTypeStatus`, ["active", "disabled"] as const),
    serviceHours: serviceHours as { text: string } | null,
    content: jsonObjectValue(row.content, `${field}.content`),
    visibilityPolicy: jsonObjectValue(row.visibilityPolicy, `${field}.visibilityPolicy`),
  };
}

function merchant(value: unknown, field: string): ReleaseMerchant {
  const row = exactObject(value, field, [
    "id", "organizationId", "hostPlaceId", "floorId", "indoorSpaceId", "revisionId", "displayName",
    "businessType", "contentHash", "openingHours", "contact", "content",
  ]);
  const openingHours = nullableSingleTextObject(row.openingHours, `${field}.openingHours`, "text");
  const contact = nullableSingleTextObject(row.contact, `${field}.contact`, "phone");
  return {
    id: requiredString(row.id, `${field}.id`),
    organizationId: nullableString(row.organizationId, `${field}.organizationId`),
    hostPlaceId: nullableString(row.hostPlaceId, `${field}.hostPlaceId`),
    floorId: nullableString(row.floorId, `${field}.floorId`),
    indoorSpaceId: nullableString(row.indoorSpaceId, `${field}.indoorSpaceId`),
    revisionId: requiredString(row.revisionId, `${field}.revisionId`),
    displayName: requiredString(row.displayName, `${field}.displayName`),
    businessType: nullableString(row.businessType, `${field}.businessType`),
    contentHash: requiredString(row.contentHash, `${field}.contentHash`),
    openingHours: openingHours as { text: string } | null,
    contact: contact as { phone: string } | null,
    content: jsonObjectValue(row.content, `${field}.content`),
  };
}

function floor(value: unknown, field: string): ReleaseFloor {
  const row = exactObject(value, field, ["id", "buildingPlaceId", "levelCode", "levelOrder", "displayName", "isPublic"]);
  return {
    id: requiredString(row.id, `${field}.id`),
    buildingPlaceId: requiredString(row.buildingPlaceId, `${field}.buildingPlaceId`),
    levelCode: requiredString(row.levelCode, `${field}.levelCode`),
    levelOrder: finiteNumber(row.levelOrder, `${field}.levelOrder`),
    displayName: requiredString(row.displayName, `${field}.displayName`),
    isPublic: integerFlag(row.isPublic, `${field}.isPublic`),
  };
}

function facilityType(value: unknown, field: string): ReleaseFacilityType {
  const row = exactObject(value, field, ["id", "code", "name", "category", "iconKey", "status"]);
  return {
    id: requiredString(row.id, `${field}.id`),
    code: requiredString(row.code, `${field}.code`),
    name: requiredString(row.name, `${field}.name`),
    category: requiredString(row.category, `${field}.category`),
    iconKey: nullableString(row.iconKey, `${field}.iconKey`),
    status: oneOf(row.status, `${field}.status`, ["active", "disabled"] as const),
  };
}

function mapFilter(value: unknown, field: string): ReleaseMapFilter {
  const row = exactObject(value, field, ["id", "key", "label", "sortOrder", "placeKindIds", "facilityTypeIds", "includesMerchants"]);
  return {
    id: requiredString(row.id, `${field}.id`),
    key: requiredString(row.key, `${field}.key`),
    label: requiredString(row.label, `${field}.label`),
    sortOrder: finiteNumber(row.sortOrder, `${field}.sortOrder`),
    placeKindIds: stringArray(row.placeKindIds, `${field}.placeKindIds`),
    facilityTypeIds: stringArray(row.facilityTypeIds, `${field}.facilityTypeIds`),
    includesMerchants: requiredBoolean(row.includesMerchants, `${field}.includesMerchants`),
  };
}

function mapVersion(value: unknown, field: string): ReleaseMapVersion {
  const row = exactObject(value, field, [
    "id", "campus_id", "floor_id", "map_asset_id", "parent_version_id", "version_label",
    "coordinate_space_type", "coordinate_space_json", "parser_version", "lifecycle_status",
    "created_by", "created_at", "checksum", "assetKey", "campusCode", "campusName",
  ]);
  return {
    id: requiredString(row.id, `${field}.id`),
    campus_id: nullableString(row.campus_id, `${field}.campus_id`),
    floor_id: nullableString(row.floor_id, `${field}.floor_id`),
    map_asset_id: requiredString(row.map_asset_id, `${field}.map_asset_id`),
    parent_version_id: nullableString(row.parent_version_id, `${field}.parent_version_id`),
    campusCode: nullableString(row.campusCode, `${field}.campusCode`),
    campusName: nullableString(row.campusName, `${field}.campusName`),
    version_label: requiredString(row.version_label, `${field}.version_label`),
    coordinate_space_type: oneOf(row.coordinate_space_type, `${field}.coordinate_space_type`, [
      "svg_viewbox", "normalized_image", "local_metric", "geographic",
    ] as const),
    coordinate_space_json: requiredString(row.coordinate_space_json, `${field}.coordinate_space_json`),
    parser_version: nullableString(row.parser_version, `${field}.parser_version`),
    lifecycle_status: oneOf(row.lifecycle_status, `${field}.lifecycle_status`, ["ready", "published"] as const),
    created_by: nullableString(row.created_by, `${field}.created_by`),
    created_at: requiredString(row.created_at, `${field}.created_at`),
    checksum: requiredString(row.checksum, `${field}.checksum`),
    assetKey: requiredString(row.assetKey, `${field}.assetKey`),
  };
}

function location(value: unknown, field: string): ReleaseLocation {
  const row = exactObject(value, field, [
    "entityType", "entityId", "role", "isPrimary", "id", "campus_id", "building_place_id",
    "floor_id", "indoor_space_id", "geometry_type", "geometry_json", "crs", "map_version_id",
    "map_feature_id", "location_hint", "precision_level", "accuracy_meters", "source_id",
    "verification_status", "verified_by", "verified_at", "valid_from", "valid_to", "created_at",
    "updated_at", "sourceElementId", "featureKind",
  ]);
  const role = requiredString(row.role, `${field}.role`);
  const geometryType = oneOf(row.geometry_type, `${field}.geometry_type`, ["Point", "LineString", "Polygon", "MultiPolygon"] as const);
  const geometryJson = nullableString(row.geometry_json, `${field}.geometry_json`);
  const crs = nullableString(row.crs, `${field}.crs`);
  if (role === "navigation_target") {
    if (geometryType !== "Point" || geometryJson === null) {
      throw new Error(`${field} navigation_target must contain a Point geometry`);
    }
    let geometry: unknown;
    try {
      geometry = JSON.parse(geometryJson) as unknown;
    } catch {
      throw new Error(`${field}.geometry_json contains invalid JSON`);
    }
    const parsed = objectValue(geometry, `${field}.geometry_json`);
    const coordinates = parsed.coordinates;
    if (
      parsed.type !== "Point"
      || !Array.isArray(coordinates)
      || coordinates.length !== 2
      || coordinates.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate))
    ) {
      throw new Error(`${field} navigation_target must contain a finite GeoJSON Point`);
    }
    if (
      coordinates[0] < -180 || coordinates[0] > 180
      || coordinates[1] < -90 || coordinates[1] > 90
    ) {
      throw new Error(`${field} navigation_target has invalid longitude or latitude`);
    }
    if (crs !== NAVIGATION_CRS) throw new Error(`${field} navigation_target must use ${NAVIGATION_CRS}`);
  }
  return {
    id: requiredString(row.id, `${field}.id`),
    entityType: oneOf(row.entityType, `${field}.entityType`, ["place", "facility", "merchant_outlet", "transit_stop"] as const),
    entityId: requiredString(row.entityId, `${field}.entityId`),
    role,
    isPrimary: integerFlag(row.isPrimary, `${field}.isPrimary`),
    campus_id: nullableString(row.campus_id, `${field}.campus_id`),
    building_place_id: nullableString(row.building_place_id, `${field}.building_place_id`),
    floor_id: nullableString(row.floor_id, `${field}.floor_id`),
    indoor_space_id: nullableString(row.indoor_space_id, `${field}.indoor_space_id`),
    geometry_type: geometryType,
    geometry_json: geometryJson,
    crs,
    map_version_id: nullableString(row.map_version_id, `${field}.map_version_id`),
    map_feature_id: nullableString(row.map_feature_id, `${field}.map_feature_id`),
    sourceElementId: nullableString(row.sourceElementId, `${field}.sourceElementId`),
    featureKind: row.featureKind === null ? null : oneOf(row.featureKind, `${field}.featureKind`, [
      "building_footprint", "road", "path", "entrance", "room", "label", "water", "green", "area", "other",
    ] as const),
    location_hint: nullableString(row.location_hint, `${field}.location_hint`),
    precision_level: oneOf(row.precision_level, `${field}.precision_level`, [
      "campus", "building", "floor", "space", "exact", "unknown",
    ] as const),
    accuracy_meters: nullableFiniteNumber(row.accuracy_meters, `${field}.accuracy_meters`),
    source_id: nullableString(row.source_id, `${field}.source_id`),
    verification_status: oneOf(row.verification_status, `${field}.verification_status`, [
      "unverified", "reviewed", "verified", "rejected",
    ] as const),
    verified_by: nullableString(row.verified_by, `${field}.verified_by`),
    verified_at: nullableString(row.verified_at, `${field}.verified_at`),
    valid_from: nullableString(row.valid_from, `${field}.valid_from`),
    valid_to: nullableString(row.valid_to, `${field}.valid_to`),
    created_at: requiredString(row.created_at, `${field}.created_at`),
    updated_at: requiredString(row.updated_at, `${field}.updated_at`),
  };
}

function transitStop(value: unknown, field: string): TransitStop {
  const row = exactObject(value, field, ["id", "place_id", "campus_id", "code", "name", "status", "created_at", "updated_at"]);
  return {
    id: requiredString(row.id, `${field}.id`),
    place_id: nullableString(row.place_id, `${field}.place_id`),
    campus_id: nullableString(row.campus_id, `${field}.campus_id`),
    code: nullableString(row.code, `${field}.code`),
    name: requiredString(row.name, `${field}.name`),
    status: oneOf(row.status, `${field}.status`, ["active"] as const),
    created_at: requiredString(row.created_at, `${field}.created_at`),
    updated_at: requiredString(row.updated_at, `${field}.updated_at`),
  };
}

function transit(value: unknown, field: string): ReleaseTransit {
  const row = exactObject(value, field, ["stops"]);
  return { stops: objectArray(row.stops, `${field}.stops`, transitStop) };
}

function searchDocument(value: unknown, field: string): SearchDocument {
  const row = exactObject(value, field, [
    "documentType", "entityId", "title", "subtitle", "normalizedText", "pinyin", "campusId",
    "buildingPlaceId", "floorId", "facets", "mapTarget", "rankingWeight",
  ]);
  const target = exactObject(row.mapTarget, `${field}.mapTarget`, ["type", "id"]);
  return {
    documentType: oneOf(row.documentType, `${field}.documentType`, ["place", "facility", "merchant_outlet"] as const),
    entityId: requiredString(row.entityId, `${field}.entityId`),
    title: requiredString(row.title, `${field}.title`),
    subtitle: nullableString(row.subtitle, `${field}.subtitle`),
    normalizedText: stringValue(row.normalizedText, `${field}.normalizedText`),
    pinyin: nullableString(row.pinyin, `${field}.pinyin`),
    campusId: nullableString(row.campusId, `${field}.campusId`),
    buildingPlaceId: nullableString(row.buildingPlaceId, `${field}.buildingPlaceId`),
    floorId: nullableString(row.floorId, `${field}.floorId`),
    facets: stringArray(row.facets, `${field}.facets`),
    mapTarget: {
      type: oneOf(target.type, `${field}.mapTarget.type`, ["locationAnchor", "place", "facility", "merchant_outlet"] as const),
      id: requiredString(target.id, `${field}.mapTarget.id`),
    },
    rankingWeight: finiteNumber(row.rankingWeight, `${field}.rankingWeight`),
  };
}

export function parseReleaseManifest(value: unknown): ReleaseManifest {
  const manifest = exactObject(value, "release manifest", [
    "schemaVersion", "release", "campuses", "places", "facilities", "merchants", "maps", "locations",
    "floors", "facilityTypes", "mapFilters", "transit", "searchDocuments", "generatedAt",
  ]);
  if (manifest.schemaVersion !== 2) throw new Error("release manifest.schemaVersion must be 2");
  const release = exactObject(manifest.release, "release manifest.release", ["id", "version", "createdAt"]);
  return {
    schemaVersion: 2,
    release: {
      id: requiredString(release.id, "release manifest.release.id"),
      version: requiredString(release.version, "release manifest.release.version"),
      createdAt: requiredString(release.createdAt, "release manifest.release.createdAt"),
    },
    campuses: objectArray(manifest.campuses, "release manifest.campuses", campus),
    places: objectArray(manifest.places, "release manifest.places", place),
    facilities: objectArray(manifest.facilities, "release manifest.facilities", facility),
    merchants: objectArray(manifest.merchants, "release manifest.merchants", merchant),
    maps: objectArray(manifest.maps, "release manifest.maps", mapVersion),
    locations: objectArray(manifest.locations, "release manifest.locations", location),
    floors: objectArray(manifest.floors, "release manifest.floors", floor),
    facilityTypes: objectArray(manifest.facilityTypes, "release manifest.facilityTypes", facilityType),
    mapFilters: objectArray(manifest.mapFilters, "release manifest.mapFilters", mapFilter),
    transit: transit(manifest.transit, "release manifest.transit"),
    searchDocuments: objectArray(manifest.searchDocuments, "release manifest.searchDocuments", searchDocument),
    generatedAt: requiredString(manifest.generatedAt, "release manifest.generatedAt"),
  };
}
