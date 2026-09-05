import type {
  FacilityContent,
  MerchantContent,
  PlaceContent,
} from "../../shared/revision-contract";
import { NAVIGATION_CRS } from "../../shared/revision-contract";
import type { DurableObjectState, Env } from "../types/cloudflare";
import { all, first } from "../lib/db";
import { HttpError, json, readJson } from "../lib/http";
import { isoNow, jsonString, makeId, parseJsonObject, requiredString, sha256 } from "../lib/values";
import {
  normalizeFacilityContent,
  normalizeMerchantContent,
  normalizePlaceContent,
} from "../lib/revision-contracts";
import { normalizeSearchText } from "./places";
import { publicMediaPath } from "./media";

interface ReleaseRequest {
  version: string;
  summary: string | null;
  reason: string | null;
  mapVersionIds: string[];
}

interface ReleaseRow {
  id: string;
  version: string;
  schema_version: number;
  status: string;
  artifact_key: string | null;
  artifact_sha256: string | null;
  created_at: string;
}

interface PlaceCandidate {
  id: string;
  kindId: string;
  kindName: string;
  campusId: string | null;
  parentPlaceId: string | null;
  lifecycleStatus: string;
  isBuilding: number;
  revisionId: string;
  displayName: string;
  summary: string | null;
  description: string | null;
  contentJson: string;
  contentHash: string;
}

interface FacilityCandidate {
  id: string;
  facilityTypeId: string;
  hostPlaceId: string | null;
  floorId: string | null;
  operationalStatus: "available" | "partially_available" | "unavailable" | "unknown";
  quantity: number | null;
  revisionId: string;
  displayName: string;
  serviceHoursJson: string | null;
  contentJson: string;
  contentHash: string;
  visibilityPolicyJson: string;
  facilityTypeStatus: string;
}

interface MerchantCandidate {
  id: string;
  organizationId: string | null;
  hostPlaceId: string | null;
  floorId: string | null;
  revisionId: string;
  displayName: string;
  businessType: string | null;
  openingHoursJson: string | null;
  contactJson: string | null;
  contentJson: string;
  contentHash: string;
}

interface MapCandidate {
  id: string;
  campus_id: string | null;
  floor_id: string | null;
  map_asset_id: string;
  parent_version_id: string | null;
  campusCode: string | null;
  campusName: string | null;
  version_label: string;
  coordinate_space_type: string;
  coordinate_space_json: string;
  parser_version: string | null;
  lifecycle_status: string;
  created_by: string | null;
  created_at: string;
  checksum: string;
  assetKey: string;
  assetByteSize: number;
  assetSha256: string;
  assetStatus: string;
  assetBucketScope: string;
}

interface MapAssetValidation {
  mapVersionId: string;
  objectKey: string;
  valid: boolean;
  error: string | null;
}

interface MapSelectionValidation {
  requestedMapVersionIds: string[];
  selectedMapVersionIds: string[];
  missingMapVersionIds: string[];
}

/**
 * 地图版本不在本次 release 中时，不能只给一串 location id：发布员需要知道是哪
 * 个实体、它仍绑在哪个旧版本，以及本次为同一空间选中了什么版本。
 */
interface MapBindingIssue {
  anchorId: string;
  entityType: LocationCandidate["entityType"];
  entityId: string;
  entityName: string;
  role: string;
  currentMapVersionId: string | null;
  currentMapVersionLabel: string | null;
  currentMapCampusName: string | null;
  selectedMapVersionId: string | null;
  selectedMapVersionLabel: string | null;
  selectedMapCampusName: string | null;
}

type ReleaseMap = Omit<MapCandidate, "assetByteSize" | "assetSha256" | "assetStatus" | "assetBucketScope">;

/**
 * 位置在**发布快照**里的字段集合，必须与客户端 src/lib/release/manifestContract.ts
 * 的 location() 白名单逐字一致：客户端用 exactObject 校验，多一个键就整份 manifest
 * 解析失败、地图直接打不开（2026-08-12 的 boundMap* 就是这样把线上地图打碎的）。
 *
 * 所以快照里的位置一律经 releaseLocation() 逐字段挑出，别把查询行直接塞进 manifest。
 */
interface ReleaseLocation {
  id: string;
  entityType: "place" | "facility" | "merchant_outlet" | "transit_stop";
  entityId: string;
  role: string;
  isPrimary: number;
  campus_id: string | null;
  building_place_id: string | null;
  floor_id: string | null;
  indoor_space_id: string | null;
  geometry_type: string;
  geometry_json: string | null;
  crs: string | null;
  map_version_id: string | null;
  map_feature_id: string | null;
  location_hint: string | null;
  precision_level: string;
  accuracy_meters: number | null;
  source_id: string | null;
  verification_status: string;
  verified_by: string | null;
  verified_at: string | null;
  valid_from: string | null;
  valid_to: string | null;
  created_at: string;
  updated_at: string;
  sourceElementId: string | null;
  featureKind: string | null;
}

/**
 * 查询行 = 快照字段 + 只供发布校验使用的绑定信息。后者不进 manifest。
 * 取位置的 SQL 用了 la.*，将来给 location_anchors 加列同样只会落在这里。
 */
interface LocationCandidate extends ReleaseLocation {
  /** 当前锚点绑定的地图版本信息；发布失败时用来给后台可操作的修复提示。 */
  boundMapVersionLabel: string | null;
  boundMapCampusId: string | null;
  boundMapFloorId: string | null;
  boundMapCampusName: string | null;
}

/**
 * 查询行 → 快照行。逐字段挑而不是展开对象：校验用的 join 别名、以及 la.* 带出来的
 * 新库列，都不会顺着漏给客户端。ReleaseLocation 增删字段时这里会编译报错。
 */
export function releaseLocation(location: LocationCandidate): ReleaseLocation {
  return {
    id: location.id,
    entityType: location.entityType,
    entityId: location.entityId,
    role: location.role,
    isPrimary: location.isPrimary,
    campus_id: location.campus_id,
    building_place_id: location.building_place_id,
    floor_id: location.floor_id,
    // indoor_spaces 已删表（0034）；manifest 键仅为兼容已发布客户端而保留，恒为 null。
    indoor_space_id: null,
    geometry_type: location.geometry_type,
    geometry_json: location.geometry_json,
    crs: location.crs,
    map_version_id: location.map_version_id,
    map_feature_id: location.map_feature_id,
    location_hint: location.location_hint,
    precision_level: location.precision_level,
    accuracy_meters: location.accuracy_meters,
    source_id: location.source_id,
    verification_status: location.verification_status,
    verified_by: location.verified_by,
    verified_at: location.verified_at,
    valid_from: location.valid_from,
    valid_to: location.valid_to,
    created_at: location.created_at,
    updated_at: location.updated_at,
    sourceElementId: location.sourceElementId,
    featureKind: location.featureKind,
  };
}

function locationGeometry(location: LocationCandidate): Record<string, unknown> | null {
  return location.geometry_json === null
    ? null
    : parseJsonObject(location.geometry_json, `location ${location.id} geometry_json`);
}

interface TransitStopCandidate {
  id: string;
  place_id: string | null;
  campus_id: string | null;
  code: string | null;
  name: string;
  status: "active";
  // 0027 起列里是十进制字符串（连续系数）；0026 的三档枚举存量由迁移映射成数值。
  marker_size: string;
  created_at: string;
  updated_at: string;
}

interface FloorCandidate {
  id: string;
  buildingPlaceId: string;
  levelCode: string;
  levelOrder: number;
  displayName: string;
  isPublic: number;
  imageMediaId: string | null;
}

/**
 * manifest.floors 的对外形状。楼内平面图是每层一张图片（0032 起）：
 * image_media_id 投影成公共读路径，没上传过图的楼层为 null，客户端按「无图」处理。
 */
interface ReleaseFloor extends Omit<FloorCandidate, "imageMediaId"> {
  imageUrl: string | null;
}

interface FacilityTypeCandidate {
  id: string;
  code: string;
  name: string;
  category: string;
  iconKey: string | null;
  status: string;
}

interface ReleasePlace extends Omit<PlaceCandidate, "isBuilding" | "contentJson"> {
  isBuilding: boolean;
  content: PlaceContent;
  aliases: string[];
}

interface ReleaseFacility extends Omit<FacilityCandidate, "serviceHoursJson" | "contentJson" | "visibilityPolicyJson"> {
  /** indoor_spaces 已删表（0034），键仅为兼容已发布小程序的白名单而保留，恒为 null。 */
  indoorSpaceId: null;
  serviceHours: { text: string } | null;
  content: FacilityContent;
  visibilityPolicy: Record<string, unknown>;
}

interface ReleaseMerchant extends Omit<MerchantCandidate, "openingHoursJson" | "contactJson" | "contentJson"> {
  /** 同 ReleaseFacility.indoorSpaceId。 */
  indoorSpaceId: null;
  openingHours: { text: string } | null;
  contact: { phone: string } | null;
  content: MerchantContent;
}

interface ReleaseMapFilter {
  id: string;
  key: string;
  label: string;
  sortOrder: number;
  placeKindIds: string[];
  facilityTypeIds: string[];
  includesMerchants: boolean;
}

interface SearchDocumentCandidate {
  documentType: "place" | "facility" | "merchant_outlet";
  entityId: string;
  title: string;
  subtitle: string | null;
  normalizedText: string;
  pinyin: null;
  campusId: string | null;
  buildingPlaceId: string | null;
  floorId: string | null;
  facets: string[];
  mapTarget: { type: "locationAnchor" | "place" | "facility" | "merchant_outlet"; id: string };
  rankingWeight: number;
}

export interface ReleaseManifest {
  schemaVersion: 2;
  release: { id: string; version: string; createdAt: string };
  campuses: Array<{ id: string; code: string; name: string; timezone: string }>;
  places: ReleasePlace[];
  facilities: ReleaseFacility[];
  merchants: ReleaseMerchant[];
  maps: ReleaseMap[];
  /** 快照字段集合（见 releaseLocation）；不是取位置的查询行。 */
  locations: ReleaseLocation[];
  floors: ReleaseFloor[];
  facilityTypes: FacilityTypeCandidate[];
  mapFilters: ReleaseMapFilter[];
  // marker_size 只在非标准系数（≠1）才进快照（见 buildCandidate 的 stops 映射注释），所以可选。
  transit: { stops: Array<Omit<TransitStopCandidate, "marker_size"> & { marker_size?: number }> };
  searchDocuments: SearchDocumentCandidate[];
  generatedAt: string;
}

function databaseBoolean(value: number, field: string): boolean {
  if (value === 0) return false;
  if (value === 1) return true;
  throw new Error(`${field} must be stored as 0 or 1`);
}

function nullableJsonObject(value: string | null, field: string): Record<string, unknown> | null {
  return value === null ? null : parseJsonObject(value, field);
}

function singleTextObject(
  value: string | null,
  field: string,
  property: "text" | "phone",
): { text: string } | { phone: string } | null {
  const parsed = nullableJsonObject(value, field);
  if (parsed === null) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== property) throw new Error(`${field} must contain only ${property}`);
  const text = requiredString(parsed[property], `${field}.${property}`, 2_000);
  return property === "text" ? { text } : { phone: text };
}

function releaseFacility(facility: FacilityCandidate): ReleaseFacility {
  const { serviceHoursJson, contentJson, visibilityPolicyJson, ...fields } = facility;
  const serviceHours = singleTextObject(
    serviceHoursJson,
    `facility ${facility.id} serviceHoursJson`,
    "text",
  );
  return {
    ...fields,
    indoorSpaceId: null,
    serviceHours: serviceHours as { text: string } | null,
    content: normalizeFacilityContent(
      parseJsonObject(contentJson, `facility ${facility.id} contentJson`),
    ),
    visibilityPolicy: parseJsonObject(
      visibilityPolicyJson,
      `facility ${facility.id} visibilityPolicyJson`,
    ),
  };
}

function releaseMerchant(merchant: MerchantCandidate): ReleaseMerchant {
  const { openingHoursJson, contactJson, contentJson, ...fields } = merchant;
  return {
    ...fields,
    indoorSpaceId: null,
    openingHours: singleTextObject(
      openingHoursJson,
      `merchant ${merchant.id} openingHoursJson`,
      "text",
    ) as { text: string } | null,
    contact: singleTextObject(
      contactJson,
      `merchant ${merchant.id} contactJson`,
      "phone",
    ) as { phone: string } | null,
    content: normalizeMerchantContent(
      parseJsonObject(contentJson, `merchant ${merchant.id} contentJson`),
    ),
  };
}

function requestObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "validation_error", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requestNullableString(value: unknown, field: string, maximum: number): string | null {
  if (value === null) return null;
  return requiredString(value, field, maximum);
}

function releaseRequest(value: unknown): ReleaseRequest {
  const body = requestObject(value, "request body");
  const allowed = new Set(["version", "summary", "reason", "mapVersionIds"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new HttpError(400, "validation_error", `${key} is not supported`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(body, key)) throw new HttpError(400, "validation_error", `${key} is required`);
  }
  if (!Array.isArray(body.mapVersionIds) || body.mapVersionIds.length > 100) {
    throw new HttpError(400, "validation_error", "mapVersionIds must be an array with at most 100 items");
  }
  const mapVersionIds = body.mapVersionIds.map((id, index) => requiredString(id, `mapVersionIds[${index}]`, 100));
  if (new Set(mapVersionIds).size !== mapVersionIds.length) {
    throw new HttpError(400, "validation_error", "mapVersionIds must not contain duplicates");
  }
  return {
    version: requiredString(body.version, "version", 100),
    summary: requestNullableString(body.summary, "summary", 2_000),
    reason: requestNullableString(body.reason, "reason", 2_000),
    mapVersionIds,
  };
}

function rollbackRequest(value: unknown): { reason: string | null } {
  const body = requestObject(value, "request body");
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "reason") {
    throw new HttpError(400, "validation_error", "request body must contain reason");
  }
  return { reason: requestNullableString(body.reason, "reason", 2_000) };
}

// 默认发布只选校区图：每个 campus 取最新的 ready 或 published 版本。
// 楼层图自 0032 起不再走 map_versions（每层一张图片挂在 floors.image_media_id），
// 存量的 floor 图纸版本留在库里给历史 release 引用，但不再进入新 release。
const DEFAULT_MAP_VERSION_QUERY = `select mv.*,ma.checksum,me.object_key as assetKey,me.byte_size as assetByteSize,
       me.sha256 as assetSha256,me.status as assetStatus,me.bucket_scope as assetBucketScope,
       c.code as campusCode,c.name as campusName
  from map_versions mv join map_assets ma on ma.id=mv.map_asset_id join media_assets me on me.id=ma.media_asset_id
  left join campuses c on c.id=mv.campus_id
 where mv.floor_id is null and mv.lifecycle_status in ('ready','published')
   and mv.id=(select mv2.id from map_versions mv2
               where mv2.lifecycle_status in ('ready','published')
                 and coalesce(mv2.campus_id,'')=coalesce(mv.campus_id,'')
                 and coalesce(mv2.floor_id,'')=coalesce(mv.floor_id,'')
               order by mv2.created_at desc,mv2.id desc limit 1)`;
const MAX_RELEASE_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_MAP_ASSET_BYTES = 50 * 1024 * 1024;
/**
 * 校区图坐标系。客户端的 buildMapPointPois 只把这个坐标系、且不挂楼层的点渲染成
 * 图钉，所以发布校验要按同一条件判断「这条位置会不会上图」。
 */
const CANVAS_CRS = "svg_viewbox";

export class ReleaseCoordinator {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.state.blockConcurrencyWhile(async () => {
        const url = new URL(request.url);
        const actorUserId = request.headers.get("x-shumap-user-id");
        if (!actorUserId) throw new HttpError(401, "unauthorized", "Missing release actor");
        if (request.method === "POST" && url.pathname === "/release") {
          return this.publish(request, actorUserId);
        }
        const rollback = url.pathname.match(/^\/rollback\/([^/]+)$/);
        if (request.method === "POST" && rollback) {
          return this.rollback(request, actorUserId, decodeURIComponent(rollback[1]));
        }
        throw new HttpError(404, "not_found", "Release coordinator route does not exist");
      });
    } catch (error) {
      if (error instanceof HttpError) return json({ error: { code: error.code, message: error.message, details: error.details } }, { status: error.status });
      console.error(error);
      return json({ error: { code: "internal_error", message: "Release operation failed" } }, { status: 500 });
    }
  }

  private async publish(request: Request, actorUserId: string): Promise<Response> {
    const body = releaseRequest(await readJson<unknown>(request));
    const { version } = body;
    const duplicate = await first<{ id: string }>(this.env.DB, "select id from releases where version=?", [version]);
    if (duplicate) throw new HttpError(409, "duplicate_version", "Release version already exists");
    const releaseId = makeId("release");
    const now = isoNow();
    await this.env.DB.prepare(
      `insert into releases(id,version,schema_version,status,summary,created_by,created_at) values(?,?,2,'validating',?,?,?)`,
    ).bind(releaseId, version, body.summary, actorUserId, now).run();

    try {
      const candidate = await buildCandidate(this.env, releaseId, version, now, body.mapVersionIds);
      const assetValidation = await validateMapAssets(this.env, candidate.maps);
      const selectionValidation = validateMapSelection(body.mapVersionIds, candidate.maps);
      const validation = validateCandidate(candidate, assetValidation, selectionValidation);
      await this.env.DB.prepare("update releases set validation_report_json=?,validated_at=?,status=? where id=?")
        .bind(jsonString(validation), isoNow(), validation.valid ? "ready" : "validation_failed", releaseId).run();
      if (!validation.valid) {
        // 校验失败的 release 永远到不了 active：buildCandidate 已写入的
        // release_items / release_map_versions / search_documents 对它毫无用处，
        // 留在库里只会越积越多（releases 行本身保留——validation report 是排障依据）。
        await deleteReleaseSideTables(this.env, releaseId);
        return json({ id: releaseId, status: "validation_failed", validation }, { status: 422 });
      }

      await this.env.DB.prepare("update releases set status='publishing' where id=?").bind(releaseId).run();
      const serialized = JSON.stringify(candidate.manifest);
      const artifactBytes = new TextEncoder().encode(serialized);
      if (artifactBytes.byteLength > MAX_RELEASE_ARTIFACT_BYTES) {
        throw new Error(`Release artifact exceeds ${MAX_RELEASE_ARTIFACT_BYTES} bytes`);
      }
      const artifactHash = await sha256(serialized);
      const artifactKey = `release/artifacts/${releaseId}/manifest.${artifactHash}.json`;
      await this.env.SHUMAP_BUCKET.put(artifactKey, serialized, {
        httpMetadata: { contentType: "application/json; charset=utf-8", cacheControl: "public, max-age=31536000, immutable" },
        customMetadata: { releaseId, version, sha256: artifactHash },
      });
      const stored = await this.env.SHUMAP_BUCKET.get(artifactKey);
      if (!stored || stored.size !== artifactBytes.byteLength || stored.size > MAX_RELEASE_ARTIFACT_BYTES) {
        throw new Error("Release artifact size verification failed");
      }
      if ((await sha256(await stored.arrayBuffer())) !== artifactHash) throw new Error("Release artifact checksum verification failed");

      const previous = await first<{ id: string }>(this.env.DB, "select id from releases where status='active'");
      const statements = [];
      if (previous) statements.push(this.env.DB.prepare("update releases set status='superseded' where id=?").bind(previous.id));
      statements.push(this.env.DB.prepare(
        "update releases set status='active',artifact_key=?,artifact_sha256=?,activated_at=?,supersedes_release_id=? where id=?",
      ).bind(artifactKey, artifactHash, isoNow(), previous?.id ?? null, releaseId));
      statements.push(this.env.DB.prepare(
        "insert into release_activations(id,from_release_id,to_release_id,action,actor_user_id,reason,created_at) values(?,?,?,'publish',?,?,?)",
      ).bind(makeId("activation"), previous?.id ?? null, releaseId, actorUserId, body.reason, isoNow()));
      // 激活即发布：本次 release 选中的 map version 从 'ready' 提升为 'published'，
      // 否则没有任何代码路径写入 'published'（jobs.ts 导入只写 'ready'）。
      for (const map of candidate.maps) {
        statements.push(this.env.DB.prepare(
          "update map_versions set lifecycle_status='published' where id=? and lifecycle_status='ready'",
        ).bind(map.id));
      }
      await this.env.DB.batch(statements);
      return json({ id: releaseId, version, status: "active", artifactSha256: artifactHash, validation }, { status: 201 });
    } catch (error) {
      await this.env.DB.prepare("update releases set status='failed',validation_report_json=? where id=?")
        .bind(jsonString({ valid: false, errors: [error instanceof Error ? error.message : "Unknown release error"] }), releaseId).run();
      // 与 validation_failed 同理：中途失败的 release（如 artifact 超限）同样带着
      // 已写入的侧表行，清掉。清理自身出错不再抛——不能让它掩盖原始错误。
      try {
        await deleteReleaseSideTables(this.env, releaseId);
      } catch (cleanupError) {
        console.error("release side-table cleanup failed", cleanupError);
      }
      throw error;
    }
  }

  private async rollback(request: Request, actorUserId: string, targetReleaseId: string): Promise<Response> {
    const body = rollbackRequest(await readJson<unknown>(request));
    const target = await first<ReleaseRow>(
      this.env.DB,
      "select id,version,schema_version,status,artifact_key,artifact_sha256,created_at from releases where id=? and status in ('active','superseded')",
      [targetReleaseId],
    );
    if (!target?.artifact_key || !target.artifact_sha256) throw new HttpError(404, "not_found", "Rollback target is unavailable");
    if (target.schema_version !== 2) throw new HttpError(409, "incompatible_release", "Rollback target uses an incompatible schema");
    const object = await this.env.SHUMAP_BUCKET.get(target.artifact_key);
    if (!object || object.size <= 0 || object.size > MAX_RELEASE_ARTIFACT_BYTES) {
      throw new HttpError(409, "invalid_artifact", "Rollback target artifact has an invalid size");
    }
    if ((await sha256(await object.arrayBuffer())) !== target.artifact_sha256) {
      throw new HttpError(409, "invalid_artifact", "Rollback target artifact failed verification");
    }
    const current = await first<{ id: string }>(this.env.DB, "select id from releases where status='active'");
    if (current?.id === targetReleaseId) return json({ id: targetReleaseId, status: "active", unchanged: true });
    await this.env.DB.batch([
      ...(current ? [this.env.DB.prepare("update releases set status='superseded' where id=?").bind(current.id)] : []),
      this.env.DB.prepare("update releases set status='active',activated_at=? where id=?").bind(isoNow(), targetReleaseId),
      this.env.DB.prepare(
        "insert into release_activations(id,from_release_id,to_release_id,action,actor_user_id,reason,created_at) values(?,?,?,'rollback',?,?,?)",
      ).bind(makeId("activation"), current?.id ?? null, targetReleaseId, actorUserId, body.reason, isoNow()),
    ]);
    return json({ id: targetReleaseId, status: "active", rolledBackFrom: current?.id ?? null });
  }
}

async function buildCandidate(env: Env, releaseId: string, version: string, createdAt: string, requestedMapVersionIds: string[]) {
  const [campuses, places, facilities, merchants, maps, stops] = await Promise.all([
    all<{ id: string; code: string; name: string; timezone: string }>(
      env.DB,
      "select id,code,name,timezone from campuses where status='active' order by code",
    ),
    all<PlaceCandidate>(env.DB, `select p.id,p.kind_id as kindId,pk.name as kindName,p.campus_id as campusId,
      p.parent_place_id as parentPlaceId,p.lifecycle_status as lifecycleStatus,
      case when b.place_id is null then 0 else 1 end as isBuilding,
      r.id as revisionId,r.display_name as displayName,r.summary,r.description,r.content_json as contentJson,r.content_hash as contentHash
      from places p join place_kinds pk on pk.id=p.kind_id left join buildings b on b.place_id=p.id
      join place_revisions r on r.id=p.current_revision_id
      where p.lifecycle_status<>'retired' and p.approval_pending=0 and r.editorial_status='approved'`),
    all<FacilityCandidate>(env.DB, `select f.id,f.facility_type_id as facilityTypeId,f.host_place_id as hostPlaceId,f.floor_id as floorId,
      f.operational_status as operationalStatus,f.quantity,r.id as revisionId,r.display_name as displayName,r.service_hours_json as serviceHoursJson,
      r.content_json as contentJson,r.content_hash as contentHash,t.visibility_policy_json as visibilityPolicyJson,t.status as facilityTypeStatus
      from facility_instances f join facility_revisions r on r.id=f.current_revision_id join facility_types t on t.id=f.facility_type_id
      where f.lifecycle_status='active' and f.approval_pending=0 and r.editorial_status='approved'`),
    all<MerchantCandidate>(env.DB, `select m.id,m.organization_id as organizationId,m.host_place_id as hostPlaceId,m.floor_id as floorId,
      r.id as revisionId,r.display_name as displayName,r.business_type as businessType,r.opening_hours_json as openingHoursJson,r.contact_json as contactJson,
      r.content_json as contentJson,r.content_hash as contentHash
      from merchant_outlets m join merchant_revisions r on r.id=m.current_revision_id where m.lifecycle_status<>'retired' and m.approval_pending=0 and r.editorial_status='approved'`),
    requestedMapVersionIds.length
      ? all<MapCandidate>(env.DB, `select mv.*,ma.checksum,me.object_key as assetKey,me.byte_size as assetByteSize,
              me.sha256 as assetSha256,me.status as assetStatus,me.bucket_scope as assetBucketScope,
              c.code as campusCode,c.name as campusName
          from map_versions mv join map_assets ma on ma.id=mv.map_asset_id join media_assets me on me.id=ma.media_asset_id
          left join campuses c on c.id=mv.campus_id
         where mv.id in (${requestedMapVersionIds.map(() => "?").join(",")}) and mv.floor_id is null and mv.lifecycle_status in ('ready','published')`, requestedMapVersionIds)
      // 默认发布只选校区图（见 DEFAULT_MAP_VERSION_QUERY 注释）。
      : all<MapCandidate>(env.DB, DEFAULT_MAP_VERSION_QUERY),
    // 快照只留站点：站点带几何，是地图数据。线路/班次/时刻/日历改点即生效，
    // 由 GET /api/public/transit/journeys 与 /transit/trips/:tripId/stops 实时下发。
    all<TransitStopCandidate>(env.DB, `select id,place_id,campus_id,code,name,status,marker_size,created_at,updated_at
      from transit_stops where status='active' order by name,id`),
  ]);

  const candidateIds = {
    place: new Set(places.map((row) => row.id)),
    facility: new Set(facilities.map((row) => row.id)),
    merchant_outlet: new Set(merchants.map((row) => row.id)),
    transit_stop: new Set(stops.map((row) => row.id)),
  };
  const allLocations = await all<LocationCandidate>(
    env.DB,
    `select el.entity_type as entityType,el.entity_id as entityId,el.role,el.is_primary as isPrimary,
            la.*,mf.source_element_id as sourceElementId,mf.feature_kind as featureKind,
            bound_mv.version_label as boundMapVersionLabel,bound_mv.campus_id as boundMapCampusId,
            bound_mv.floor_id as boundMapFloorId,bound_campus.name as boundMapCampusName
       from entity_locations el join location_anchors la on la.id=el.anchor_id
       left join map_features mf on mf.id=la.map_feature_id
       left join map_versions bound_mv on bound_mv.id=la.map_version_id
       left join campuses bound_campus on bound_campus.id=bound_mv.campus_id
      where el.valid_to is null and (la.valid_to is null or la.valid_to>?)`,
    [isoNow()],
  );
  // 站点锚点也进快照：站点由此能独立出图钉，不必再依附一个地点。绑定表里还有
  // operational_event / campaign 两种实体，它们的位置走实时接口，继续挡在外面。
  const locations = allLocations.filter((location) => {
    if (location.entityType === "place") return candidateIds.place.has(location.entityId);
    if (location.entityType === "facility") return candidateIds.facility.has(location.entityId);
    if (location.entityType === "merchant_outlet") return candidateIds.merchant_outlet.has(location.entityId);
    if (location.entityType === "transit_stop") return candidateIds.transit_stop.has(location.entityId);
    return false;
  });

  // 楼层与设施类型进 manifest：客户端楼层视图/设施筛选此前只能绕过 release 直读
  // GET /api/public/places/:id，导致「地图数据只来自 release」的约定有个缺口。
  // 设施的实时状态（operational_status）由 GET /api/public/facility-status 覆盖，
  // 这里发布的那一份只是基线。
  const [allFloors, facilityTypes, mapFilters] = await Promise.all([
    all<FloorCandidate>(env.DB, `select id,building_place_id as buildingPlaceId,level_code as levelCode,level_order as levelOrder,
      display_name as displayName,is_public as isPublic,image_media_id as imageMediaId
      from floors where lifecycle_status='active' order by building_place_id,level_order`),
    all<FacilityTypeCandidate>(env.DB, "select id,code,name,category,icon_key as iconKey,status from facility_types order by category,name"),
    loadReleaseMapFilters(env),
  ]);
  const floors = allFloors
    .filter((floor) => candidateIds.place.has(floor.buildingPlaceId))
    .map((floor): ReleaseFloor => {
      const { imageMediaId, ...fields } = floor;
      return { ...fields, imageUrl: imageMediaId ? publicMediaPath(imageMediaId) : null };
    });

  const aliasRows = await all<{ placeId: string; name: string }>(
    env.DB,
    "select place_id as placeId,name from place_names where name_type in ('alias','former','short','english') and is_searchable=1 order by place_id,name",
  );
  const aliasesByPlace = new Map(places.map((place) => [place.id, [] as string[]]));
  for (const row of aliasRows) {
    const aliases = aliasesByPlace.get(row.placeId);
    if (aliases) aliases.push(row.name);
  }
  const releasePlaces = places.map((place): ReleasePlace => {
    const { isBuilding, contentJson, ...fields } = place;
    return {
      ...fields,
      isBuilding: databaseBoolean(isBuilding, `place ${place.id} isBuilding`),
      content: normalizePlaceContent(parseJsonObject(contentJson, `place ${place.id} contentJson`)),
      aliases: aliasesByPlace.get(place.id)!,
    };
  });
  const releaseFacilities = facilities.map(releaseFacility);
  const releaseMerchants = merchants.map(releaseMerchant);
  const releaseMaps = maps.map(releaseMap);
  const searchDocuments = buildSearchDocuments(releasePlaces, releaseFacilities, releaseMerchants, locations, floors);
  const manifest: ReleaseManifest = {
    schemaVersion: 2,
    release: { id: releaseId, version, createdAt },
    campuses,
    places: releasePlaces,
    facilities: releaseFacilities,
    merchants: releaseMerchants,
    // 位置逐字段挑进快照（releaseLocation）：校验用的 boundMap* 别名留在
    // locations 里给 validateCandidate 用，不外发给客户端。
    maps: releaseMaps, locations: locations.map(releaseLocation), floors, facilityTypes, mapFilters,
    // marker_size 只在非标准系数（≠1）才进快照：客户端对 stops 是 exactObject 白名单校验，
    // 已发布的旧版小程序不认识这个键，全量输出会让它们在下次发版时整份解析失败。
    transit: { stops: stops.map((stop) => {
      const scale = Number(stop.marker_size);
      if (Number.isFinite(scale) && scale !== 1) return { ...stop, marker_size: scale };
      const { marker_size: _omitted, ...rest } = stop;
      return rest;
    }) },
    searchDocuments,
    generatedAt: isoNow(),
  };

  const itemStatements = [];
  for (const [entityType, records] of [["place", places], ["facility", facilities], ["merchant_outlet", merchants]] as const) {
    for (const record of records) {
      itemStatements.push(env.DB.prepare("insert into release_items(release_id,entity_type,entity_id,revision_id,item_hash) values(?,?,?,?,?)")
        .bind(releaseId, entityType, record.id, record.revisionId, record.contentHash));
    }
  }
  for (const map of maps) itemStatements.push(env.DB.prepare("insert into release_map_versions(release_id,map_version_id) values(?,?)").bind(releaseId, map.id));
  for (const doc of searchDocuments) itemStatements.push(env.DB.prepare(
    `insert into search_documents(release_id,document_type,entity_id,title,subtitle,normalized_text,pinyin,campus_id,building_place_id,floor_id,facets_json,map_target_json,ranking_weight)
     values(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(releaseId, doc.documentType, doc.entityId, doc.title, doc.subtitle, doc.normalizedText, doc.pinyin, doc.campusId, doc.buildingPlaceId, doc.floorId, jsonString(doc.facets), jsonString(doc.mapTarget), doc.rankingWeight));
  if (itemStatements.length) await env.DB.batch(itemStatements);
  return { manifest, places: releasePlaces, facilities: releaseFacilities, merchants: releaseMerchants, maps, locations, facilityTypes, mapFilters, searchDocuments };
}

async function loadReleaseMapFilters(env: Env) {
  const [categories, members] = await Promise.all([
    all<{ id: string; key: string; label: string; sortOrder: number }>(
      env.DB,
      "select id,key,label,sort_order as sortOrder from map_filter_categories where active=1 order by sort_order,label,id",
    ),
    all<{ categoryId: string; placeKindId: string | null; facilityTypeId: string | null; includesMerchants: number }>(
      env.DB,
      `select category_id as categoryId,place_kind_id as placeKindId,facility_type_id as facilityTypeId,
              includes_merchants as includesMerchants
         from map_filter_members
        where category_id in (select id from map_filter_categories where active=1)
        order by category_id,sort_order,created_at,id`,
    ),
  ]);
  const membersByCategory = new Map(categories.map((category) => [category.id, [] as typeof members]));
  for (const member of members) {
    const categoryMembers = membersByCategory.get(member.categoryId);
    if (!categoryMembers) throw new Error(`Map filter member ${member.categoryId} has no active category`);
    categoryMembers.push(member);
  }
  return categories.map((category): ReleaseMapFilter => {
    const categoryMembers = membersByCategory.get(category.id)!;
    return {
      ...category,
      placeKindIds: categoryMembers.flatMap((member) => member.placeKindId ? [member.placeKindId] : []),
      facilityTypeIds: categoryMembers.flatMap((member) => member.facilityTypeId ? [member.facilityTypeId] : []),
      includesMerchants: categoryMembers.some((member) => databaseBoolean(
        member.includesMerchants,
        `map filter member in ${category.id} includesMerchants`,
      )),
    };
  });
}

async function validateMapAssets(env: Env, maps: MapCandidate[]): Promise<MapAssetValidation[]> {
  const results: MapAssetValidation[] = [];
  for (const map of maps) {
    let error: string | null = null;
    if (!Number.isSafeInteger(map.assetByteSize) || map.assetByteSize <= 0 || map.assetByteSize > MAX_MAP_ASSET_BYTES) {
      error = `Map ${map.id} has invalid stored byte size ${map.assetByteSize}`;
    } else if (!/^[a-f0-9]{64}$/.test(map.assetSha256)) {
      error = `Map ${map.id} has an invalid stored SHA-256 digest`;
    } else if (map.checksum !== map.assetSha256) {
      error = `Map ${map.id} checksum does not match its media asset`;
    } else if (!(["approved", "published"] as string[]).includes(map.assetStatus)) {
      error = `Map ${map.id} media asset is not approved`;
    } else if (!(["private", "public"] as string[]).includes(map.assetBucketScope)) {
      error = `Map ${map.id} media asset is not in a readable bucket scope`;
    } else {
      try {
        const object = await env.SHUMAP_BUCKET.get(map.assetKey);
        if (!object) {
          error = `Map ${map.id} object ${map.assetKey} is missing`;
        } else if (object.size !== map.assetByteSize) {
          await object.body.cancel();
          error = `Map ${map.id} object size ${object.size} does not match stored byte size ${map.assetByteSize}`;
        } else if ((await sha256(await object.arrayBuffer())) !== map.assetSha256) {
          error = `Map ${map.id} object checksum does not match stored SHA-256`;
        }
      } catch {
        error = `Map ${map.id} object ${map.assetKey} could not be read`;
      }
    }
    results.push({ mapVersionId: map.id, objectKey: map.assetKey, valid: error === null, error });
  }
  return results;
}

function releaseMap(map: MapCandidate): ReleaseMap {
  return {
    id: map.id,
    campus_id: map.campus_id,
    floor_id: map.floor_id,
    map_asset_id: map.map_asset_id,
    parent_version_id: map.parent_version_id,
    campusCode: map.campusCode,
    campusName: map.campusName,
    version_label: map.version_label,
    coordinate_space_type: map.coordinate_space_type,
    coordinate_space_json: map.coordinate_space_json,
    parser_version: map.parser_version,
    lifecycle_status: map.lifecycle_status,
    created_by: map.created_by,
    created_at: map.created_at,
    checksum: map.checksum,
    assetKey: map.assetKey,
  };
}

function validateMapSelection(requestedMapVersionIds: string[], maps: MapCandidate[]): MapSelectionValidation {
  const selectedMapVersionIds = maps.map((map) => map.id);
  const selected = new Set(selectedMapVersionIds);
  return {
    requestedMapVersionIds,
    selectedMapVersionIds,
    missingMapVersionIds: requestedMapVersionIds.filter((id) => !selected.has(id)),
  };
}

function mapBindingIssue(
  location: LocationCandidate,
  maps: MapCandidate[],
  entityNames: Map<string, string>,
): MapBindingIssue {
  // 楼层位置优先对应本层图纸；其余位置对应校区图。这样后台能明确指出本次
  // 已选择的替代版本，而不是只报出一个无法反查的 anchor id。
  const floorId = location.floor_id ?? location.boundMapFloorId;
  const campusId = location.campus_id ?? location.boundMapCampusId;
  const selectedMap = floorId
    ? maps.find((map) => map.floor_id === floorId)
    : maps.find((map) => map.floor_id === null && map.campus_id === campusId);
  return {
    anchorId: location.id,
    entityType: location.entityType,
    entityId: location.entityId,
    entityName: entityNames.get(`${location.entityType}:${location.entityId}`) ?? location.entityId,
    role: location.role,
    currentMapVersionId: location.map_version_id,
    currentMapVersionLabel: location.boundMapVersionLabel,
    currentMapCampusName: location.boundMapCampusName,
    selectedMapVersionId: selectedMap?.id ?? null,
    selectedMapVersionLabel: selectedMap?.version_label ?? null,
    selectedMapCampusName: selectedMap?.campusName ?? null,
  };
}

function validateCandidate(
  candidate: Awaited<ReturnType<typeof buildCandidate>>,
  mapAssets: MapAssetValidation[],
  mapSelection: MapSelectionValidation,
) {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const result of mapAssets) {
    if (result.error) errors.push(result.error);
  }
  for (const mapVersionId of mapSelection.missingMapVersionIds) {
    errors.push(`Requested map version ${mapVersionId} does not exist or is not ready for release`);
  }
  if (!candidate.maps.length) errors.push("At least one published or explicitly selected map version is required");
  const mapIds = new Set(candidate.maps.map((map) => map.id));
  const entityNames = new Map<string, string>([
    ...candidate.places.map((place): [string, string] => [`place:${place.id}`, place.displayName]),
    ...candidate.facilities.map((facility): [string, string] => [`facility:${facility.id}`, facility.displayName]),
    ...candidate.merchants.map((merchant): [string, string] => [`merchant_outlet:${merchant.id}`, merchant.displayName]),
    ...candidate.manifest.transit.stops.map((stop): [string, string] => [`transit_stop:${stop.id}`, stop.name]),
  ]);
  const mapBindingIssues: MapBindingIssue[] = [];
  const mapBindingIssueAnchorIds = new Set<string>();
  const addMapBindingIssue = (location: LocationCandidate) => {
    if (mapBindingIssueAnchorIds.has(location.id)) return;
    mapBindingIssueAnchorIds.add(location.id);
    mapBindingIssues.push(mapBindingIssue(location, candidate.maps, entityNames));
  };
  const campusMapCount = new Map<string, number>();
  for (const map of candidate.maps) {
    if (map.campus_id) campusMapCount.set(map.campus_id, (campusMapCount.get(map.campus_id) ?? 0) + 1);
  }
  for (const [campusId, count] of campusMapCount) {
    if (count !== 1) errors.push(`Campus ${campusId} must have exactly one map version in this release`);
  }
  const placeIds = new Set(candidate.places.map((place) => place.id));
  const placeCampusById = new Map(candidate.places.map((place) => [place.id, place.campusId]));
  for (const stop of candidate.manifest.transit.stops) {
    if (stop.place_id && !placeIds.has(stop.place_id)) {
      errors.push(`Transit stop ${stop.id} refers to an unpublished place`);
    }
    // 站点标了校区级点位就会在客户端出图钉，而 buildMapPointPois 解析不出校区时
    // 直接抛 —— 那会让整张地图打不开。发布时先拦下来，别把它带到线上。
    const pin = candidate.locations.find((location) =>
      location.entityType === "transit_stop"
      && location.entityId === stop.id
      && location.geometry_type === "Point"
      && location.crs === CANVAS_CRS
      && location.floor_id === null);
    if (!pin) continue;
    const campusId = pin.campus_id
      ?? stop.campus_id
      ?? (stop.place_id ? placeCampusById.get(stop.place_id) ?? null : null);
    if (!campusId) {
      errors.push(`Transit stop ${stop.id} has a campus map pin but no campus to place it on`);
    } else if (!campusMapCount.has(campusId)) {
      errors.push(`Transit stop ${stop.id} pin needs campus ${campusId} to have a campus map in this release`);
    }
  }
  for (const filter of candidate.mapFilters) {
    if (!filter.placeKindIds.length && !filter.facilityTypeIds.length && !filter.includesMerchants) {
      errors.push(`Active map filter ${filter.id} has no members`);
    }
  }
  const publishedPlaceKindIds = new Set(candidate.places.map((place) => place.kindId));
  for (const kindId of publishedPlaceKindIds) {
    const ownerCount = candidate.mapFilters.filter((filter) => filter.placeKindIds.includes(kindId)).length;
    if (ownerCount !== 1) errors.push(`Published place kind ${kindId} must belong to exactly one active map filter`);
  }
  for (const facilityType of candidate.facilityTypes) {
    if (facilityType.status !== "active") continue;
    const facilityTypeId = facilityType.id;
    const ownerCount = candidate.mapFilters.filter((filter) => filter.facilityTypeIds.includes(facilityTypeId)).length;
    if (ownerCount !== 1) errors.push(`Active facility type ${facilityTypeId} must belong to exactly one active map filter`);
  }
  if (candidate.merchants.length) {
    const ownerCount = candidate.mapFilters.filter((filter) => filter.includesMerchants).length;
    if (ownerCount !== 1) errors.push("Merchant outlets must belong to exactly one active map filter");
  }
  for (const merchant of candidate.merchants) {
    if (merchant.hostPlaceId && !placeIds.has(merchant.hostPlaceId)) {
      errors.push(`Merchant ${merchant.id} refers to an unpublished host place`);
    }
  }
  for (const facility of candidate.facilities) {
    if (facility.hostPlaceId && !placeIds.has(facility.hostPlaceId)) errors.push(`Facility ${facility.id} refers to an unpublished host place`);
    if (facility.facilityTypeStatus === "disabled") warnings.push(`Facility ${facility.id} uses a disabled facility type`);
  }
  const locations = candidate.locations;
  for (const location of locations) {
    if (location.map_version_id && !mapIds.has(location.map_version_id)) {
      errors.push(`Location ${location.id} uses a map version outside this release`);
      addMapBindingIssue(location);
    }
    if (location.role === "navigation_target") {
      const geometry = locationGeometry(location);
      const coordinates = geometry?.coordinates;
      if (
        location.geometry_type !== "Point"
        || geometry?.type !== "Point"
        || !Array.isArray(coordinates)
        || coordinates.length !== 2
        || coordinates.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate))
      ) {
        errors.push(`Navigation location ${location.id} must contain a finite GeoJSON Point`);
      } else if (
        coordinates[0] < -180 || coordinates[0] > 180
        || coordinates[1] < -90 || coordinates[1] > 90
      ) {
        errors.push(`Navigation location ${location.id} has invalid longitude or latitude`);
      }
      if (location.crs !== NAVIGATION_CRS) {
        errors.push(`Navigation location ${location.id} must use ${NAVIGATION_CRS}`);
      }
    }
  }
  const displayedCampusIds = new Set(candidate.places.flatMap((place) => place.campusId ? [place.campusId] : []));
  for (const campusId of displayedCampusIds) {
    if (!campusMapCount.has(campusId)) errors.push(`Campus ${campusId} has published places but no campus map in this release`);
  }
  for (const place of candidate.places) {
    if (!place.isBuilding) continue;
    if (!place.campusId) {
      errors.push(`Building ${place.id} must belong to a campus`);
      continue;
    }
    const footprints = locations.filter((location) =>
      location.entityType === "place"
      && location.entityId === place.id
      && location.role === "footprint");
    if (footprints.length !== 1) {
      errors.push(`Building ${place.id} must have exactly one footprint location`);
      continue;
    }
    const [footprint] = footprints;
    if (!footprint.map_feature_id || !footprint.sourceElementId || footprint.featureKind !== "building_footprint") {
      errors.push(`Building ${place.id} footprint must reference a building footprint feature with a source element id`);
    }
    if (!footprint.map_version_id || !mapIds.has(footprint.map_version_id)) {
      errors.push(`Building ${place.id} footprint must use a map version in this release`);
      addMapBindingIssue(footprint);
    }
  }
  if (!candidate.places.length) warnings.push("Release has no approved places");
  return { valid: errors.length === 0, errors, warnings, mapAssets, mapSelection, mapBindingIssues, counts: {
    places: candidate.places.length, facilities: candidate.facilities.length, merchants: candidate.merchants.length,
    maps: candidate.maps.length, locations: candidate.locations.length, searchDocuments: candidate.searchDocuments.length,
  } };
}

export function buildSearchDocuments(
  places: ReleasePlace[],
  facilities: ReleaseFacility[],
  merchants: ReleaseMerchant[],
  locations: LocationCandidate[],
  floors: Array<Pick<FloorCandidate, "id" | "buildingPlaceId">> = [],
): SearchDocumentCandidate[] {
  const locationsByEntity = new Map<string, LocationCandidate[]>();
  for (const location of locations) {
    const key = `${location.entityType}:${location.entityId}`;
    databaseBoolean(location.isPrimary, `location ${location.id} isPrimary`);
    const entityLocations = locationsByEntity.get(key) ?? [];
    entityLocations.push(location);
    locationsByEntity.set(key, entityLocations);
  }
  for (const entityLocations of locationsByEntity.values()) {
    entityLocations.sort((left, right) =>
      right.isPrimary - left.isPrimary || left.id.localeCompare(right.id),
    );
  }
  const placeById = new Map(places.map((place) => [place.id, place]));
  const campusByPlace = new Map(
    places.flatMap((place) => place.campusId ? [[place.id, place.campusId] as const] : []),
  );
  const buildingIds = new Set(places.filter((place) => place.isBuilding).map((place) => place.id));
  const buildingByFloor = new Map(floors.map((floor) => [floor.id, floor.buildingPlaceId]));
  const entityLocationsFor = (entityType: LocationCandidate["entityType"], entityId: string) =>
    locationsByEntity.get(`${entityType}:${entityId}`) ?? [];
  const locationFor = (entityType: LocationCandidate["entityType"], entityId: string) =>
    entityLocationsFor(entityType, entityId)[0];
  const campusInPlaceChain = (placeId: string | null): string | null => {
    const visited = new Set<string>();
    let currentId = placeId;
    while (currentId) {
      if (visited.has(currentId)) throw new Error(`Place hierarchy contains a cycle at ${currentId}`);
      visited.add(currentId);
      const place = placeById.get(currentId);
      if (!place) return null;
      const campusId = campusByPlace.get(place.id);
      if (campusId) return campusId;
      const locationCampusId = campusFromLocations("place", place.id);
      if (locationCampusId) return locationCampusId;
      currentId = place.parentPlaceId;
    }
    return null;
  };
  const buildingInPlaceChain = (placeId: string | null): string | null => {
    const visited = new Set<string>();
    let currentId = placeId;
    while (currentId) {
      if (visited.has(currentId)) throw new Error(`Place hierarchy contains a cycle at ${currentId}`);
      visited.add(currentId);
      const place = placeById.get(currentId);
      if (!place) return null;
      if (buildingIds.has(place.id)) return place.id;
      const anchoredBuildingId = buildingFromLocations("place", place.id);
      if (anchoredBuildingId) return anchoredBuildingId;
      currentId = place.parentPlaceId;
    }
    return null;
  };
  const campusFromLocations = (entityType: LocationCandidate["entityType"], entityId: string) =>
    entityLocationsFor(entityType, entityId).find((location) => location.campus_id)?.campus_id ?? null;
  const buildingFromLocations = (entityType: LocationCandidate["entityType"], entityId: string) =>
    entityLocationsFor(entityType, entityId).reduce<string | null>((buildingPlaceId, location) => {
      if (buildingPlaceId) return buildingPlaceId;
      if (location.building_place_id && buildingIds.has(location.building_place_id)) {
        return location.building_place_id;
      }
      const floorBuildingId = location.floor_id ? buildingByFloor.get(location.floor_id) : undefined;
      return floorBuildingId && buildingIds.has(floorBuildingId) ? floorBuildingId : null;
    }, null);
  const campusForHostedEntity = (
    entityType: "facility" | "merchant_outlet",
    record: ReleaseFacility | ReleaseMerchant,
  ): string | null => campusFromLocations(entityType, record.id) ?? campusInPlaceChain(record.hostPlaceId);
  const buildingForHostedEntity = (
    entityType: "facility" | "merchant_outlet",
    record: ReleaseFacility | ReleaseMerchant,
  ): string | null => {
    const floorBuildingId = record.floorId ? buildingByFloor.get(record.floorId) ?? null : null;
    return buildingFromLocations(entityType, record.id)
      ?? floorBuildingId
      ?? buildingInPlaceChain(record.hostPlaceId);
  };
  return [
    ...places.map((record) => document(
      "place",
      record,
      locationFor("place", record.id),
      10,
      campusFromLocations("place", record.id) ?? campusInPlaceChain(record.id),
      buildingFromLocations("place", record.id) ?? buildingInPlaceChain(record.id),
      null,
    )),
    ...facilities.map((record) => document(
      "facility",
      record,
      locationFor("facility", record.id),
      8,
      campusForHostedEntity("facility", record),
      buildingForHostedEntity("facility", record),
      record.floorId,
    )),
    ...merchants.map((record) => document(
      "merchant_outlet",
      record,
      locationFor("merchant_outlet", record.id),
      7,
      campusForHostedEntity("merchant_outlet", record),
      buildingForHostedEntity("merchant_outlet", record),
      record.floorId,
    )),
  ];
}

function document(
  type: "place" | "facility" | "merchant_outlet",
  record: ReleasePlace | ReleaseFacility | ReleaseMerchant,
  location: LocationCandidate | undefined,
  weight: number,
  campusId: string | null,
  buildingPlaceId: string | null,
  floorId: string | null,
): SearchDocumentCandidate {
  const title = record.displayName;
  const aliases = "aliases" in record ? record.aliases.join(" ") : "";
  const summary = "summary" in record ? record.summary : null;
  const businessType = "businessType" in record ? record.businessType : null;
  const merchantText = "openingHours" in record ? merchantSearchText(record.content) : "";
  const searchable = [title, aliases, summary, businessType, merchantText]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");
  const facets: string[] = [type];
  if ("kindId" in record) facets.push(record.kindId);
  if ("facilityTypeId" in record) facets.push(record.facilityTypeId);
  if ("businessType" in record && record.businessType) facets.push(record.businessType);
  return {
    documentType: type, entityId: record.id, title,
    subtitle: location?.location_hint ?? null,
    normalizedText: normalizeSearchText(searchable), pinyin: null,
    campusId,
    buildingPlaceId,
    floorId,
    facets,
    mapTarget: location ? { type: "locationAnchor", id: location.id } : { type, id: record.id },
    rankingWeight: weight,
  };
}

/** Merchant summary and stall code are included in outlet search text. */
function merchantSearchText(content: MerchantContent): string {
  return [content.summary, content.stallCode]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

// ---------------------------------------------------------------------------
// 待发布改动（GET /api/admin/releases/pending）
//
// 「地图数据只来自 release」这条约定有个副作用：后台改完东西，线上要等到发一次版
// 才会变。此前后台没有任何地方说这件事，于是改完看不到效果，无从判断是自己填错了
// 还是只差一次发版 —— 这个端点就是回答后者。
//
// 判定依据是 release_items.item_hash 与当前可发布集合的 content_hash 对比。
// content_hash 覆盖 structure_json（见 places.ts / facilities.ts / merchants.ts），
// 而位置就存在 structure_json.locations 里，所以「在校区图上挪了个点」同样算改动，
// 不需要另外去比锚点表。
//
// 过滤条件必须与 buildCandidate 完全一致，否则会出现「这里说有改动，发版却不带它」
// 这种更糟的不一致。两处都是 lifecycle + approval_pending + editorial_status 三条。
// ---------------------------------------------------------------------------

type PendingEntityType = "place" | "facility" | "merchant_outlet" | "transit_stop" | "map_version";
type PendingChangeKind = "added" | "changed" | "removed";

interface PendingChange {
  entityType: PendingEntityType;
  entityId: string;
  displayName: string;
  change: PendingChangeKind;
}

interface HashedRow {
  entityId: string;
  displayName: string | null;
  itemHash: string;
}

/** 当前集合 vs 已发布集合 → 新增 / 变更 / 移除。名称缺失时退回 id，界面不至于空着。 */
function diffHashed(
  entityType: PendingEntityType,
  current: HashedRow[],
  released: HashedRow[],
): PendingChange[] {
  const releasedByEntity = new Map(released.map((row) => [row.entityId, row]));
  const changes: PendingChange[] = [];
  for (const row of current) {
    const before = releasedByEntity.get(row.entityId);
    if (!before) {
      changes.push({ entityType, entityId: row.entityId, displayName: row.displayName ?? row.entityId, change: "added" });
    } else if (before.itemHash !== row.itemHash) {
      changes.push({ entityType, entityId: row.entityId, displayName: row.displayName ?? row.entityId, change: "changed" });
    }
  }
  const currentIds = new Set(current.map((row) => row.entityId));
  for (const row of released) {
    if (currentIds.has(row.entityId)) continue;
    // 停用或删除的实体：已发布快照里还在，当前集合里没有了。
    changes.push({ entityType, entityId: row.entityId, displayName: row.displayName ?? row.entityId, change: "removed" });
  }
  return changes;
}

/**
 * 清掉 buildCandidate 为一个 release 写入的三张侧表（release_items /
 * release_map_versions / search_documents）。只用于终态为 validation_failed /
 * failed 的 release——它们的侧表行永远不会被任何读路径消费，留着就是孤儿。
 * releases 行本身不动：validation_report_json 是排障与审计依据。
 */
async function deleteReleaseSideTables(env: Env, releaseId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("delete from search_documents where release_id=?").bind(releaseId),
    env.DB.prepare("delete from release_map_versions where release_id=?").bind(releaseId),
    env.DB.prepare("delete from release_items where release_id=?").bind(releaseId),
  ]);
}

/**
 * GET /api/admin/releases —— 发布历史。回滚此前只能手输版本 ID，而回滚立刻影响
 * 全体用户；有列表才能「看着回滚」，也能看出哪些版本是 validation_failed / failed
 * 的废尝试。只读、不含 manifest 内容。
 */
export async function listReleases(env: Env): Promise<Response> {
  const items = await all<{
    id: string;
    version: string;
    status: string;
    summary: string | null;
    createdAt: string;
    activatedAt: string | null;
    createdByEmail: string | null;
    itemCount: number;
  }>(
    env.DB,
    `select r.id,r.version,r.status,r.summary,r.created_at as createdAt,r.activated_at as activatedAt,
            u.email as createdByEmail,(select count(*) from release_items ri where ri.release_id=r.id) as itemCount
       from releases r left join users u on u.id=r.created_by
      order by r.created_at desc limit 50`,
  );
  return json({
    items: items.map((row) => ({
      id: row.id,
      version: row.version,
      status: row.status,
      summary: row.summary,
      createdAt: row.createdAt,
      activatedAt: row.activatedAt,
      createdBy: row.createdByEmail,
      itemCount: row.itemCount,
      // 与 rollback 的可回滚条件保持一致（active/superseded 且有 artifact）。
      rollbackEligible: (row.status === "active" || row.status === "superseded"),
    })),
  });
}

export async function pendingReleaseChanges(env: Env): Promise<Response> {
  const active = await first<{ id: string; version: string; createdAt: string; activatedAt: string | null }>(
    env.DB,
    "select id,version,created_at as createdAt,activated_at as activatedAt from releases where status='active'",
  );

  const [places, facilities, merchants, stops, mapVersions] = await Promise.all([
    all<HashedRow>(env.DB, `select p.id as entityId,r.display_name as displayName,r.content_hash as itemHash
       from places p join place_revisions r on r.id=p.current_revision_id
      where p.lifecycle_status<>'retired' and p.approval_pending=0 and r.editorial_status='approved'`),
    all<HashedRow>(env.DB, `select f.id as entityId,r.display_name as displayName,r.content_hash as itemHash
       from facility_instances f join facility_revisions r on r.id=f.current_revision_id
      where f.lifecycle_status='active' and f.approval_pending=0 and r.editorial_status='approved'`),
    all<HashedRow>(env.DB, `select m.id as entityId,r.display_name as displayName,r.content_hash as itemHash
       from merchant_outlets m join merchant_revisions r on r.id=m.current_revision_id
      where m.lifecycle_status<>'retired' and m.approval_pending=0 and r.editorial_status='approved'`),
    all<{ entityId: string; displayName: string; updatedAt: string }>(
      env.DB,
      "select id as entityId,name as displayName,updated_at as updatedAt from transit_stops where status='active' order by name,id",
    ),
    all<{ entityId: string; displayName: string }>(env.DB, `select mv.id as entityId,mv.version_label as displayName
       from map_versions mv where mv.floor_id is null and mv.lifecycle_status in ('ready','published')
        and mv.id=(select mv2.id from map_versions mv2
                    where mv2.lifecycle_status in ('ready','published')
                      and coalesce(mv2.campus_id,'')=coalesce(mv.campus_id,'')
                      and coalesce(mv2.floor_id,'')=coalesce(mv.floor_id,'')
                    order by mv2.created_at desc,mv2.id desc limit 1)`),
  ]);

  // 从未发过版：当前所有可发布内容都是「新增」，这也是最直白的说法。
  if (!active) {
    const changes = [
      ...places.map((row) => ({ entityType: "place" as const, entityId: row.entityId, displayName: row.displayName ?? row.entityId, change: "added" as const })),
      ...facilities.map((row) => ({ entityType: "facility" as const, entityId: row.entityId, displayName: row.displayName ?? row.entityId, change: "added" as const })),
      ...merchants.map((row) => ({ entityType: "merchant_outlet" as const, entityId: row.entityId, displayName: row.displayName ?? row.entityId, change: "added" as const })),
      ...stops.map((row) => ({ entityType: "transit_stop" as const, entityId: row.entityId, displayName: row.displayName, change: "added" as const })),
      ...mapVersions.map((row) => ({ entityType: "map_version" as const, entityId: row.entityId, displayName: row.displayName, change: "added" as const })),
    ];
    return json({ release: null, hasPendingChanges: changes.length > 0, total: changes.length, changes });
  }

  const [releasedPlaces, releasedFacilities, releasedMerchants, releasedMaps] = await Promise.all([
    all<HashedRow>(env.DB, `select ri.entity_id as entityId,ri.item_hash as itemHash,r.display_name as displayName
       from release_items ri left join place_revisions r on r.id=ri.revision_id
      where ri.release_id=? and ri.entity_type='place'`, [active.id]),
    all<HashedRow>(env.DB, `select ri.entity_id as entityId,ri.item_hash as itemHash,r.display_name as displayName
       from release_items ri left join facility_revisions r on r.id=ri.revision_id
      where ri.release_id=? and ri.entity_type='facility'`, [active.id]),
    all<HashedRow>(env.DB, `select ri.entity_id as entityId,ri.item_hash as itemHash,r.display_name as displayName
       from release_items ri left join merchant_revisions r on r.id=ri.revision_id
      where ri.release_id=? and ri.entity_type='merchant_outlet'`, [active.id]),
    all<{ entityId: string; displayName: string | null }>(env.DB, `select rmv.map_version_id as entityId,mv.version_label as displayName
       from release_map_versions rmv left join map_versions mv on mv.id=rmv.map_version_id
      where rmv.release_id=?`, [active.id]),
  ]);

  const changes: PendingChange[] = [
    ...diffHashed("place", places, releasedPlaces),
    ...diffHashed("facility", facilities, releasedFacilities),
    ...diffHashed("merchant_outlet", merchants, releasedMerchants),
  ];

  // 站点与地图版本没有 item_hash 可比：release_items 只记三类带修订的实体。
  //
  // 站点退回时间比较 —— 它没有修订流，改一个字段即时落库，updated_at 就是唯一的
  // 变更痕迹。判据取 activated_at（快照真正生效的时刻），没有则退回 created_at。
  // 这条比哈希弱：发版后仅改了不进快照的字段（如 code）也会被算作改动。宁可多报，
  // 也不要让「站点挪了位置」这种真改动无声无息。
  const releasedAt = active.activatedAt ?? active.createdAt;
  for (const stop of stops) {
    if (stop.updatedAt > releasedAt) {
      changes.push({ entityType: "transit_stop", entityId: stop.entityId, displayName: stop.displayName, change: "changed" });
    }
  }
  const releasedMapIds = new Set(releasedMaps.map((row) => row.entityId));
  const currentMapIds = new Set(mapVersions.map((row) => row.entityId));
  for (const row of mapVersions) {
    if (!releasedMapIds.has(row.entityId)) {
      changes.push({ entityType: "map_version", entityId: row.entityId, displayName: row.displayName, change: "added" });
    }
  }
  for (const row of releasedMaps) {
    if (currentMapIds.has(row.entityId)) continue;
    changes.push({ entityType: "map_version", entityId: row.entityId, displayName: row.displayName ?? row.entityId, change: "removed" });
  }

  return json({
    release: { id: active.id, version: active.version, activatedAt: releasedAt },
    hasPendingChanges: changes.length > 0,
    total: changes.length,
    changes,
  });
}
