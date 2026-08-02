import type { SessionPrincipal } from "../domain/types";
import type { Env } from "../types/cloudflare";
import { all, first } from "../lib/db";
import { HttpError, json, readJson } from "../lib/http";
import { isoNow, jsonString, makeId, sha256 } from "../lib/values";
import { normalizeMerchantRevision, validateMerchantRevision } from "../lib/revision-contracts";
import { audit } from "./audit";
import { listEntityLocations } from "./locations";

export async function listMerchants(env: Env): Promise<Response> {
  const items = await all(
    env.DB,
    `select m.id,m.organization_id as organizationId,m.host_place_id as hostPlaceId,m.floor_id as floorId,m.indoor_space_id as indoorSpaceId,
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
  const { organizationId, hostPlaceId, floorId, indoorSpaceId, locations } = revision.structure;
  const id = makeId("merchant");
  const revisionId = makeId("mrev");
  const now = isoNow();
  const openingHours = revision.openingHours === null ? null : jsonString(revision.openingHours);
  const contact = revision.contact === null ? null : jsonString(revision.contact);
  const contentJson = jsonString(revision.content);
  const structureJson = jsonString({ organizationId, hostPlaceId, floorId, indoorSpaceId, locations });
  const contentHash = await sha256(`${revision.displayName}\n${openingHours ?? ""}\n${contact ?? ""}\n${contentJson}\n${structureJson}`);
  await env.DB.batch([
    env.DB.prepare(`insert into merchant_outlets(id,organization_id,host_place_id,floor_id,indoor_space_id,lifecycle_status,approval_pending,created_at,updated_at)
      values(?,?,?,?,?,'planned',1,?,?)`).bind(id, organizationId, hostPlaceId, floorId, indoorSpaceId, now, now),
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
