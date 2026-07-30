import type { SessionPrincipal } from "../domain/types";
import type { Env } from "../types/cloudflare";
import { all, first } from "../lib/db";
import { HttpError, json, readJson } from "../lib/http";
import { isoNow, makeId, oneOf, optionalNumber, optionalString, requiredString } from "../lib/values";
import { audit } from "./audit";

// ---------------------------------------------------------------------------
// 设施类型（标签）维护。facility_types 是引用表，facility_instances.facility_type_id
// 指向它，因此「不要这个标签了」在语义上分成两步：
//
//   1. status='disabled' —— 停用。既有实例照常展示与发布，只是不再作为新建选项。
//      有实例引用的类型只能走这条路，物理删除会破坏历史数据的类型指向。
//   2. DELETE —— 仅当没有任何实例引用时允许，真正把行删掉。
//
// icon_key 只能取 SUPPORTED_ICON_KEYS 里的值，与 src/lib/facilityIcons.tsx 的
// FACILITY_ICON_BY_KEY 一一对应；这里是校验用的权威列表，接口把它连同中文
// 说明一起回给后台，界面据此渲染带预览的下拉。
// ---------------------------------------------------------------------------

const STATUSES = ["active", "disabled"] as const;
type FacilityTypeStatus = (typeof STATUSES)[number];

/** 与 src/lib/facilityIcons.tsx 的 FACILITY_ICON_BY_KEY 保持同步。 */
export const SUPPORTED_ICON_KEYS = [
  "printer", "desk", "restroom", "water", "elevator", "vending", "battery", "charging", "service",
  "wifi", "food", "parking", "bike", "bus", "mail", "health", "lounge", "locker", "security",
  "landmark", "sports", "trash", "generic",
] as const;

/** 已有种子数据用到的分类 + other 兜底。分类只用于后台分组展示。 */
export const CATEGORIES = ["service", "study", "amenity", "navigation", "commercial", "transport", "other"] as const;

/**
 * 新建类型的默认可见性策略。与种子数据里最常见的一组取值一致：可搜索、可筛选、
 * 进楼宇概览，不默认铺满校区图和楼层图。后续如需精细控制再单独做界面。
 */
const DEFAULT_VISIBILITY_POLICY = {
  searchable: true,
  filterable: true,
  campusDefault: false,
  buildingSummary: true,
  floorDefault: false,
  showOnSearch: true,
  showOnFilter: true,
  showWhenUnavailable: true,
};

const CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

interface FacilityTypeRow {
  id: string;
  code: string;
  name: string;
  category: string;
  iconKey: string | null;
  status: string;
  verificationIntervalDays: number | null;
  createdAt: string;
  updatedAt: string;
  instanceCount: number;
}

interface FacilityTypeInstanceRow {
  id: string;
  facilityTypeId: string;
  displayName: string;
  lifecycleStatus: string;
  operationalStatus: string;
  hostPlaceId: string | null;
  placeName: string | null;
  floorId: string | null;
  floorName: string | null;
  floorLevelCode: string | null;
  spaceName: string | null;
  editorialStatus: string | null;
}

interface WriteBody {
  code?: unknown;
  name?: unknown;
  category?: unknown;
  iconKey?: unknown;
  status?: unknown;
  verificationIntervalDays?: unknown;
}

/**
 * GET /api/admin/facility-types
 *
 * 全量类型（含停用）+ 每个类型下挂着的点位。点位名取当前修订的 display_name，
 * 没有修订时退回类型名；楼宇名同理走 place_revisions，草稿地点也能显示出来。
 */
export async function listFacilityTypes(env: Env): Promise<Response> {
  const [types, instances] = await Promise.all([
    all<FacilityTypeRow>(
      env.DB,
      `select t.id,t.code,t.name,t.category,t.icon_key as iconKey,t.status,
              t.verification_interval_days as verificationIntervalDays,
              t.created_at as createdAt,t.updated_at as updatedAt,
              (select count(*) from facility_instances f where f.facility_type_id=t.id) as instanceCount
         from facility_types t
        order by t.status='disabled',t.category,t.name`,
    ),
    all<FacilityTypeInstanceRow>(
      env.DB,
      `select f.id,f.facility_type_id as facilityTypeId,
              coalesce(fr.display_name,t.name) as displayName,
              f.lifecycle_status as lifecycleStatus,f.operational_status as operationalStatus,
              f.host_place_id as hostPlaceId,
              coalesce(pr.display_name,
                (select r2.display_name from place_revisions r2 where r2.place_id=pl.id order by r2.revision_no desc limit 1)
              ) as placeName,
              f.floor_id as floorId,fl.display_name as floorName,fl.level_code as floorLevelCode,
              sp.display_name as spaceName,fr.editorial_status as editorialStatus
         from facility_instances f
         join facility_types t on t.id=f.facility_type_id
         left join facility_revisions fr on fr.id=coalesce(
           f.current_revision_id,
           (select fr2.id from facility_revisions fr2 where fr2.facility_id=f.id order by fr2.revision_no desc limit 1)
         )
         left join places pl on pl.id=f.host_place_id
         left join place_revisions pr on pr.id=pl.current_revision_id
         left join floors fl on fl.id=f.floor_id
         left join indoor_spaces sp on sp.id=f.indoor_space_id
        order by t.name,placeName,fl.level_order,displayName`,
    ),
  ]);

  return json({
    items: types.map((type) => ({
      ...type,
      instances: instances.filter((instance) => instance.facilityTypeId === type.id),
    })),
    iconKeys: SUPPORTED_ICON_KEYS,
    categories: CATEGORIES,
  });
}

/** GET /api/public/facility-types —— 采集表单等公开界面用的轻量类型表，只回启用中的。 */
export async function listPublicFacilityTypes(env: Env): Promise<Response> {
  const items = await all<{ code: string; name: string; iconKey: string | null }>(
    env.DB,
    `select code,name,icon_key as iconKey from facility_types
      where status='active' order by category,name`,
  );
  return json({ items }, { headers: { "cache-control": "public, max-age=300, stale-while-revalidate=600" } });
}

export async function createFacilityType(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  requestId: string,
): Promise<Response> {
  const body = await readJson<WriteBody>(request);
  const code = requiredString(body.code, "code", 50).toLowerCase();
  if (!CODE_PATTERN.test(code)) {
    throw new HttpError(400, "invalid_code", "code must be lowercase letters, digits and underscores, starting with a letter");
  }
  const name = requiredString(body.name, "name", 50);
  const category = body.category === undefined || body.category === null || body.category === ""
    ? "other"
    : oneOf(body.category, "category", CATEGORIES);
  const iconKey = normalizeIconKey(body.iconKey);
  const verificationIntervalDays = normalizeInterval(body.verificationIntervalDays);

  const existing = await first<{ id: string }>(env.DB, "select id from facility_types where code=?", [code]);
  if (existing) throw new HttpError(409, "code_taken", "A facility type with this code already exists");

  const id = makeId("facility_type");
  const now = isoNow();
  await env.DB.prepare(
    `insert into facility_types(id,code,name,category,icon_key,visibility_policy_json,verification_interval_days,status,created_at,updated_at)
     values(?,?,?,?,?,?,?,'active',?,?)`,
  ).bind(id, code, name, category, iconKey, JSON.stringify(DEFAULT_VISIBILITY_POLICY), verificationIntervalDays, now, now).run();
  invalidateActiveCodeCache();

  await audit(env, principal, "facility_type.create", "facility_type", id, requestId, null, {
    code, name, category, iconKey, verificationIntervalDays,
  });
  return json({ id, code, name, category, iconKey, status: "active", verificationIntervalDays, instanceCount: 0 }, { status: 201 });
}

/**
 * PATCH /api/admin/facility-types/:id
 *
 * code 不可改：它是 release manifest、采集草稿与前端图标表共同依赖的稳定键，
 * 改掉会让既有数据对不上。要换编码就新建一个类型再把旧的停用。
 */
export async function updateFacilityType(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  id: string,
  requestId: string,
): Promise<Response> {
  const current = await first<{ id: string; code: string; name: string; category: string; icon_key: string | null; status: string; verification_interval_days: number | null }>(
    env.DB,
    "select id,code,name,category,icon_key,status,verification_interval_days from facility_types where id=?",
    [id],
  );
  if (!current) throw new HttpError(404, "not_found", "Facility type does not exist");

  const body = await readJson<WriteBody>(request);
  if (body.code !== undefined && String(body.code).toLowerCase() !== current.code) {
    throw new HttpError(409, "code_immutable", "The code of an existing facility type cannot be changed");
  }
  const name = body.name === undefined ? null : requiredString(body.name, "name", 50);
  const category = body.category === undefined ? null : oneOf(body.category, "category", CATEGORIES);
  const iconKey = body.iconKey === undefined ? undefined : normalizeIconKey(body.iconKey);
  const status = body.status === undefined ? null : oneOf<FacilityTypeStatus>(body.status, "status", STATUSES);
  const verificationIntervalDays = body.verificationIntervalDays === undefined ? undefined : normalizeInterval(body.verificationIntervalDays);

  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (name !== null) { sets.push("name=?"); values.push(name); }
  if (category !== null) { sets.push("category=?"); values.push(category); }
  if (iconKey !== undefined) { sets.push("icon_key=?"); values.push(iconKey); }
  if (status !== null) { sets.push("status=?"); values.push(status); }
  if (verificationIntervalDays !== undefined) { sets.push("verification_interval_days=?"); values.push(verificationIntervalDays); }
  if (!sets.length) throw new HttpError(400, "validation_error", "Nothing to update");

  const now = isoNow();
  sets.push("updated_at=?");
  values.push(now, id);
  await env.DB.prepare(`update facility_types set ${sets.join(",")} where id=?`).bind(...values).run();
  invalidateActiveCodeCache();

  await audit(
    env, principal, "facility_type.update", "facility_type", id, requestId,
    { name: current.name, category: current.category, iconKey: current.icon_key, status: current.status, verificationIntervalDays: current.verification_interval_days },
    {
      name: name ?? current.name,
      category: category ?? current.category,
      iconKey: iconKey === undefined ? current.icon_key : iconKey,
      status: status ?? current.status,
      verificationIntervalDays: verificationIntervalDays === undefined ? current.verification_interval_days : verificationIntervalDays,
    },
  );

  const count = await instanceCount(env, id);
  return json({
    id,
    code: current.code,
    name: name ?? current.name,
    category: category ?? current.category,
    iconKey: iconKey === undefined ? current.icon_key : iconKey,
    status: status ?? current.status,
    verificationIntervalDays: verificationIntervalDays === undefined ? current.verification_interval_days : verificationIntervalDays,
    instanceCount: count,
  });
}

/** DELETE /api/admin/facility-types/:id —— 仅无实例引用时物理删除，否则要求改为停用。 */
export async function deleteFacilityType(
  env: Env,
  principal: SessionPrincipal,
  id: string,
  requestId: string,
): Promise<Response> {
  const current = await first<{ id: string; code: string; name: string; status: string }>(
    env.DB,
    "select id,code,name,status from facility_types where id=?",
    [id],
  );
  if (!current) throw new HttpError(404, "not_found", "Facility type does not exist");
  const count = await instanceCount(env, id);
  if (count > 0) {
    throw new HttpError(409, "facility_type_in_use", `This facility type is still used by ${count} facilities; disable it instead`);
  }
  await env.DB.prepare("delete from facility_types where id=?").bind(id).run();
  invalidateActiveCodeCache();
  await audit(env, principal, "facility_type.delete", "facility_type", id, requestId, current, null);
  return json({ id, deleted: true });
}

async function instanceCount(env: Env, id: string): Promise<number> {
  const row = await first<{ count: number }>(env.DB, "select count(*) as count from facility_instances where facility_type_id=?", [id]);
  return row?.count ?? 0;
}

function normalizeIconKey(value: unknown): string | null {
  const raw = optionalString(value, "iconKey", 50);
  if (raw === null) return null;
  if (!(SUPPORTED_ICON_KEYS as readonly string[]).includes(raw)) {
    throw new HttpError(400, "unsupported_icon_key", `iconKey must be one of: ${SUPPORTED_ICON_KEYS.join(", ")}`);
  }
  return raw;
}

function normalizeInterval(value: unknown): number | null {
  const days = optionalNumber(value, "verificationIntervalDays");
  if (days === null) return null;
  if (!Number.isInteger(days) || days <= 0 || days > 3650) {
    throw new HttpError(400, "validation_error", "verificationIntervalDays must be an integer between 1 and 3650");
  }
  return days;
}

// ---------------------------------------------------------------------------
// 启用中的类型编码集合。采集提交的白名单校验每次请求都要用一次，
// 用 30 秒的进程内缓存挡掉重复查询；改动类型时立即失效。
// ---------------------------------------------------------------------------

const CODE_CACHE_TTL_MS = 30_000;
let codeCache: { codes: Set<string>; expiresAt: number } | null = null;

export function invalidateActiveCodeCache(): void {
  codeCache = null;
}

export async function activeFacilityTypeCodes(env: Env): Promise<Set<string>> {
  const now = Date.now();
  if (codeCache && codeCache.expiresAt > now) return codeCache.codes;
  const rows = await all<{ code: string }>(env.DB, "select code from facility_types where status='active'");
  const codes = new Set(rows.map((row) => row.code));
  codeCache = { codes, expiresAt: now + CODE_CACHE_TTL_MS };
  return codes;
}
