import type {
  CollectedFacility,
  CollectedFloor,
  CollectionPayload,
  CollectionSubmissionPayload,
  FeedbackSubmissionPayload,
  FeedbackType,
  SubmissionPayload,
} from "../../shared/submission-contract";
import { HttpError } from "./http";
import { parseJson } from "./values";

const FEEDBACK_TYPES = ["correction", "new_place", "shuttle", "other"] as const;
const MAX_FLOORS = 40;
const MAX_FACILITIES_PER_FLOOR = 80;
const MAX_ENTRANCE_PHOTOS = 3;
const MAX_FLOOR_PHOTOS = 2;
const MAX_COLLECTION_PHOTOS = 12;
const MEDIA_ID_PATTERN = /^media_[0-9a-f]{32}$/i;

type Reject = (message: string) => never;

function requestReject(message: string): never {
  throw new HttpError(400, "validation_error", message);
}

function storedReject(message: string): never {
  throw new Error(message);
}

function recordValue(value: unknown, field: string, reject: Reject): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) reject(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function exactRecord(
  value: unknown,
  field: string,
  fields: readonly string[],
  reject: Reject,
): Record<string, unknown> {
  const record = recordValue(value, field, reject);
  const allowed = new Set(fields);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) reject(`${field}.${key} is not supported`);
  }
  for (const key of fields) {
    if (!Object.hasOwn(record, key)) reject(`${field}.${key} is required`);
  }
  return record;
}

function text(
  value: unknown,
  field: string,
  maximum: number,
  reject: Reject,
  allowEmpty = false,
): string {
  if (typeof value !== "string") reject(`${field} must be a string`);
  const normalized = value.trim();
  if (!allowEmpty && normalized.length === 0) reject(`${field} must be a non-empty string`);
  if (normalized.length > maximum) reject(`${field} must be at most ${maximum} characters`);
  return normalized;
}

function feedbackType(value: unknown, field: string, reject: Reject): FeedbackType {
  if (typeof value !== "string" || !FEEDBACK_TYPES.includes(value as FeedbackType)) {
    reject(`${field} must be one of: ${FEEDBACK_TYPES.join(", ")}`);
  }
  return value as FeedbackType;
}

function mediaIds(value: unknown, field: string, maximum: number, reject: Reject): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    reject(`${field} must be an array with at most ${maximum} items`);
  }
  const result = value.map((item, index) => {
    if (typeof item !== "string" || !MEDIA_ID_PATTERN.test(item)) {
      reject(`${field}[${index}] must be a media asset id`);
    }
    return item as string;
  });
  if (new Set(result).size !== result.length) reject(`${field} must not contain duplicates`);
  return result;
}

function levelCode(value: unknown, field: string, reject: Reject): string {
  const raw = text(value, field, 4, reject).toUpperCase();
  const above = raw.match(/^F?(\d{1,3})$/);
  if (above) return `F${Number(above[1])}`;
  const below = raw.match(/^B(\d{1,2})$/);
  if (below) return `B${Number(below[1])}`;
  return reject(`${field} must use F1 or B1 format`);
}

function facilityValue(
  value: unknown,
  field: string,
  reject: Reject,
  activeFacilityCodes: ReadonlySet<string> | null,
): CollectedFacility {
  const facility = exactRecord(value, field, ["id", "typeCode", "name", "locationText"], reject);
  const typeCode = text(facility.typeCode, `${field}.typeCode`, 50, reject);
  if (activeFacilityCodes !== null && !activeFacilityCodes.has(typeCode)) {
    reject(`${field}.typeCode references an inactive facility type`);
  }
  return {
    id: text(facility.id, `${field}.id`, 100, reject),
    typeCode,
    name: text(facility.name, `${field}.name`, 200, reject, true),
    locationText: text(facility.locationText, `${field}.locationText`, 500, reject, true),
  };
}

function floorValue(
  value: unknown,
  field: string,
  reject: Reject,
  activeFacilityCodes: ReadonlySet<string> | null,
): CollectedFloor {
  const floor = exactRecord(value, field, ["id", "levelCode", "note", "facilities", "photoMediaIds"], reject);
  const normalizedLevelCode = levelCode(floor.levelCode, `${field}.levelCode`, reject);
  if (!Array.isArray(floor.facilities) || floor.facilities.length > MAX_FACILITIES_PER_FLOOR) {
    reject(`${field}.facilities must be an array with at most ${MAX_FACILITIES_PER_FLOOR} items`);
  }
  const facilities = floor.facilities.map((item, index) =>
    facilityValue(item, `${field}.facilities[${index}]`, reject, activeFacilityCodes));
  const facilityKeys = facilities.map((facility) =>
    `${facility.typeCode}\u0000${facility.name}\u0000${facility.locationText}`);
  if (new Set(facilityKeys).size !== facilityKeys.length) {
    reject(`${field}.facilities must not contain duplicate facilities`);
  }
  return {
    id: text(floor.id, `${field}.id`, 100, reject),
    levelCode: normalizedLevelCode,
    note: text(floor.note, `${field}.note`, 500, reject, true),
    facilities,
    photoMediaIds: mediaIds(floor.photoMediaIds, `${field}.photoMediaIds`, MAX_FLOOR_PHOTOS, reject),
  };
}

function collectionValue(
  value: unknown,
  field: string,
  reject: Reject,
  activeFacilityCodes: ReadonlySet<string> | null,
): CollectionPayload {
  const collection = exactRecord(
    value,
    field,
    ["openHours", "phone", "organization", "floors", "photoMediaIds"],
    reject,
  );
  if (!Array.isArray(collection.floors) || collection.floors.length > MAX_FLOORS) {
    reject(`${field}.floors must be an array with at most ${MAX_FLOORS} items`);
  }
  const floors = collection.floors.map((item, index) =>
    floorValue(item, `${field}.floors[${index}]`, reject, activeFacilityCodes));
  const levelCodes = floors.map((floor) => floor.levelCode.toLocaleLowerCase());
  if (new Set(levelCodes).size !== levelCodes.length) reject(`${field}.floors must not contain duplicate levels`);
  const entrancePhotoIds = mediaIds(
    collection.photoMediaIds,
    `${field}.photoMediaIds`,
    MAX_ENTRANCE_PHOTOS,
    reject,
  );
  const allPhotoIds = [...entrancePhotoIds, ...floors.flatMap((floor) => floor.photoMediaIds)];
  if (new Set(allPhotoIds).size !== allPhotoIds.length) reject(`${field} must not reuse a photo`);
  if (allPhotoIds.length > MAX_COLLECTION_PHOTOS) {
    reject(`${field} must contain at most ${MAX_COLLECTION_PHOTOS} photos`);
  }
  return {
    openHours: text(collection.openHours, `${field}.openHours`, 200, reject, true),
    phone: text(collection.phone, `${field}.phone`, 100, reject, true),
    organization: text(collection.organization, `${field}.organization`, 200, reject, true),
    floors,
    photoMediaIds: entrancePhotoIds,
  };
}

function feedbackPayloadValue(value: unknown, field: string, reject: Reject): FeedbackSubmissionPayload {
  const payload = exactRecord(
    value,
    field,
    ["submissionKind", "feedbackType", "description"],
    reject,
  );
  if (payload.submissionKind !== "feedback") reject(`${field}.submissionKind must be feedback`);
  return {
    submissionKind: "feedback",
    feedbackType: feedbackType(payload.feedbackType, `${field}.feedbackType`, reject),
    description: text(payload.description, `${field}.description`, 2_000, reject),
  };
}

function collectionSubmissionValue(value: unknown, field: string, reject: Reject): CollectionSubmissionPayload {
  const payload = exactRecord(value, field, ["submissionKind", "collection"], reject);
  if (payload.submissionKind !== "collection") reject(`${field}.submissionKind must be collection`);
  return {
    submissionKind: "collection",
    collection: collectionValue(payload.collection, `${field}.collection`, reject, null),
  };
}

function submissionPayloadValue(value: unknown, field: string, reject: Reject): SubmissionPayload {
  const payload = recordValue(value, field, reject);
  if (payload.submissionKind === "feedback") return feedbackPayloadValue(payload, field, reject);
  if (payload.submissionKind === "collection") return collectionSubmissionValue(payload, field, reject);
  return reject(`${field}.submissionKind must be feedback or collection`);
}

export function normalizeFeedbackSubmissionPayload(value: unknown): FeedbackSubmissionPayload {
  return feedbackPayloadValue(value, "payload", requestReject);
}

export function normalizeCollectionPayload(
  value: unknown,
  activeFacilityCodes: ReadonlySet<string>,
): CollectionPayload {
  return collectionValue(value, "payload", requestReject, activeFacilityCodes);
}

export function normalizeStoredCollectionPayload(value: unknown, field: string): CollectionPayload {
  const parsed = parseJson<unknown>(value, field);
  return collectionValue(parsed, field, storedReject, null);
}

export function normalizeStoredSubmissionPayload(value: unknown, field: string): SubmissionPayload {
  const parsed = parseJson<unknown>(value, field);
  return submissionPayloadValue(parsed, field, storedReject);
}
