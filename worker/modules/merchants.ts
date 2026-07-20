import type { LocationInput, SessionPrincipal } from "../domain/types";
import type { Env } from "../types/cloudflare";
import { all, assertExists, first } from "../lib/db";
import { HttpError, json, readJson } from "../lib/http";
import { isoNow, jsonString, makeId, objectValue, optionalString, requiredString, sha256 } from "../lib/values";
import { audit } from "./audit";
import { createLocation } from "./locations";

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
    `select m.*,r.display_name,r.business_type,r.opening_hours_json,r.contact_json,r.content_json,r.source_id,r.editorial_status
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
    all(
      env.DB,
      `select el.id as bindingId,el.role,el.is_primary as isPrimary,la.* from entity_locations el
       join location_anchors la on la.id=el.anchor_id where el.entity_type='merchant_outlet' and el.entity_id=? and el.valid_to is null`,
      [id],
    ),
  ]);
  return json({ merchant, revisions, locations });
}

export async function createMerchant(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  requestId: string,
): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request);
  const organizationId = optionalString(body.organizationId, "organizationId", 100);
  const hostPlaceId = optionalString(body.hostPlaceId, "hostPlaceId", 100);
  const floorId = optionalString(body.floorId, "floorId", 100);
  const indoorSpaceId = optionalString(body.indoorSpaceId, "indoorSpaceId", 100);
  const sourceId = optionalString(body.sourceId, "sourceId", 100);
  await Promise.all([
    assertExists(env.DB, "organizations", organizationId, "Organization"), assertExists(env.DB, "places", hostPlaceId, "Host place"),
    assertExists(env.DB, "floors", floorId, "Floor"), assertExists(env.DB, "indoor_spaces", indoorSpaceId, "Indoor space"),
    assertExists(env.DB, "data_sources", sourceId, "Data source"),
  ]);
  if (floorId && hostPlaceId) {
    const floor = await first<{ building_place_id: string }>(env.DB, "select building_place_id from floors where id=?", [floorId]);
    if (floor?.building_place_id !== hostPlaceId) throw new HttpError(400, "invalid_spatial_hierarchy", "Floor does not belong to host place");
  }
  const id = makeId("merchant");
  const revisionId = makeId("mrev");
  const now = isoNow();
  const displayName = requiredString(body.displayName, "displayName", 200);
  const content = objectValue(body.content, "content");
  const openingHours = body.openingHours === undefined ? null : jsonString(body.openingHours);
  const contact = body.contact === undefined ? null : jsonString(body.contact);
  const contentJson = jsonString(content);
  const contentHash = await sha256(`${displayName}\n${openingHours ?? ""}\n${contact ?? ""}\n${contentJson}`);
  await env.DB.batch([
    env.DB.prepare(`insert into merchant_outlets(id,organization_id,host_place_id,floor_id,indoor_space_id,lifecycle_status,created_at,updated_at)
      values(?,?,?,?,?,'active',?,?)`).bind(id, organizationId, hostPlaceId, floorId, indoorSpaceId, now, now),
    env.DB.prepare(`insert into merchant_revisions(id,outlet_id,revision_no,editorial_status,display_name,business_type,opening_hours_json,contact_json,content_json,source_id,content_hash,created_by,created_at)
      values(?,?,1,'draft',?,?,?,?,?,?,?,?,?)`).bind(revisionId, id, displayName, optionalString(body.businessType, "businessType", 100), openingHours, contact, contentJson, sourceId, contentHash, principal.userId, now),
  ]);
  const locations = Array.isArray(body.locations) ? body.locations : [];
  for (const [index, raw] of locations.entries()) await createLocation(env, "merchant_outlet", id, raw as LocationInput, principal, index === 0);
  await audit(env, principal, "merchant.create", "merchant_outlet", id, requestId, null, body);
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
  const body = await readJson<Record<string, unknown>>(request);
  const displayName = requiredString(body.displayName, "displayName", 200);
  const contentJson = jsonString(objectValue(body.content, "content"));
  const openingHours = body.openingHours === undefined ? null : jsonString(body.openingHours);
  const contact = body.contact === undefined ? null : jsonString(body.contact);
  const contentHash = await sha256(`${displayName}\n${openingHours ?? ""}\n${contact ?? ""}\n${contentJson}`);
  const next = await first<{ next_no: number }>(env.DB, "select coalesce(max(revision_no),0)+1 as next_no from merchant_revisions where outlet_id=?", [outletId]);
  const revisionId = pending?.id ?? makeId("mrev");
  const now = isoNow();
  await env.DB.batch([
    pending
      ? env.DB.prepare(`update merchant_revisions set display_name=?,business_type=?,opening_hours_json=?,contact_json=?,content_json=?,source_id=?,content_hash=?,created_by=?,created_at=?
          where id=? and editorial_status='draft'`).bind(displayName, optionalString(body.businessType, "businessType", 100), openingHours, contact, contentJson, optionalString(body.sourceId, "sourceId", 100), contentHash, principal.userId, now, revisionId)
      : env.DB.prepare(`insert into merchant_revisions(id,outlet_id,revision_no,editorial_status,display_name,business_type,opening_hours_json,contact_json,content_json,source_id,content_hash,created_by,created_at)
          values(?,?,?,'draft',?,?,?,?,?,?,?,?,?)`).bind(revisionId, outletId, next?.next_no ?? 1, displayName, optionalString(body.businessType, "businessType", 100), openingHours, contact, contentJson, optionalString(body.sourceId, "sourceId", 100), contentHash, principal.userId, now),
    env.DB.prepare("update merchant_outlets set updated_at=? where id=?").bind(now, outletId),
  ]);
  await audit(env, principal, "merchant.revision.create", "merchant_revision", revisionId, requestId, null, body);
  return json({ id: revisionId, outletId, revisionNo: pending?.revision_no ?? next?.next_no ?? 1, editorialStatus: "draft" }, { status: pending ? 200 : 201 });
}
