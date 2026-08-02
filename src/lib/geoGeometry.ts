export type GeoPosition = [number, number];

export type GeoGeometry =
  | { type: "Point"; coordinates: GeoPosition }
  | { type: "LineString"; coordinates: GeoPosition[] }
  | { type: "Polygon"; coordinates: GeoPosition[][] }
  | { type: "MultiPolygon"; coordinates: GeoPosition[][][] };

function contractViolation(field: string, expectation: string): Error {
  return new Error(`Data contract violation: ${field} ${expectation}`);
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw contractViolation(field, "must be an object");
  }
  return value as Record<string, unknown>;
}

function exactGeometryObject(value: unknown, field: string): Record<string, unknown> {
  const geometry = objectValue(value, field);
  const keys = Object.keys(geometry);
  if (keys.length !== 2 || !keys.includes("type") || !keys.includes("coordinates")) {
    throw contractViolation(field, "must contain exactly type and coordinates");
  }
  return geometry;
}

function position(value: unknown, field: string): GeoPosition {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate))
  ) {
    throw contractViolation(field, "must contain exactly two finite numbers");
  }
  return [value[0] as number, value[1] as number];
}

function line(value: unknown, field: string, minimum: number): GeoPosition[] {
  if (!Array.isArray(value) || value.length < minimum) {
    throw contractViolation(field, `must contain at least ${minimum} positions`);
  }
  return value.map((item, index) => position(item, `${field}[${index}]`));
}

function polygon(value: unknown, field: string): GeoPosition[][] {
  if (!Array.isArray(value) || value.length === 0) {
    throw contractViolation(field, "must contain at least one linear ring");
  }
  return value.map((valueRing, ringIndex) => {
    const ring = line(valueRing, `${field}[${ringIndex}]`, 4);
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      throw contractViolation(`${field}[${ringIndex}]`, "must be closed");
    }
    return ring;
  });
}

export function parseGeoGeometryJson(raw: unknown, field: string): GeoGeometry {
  if (typeof raw !== "string") throw contractViolation(field, "must be JSON text");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw contractViolation(field, "contains invalid JSON");
  }

  const geometry = exactGeometryObject(parsed, field);
  if (geometry.type === "Point") {
    return { type: "Point", coordinates: position(geometry.coordinates, `${field}.coordinates`) };
  }
  if (geometry.type === "LineString") {
    return { type: "LineString", coordinates: line(geometry.coordinates, `${field}.coordinates`, 2) };
  }
  if (geometry.type === "Polygon") {
    return { type: "Polygon", coordinates: polygon(geometry.coordinates, `${field}.coordinates`) };
  }
  if (geometry.type === "MultiPolygon") {
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) {
      throw contractViolation(`${field}.coordinates`, "must contain at least one polygon");
    }
    return {
      type: "MultiPolygon",
      coordinates: geometry.coordinates.map((item, index) => polygon(item, `${field}.coordinates[${index}]`)),
    };
  }
  throw contractViolation(`${field}.type`, "must be Point, LineString, Polygon, or MultiPolygon");
}
