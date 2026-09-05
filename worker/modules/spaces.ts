// ---------------------------------------------------------------------------
// 参考数据只读视图。
//
// 楼层本身的增删改与平面图图片在 floors.ts。indoor_spaces 表已由 0034 删除
// （0032 起楼内平面图改为每层一张图片），这里不再返回 spaces 列表。
// ---------------------------------------------------------------------------
import type { SessionPrincipal } from "../domain/types";
import type { Env } from "../types/cloudflare";
import { all, assertExists } from "../lib/db";
import { json, readJson } from "../lib/http";
import {
  exactObject,
  isoNow,
  jsonString,
  makeId,
  objectValue,
  oneOf,
  optionalString,
  requiredString,
} from "../lib/values";
import { audit } from "./audit";

const SOURCE_TYPES = ["official", "survey", "import", "community", "derived"] as const;
const SOURCE_RELIABILITIES = ["authoritative", "reviewed", "unverified", "unknown"] as const;

export async function listCampusesAndSpaces(env: Env): Promise<Response> {
  const [campuses, buildings, floors] = await Promise.all([
    all(env.DB, "select id,code,name,timezone,status from campuses order by name"),
    all(env.DB, `select b.place_id as placeId,b.building_code as buildingCode,b.managing_organization_id as managingOrganizationId,
      b.public_access_level as publicAccessLevel,r.display_name as displayName,p.campus_id as campusId
      from buildings b join places p on p.id=b.place_id left join place_revisions r on r.id=p.current_revision_id order by r.display_name`),
    all(env.DB, "select id,building_place_id as buildingPlaceId,level_code as levelCode,level_order as levelOrder,display_name as displayName,is_public as isPublic,lifecycle_status as lifecycleStatus from floors order by building_place_id,level_order"),
  ]);
  return json({ campuses, buildings, floors });
}

export async function createDataSource(request: Request, env: Env, principal: SessionPrincipal, requestId: string): Promise<Response> {
  const body = exactObject(await readJson<unknown>(request), "dataSource", [
    "sourceType",
    "title",
    "organizationId",
    "url",
    "license",
    "obtainedAt",
    "reliability",
    "metadata",
  ]);
  const sourceType = oneOf(body.sourceType, "sourceType", SOURCE_TYPES);
  const organizationId = optionalString(body.organizationId, "organizationId", 100);
  await assertExists(env.DB, "organizations", organizationId, "Organization");
  const reliability = oneOf(body.reliability, "reliability", SOURCE_RELIABILITIES);
  const metadataJson = jsonString(objectValue(body.metadata, "metadata"));
  const id = makeId("source");
  await env.DB.prepare(
    `insert into data_sources(id,source_type,title,organization_id,url,license,obtained_at,reliability,metadata_json,created_at)
     values(?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    id,
    sourceType,
    requiredString(body.title, "title", 300),
    organizationId,
    optionalString(body.url, "url", 1000),
    optionalString(body.license, "license", 200),
    optionalString(body.obtainedAt, "obtainedAt", 50),
    reliability,
    metadataJson,
    isoNow(),
  ).run();
  await audit(env, principal, "data_source.create", "data_source", id, requestId, null, body);
  return json({ id }, { status: 201 });
}

export async function listReferenceData(env: Env): Promise<Response> {
  const [organizations, sources, facilityTypes, placeKinds] = await Promise.all([
    all(env.DB, "select * from organizations where status='active' order by name"),
    all(env.DB, "select * from data_sources order by created_at desc"),
    all(env.DB, "select * from facility_types where status='active' order by category,name"),
    all(env.DB, "select * from place_kinds order by sort_order"),
  ]);
  return json({ organizations, sources, facilityTypes, placeKinds });
}
