import type { LocationInput, PlaceRevisionInput, SessionPrincipal } from "../domain/types";
import type { Env } from "../types/cloudflare";
import { all, assertExists, first } from "../lib/db";
import { HttpError, json, readJson } from "../lib/http";
import { isoNow, jsonString, makeId, objectValue, optionalString, requiredString, sha256 } from "../lib/values";
import { audit } from "./audit";
import { createLocation } from "./locations";

interface CreatePlaceBody extends PlaceRevisionInput {
  kindId: string;
  campusId?: string | null;
  parentPlaceId?: string | null;
  stableCode?: string | null;
  building?: { buildingCode?: string | null; managingOrganizationId?: string | null; publicAccessLevel?: string };
  aliases?: string[];
  locations?: Array<LocationInput & { isPrimary?: boolean }>;
}

export async function listPlaces(env: Env): Promise<Response> {
  const rows = await all<Record<string, unknown>>(
    env.DB,
    `select p.id,p.kind_id as kindId,p.campus_id as campusId,p.parent_place_id as parentPlaceId,p.stable_code as stableCode,
            p.lifecycle_status as lifecycleStatus,r.id as currentRevisionId,
            r.display_name as displayName,r.summary,r.editorial_status as editorialStatus,p.updated_at as updatedAt
       from places p left join place_revisions r on r.id=coalesce(
         (select pending.id from place_revisions pending
           where pending.place_id=p.id and pending.editorial_status in ('draft','in_review')
           order by case pending.editorial_status when 'in_review' then 0 else 1 end,pending.revision_no desc limit 1),
         p.current_revision_id
       )
      order by coalesce(r.display_name,p.id)`,
  );
  return json({ items: rows });
}

export async function getPlace(env: Env, id: string): Promise<Response> {
  const place = await first<Record<string, unknown>>(
    env.DB,
    `select p.*,b.building_code,r.display_name,r.summary,r.description,r.content_json,r.source_id,r.editorial_status
       from places p left join buildings b on b.place_id=p.id left join place_revisions r on r.id=coalesce(
         (select pending.id from place_revisions pending
           where pending.place_id=p.id and pending.editorial_status in ('draft','in_review')
           order by case pending.editorial_status when 'in_review' then 0 else 1 end,pending.revision_no desc limit 1),
         p.current_revision_id
       ) where p.id=?`,
    [id],
  );
  if (!place) throw new HttpError(404, "not_found", "Place does not exist");
  const [revisions, names, locations, floors] = await Promise.all([
    all(env.DB, "select * from place_revisions where place_id=? order by revision_no desc", [id]),
    all(env.DB, "select * from place_names where place_id=? order by name_type,name", [id]),
    all(
      env.DB,
      `select el.id as bindingId,el.role,el.is_primary as isPrimary,la.* from entity_locations el
       join location_anchors la on la.id=el.anchor_id where el.entity_type='place' and el.entity_id=? and el.valid_to is null`,
      [id],
    ),
    all(env.DB, "select * from floors where building_place_id=? order by level_order", [id]),
  ]);
  return json({ place, revisions, names, locations, floors });
}

export async function createPlaceHandler(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  requestId: string,
): Promise<Response> {
  const body = await readJson<CreatePlaceBody>(request);
  const kindId = requiredString(body.kindId, "kindId", 80);
  const campusId = optionalString(body.campusId, "campusId", 100);
  const parentPlaceId = optionalString(body.parentPlaceId, "parentPlaceId", 100);
  const stableCode = optionalString(body.stableCode, "stableCode", 100);
  const revisionInput = normalizeRevision(body);
  await Promise.all([
    assertExists(env.DB, "place_kinds", kindId, "Place kind"),
    assertExists(env.DB, "campuses", campusId, "Campus"),
    assertExists(env.DB, "places", parentPlaceId, "Parent place"),
  ]);

  const placeId = makeId("place");
  const revisionId = makeId("prev");
  const now = isoNow();
  const contentJson = jsonString(revisionInput.content);
  const contentHash = await sha256(`${revisionInput.displayName}\n${revisionInput.summary ?? ""}\n${revisionInput.description ?? ""}\n${contentJson}`);
  const normalizedName = normalizeSearchText(revisionInput.displayName);
  const statements = [
    env.DB.prepare(
      `insert into places(id,kind_id,campus_id,parent_place_id,stable_code,lifecycle_status,created_at,updated_at)
       values(?,?,?,?,?,'active',?,?)`,
    ).bind(placeId, kindId, campusId, parentPlaceId, stableCode, now, now),
    env.DB.prepare(
      `insert into place_revisions(id,place_id,revision_no,editorial_status,display_name,summary,description,content_json,source_id,content_hash,created_by,created_at)
       values(?,?,1,'draft',?,?,?,?,?,?,?,?)`,
    ).bind(revisionId, placeId, revisionInput.displayName, revisionInput.summary ?? null, revisionInput.description ?? null, contentJson, revisionInput.sourceId ?? null, contentHash, principal.userId, now),
    env.DB.prepare(
      `insert into place_names(id,place_id,language,name,normalized_name,name_type,is_searchable) values(?,?,'zh-CN',?,?,'primary',1)`,
    ).bind(makeId("pname"), placeId, revisionInput.displayName, normalizedName),
  ];

  for (const alias of body.aliases ?? []) {
    const name = requiredString(alias, "alias", 200);
    statements.push(env.DB.prepare(
      `insert into place_names(id,place_id,language,name,normalized_name,name_type,is_searchable) values(?,?,'zh-CN',?,?,'alias',1)`,
    ).bind(makeId("pname"), placeId, name, normalizeSearchText(name)));
  }
  if (kindId === "building") {
    const buildingCode = optionalString(body.building?.buildingCode, "building.buildingCode", 100);
    const organizationId = optionalString(body.building?.managingOrganizationId, "building.managingOrganizationId", 100);
    if (organizationId) await assertExists(env.DB, "organizations", organizationId, "Managing organization");
    const access = body.building?.publicAccessLevel ?? "unknown";
    if (!["public", "restricted", "private", "unknown"].includes(access)) throw new HttpError(400, "validation_error", "Invalid publicAccessLevel");
    statements.push(env.DB.prepare(
      "insert into buildings(place_id,building_code,managing_organization_id,public_access_level) values(?,?,?,?)",
    ).bind(placeId, buildingCode, organizationId, access));
  }

  await env.DB.batch(statements);
  for (const [index, location] of (body.locations ?? []).entries()) {
    await createLocation(env, "place", placeId, location, principal, location.isPrimary ?? index === 0);
  }
  await audit(env, principal, "place.create", "place", placeId, requestId, null, { ...body, revisionId });
  return json({ id: placeId, revisionId, editorialStatus: "draft" }, { status: 201 });
}

/**
 * PATCH /api/admin/places/:id — 结构字段直接生效，不走修订流。
 *
 * 设计边界：place_revisions 只承载 displayName/summary/description/content/sourceId
 * 这些「文案」字段，实体的骨架（所属类型、校区、稳定编码、楼栋编码、检索别名）
 * 没有任何列可以进修订表，因此无法用「提交草稿 → 审核 → 发布」承载。这些字段
 * 一律即时写库并记审计；正文改动仍旧只能经修订流。
 *
 * 别名走 place_names 的 replace 语义：删掉全部 name_type='alias' 行后按入参重建。
 * name_type='primary' 那行由 displayName 的既有机制维护，这里不碰。
 */
export async function updatePlaceHandler(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  placeId: string,
  requestId: string,
): Promise<Response> {
  const before = await first<Record<string, unknown>>(
    env.DB,
    `select p.id,p.kind_id,p.campus_id,p.stable_code,b.building_code
       from places p left join buildings b on b.place_id=p.id where p.id=?`,
    [placeId],
  );
  if (!before) throw new HttpError(404, "not_found", "Place does not exist");

  const body = await readJson<{
    kindId?: unknown;
    campusId?: unknown;
    stableCode?: unknown;
    buildingCode?: unknown;
    aliases?: unknown;
  }>(request);

  const kindId = body.kindId === undefined ? String(before.kind_id) : requiredString(body.kindId, "kindId", 80);
  const campusId = body.campusId === undefined
    ? (before.campus_id === null ? null : String(before.campus_id))
    : optionalString(body.campusId, "campusId", 100);
  const stableCode = body.stableCode === undefined
    ? (before.stable_code === null ? null : String(before.stable_code))
    : optionalString(body.stableCode, "stableCode", 100);
  await Promise.all([
    assertExists(env.DB, "place_kinds", kindId, "Place kind"),
    assertExists(env.DB, "campuses", campusId, "Campus"),
  ]);
  if (stableCode) {
    const clash = await first<{ id: string }>(
      env.DB,
      "select id from places where id<>? and stable_code=? and coalesce(campus_id,'')=coalesce(?,'')",
      [placeId, stableCode, campusId],
    );
    if (clash) throw new HttpError(409, "duplicate_stable_code", "Another place in this campus already uses this code");
  }

  const aliases: string[] | null = body.aliases === undefined
    ? null
    : (() => {
      if (!Array.isArray(body.aliases)) throw new HttpError(400, "validation_error", "aliases must be an array");
      const unique: string[] = [];
      for (const raw of body.aliases) {
        const name = requiredString(raw, "alias", 200);
        if (!unique.includes(name)) unique.push(name);
      }
      if (unique.length > 20) throw new HttpError(400, "validation_error", "At most 20 aliases per place");
      return unique;
    })();

  const now = isoNow();
  const statements = [
    env.DB.prepare("update places set kind_id=?,campus_id=?,stable_code=?,updated_at=? where id=?")
      .bind(kindId, campusId, stableCode, now, placeId),
  ];

  if (body.buildingCode !== undefined) {
    const buildingCode = optionalString(body.buildingCode, "buildingCode", 100);
    // buildings 是 places 的 1:1 扩展，且 floors 以 on delete cascade 挂在它上面。
    // 因此只补建不删除：类型改成非建筑时保留原行，避免连带删掉已采集的楼层。
    statements.push(
      env.DB.prepare("insert or ignore into buildings(place_id,building_code,public_access_level) values(?,?,'unknown')")
        .bind(placeId, buildingCode),
      env.DB.prepare("update buildings set building_code=? where place_id=?").bind(buildingCode, placeId),
    );
  } else if (kindId === "building") {
    statements.push(
      env.DB.prepare("insert or ignore into buildings(place_id,building_code,public_access_level) values(?,null,'unknown')")
        .bind(placeId),
    );
  }

  if (aliases) {
    statements.push(env.DB.prepare("delete from place_names where place_id=? and name_type='alias'").bind(placeId));
    for (const alias of aliases) {
      statements.push(env.DB.prepare(
        `insert into place_names(id,place_id,language,name,normalized_name,name_type,is_searchable) values(?,?,'zh-CN',?,?,'alias',1)`,
      ).bind(makeId("pname"), placeId, alias, normalizeSearchText(alias)));
    }
  }

  await env.DB.batch(statements);
  await audit(env, principal, "place.update", "place", placeId, requestId, before, {
    kindId, campusId, stableCode, buildingCode: body.buildingCode, aliases,
  });
  return json({ id: placeId, kindId, campusId, stableCode, aliases: aliases ?? undefined });
}

export async function createPlaceRevisionHandler(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  placeId: string,
  requestId: string,
): Promise<Response> {
  const place = await first<{ id: string; current_revision_id: string | null }>(env.DB, "select id,current_revision_id from places where id=?", [placeId]);
  if (!place) throw new HttpError(404, "not_found", "Place does not exist");
  const pending = await first<{ id: string; editorial_status: string; revision_no: number }>(
    env.DB,
    `select id,editorial_status,revision_no from place_revisions
      where place_id=? and editorial_status in ('draft','in_review')
      order by case editorial_status when 'in_review' then 0 else 1 end,revision_no desc limit 1`,
    [placeId],
  );
  if (pending?.editorial_status === "in_review") {
    throw new HttpError(409, "revision_in_review", "This place already has a revision in review");
  }
  const body = await readJson<PlaceRevisionInput>(request);
  const input = normalizeRevision(body);
  const number = await first<{ next_no: number }>(env.DB, "select coalesce(max(revision_no),0)+1 as next_no from place_revisions where place_id=?", [placeId]);
  const revisionId = pending?.id ?? makeId("prev");
  const now = isoNow();
  const contentJson = jsonString(input.content);
  const contentHash = await sha256(`${input.displayName}\n${input.summary ?? ""}\n${input.description ?? ""}\n${contentJson}`);
  await env.DB.batch([
    pending
      ? env.DB.prepare(
        `update place_revisions set display_name=?,summary=?,description=?,content_json=?,source_id=?,content_hash=?,created_by=?,created_at=?
          where id=? and editorial_status='draft'`,
      ).bind(input.displayName, input.summary ?? null, input.description ?? null, contentJson, input.sourceId ?? null, contentHash, principal.userId, now, revisionId)
      : env.DB.prepare(
        `insert into place_revisions(id,place_id,revision_no,editorial_status,display_name,summary,description,content_json,source_id,based_on_revision_id,content_hash,created_by,created_at)
         values(?,?,?,'draft',?,?,?,?,?,?,?,?,?)`,
      ).bind(revisionId, placeId, number?.next_no ?? 1, input.displayName, input.summary ?? null, input.description ?? null, contentJson, input.sourceId ?? null, place.current_revision_id, contentHash, principal.userId, now),
    env.DB.prepare("update places set updated_at=? where id=?").bind(now, placeId),
  ]);
  await audit(env, principal, "place.revision.create", "place_revision", revisionId, requestId, null, input);
  return json({ id: revisionId, placeId, revisionNo: pending?.revision_no ?? number?.next_no ?? 1, editorialStatus: "draft" }, { status: pending ? 200 : 201 });
}

function normalizeRevision(input: PlaceRevisionInput): Required<Pick<PlaceRevisionInput, "displayName">> & Omit<PlaceRevisionInput, "displayName"> {
  return {
    displayName: requiredString(input.displayName, "displayName", 200),
    summary: optionalString(input.summary, "summary", 500),
    description: optionalString(input.description, "description", 10_000),
    content: objectValue(input.content, "content"),
    sourceId: optionalString(input.sourceId, "sourceId", 100),
  };
}

export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}
