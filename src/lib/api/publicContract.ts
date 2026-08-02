import {
  arrayValue,
  nullableString,
  objectValue,
  oneOf,
  requiredString,
} from "../dataContract";
import { parseGeoGeometryJson } from "../geoGeometry";
import type {
  FacilityOperationalStatus,
  FacilityStatusResponse,
  OperationalEvent,
  OperationalEventLocation,
  OperationalEventTarget,
  OperationalEventUpdate,
  OperationalEventsResponse,
} from "./types";

function exactObject(value: unknown, field: string, fields: readonly string[]): Record<string, unknown> {
  const record = objectValue(value, field);
  for (const key of fields) {
    if (!Object.hasOwn(record, key)) throw new Error(`${field}.${key} is required`);
  }
  for (const key of Object.keys(record)) {
    if (!fields.includes(key)) throw new Error(`${field}.${key} is not supported`);
  }
  return record;
}

function isoTimestamp(value: unknown, field: string): string {
  const timestamp = requiredString(value, field);
  const date = new Date(timestamp);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== timestamp) {
    throw new Error(`${field} must be a canonical ISO timestamp`);
  }
  return timestamp;
}

function nullableIsoTimestamp(value: unknown, field: string): string | null {
  if (value === null) return null;
  return isoTimestamp(value, field);
}

const FACILITY_STATUSES = ["available", "partially_available", "unavailable", "unknown"] as const;
const EVENT_TYPES = ["maintenance", "activity", "closure", "notice"] as const;
const EVENT_SEVERITIES = ["info", "warning", "critical"] as const;
const EVENT_STATUSES = ["scheduled", "active", "resolved", "cancelled", "expired"] as const;
const EVENT_TARGET_TYPES = [
  "place", "floor", "space", "facility", "merchant_outlet", "transit_stop", "transit_route", "transit_trip", "map_feature",
] as const;
const EVENT_LOCATION_ROLES = ["event_location", "impact_area", "route_shape"] as const;
const EVENT_GEOMETRY_TYPES = ["Point", "Polygon", "LineString"] as const;

export function parseFacilityStatusResponse(value: unknown): FacilityStatusResponse {
  const response = exactObject(value, "facility status response", ["statuses"]);
  const rawStatuses = objectValue(response.statuses, "facility status response.statuses");
  const statuses: Record<string, FacilityOperationalStatus> = {};
  for (const [facilityId, status] of Object.entries(rawStatuses)) {
    if (!facilityId.trim()) throw new Error("facility status response.statuses contains an empty facility id");
    statuses[facilityId] = oneOf(status, `facility status response.statuses.${facilityId}`, FACILITY_STATUSES);
  }
  return { statuses };
}

function eventTarget(value: unknown, field: string): OperationalEventTarget {
  const target = exactObject(value, field, ["targetType", "targetId", "impactType"]);
  return {
    targetType: oneOf(target.targetType, `${field}.targetType`, EVENT_TARGET_TYPES),
    targetId: requiredString(target.targetId, `${field}.targetId`),
    impactType: requiredString(target.impactType, `${field}.impactType`),
  };
}

function eventUpdate(value: unknown, field: string): OperationalEventUpdate {
  const update = exactObject(value, field, ["id", "status", "message", "createdAt"]);
  return {
    id: requiredString(update.id, `${field}.id`),
    status: requiredString(update.status, `${field}.status`),
    message: requiredString(update.message, `${field}.message`),
    createdAt: isoTimestamp(update.createdAt, `${field}.createdAt`),
  };
}

function eventLocation(value: unknown, field: string): OperationalEventLocation {
  const location = exactObject(value, field, ["id", "role", "geometryType", "geometryJson", "crs", "campusId"]);
  const role = oneOf(location.role, `${field}.role`, EVENT_LOCATION_ROLES);
  const geometryType = oneOf(location.geometryType, `${field}.geometryType`, EVENT_GEOMETRY_TYPES);
  const geometryJson = requiredString(location.geometryJson, `${field}.geometryJson`);
  const geometry = parseGeoGeometryJson(geometryJson, `${field}.geometryJson`);
  const expectedGeometryType = role === "event_location" ? "Point" : role === "impact_area" ? "Polygon" : "LineString";
  if (geometryType !== expectedGeometryType || geometry.type !== expectedGeometryType) {
    throw new Error(`${field} geometry must match its role`);
  }
  return {
    id: requiredString(location.id, `${field}.id`),
    role,
    geometryType,
    geometryJson,
    crs: oneOf(location.crs, `${field}.crs`, ["svg_viewbox"] as const),
    campusId: nullableString(location.campusId, `${field}.campusId`),
  };
}

function event(value: unknown, field: string): OperationalEvent {
  const row = exactObject(value, field, [
    "id", "eventType", "severity", "editorialStatus", "operationalStatus", "title", "description",
    "startsAt", "expectedEndsAt", "autoExpireAt", "resolvedAt", "lastVerifiedAt", "createdAt", "updatedAt",
    "targets", "updates", "locations",
  ]);
  return {
    id: requiredString(row.id, `${field}.id`),
    eventType: oneOf(row.eventType, `${field}.eventType`, EVENT_TYPES),
    severity: oneOf(row.severity, `${field}.severity`, EVENT_SEVERITIES),
    editorialStatus: oneOf(row.editorialStatus, `${field}.editorialStatus`, ["approved"] as const),
    operationalStatus: oneOf(row.operationalStatus, `${field}.operationalStatus`, EVENT_STATUSES),
    title: requiredString(row.title, `${field}.title`),
    description: nullableString(row.description, `${field}.description`),
    startsAt: isoTimestamp(row.startsAt, `${field}.startsAt`),
    expectedEndsAt: nullableIsoTimestamp(row.expectedEndsAt, `${field}.expectedEndsAt`),
    autoExpireAt: nullableIsoTimestamp(row.autoExpireAt, `${field}.autoExpireAt`),
    resolvedAt: nullableIsoTimestamp(row.resolvedAt, `${field}.resolvedAt`),
    lastVerifiedAt: nullableIsoTimestamp(row.lastVerifiedAt, `${field}.lastVerifiedAt`),
    createdAt: isoTimestamp(row.createdAt, `${field}.createdAt`),
    updatedAt: isoTimestamp(row.updatedAt, `${field}.updatedAt`),
    targets: arrayValue(row.targets, `${field}.targets`).map((item, index) => eventTarget(item, `${field}.targets[${index}]`)),
    updates: arrayValue(row.updates, `${field}.updates`).map((item, index) => eventUpdate(item, `${field}.updates[${index}]`)),
    locations: arrayValue(row.locations, `${field}.locations`).map((item, index) => eventLocation(item, `${field}.locations[${index}]`)),
  };
}

export function parseOperationalEventsResponse(value: unknown): OperationalEventsResponse {
  const response = exactObject(value, "operational events response", ["items"]);
  return {
    items: arrayValue(response.items, "operational events response.items")
      .map((item, index) => event(item, `operational events response.items[${index}]`)),
  };
}
