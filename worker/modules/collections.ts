import type { SessionPrincipal } from "../domain/types";
import {
  collectionPhotoMediaIds,
  type CollectionPayload,
} from "../../shared/submission-contract";
import type { Env } from "../types/cloudflare";
import { all, first } from "../lib/db";
import { HttpError, json, readJsonLimited } from "../lib/http";
import { enforcePublicRateLimit } from "../lib/public-rate-limit";
import { exactObject, isoNow, jsonString, makeId, requiredString } from "../lib/values";
import { normalizeCollectionPayload, normalizeStoredCollectionPayload } from "../lib/submission-contracts";
import { activeFacilityTypeCodes } from "./facility-types";
import { assertAttachablePhotos, linkSubmissionPhotoStatements } from "./media";

const LOCK_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 48 * 1024;
/** 一次采集提交最多关联的照片总数。 */
const MAX_COLLECTION_PHOTOS = 12;

const EMPTY_COLLECTION_PAYLOAD: CollectionPayload = {
  openHours: "",
  phone: "",
  organization: "",
  floors: [],
  photoMediaIds: [],
};

interface CollectionRow {
  buildingId: string;
  deviceId: string;
  assigneeUserId: string | null;
  assignee: string;
  status: "collecting" | "submitted" | "accepted" | "needs_recollection";
  payloadJson: string;
  lockExpiresAt: string | null;
  submissionId: string | null;
  updatedAt: string;
  submittedAt: string | null;
}

/**
 * 采集进展对所有设备可见：状态、领取人昵称和时间戳是公开的协作信息，
 * 任何志愿者都能看到「哪栋楼谁在采、采到哪一步」。
 * 草稿正文与提交单号只回给持锁设备本身——它是尚未审核的私有内容。
 */
function publicTask(row: CollectionRow, userId: string) {
  const owned = row.assigneeUserId === userId;
  return {
    buildingId: row.buildingId,
    status: row.status,
    assignee: row.assignee,
    owned,
    payload: owned ? parsePayload(row.payloadJson) : undefined,
    lockExpiresAt: row.lockExpiresAt,
    submissionId: owned ? row.submissionId : undefined,
    updatedAt: row.updatedAt,
    submittedAt: row.submittedAt,
  };
}

function parsePayload(value: string): CollectionPayload {
  return normalizeStoredCollectionPayload(value, "collection_tasks.payload_json");
}

function deviceIdFrom(value: unknown): string {
  const deviceId = requiredString(value, "deviceId", 120);
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
            assignee_user_id as assigneeUserId,payload_json as payloadJson,lock_expires_at as lockExpiresAt,submission_id as submissionId,
            updated_at as updatedAt,submitted_at as submittedAt
       from collection_tasks where building_place_id=?`,
    [buildingId],
  );
}

export async function listCollectionTasks(request: Request, env: Env, principal: SessionPrincipal): Promise<Response> {
  await enforcePublicRateLimit(request, env, "collection-list", 120);
  const rows = await all<CollectionRow>(
    env.DB,
    `select building_place_id as buildingId,device_id as deviceId,assignee_name as assignee,status,
            assignee_user_id as assigneeUserId,payload_json as payloadJson,lock_expires_at as lockExpiresAt,submission_id as submissionId,
            updated_at as updatedAt,submitted_at as submittedAt
       from collection_tasks order by updated_at desc`,
  );
  return json({ items: rows.map((row) => publicTask(row, principal.userId)) });
}

export async function claimCollectionTask(request: Request, env: Env, principal: SessionPrincipal, buildingId: string): Promise<Response> {
  await enforcePublicRateLimit(request, env, "collection-claim", 30);
  const body = exactObject(await readJsonLimited<unknown>(request, MAX_BODY_BYTES), "collectionClaim", ["deviceId"]);
  const deviceId = deviceIdFrom(body.deviceId);
  const assignee = principal.displayName;
  await requireBuilding(env, buildingId);

  const now = isoNow();
  await env.DB.prepare(
    `insert into collection_tasks(building_place_id,device_id,assignee_name,assignee_user_id,status,payload_json,lock_expires_at,created_at,updated_at)
     values(?,?,?,?,'collecting',?,?,?,?)
     on conflict(building_place_id) do update set
       device_id=excluded.device_id,assignee_name=excluded.assignee_name,assignee_user_id=excluded.assignee_user_id,status='collecting',
       lock_expires_at=excluded.lock_expires_at,updated_at=excluded.updated_at,
       submission_id=case when collection_tasks.status='needs_recollection' then null else collection_tasks.submission_id end,
       submitted_at=case when collection_tasks.status='needs_recollection' then null else collection_tasks.submitted_at end,
       reviewed_at=case when collection_tasks.status='needs_recollection' then null else collection_tasks.reviewed_at end
     where collection_tasks.status='needs_recollection'
        or (collection_tasks.status='collecting' and (
          collection_tasks.assignee_user_id=excluded.assignee_user_id or collection_tasks.lock_expires_at<=excluded.updated_at
        ))`,
  ).bind(buildingId, deviceId, assignee, principal.userId, jsonString(EMPTY_COLLECTION_PAYLOAD), lockExpiry(), now, now).run();

  const row = await getRow(env, buildingId);
  if (!row || row.assigneeUserId !== principal.userId) {
    throw new HttpError(409, "collection_locked", "This building is being collected by another volunteer");
  }
  if (row.status === "submitted" || row.status === "accepted") {
    throw new HttpError(409, "collection_submitted", "This collection has already been submitted");
  }
  return json({ task: publicTask(row, principal.userId) });
}

export async function saveCollectionTask(request: Request, env: Env, principal: SessionPrincipal, buildingId: string): Promise<Response> {
  await enforcePublicRateLimit(request, env, "collection-save", 180);
  const body = exactObject(await readJsonLimited<unknown>(request, MAX_BODY_BYTES), "collectionSave", ["deviceId", "payload"]);
  deviceIdFrom(body.deviceId);
  const payload = normalizeCollectionPayload(body.payload, await activeFacilityTypeCodes(env));
  const now = isoNow();
  await env.DB.prepare(
    `update collection_tasks set payload_json=?,lock_expires_at=?,updated_at=?
      where building_place_id=? and assignee_user_id=? and status='collecting' and lock_expires_at>?`,
  ).bind(jsonString(payload), lockExpiry(), now, buildingId, principal.userId, now).run();
  const row = await getRow(env, buildingId);
  if (!row) throw new HttpError(404, "not_found", "Collection task does not exist");
  if (row.assigneeUserId !== principal.userId) throw new HttpError(409, "collection_locked", "This building is being collected by another volunteer");
  if (row.status !== "collecting") throw new HttpError(409, "invalid_state", "Only collecting tasks can be updated");
  if (!row.lockExpiresAt || row.lockExpiresAt <= now) throw new HttpError(409, "collection_lock_expired", "The collection lock has expired; claim it again before saving");
  return json({ task: publicTask(row, principal.userId) });
}

export async function submitCollectionTask(request: Request, env: Env, principal: SessionPrincipal, buildingId: string): Promise<Response> {
  await enforcePublicRateLimit(request, env, "collection-submit", 20);
  const body = exactObject(await readJsonLimited<unknown>(request, MAX_BODY_BYTES), "collectionSubmit", ["deviceId", "payload"]);
  deviceIdFrom(body.deviceId);
  const payload = normalizeCollectionPayload(body.payload, await activeFacilityTypeCodes(env));
  const row = await getRow(env, buildingId);
  if (!row) throw new HttpError(404, "not_found", "Collection task does not exist");
  if (row.assigneeUserId !== principal.userId) throw new HttpError(409, "collection_locked", "This building is being collected by another volunteer");
  if ((row.status === "submitted" || row.status === "accepted") && row.submissionId) {
    return json({ task: publicTask(row, principal.userId), submissionId: row.submissionId });
  }
  if (row.status !== "collecting") throw new HttpError(409, "invalid_state", "Only collecting tasks can be submitted");
  if (collectionPhotoMediaIds(payload).length === 0
    && payload.openHours.length === 0
    && payload.phone.length === 0
    && payload.organization.length === 0
    && payload.floors.length === 0) {
    throw new HttpError(400, "validation_error", "Collection payload must contain collected information");
  }

  const submissionId = makeId("submission");
  const now = isoNow();
  const photoMediaIds = await assertAttachablePhotos(env, collectionPhotoMediaIds(payload), MAX_COLLECTION_PHOTOS);
  await env.DB.batch([
    env.DB.prepare(
      `insert into content_submissions(id,target_type,target_id,base_revision_id,payload_json,submitter_name,status,created_at)
       select ?,'place',ct.building_place_id,p.current_revision_id,?,ct.assignee_name,'pending',?
         from collection_tasks ct join places p on p.id=ct.building_place_id
        where ct.building_place_id=? and ct.assignee_user_id=? and ct.status='collecting'
          and ct.lock_expires_at>? and p.current_revision_id is not null`,
    ).bind(submissionId, jsonString({ submissionKind: "collection", collection: payload }), now, buildingId, principal.userId, now),
    env.DB.prepare(
      `update collection_tasks set status='submitted',payload_json=?,lock_expires_at=null,submission_id=?,updated_at=?,submitted_at=?
        where building_place_id=? and assignee_user_id=? and status='collecting' and lock_expires_at>?`,
    ).bind(jsonString(payload), submissionId, now, now, buildingId, principal.userId, now),
    ...linkSubmissionPhotoStatements(env, submissionId, photoMediaIds),
  ]);
  const submitted = await getRow(env, buildingId);
  if (!submitted) throw new HttpError(404, "not_found", "Collection task does not exist");
  if (submitted.submissionId !== submissionId) {
    if (submitted.assigneeUserId !== principal.userId) throw new HttpError(409, "collection_locked", "This building is being collected by another volunteer");
    if (submitted.status === "submitted" && submitted.submissionId) {
      return json({ task: publicTask(submitted, principal.userId), submissionId: submitted.submissionId });
    }
    throw new HttpError(409, "collection_lock_expired", "The collection lock has expired; claim it again before submitting");
  }
  return json({ task: publicTask(submitted, principal.userId), submissionId }, { status: 201 });
}
