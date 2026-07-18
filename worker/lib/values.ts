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

export function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "validation_error", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function jsonString(value: unknown): string {
  return JSON.stringify(value ?? {});
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

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
