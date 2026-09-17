import type { SessionPrincipal } from "../domain/types";
import type { Env } from "../types/cloudflare";
import { all, first } from "../lib/db";
import { HttpError, json, readJson } from "../lib/http";
import { exactObject, isoNow, jsonString, makeId, oneOf, sha256 } from "../lib/values";
import { normalizeMerchantRevision, validateMerchantRevision } from "../lib/revision-contracts";
import { audit } from "./audit";
import { listEntityLocations } from "./locations";

export async function listMerchants(env: Env): Promise<Response> {
  const items = await all(
    env.DB,
    `select m.id,m.organization_id as organizationId,m.host_place_id as hostPlaceId,m.floor_id as floorId,
            m.lifecycle_status as lifecycleStatus,r.id as currentRevisionId,r.display_name as displayName,r.business_type as businessType,
            r.editorial_status as editorialStatus,m.created_at as createdAt,m.updated_at as updatedAt
       from merchant_outlets m left join merchant_revisions r on r.id=coalesce(
         (select pending.id from merchant_revisions pending
           where pending.outlet_id=m.id and pending.editorial_status in ('draft','in_review')
           order by case pending.editorial_status when 'in_review' then 0 else 1 end,pending.revision_no desc limit 1),
         m.current_revision_id
       ) order by coalesce(r.display_name,m.id)`,
  );
  return json({ items });
}

export async function getMerchant(env: Env, id: string): Promise<Response> {
  const merchant = await first<Record<string, unknown>>(
    env.DB,
    `select m.*,r.display_name,r.business_type,r.opening_hours_json,r.contact_json,r.content_json,r.structure_json,r.source_id,r.editorial_status
       from merchant_outlets m left join merchant_revisions r on r.id=coalesce(
         (select pending.id from merchant_revisions pending
           where pending.outlet_id=m.id and pending.editorial_status in ('draft','in_review')
           order by case pending.editorial_status when 'in_review' then 0 else 1 end,pending.revision_no desc limit 1),
         m.current_revision_id
       ) where m.id=?`,
    [id],
  );
  if (!merchant) throw new HttpError(404, "not_found", "Merchant outlet does not exist");
  const [revisions, locations] = await Promise.all([
    all(env.DB, "select * from merchant_revisions where outlet_id=? order by revision_no desc", [id]),
    listEntityLocations(env, "merchant_outlet", id),
  ]);
  return json({ merchant, revisions, locations });
}

export async function createMerchant(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  requestId: string,
): Promise<Response> {
  const revision = normalizeMerchantRevision(await readJson<unknown>(request));
  await validateMerchantRevision(env, revision);
  const { organizationId, hostPlaceId, floorId, locations } = revision.structure;
  const id = makeId("merchant");
  const revisionId = makeId("mrev");
  const now = isoNow();
  const openingHours = revision.openingHours === null ? null : jsonString(revision.openingHours);
  const contact = revision.contact === null ? null : jsonString(revision.contact);
  const contentJson = jsonString(revision.content);
  const structureJson = jsonString({ organizationId, hostPlaceId, floorId, locations });
  const contentHash = await sha256(`${revision.displayName}\n${openingHours ?? ""}\n${contact ?? ""}\n${contentJson}\n${structureJson}`);
  await env.DB.batch([
    env.DB.prepare(`insert into merchant_outlets(id,organization_id,host_place_id,floor_id,lifecycle_status,approval_pending,created_at,updated_at)
      values(?,?,?,?,'planned',1,?,?)`).bind(id, organizationId, hostPlaceId, floorId, now, now),
    env.DB.prepare(`insert into merchant_revisions(id,outlet_id,revision_no,editorial_status,display_name,business_type,opening_hours_json,contact_json,content_json,structure_json,source_id,content_hash,created_by,created_at)
      values(?,?,1,'draft',?,?,?,?,?,?,?,?,?,?)`).bind(revisionId, id, revision.displayName, revision.businessType, openingHours, contact, contentJson, structureJson, revision.sourceId, contentHash, principal.userId, now),
  ]);
  await audit(env, principal, "merchant.create", "merchant_outlet", id, requestId, null, { ...revision, revisionId });
  return json({ id, revisionId, editorialStatus: "draft" }, { status: 201 });
}

export async function createMerchantRevision(request: Request, env: Env, principal: SessionPrincipal, outletId: string, requestId: string): Promise<Response> {
  const outlet = await first<{ id: string; current_revision_id: string | null }>(env.DB, "select id,current_revision_id from merchant_outlets where id=?", [outletId]);
  if (!outlet) throw new HttpError(404, "not_found", "Merchant outlet does not exist");
  const pending = await first<{ id: string; editorial_status: string; revision_no: number }>(
    env.DB,
    `select id,editorial_status,revision_no from merchant_revisions
      where outlet_id=? and editorial_status in ('draft','in_review')
      order by case editorial_status when 'in_review' then 0 else 1 end,revision_no desc limit 1`,
    [outletId],
  );
  if (pending?.editorial_status === "in_review") {
    throw new HttpError(409, "revision_in_review", "This merchant already has a revision in review");
  }
  const revision = normalizeMerchantRevision(await readJson<unknown>(request));
  await validateMerchantRevision(env, revision);
  const contentJson = jsonString(revision.content);
  const structureJson = jsonString(revision.structure);
  const openingHours = revision.openingHours === null ? null : jsonString(revision.openingHours);
  const contact = revision.contact === null ? null : jsonString(revision.contact);
  const contentHash = await sha256(`${revision.displayName}\n${openingHours ?? ""}\n${contact ?? ""}\n${contentJson}\n${structureJson}`);
  const next = await first<{ next_no: number }>(env.DB, "select coalesce(max(revision_no),0)+1 as next_no from merchant_revisions where outlet_id=?", [outletId]);
  if (!next) throw new Error("Could not allocate a merchant revision number");
  const revisionId = pending?.id ?? makeId("mrev");
  const now = isoNow();
  await env.DB.batch([
    pending
      ? env.DB.prepare(`update merchant_revisions set display_name=?,business_type=?,opening_hours_json=?,contact_json=?,content_json=?,structure_json=?,source_id=?,content_hash=?,created_by=?,created_at=?
          where id=? and editorial_status='draft'`).bind(revision.displayName, revision.businessType, openingHours, contact, contentJson, structureJson, revision.sourceId, contentHash, principal.userId, now, revisionId)
      : env.DB.prepare(`insert into merchant_revisions(id,outlet_id,revision_no,editorial_status,display_name,business_type,opening_hours_json,contact_json,content_json,structure_json,source_id,content_hash,created_by,created_at)
          values(?,?,?,'draft',?,?,?,?,?,?,?,?,?,?)`).bind(revisionId, outletId, next.next_no, revision.displayName, revision.businessType, openingHours, contact, contentJson, structureJson, revision.sourceId, contentHash, principal.userId, now),
    env.DB.prepare("update merchant_outlets set updated_at=? where id=?").bind(now, outletId),
  ]);
  await audit(env, principal, "merchant.revision.create", "merchant_revision", revisionId, requestId, null, revision);
  return json({ id: revisionId, outletId, revisionNo: pending?.revision_no ?? next.next_no, editorialStatus: "draft" }, { status: pending ? 200 : 201 });
}

const LIFECYCLE_STATUSES = ["planned", "active", "temporarily_closed", "retired"] as const;

/**
 * PATCH /api/admin/merchants/:id/lifecycle —— 开业 / 暂停营业 / 关店。
 *
 * 生命周期不进修订流：它描述的是门店此刻在不在营业，改动即时生效。门店的名称、
 * 品类等内容仍然只能通过修订改。retired 之外的取值会触发 map filter 归属校验
 * （见 0012_map_filter_integrity.sql 的 require_merchant_active_map_filter_update）。
 */
export async function updateMerchantLifecycle(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  outletId: string,
  requestId: string,
): Promise<Response> {
  const before = await first<{ id: string; lifecycle_status: string }>(
    env.DB,
    "select id,lifecycle_status from merchant_outlets where id=?",
    [outletId],
  );
  if (!before) throw new HttpError(404, "not_found", "Merchant outlet does not exist");
  const body = exactObject(await readJson<unknown>(request), "merchantLifecycle", ["lifecycleStatus"]);
  const lifecycleStatus = oneOf(body.lifecycleStatus, "lifecycleStatus", LIFECYCLE_STATUSES);
  // 从 retired 恢复前先确认商户筛选组仍有一个启用的：protect_used_* 只挡
  // 「未停用」的成员，停用期间筛选组允许被整体下线；不查的话 0012 的
  // require_merchant_active_map_filter_update 会把恢复打成没有说明的 500。
  // （与 places/facilities 的恢复预检同构；预检与更新不在一个事务里，
  // 窗口极小，最坏结果等于修复前的旧行为。）
  if (before.lifecycle_status === "retired" && lifecycleStatus !== "retired") {
    const activeFilter = await first<{ id: string }>(
      env.DB,
      `select m.id from map_filter_members m
         join map_filter_categories c on c.id=m.category_id and c.active=1
        where m.includes_merchants=1 limit 1`,
    );
    if (!activeFilter) {
      throw new HttpError(
        409,
        "merchant_filter_inactive",
        "The merchant map filter was deactivated while this outlet was retired; re-activate the filter first",
      );
    }
  }
  await env.DB.prepare("update merchant_outlets set lifecycle_status=?,updated_at=? where id=?")
    .bind(lifecycleStatus, isoNow(), outletId).run();
  await audit(env, principal, "merchant.lifecycle.update", "merchant_outlet", outletId, requestId, before, { lifecycleStatus });
  return json({ id: outletId, lifecycleStatus });
}
