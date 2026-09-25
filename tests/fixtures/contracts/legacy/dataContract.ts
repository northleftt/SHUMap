export type DataObject = Record<string, unknown>;

function violation(field: string, expectation: string): Error {
  return new Error(`${field} ${expectation}`);
}

export function objectValue(value: unknown, field: string): DataObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw violation(field, "must be an object");
  }
  return value as DataObject;
}

export function arrayValue(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw violation(field, "must be an array");
  return value;
}

export function jsonValue(value: unknown, field: string): unknown {
  if (typeof value !== "string") throw violation(field, "must be JSON text");
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw violation(field, "contains invalid JSON");
  }
}

export function jsonObject(value: unknown, field: string): DataObject {
  return objectValue(jsonValue(value, field), field);
}

export function nullableJsonObject(value: unknown, field: string): DataObject | null {
  if (value === null) return null;
  return jsonObject(value, field);
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw violation(field, "must be a non-empty string");
  }
  return value;
}

export function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string") throw violation(field, "must be a string");
  return value;
}

export function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw violation(field, "must be a string or null");
  return value;
}

export function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw violation(field, "must be a string when present");
  return value;
}

export function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw violation(field, "must be a boolean");
  return value;
}

export function nullablePositiveInteger(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw violation(field, "must be a positive integer or null");
  }
  return value;
}

export function oneOf<const T extends readonly string[]>(
  value: unknown,
  field: string,
  allowed: T,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw violation(field, `must be one of ${allowed.join(", ")}`);
  }
  return value as T[number];
}

export function nullableSingleTextObject(
  value: unknown,
  field: string,
  property: string,
): string {
  const record = nullableJsonObject(value, field);
  if (record === null) return "";
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== property) {
    throw violation(field, `must contain only ${property}`);
  }
  return requiredString(record[property], `${field}.${property}`);
}
