import { HttpError } from "./http";

export function requiredString(value: unknown, field: string, maxLength = 500): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, "validation_error", `${field} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new HttpError(400, "validation_error", `${field} must be at most ${maxLength} characters`);
  }
  return normalized;
}

export function optionalString(value: unknown, field: string, maxLength = 500): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new HttpError(400, "validation_error", `${field} must be a string`);
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new HttpError(400, "validation_error", `${field} must be at most ${maxLength} characters`);
  }
  return normalized || null;
}

export function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new HttpError(400, "validation_error", `${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

export function optionalNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, "validation_error", `${field} must be a finite number`);
  }
  return value;
}

export function numberValue(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, "validation_error", `${field} must be a finite number`);
  }
  return value;
}

export function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new HttpError(400, "validation_error", `${field} must be a boolean`);
  }
  return value;
}

export function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "validation_error", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function exactObject(value: unknown, field: string, fields: readonly string[]): Record<string, unknown> {
  const object = objectValue(value, field);
  const allowed = new Set(fields);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw new HttpError(400, "validation_error", `${field}.${key} is not supported`);
  }
  for (const key of fields) {
    if (!Object.hasOwn(object, key)) throw new HttpError(400, "validation_error", `${field}.${key} is required`);
  }
  return object;
}

export function partialObject(value: unknown, field: string, fields: readonly string[]): Record<string, unknown> {
  const object = objectValue(value, field);
  const allowed = new Set(fields);
  const keys = Object.keys(object);
  if (keys.length === 0) throw new HttpError(400, "validation_error", `${field} must contain at least one field`);
  for (const key of keys) {
    if (!allowed.has(key)) throw new HttpError(400, "validation_error", `${field}.${key} is not supported`);
  }
  return object;
}

export function arrayValue(value: unknown, field: string, maximumItems: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new HttpError(400, "validation_error", `${field} must be an array with at most ${maximumItems} items`);
  }
  return value;
}

export function jsonString(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Value is not JSON serializable");
  return serialized;
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export async function sha256(value: string | ArrayBuffer): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parseJson<T>(value: unknown, field: string): T {
  if (typeof value !== "string") {
    throw new Error(`${field} must be stored as JSON text`);
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${field} contains invalid JSON`);
  }
}

export function parseJsonObject(value: unknown, field: string): Record<string, unknown> {
  const parsed = parseJson<unknown>(value, field);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${field} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export function parseJsonArray(value: unknown, field: string): unknown[] {
  const parsed = parseJson<unknown>(value, field);
  if (!Array.isArray(parsed)) throw new Error(`${field} must contain a JSON array`);
  return parsed;
}
