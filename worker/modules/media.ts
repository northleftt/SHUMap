import type { SessionPrincipal } from "../domain/types";
import type { D1PreparedStatement, Env } from "../types/cloudflare";
import { all, first } from "../lib/db";
import { HttpError, json, readBodyLimited } from "../lib/http";
import { enforcePublicRateLimit } from "../lib/public-rate-limit";
import { isoNow, makeId, sha256 } from "../lib/values";

const PUBLIC_MEDIA_PREFIX = "public/media/";
const QUARANTINE_PREFIX = "quarantine/submissions/";
/** 匿名上传只接受这三种位图；svg 会带脚本，永不放行。 */
const PUBLIC_UPLOAD_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_PUBLIC_UPLOAD_BYTES = 2 * 1024 * 1024;
/** 单条提交最多关联的照片数（前端槽位同样是 3）。 */
export const MAX_SUBMISSION_PHOTOS = 3;

/**
 * POST /api/public/media — 用户侧照片上传（一段式，raw body）。
 *
 * 需要登录会话：`uploaded_by` 记的是管理端同一张 users 表里的账号，所以审核时
 * 能回答「这张照片是谁传的」。权限门槛只到「有效会话」，任何角色都能供稿。
 *
 * 防滥用：账号 + IP 限流 + 声明类型白名单 + 魔术字节校验 + 2MiB 硬上限。落盘一律
 * `quarantine/submissions/`，行记 bucket_scope='quarantine' / status='quarantined'，
 * 因此在被审核采纳之前公共读端（要求 public + published + public/media/ 前缀）永远读不到。
 */
export async function createPublicMediaUpload(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
): Promise<Response> {
  await enforcePublicRateLimit(request, env, "media-upload", 30);
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!PUBLIC_UPLOAD_TYPES.has(contentType)) {
    throw new HttpError(415, "unsupported_media_type", "Only image/jpeg, image/png and image/webp are accepted");
  }
  const bytes = await readBodyLimited(request, MAX_PUBLIC_UPLOAD_BYTES);
  if (bytes.byteLength === 0) throw new HttpError(400, "validation_error", "Photo body is empty");
  if (bytes.byteLength > MAX_PUBLIC_UPLOAD_BYTES) {
    throw new HttpError(413, "payload_too_large", "Each photo must be at most 2 MiB");
  }
  const sniffed = sniffImageType(bytes);
  if (sniffed !== contentType) {
    throw new HttpError(415, "unsupported_media_type", "Photo bytes do not match the declared image type");
  }

  const mediaId = makeId("media");
  const objectKey = `${QUARANTINE_PREFIX}${mediaId}.${extensionOf(contentType)}`;
  const digest = await sha256(bytes);
  await env.SHUMAP_BUCKET.put(objectKey, bytes, {
    httpMetadata: { contentType, cacheControl: "private, no-store" },
    customMetadata: { scope: "quarantine" },
  });
  await env.DB.prepare(
    `insert into media_assets(id,bucket_scope,object_key,original_name,content_type,byte_size,sha256,status,uploaded_by,created_at)
     values(?,'quarantine',?,null,?,?,?,'quarantined',?,?)`,
  ).bind(mediaId, objectKey, contentType, bytes.byteLength, digest, principal.userId, isoNow()).run();

  return json({ mediaId, byteSize: bytes.byteLength, contentType, status: "quarantined" }, { status: 201 });
}

/** 管理端直传上限比匿名通道宽一些，但仍只接受位图。 */
const MAX_ADMIN_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * POST /api/admin/media — 管理端图片直传（raw body），落盘即公开可读。
 *
 * 与匿名 POST /api/public/media 的区别：管理员是可信方，不需要「隔离 → 审核采纳
 * → 提升」这一路，所以对象直接写 `public/media/` 前缀、行记 bucket_scope='public'
 * / status='published'，返回的路径立刻能被 GET /api/public/media/:id 读到。
 *
 * 仍保留的防线：声明类型白名单 + 魔术字节校验（声明与实际字节必须一致），
 * 因此 SVG 之类可携带脚本的类型永远进不来。调用点已要求 write:content 会话。
 */
export async function createAdminMediaUpload(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
): Promise<Response> {
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!PUBLIC_UPLOAD_TYPES.has(contentType)) {
    throw new HttpError(415, "unsupported_media_type", "Only image/jpeg, image/png and image/webp are accepted");
  }
  const bytes = await readBodyLimited(request, MAX_ADMIN_UPLOAD_BYTES);
  if (bytes.byteLength === 0) throw new HttpError(400, "validation_error", "Image body is empty");
  if (bytes.byteLength > MAX_ADMIN_UPLOAD_BYTES) {
    throw new HttpError(413, "payload_too_large", "Each image must be at most 8 MiB");
  }
  if (sniffImageType(bytes) !== contentType) {
    throw new HttpError(415, "unsupported_media_type", "Image bytes do not match the declared image type");
  }

  const mediaId = makeId("media");
  const objectKey = `${PUBLIC_MEDIA_PREFIX}${mediaId}.${extensionOf(contentType)}`;
  const digest = await sha256(bytes);
  const now = isoNow();
  await env.SHUMAP_BUCKET.put(objectKey, bytes, {
    httpMetadata: { contentType, cacheControl: "public, max-age=31536000, immutable" },
    customMetadata: { scope: "public", uploadedBy: principal.userId },
  });
  await env.DB.prepare(
    `insert into media_assets(id,bucket_scope,object_key,original_name,content_type,byte_size,sha256,status,uploaded_by,created_at,approved_at)
     values(?,'public',?,null,?,?,?,'published',?,?,?)`,
  ).bind(mediaId, objectKey, contentType, bytes.byteLength, digest, principal.userId, now, now).run();

  return json({ mediaId, url: publicMediaPath(mediaId), byteSize: bytes.byteLength, contentType, status: "published" }, { status: 201 });
}

/**
 * GET /api/public/media/:id — 只服务已发布的公共对象。三个条件（scope/status/前缀）
 * 任一不满足即 404，隔离区与私有底图因此不可能从公共侧被读到。
 */
export async function getPublicMedia(env: Env, mediaId: string): Promise<Response> {
  const asset = await first<{ objectKey: string; contentType: string; byteSize: number; sha256: string; status: string }>(
    env.DB,
    `select object_key as objectKey,content_type as contentType,byte_size as byteSize,sha256,status
       from media_assets where id=? and bucket_scope='public'`,
    [mediaId],
  );
  if (!asset || asset.status !== "published" || !asset.objectKey.startsWith(PUBLIC_MEDIA_PREFIX)) {
    throw new HttpError(404, "not_found", "Media asset does not exist");
  }
  const object = await env.SHUMAP_BUCKET.get(asset.objectKey);
  if (!object) throw new HttpError(404, "not_found", "Media object is missing");
  assertStoredObjectSize(asset.byteSize, object.size, MAX_ADMIN_UPLOAD_BYTES, mediaId);
  const safeType = allowedPublicContentType(asset.contentType);
  return new Response(object.body, {
    headers: {
      "content-type": safeType,
      "content-length": String(object.size),
      "content-disposition": "inline",
      "cache-control": "public, max-age=31536000, immutable",
      "etag": `"${asset.sha256}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

/**
 * GET /api/admin/media/:id/content — 审核端读原图，任意 scope 可读（含隔离区）。
 * 调用点已要求 read:admin 会话，响应 no-store 且强制 nosniff/sandbox。
 */
export async function getAdminMediaContent(env: Env, _principal: SessionPrincipal, mediaId: string): Promise<Response> {
  const asset = await first<{ objectKey: string; contentType: string; byteSize: number; sha256: string }>(
    env.DB,
    "select object_key as objectKey,content_type as contentType,byte_size as byteSize,sha256 from media_assets where id=?",
    [mediaId],
  );
  if (!asset) throw new HttpError(404, "not_found", "Media asset does not exist");
  const object = await env.SHUMAP_BUCKET.get(asset.objectKey);
  if (!object) throw new HttpError(404, "not_found", "Media object is missing");
  assertStoredObjectSize(asset.byteSize, object.size, MAX_ADMIN_UPLOAD_BYTES, mediaId);
  return new Response(object.body, {
    headers: {
      "content-type": allowedPublicContentType(asset.contentType),
      "content-length": String(object.size),
      "content-disposition": "inline",
      "cache-control": "private, no-store",
      "etag": `"${asset.sha256}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

export interface SubmissionPhoto {
  mediaAssetId: string;
  sortOrder: number;
  bucketScope: string;
  status: string;
  contentType: string;
  objectKey: string;
  byteSize: number;
}

/** 一条提交关联的照片，按提交时的顺序。 */
export async function listSubmissionPhotos(env: Env, submissionId: string): Promise<SubmissionPhoto[]> {
  return all<SubmissionPhoto>(
    env.DB,
    `select sm.media_asset_id as mediaAssetId,sm.sort_order as sortOrder,ma.bucket_scope as bucketScope,
            ma.status,ma.content_type as contentType,ma.object_key as objectKey,ma.byte_size as byteSize
       from submission_media sm join media_assets ma on ma.id=sm.media_asset_id
      where sm.submission_id=? order by sm.sort_order`,
    [submissionId],
  );
}

/** 形状校验：只接受 media id 字符串，按入参顺序去重，超额直接 400。 */
export function normalizePhotoIds(mediaIds: unknown, maximum = MAX_SUBMISSION_PHOTOS): string[] {
  if (mediaIds === undefined || mediaIds === null) return [];
  if (!Array.isArray(mediaIds)) throw new HttpError(400, "validation_error", "photoMediaIds must be an array");
  const unique: string[] = [];
  for (const raw of mediaIds) {
    if (typeof raw !== "string" || !/^media_[0-9a-f]{32}$/i.test(raw)) {
      throw new HttpError(400, "validation_error", "photoMediaIds must contain media asset ids");
    }
    if (!unique.includes(raw)) unique.push(raw);
  }
  if (unique.length > maximum) {
    throw new HttpError(400, "validation_error", `At most ${maximum} photos per submission`);
  }
  return unique;
}

async function attachableState(env: Env, mediaId: string): Promise<{ bucket_scope: string; status: string; used: number } | null> {
  return first<{ bucket_scope: string; status: string; used: number }>(
    env.DB,
    `select ma.bucket_scope,ma.status,
            (select count(*) from submission_media sm where sm.media_asset_id=ma.id) as used
       from media_assets ma where ma.id=?`,
    [mediaId],
  );
}

/**
 * 校验一批 mediaId 可被挂到提交上：必须存在、仍在隔离区、且尚未被别的提交占用。
 * 返回按入参顺序去重后的 id 列表。
 */
export async function assertAttachablePhotos(env: Env, mediaIds: unknown, maximum = MAX_SUBMISSION_PHOTOS): Promise<string[]> {
  const unique = normalizePhotoIds(mediaIds, maximum);
  for (const mediaId of unique) {
    const asset = await attachableState(env, mediaId);
    if (!asset) throw new HttpError(404, "media_not_found", "Photo does not exist");
    if (asset.bucket_scope !== "quarantine" || asset.status !== "quarantined") {
      throw new HttpError(409, "media_not_attachable", "Photo is not an unreviewed upload");
    }
    if (asset.used > 0) throw new HttpError(409, "media_already_used", "Photo is already attached to a submission");
  }
  return unique;
}

/**
 * submission_media 的插入语句（提交创建时与主插入同批执行）。
 *
 * `where exists` 是给采集提交用的：那条 content_submissions 插入本身带锁条件，
 * 可能一行都不写；没有父行时这里就跟着不写，而不是让整个 batch 因外键失败。
 */
export function linkSubmissionPhotoStatements(env: Env, submissionId: string, mediaIds: string[]): D1PreparedStatement[] {
  const now = isoNow();
  return mediaIds.map((mediaId, index) =>
    env.DB.prepare(
      `insert into submission_media(submission_id,media_asset_id,sort_order,role,created_at)
       select ?,?,?,'evidence',? where exists(select 1 from content_submissions where id=?)`,
    ).bind(submissionId, mediaId, index, now, submissionId),
  );
}

export interface PhotoPromotion {
  /** 已发布照片的公共相对路径，按提交顺序。 */
  urls: string[];
  statements: D1PreparedStatement[];
}

/**
 * 审核采纳时把隔离区照片提升为公共可读：R2 对象拷到 `public/media/` 前缀，
 * 行改为 bucket_scope='public' / status='published'，并删掉隔离区副本。
 *
 * R2 拷贝先做（幂等：同 key 重复 put 无害），DB 更新以语句形式返回给调用方，
 * 和审核决定写在同一个 batch 里，避免出现「对象已公开但行未发布」之外的组合。
 */
export async function promoteSubmissionPhotos(
  env: Env,
  submissionId: string,
  mediaAssetIds: readonly string[],
): Promise<PhotoPromotion> {
  const photos = await listSubmissionPhotos(env, submissionId);
  const requested = new Set(mediaAssetIds);
  if (requested.size !== mediaAssetIds.length) {
    throw new Error(`Submission ${submissionId} photo promotion contains duplicate media ids`);
  }
  const attached = new Set(photos.map((photo) => photo.mediaAssetId));
  for (const mediaAssetId of requested) {
    if (!attached.has(mediaAssetId)) {
      throw new Error(`Media ${mediaAssetId} is not attached to submission ${submissionId}`);
    }
  }
  const urls: string[] = [];
  const statements: D1PreparedStatement[] = [];
  const now = isoNow();
  for (const photo of photos) {
    if (!requested.has(photo.mediaAssetId)) continue;
    if (photo.bucketScope === "public" && photo.status === "published") {
      if (!photo.objectKey.startsWith(PUBLIC_MEDIA_PREFIX)) {
        throw new Error(`Published media ${photo.mediaAssetId} has an invalid object key`);
      }
      allowedPublicContentType(photo.contentType);
      urls.push(publicMediaPath(photo.mediaAssetId));
      continue;
    }
    if (photo.bucketScope !== "quarantine" || photo.status !== "quarantined") {
      throw new Error(`Submission media ${photo.mediaAssetId} has invalid state ${photo.bucketScope}/${photo.status}`);
    }
    if (!photo.objectKey.startsWith(QUARANTINE_PREFIX)) {
      throw new Error(`Quarantined media ${photo.mediaAssetId} has an invalid object key`);
    }
    const contentType = allowedPublicContentType(photo.contentType);
    const publicKey = `${PUBLIC_MEDIA_PREFIX}${photo.mediaAssetId}.${extensionOf(photo.contentType)}`;
    const object = await env.SHUMAP_BUCKET.get(photo.objectKey);
    if (!object) throw new Error(`Quarantined media object ${photo.objectKey} is missing`);
    assertStoredObjectSize(photo.byteSize, object.size, MAX_PUBLIC_UPLOAD_BYTES, photo.mediaAssetId);
    await env.SHUMAP_BUCKET.put(publicKey, object.body, {
      httpMetadata: { contentType, cacheControl: "public, max-age=31536000, immutable" },
      customMetadata: { scope: "public", submissionId },
    });
    statements.push(
      env.DB.prepare(
        "update media_assets set bucket_scope='public',status='published',object_key=?,approved_at=? where id=? and bucket_scope='quarantine'",
      ).bind(publicKey, now, photo.mediaAssetId),
    );
    urls.push(publicMediaPath(photo.mediaAssetId));
  }
  return { urls, statements };
}

/** 提升成功后清掉隔离区副本。 */
export async function dropQuarantineCopies(env: Env, photos: SubmissionPhoto[]): Promise<void> {
  const keys = photos.filter((photo) => photo.objectKey.startsWith(QUARANTINE_PREFIX)).map((photo) => photo.objectKey);
  if (!keys.length) return;
  await env.SHUMAP_BUCKET.delete(keys);
}

export function publicMediaPath(mediaId: string): string {
  return `/api/public/media/${mediaId}`;
}

function extensionOf(contentType: string): string {
  switch (contentType.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/jpeg":
      return "jpg";
    default:
      throw new Error(`Unsupported stored media content type: ${contentType}`);
  }
}

/** 只认 JPEG/PNG/WebP 的文件头，避免声明 image/* 却上传别的东西。 */
function sniffImageType(bytes: ArrayBuffer): string | null {
  const view = new Uint8Array(bytes);
  if (view.length >= 3 && view[0] === 0xff && view[1] === 0xd8 && view[2] === 0xff) return "image/jpeg";
  if (
    view.length >= 8 && view[0] === 0x89 && view[1] === 0x50 && view[2] === 0x4e && view[3] === 0x47
    && view[4] === 0x0d && view[5] === 0x0a && view[6] === 0x1a && view[7] === 0x0a
  ) return "image/png";
  if (
    view.length >= 12 && view[0] === 0x52 && view[1] === 0x49 && view[2] === 0x46 && view[3] === 0x46
    && view[8] === 0x57 && view[9] === 0x45 && view[10] === 0x42 && view[11] === 0x50
  ) return "image/webp";
  return null;
}

function allowedPublicContentType(contentType: string): string {
  switch (contentType.toLowerCase()) {
    case "image/png":
    case "image/jpeg":
    case "image/webp":
      return contentType.toLowerCase();
    default:
      throw new Error(`Unsupported stored media content type: ${contentType}`);
  }
}

function assertStoredObjectSize(expected: number, actual: number, maximum: number, mediaId: string): void {
  if (!Number.isInteger(expected) || expected <= 0 || expected > maximum) {
    throw new Error(`Media ${mediaId} has invalid stored byte size ${expected}`);
  }
  if (actual !== expected) {
    throw new Error(`Media ${mediaId} object size ${actual} does not match stored byte size ${expected}`);
  }
}
