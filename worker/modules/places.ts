import type { SessionPrincipal } from "../domain/types";
import type { PlaceRevisionWrite } from "../../shared/revision-contract";
import type { Env } from "../types/cloudflare";
import { all, first } from "../lib/db";
import { HttpError, json, readJson } from "../lib/http";
import { isoNow, jsonString, makeId, sha256 } from "../lib/values";
import { normalizePlaceRevision, validatePlaceRevision } from "../lib/revision-contracts";
import { audit } from "./audit";
import { listEntityLocations } from "./locations";

function bindNewBuildingLocations(locations: PlaceRevisionWrite["structure"]["locations"], placeId: string) {
  return locations.map((location) => ({ ...location, buildingPlaceId: placeId }));
}

export async function listPlaces(env: Env): Promise<Response> {
  const rows = await all<Record<string, unknown>>(
    env.DB,
    `select p.id,p.kind_id as kindId,pk.name as kindName,p.campus_id as campusId,p.parent_place_id as parentPlaceId,p.stable_code as stableCode,
            p.lifecycle_status as lifecycleStatus,r.id as currentRevisionId,
            r.display_name as displayName,r.summary,r.editorial_status as editorialStatus,p.updated_at as updatedAt,
            case when b.place_id is null then 0 else 1 end as isBuilding
       from places p join place_kinds pk on pk.id=p.kind_id left join buildings b on b.place_id=p.id
       left join place_revisions r on r.id=coalesce(
         (select pending.id from place_revisions pending
           where pending.place_id=p.id and pending.editorial_status in ('draft','in_review')
           order by case pending.editorial_status when 'in_review' then 0 else 1 end,pending.revision_no desc limit 1),
         p.current_revision_id
       )
      order by coalesce(r.display_name,p.id)`,
  );
  return json({ items: rows.map((row) => ({ ...row, isBuilding: Number(row.isBuilding) === 1 })) });
}

export async function getPlace(env: Env, id: string): Promise<Response> {
  const place = await first<Record<string, unknown>>(
    env.DB,
    `select p.*,pk.name as kindName,b.building_code,b.managing_organization_id,b.public_access_level,
            case when b.place_id is null then 0 else 1 end as isBuilding,
            r.display_name,r.summary,r.description,r.content_json,r.structure_json,r.source_id,r.editorial_status
       from places p join place_kinds pk on pk.id=p.kind_id left join buildings b on b.place_id=p.id
       left join place_revisions r on r.id=coalesce(
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
    listEntityLocations(env, "place", id),
    all(
      env.DB,
      `select id,building_place_id as buildingPlaceId,level_code as levelCode,level_order as levelOrder,
              display_name as displayName,is_public as isPublic,lifecycle_status as lifecycleStatus
         from floors where building_place_id=? order by level_order`,
      [id],
    ),
  ]);
  return json({ place: { ...place, isBuilding: Number(place.isBuilding) === 1 }, revisions, names, locations, floors });
}

export async function createPlaceHandler(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  requestId: string,
): Promise<Response> {
  const revision = normalizePlaceRevision(await readJson<unknown>(request));
  await validatePlaceRevision(env, revision, null);
  const { kindId, campusId, parentPlaceId, stableCode, aliases, building, locations } = revision.structure;

  const placeId = makeId("place");
  const revisionId = makeId("prev");
  const now = isoNow();
  const storedLocations = building ? bindNewBuildingLocations(locations, placeId) : locations;
  const contentJson = jsonString(revision.content);
  const structureJson = jsonString({ kindId, campusId, parentPlaceId, stableCode, aliases, building, locations: storedLocations });
  const contentHash = await sha256(`${revision.displayName}\n${revision.summary ?? ""}\n${revision.description ?? ""}\n${contentJson}\n${structureJson}`);
  const normalizedName = normalizeSearchText(revision.displayName);
  const statements = [
    env.DB.prepare(
      `insert into places(id,kind_id,campus_id,parent_place_id,stable_code,lifecycle_status,approval_pending,created_at,updated_at)
       values(?,?,?,?,?,'planned',1,?,?)`,
    ).bind(placeId, kindId, campusId, parentPlaceId, stableCode, now, now),
    env.DB.prepare(
      `insert into place_revisions(id,place_id,revision_no,editorial_status,display_name,summary,description,content_json,structure_json,source_id,content_hash,created_by,created_at)
       values(?,?,1,'draft',?,?,?,?,?,?,?,?,?)`,
    ).bind(revisionId, placeId, revision.displayName, revision.summary, revision.description, contentJson, structureJson, revision.sourceId, contentHash, principal.userId, now),
    env.DB.prepare(
      `insert into place_names(id,place_id,language,name,normalized_name,name_type,is_searchable) values(?,?,'zh-CN',?,?,'primary',1)`,
    ).bind(makeId("pname"), placeId, revision.displayName, normalizedName),
  ];

  for (const name of aliases) {
    statements.push(env.DB.prepare(
      `insert into place_names(id,place_id,language,name,normalized_name,name_type,is_searchable) values(?,?,'zh-CN',?,?,'alias',1)`,
    ).bind(makeId("pname"), placeId, name, normalizeSearchText(name)));
  }
  if (building) statements.push(env.DB.prepare(
    "insert into buildings(place_id,building_code,managing_organization_id,public_access_level) values(?,?,?,?)",
  ).bind(placeId, building.buildingCode, building.managingOrganizationId, building.publicAccessLevel));

  await env.DB.batch(statements);
  await audit(env, principal, "place.create", "place", placeId, requestId, null, { ...revision, revisionId });
  return json({ id: placeId, revisionId, editorialStatus: "draft" }, { status: 201 });
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
  const input = normalizePlaceRevision(await readJson<unknown>(request));
  await validatePlaceRevision(env, input, placeId);
  const number = await first<{ next_no: number }>(env.DB, "select coalesce(max(revision_no),0)+1 as next_no from place_revisions where place_id=?", [placeId]);
  if (!number) throw new Error("Could not allocate a place revision number");
  const revisionId = pending?.id ?? makeId("prev");
  const now = isoNow();
  const contentJson = jsonString(input.content);
  const structureJson = jsonString(input.structure);
  const contentHash = await sha256(`${input.displayName}\n${input.summary ?? ""}\n${input.description ?? ""}\n${contentJson}\n${structureJson}`);
  await env.DB.batch([
    pending
      ? env.DB.prepare(
        `update place_revisions set display_name=?,summary=?,description=?,content_json=?,structure_json=?,source_id=?,content_hash=?,created_by=?,created_at=?
          where id=? and editorial_status='draft'`,
      ).bind(input.displayName, input.summary ?? null, input.description ?? null, contentJson, structureJson, input.sourceId ?? null, contentHash, principal.userId, now, revisionId)
      : env.DB.prepare(
        `insert into place_revisions(id,place_id,revision_no,editorial_status,display_name,summary,description,content_json,structure_json,source_id,based_on_revision_id,content_hash,created_by,created_at)
         values(?,?,?,'draft',?,?,?,?,?,?,?,?,?,?)`,
      ).bind(revisionId, placeId, number.next_no, input.displayName, input.summary, input.description, contentJson, structureJson, input.sourceId, place.current_revision_id, contentHash, principal.userId, now),
    env.DB.prepare("update places set updated_at=? where id=?").bind(now, placeId),
  ]);
  await audit(env, principal, "place.revision.create", "place_revision", revisionId, requestId, null, input);
  return json({ id: revisionId, placeId, revisionNo: pending?.revision_no ?? number.next_no, editorialStatus: "draft" }, { status: pending ? 200 : 201 });
}

export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}
