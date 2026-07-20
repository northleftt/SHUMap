import type { Env } from "../types/cloudflare";
import { all, first } from "../lib/db";
import { HttpError, json, readJsonLimited } from "../lib/http";
import { enforcePublicRateLimit } from "../lib/public-rate-limit";
import { isoNow, jsonString, makeId, objectValue, requiredString } from "../lib/values";

const LOCK_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 48 * 1024;
const MAX_FLOORS = 40;
const MAX_FACILITIES_PER_FLOOR = 80;
const FACILITY_CODES = new Set(["restroom", "elevator", "drinking_water", "printer", "study_area", "vending_machine", "power_bank"]);

interface CollectionBody {
  deviceId?: unknown;
  assigneeName?: unknown;
  payload?: unknown;
}

interface CollectionRow {
  buildingId: string;
  deviceId: string;
  assignee: string;
  status: "collecting" | "submitted" | "accepted" | "needs_recollection";
  payloadJson: string;
  lockExpiresAt: string | null;
  submissionId: string | null;
  updatedAt: string;
  submittedAt: string | null;
}

function publicTask(row: CollectionRow, deviceId: string | null) {
  const owned = Boolean(deviceId && row.deviceId === deviceId);
  return {
    buildingId: row.buildingId,
    status: row.status,
    assignee: owned ? row.assignee : null,
    owned,
    payload: owned ? parsePayload(row.payloadJson) : undefined,
    lockExpiresAt: row.lockExpiresAt,
    submissionId: owned ? row.submissionId : undefined,
    updatedAt: row.updatedAt,
    submittedAt: row.submittedAt,
  };
}

function parsePayload(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function deviceIdFrom(request: Request, body?: CollectionBody): string {
  const deviceId = requiredString(body?.deviceId ?? request.headers.get("x-shumap-device-id"), "deviceId", 120);
  if (!/^device_[0-9a-f-]{36}$/i.test(deviceId)) {
    throw new HttpError(400, "validation_error", "Invalid deviceId");
  }
  return deviceId;
}

function lockExpiry(): string {
  return new Date(Date.now() + LOCK_TTL_MS).toISOString();
}

async function requireBuilding(env: Env, buildingId: string): Promise<void> {
  const place = await first<{ id: string }>(
    env.DB,
    "select p.id from places p join buildings b on b.place_id=p.id where p.id=? and p.lifecycle_status<>'retired'",
    [buildingId],
  );
  if (!place) throw new HttpError(404, "not_found", "Building does not exist");
}

async function getRow(env: Env, buildingId: string): Promise<CollectionRow | null> {
  return first<CollectionRow>(
    env.DB,
    `select building_place_id as buildingId,device_id as deviceId,assignee_name as assignee,status,
            payload_json as payloadJson,lock_expires_at as lockExpiresAt,submission_id as submissionId,
            updated_at as updatedAt,submitted_at as submittedAt
       from collection_tasks where building_place_id=?`,
    [buildingId],
  );
}

export async function listCollectionTasks(request: Request, env: Env): Promise<Response> {
  await enforcePublicRateLimit(request, env, "collection-list", 120);
  const deviceId = request.headers.get("x-shumap-device-id");
  const rows = await all<CollectionRow>(
    env.DB,
    `select building_place_id as buildingId,device_id as deviceId,assignee_name as assignee,status,
            payload_json as payloadJson,lock_expires_at as lockExpiresAt,submission_id as submissionId,
            updated_at as updatedAt,submitted_at as submittedAt
       from collection_tasks order by updated_at desc`,
  );
  return json({ items: rows.map((row) => publicTask(row, deviceId)) });
}

export async function claimCollectionTask(request: Request, env: Env, buildingId: string): Promise<Response> {
  await enforcePublicRateLimit(request, env, "collection-claim", 30);
  const body = await readJsonLimited<CollectionBody>(request, MAX_BODY_BYTES);
  const deviceId = deviceIdFrom(request, body);
  const assignee = requiredString(body.assigneeName, "assigneeName", 100);
  await requireBuilding(env, buildingId);

  const now = isoNow();
  await env.DB.prepare(
    `insert into collection_tasks(building_place_id,device_id,assignee_name,status,payload_json,lock_expires_at,created_at,updated_at)
     values(?,?,?,'collecting','{}',?,?,?)
     on conflict(building_place_id) do update set
       device_id=excluded.device_id,assignee_name=excluded.assignee_name,status='collecting',
       lock_expires_at=excluded.lock_expires_at,updated_at=excluded.updated_at,
       submission_id=case when collection_tasks.status='needs_recollection' then null else collection_tasks.submission_id end,
       submitted_at=case when collection_tasks.status='needs_recollection' then null else collection_tasks.submitted_at end,
       reviewed_at=case when collection_tasks.status='needs_recollection' then null else collection_tasks.reviewed_at end
     where collection_tasks.status='needs_recollection'
        or (collection_tasks.status='collecting' and (
          collection_tasks.device_id=excluded.device_id or collection_tasks.lock_expires_at<=excluded.updated_at
        ))`,
  ).bind(buildingId, deviceId, assignee, lockExpiry(), now, now).run();

  const row = await getRow(env, buildingId);
  if (!row || row.deviceId !== deviceId) {
    throw new HttpError(409, "collection_locked", "This building is being collected by another volunteer");
  }
  if (row.status === "submitted" || row.status === "accepted") {
    throw new HttpError(409, "collection_submitted", "This collection has already been submitted");
  }
  return json({ task: publicTask(row, deviceId) });
}

export async function saveCollectionTask(request: Request, env: Env, buildingId: string): Promise<Response> {
  await enforcePublicRateLimit(request, env, "collection-save", 180);
  const body = await readJsonLimited<CollectionBody>(request, MAX_BODY_BYTES);
  const deviceId = deviceIdFrom(request, body);
  const payload = validatePayload(body.payload);
  const now = isoNow();
  await env.DB.prepare(
    `update collection_tasks set payload_json=?,lock_expires_at=?,updated_at=?
      where building_place_id=? and device_id=? and status='collecting' and lock_expires_at>?`,
  ).bind(jsonString(payload), lockExpiry(), now, buildingId, deviceId, now).run();
  const row = await getRow(env, buildingId);
  if (!row) throw new HttpError(404, "not_found", "Collection task does not exist");
  if (row.deviceId !== deviceId) throw new HttpError(409, "collection_locked", "This building is being collected by another volunteer");
  if (row.status !== "collecting") throw new HttpError(409, "invalid_state", "Only collecting tasks can be updated");
  if (!row.lockExpiresAt || row.lockExpiresAt <= now) throw new HttpError(409, "collection_lock_expired", "The collection lock has expired; claim it again before saving");
  return json({ task: publicTask(row, deviceId) });
}

export async function submitCollectionTask(request: Request, env: Env, buildingId: string): Promise<Response> {
  await enforcePublicRateLimit(request, env, "collection-submit", 20);
  const body = await readJsonLimited<CollectionBody>(request, MAX_BODY_BYTES);
  const deviceId = deviceIdFrom(request, body);
  const payload = validatePayload(body.payload);
  const row = await getRow(env, buildingId);
  if (!row) throw new HttpError(404, "not_found", "Collection task does not exist");
  if (row.deviceId !== deviceId) throw new HttpError(409, "collection_locked", "This building is being collected by another volunteer");
  if ((row.status === "submitted" || row.status === "accepted") && row.submissionId) {
    return json({ task: publicTask(row, deviceId), submissionId: row.submissionId });
  }
  if (row.status !== "collecting") throw new HttpError(409, "invalid_state", "Only collecting tasks can be submitted");

  const submissionId = makeId("submission");
  const now = isoNow();
  await env.DB.batch([
    env.DB.prepare(
      `insert into content_submissions(id,target_type,target_id,payload_json,submitter_name,status,created_at)
       select ?,'place',building_place_id,?,assignee_name,'pending',?
         from collection_tasks
        where building_place_id=? and device_id=? and status='collecting' and lock_expires_at>?`,
    ).bind(submissionId, jsonString({ submissionKind: "collection", collection: payload }), now, buildingId, deviceId, now),
    env.DB.prepare(
      `update collection_tasks set status='submitted',payload_json=?,lock_expires_at=null,submission_id=?,updated_at=?,submitted_at=?
        where building_place_id=? and device_id=? and status='collecting' and lock_expires_at>?`,
    ).bind(jsonString(payload), submissionId, now, now, buildingId, deviceId, now),
  ]);
  const submitted = await getRow(env, buildingId);
  if (!submitted) throw new HttpError(404, "not_found", "Collection task does not exist");
  if (submitted.submissionId !== submissionId) {
    if (submitted.deviceId !== deviceId) throw new HttpError(409, "collection_locked", "This building is being collected by another volunteer");
    if (submitted.status === "submitted" && submitted.submissionId) {
      return json({ task: publicTask(submitted, deviceId), submissionId: submitted.submissionId });
    }
    throw new HttpError(409, "collection_lock_expired", "The collection lock has expired; claim it again before submitting");
  }
  return json({ task: publicTask(submitted, deviceId), submissionId }, { status: 201 });
}

function validatePayload(value: unknown): Record<string, unknown> {
  const payload = objectValue(value, "payload");
  const allowed = new Set(["openHours", "phone", "organization", "floors"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new HttpError(400, "validation_error", `Unknown collection field: ${key}`);
  }
  const result: Record<string, unknown> = {};
  for (const [key, maximum] of [["openHours", 200], ["phone", 100], ["organization", 200]] as const) {
    const raw = payload[key];
    if (raw !== undefined && typeof raw !== "string") throw new HttpError(400, "validation_error", `${key} must be a string`);
    const text = typeof raw === "string" ? raw.trim() : "";
    if (text.length > maximum) throw new HttpError(400, "validation_error", `${key} is too long`);
    result[key] = text;
  }
  const rawFloors = payload.floors ?? [];
  if (!Array.isArray(rawFloors) || rawFloors.length > MAX_FLOORS) {
    throw new HttpError(400, "validation_error", `floors must contain at most ${MAX_FLOORS} items`);
  }
  const levelCodes = new Set<string>();
  result.floors = rawFloors.map((rawFloor, floorIndex) => {
    const floor = objectValue(rawFloor, `floors[${floorIndex}]`);
    const id = requiredString(floor.id, `floors[${floorIndex}].id`, 100);
    const levelCode = requiredString(floor.levelCode, `floors[${floorIndex}].levelCode`, 50);
    const normalizedLevelCode = levelCode.toLocaleLowerCase();
    if (levelCodes.has(normalizedLevelCode)) throw new HttpError(400, "validation_error", `Duplicate floor: ${levelCode}`);
    levelCodes.add(normalizedLevelCode);
    const note = typeof floor.note === "string" ? floor.note.trim() : "";
    if (note.length > 500) throw new HttpError(400, "validation_error", `floors[${floorIndex}].note is too long`);
    if (!Array.isArray(floor.facilities) || floor.facilities.length > MAX_FACILITIES_PER_FLOOR) {
      throw new HttpError(400, "validation_error", `floors[${floorIndex}].facilities is invalid`);
    }
    const facilityKeys = new Set<string>();
    const facilities = floor.facilities.map((rawFacility, facilityIndex) => {
      const facility = objectValue(rawFacility, `floors[${floorIndex}].facilities[${facilityIndex}]`);
      const facilityId = requiredString(facility.id, "facility.id", 100);
      const typeCode = requiredString(facility.typeCode, "facility.typeCode", 50);
      if (!FACILITY_CODES.has(typeCode)) throw new HttpError(400, "validation_error", `Unsupported facility type: ${typeCode}`);
      const name = typeof facility.name === "string" ? facility.name.trim() : "";
      const locationText = typeof facility.locationText === "string" ? facility.locationText.trim() : "";
      if (name.length > 200 || locationText.length > 500) throw new HttpError(400, "validation_error", "Facility text is too long");
      const facilityKey = `${typeCode}\u0000${name}\u0000${locationText}`;
      if (facilityKeys.has(facilityKey)) throw new HttpError(400, "validation_error", "Duplicate facility on the same floor");
      facilityKeys.add(facilityKey);
      return { id: facilityId, typeCode, name, locationText };
    });
    return { id, levelCode, note, facilities };
  });
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "payload_too_large", "Collection payload must be at most 48 KiB");
  }
  return result;
}
