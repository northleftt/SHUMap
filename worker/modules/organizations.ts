import type { SessionPrincipal } from "../domain/types";
import type { Env } from "../types/cloudflare";
import { all, first } from "../lib/db";
import { HttpError, json, readJson } from "../lib/http";
import { exactObject, isoNow, makeId, oneOf, partialObject, requiredString } from "../lib/values";
import { audit } from "./audit";

// ---------------------------------------------------------------------------
// 品牌 / 机构维护。organizations 是引用表，商户的所属品牌、数据来源的提供方、
// 楼宇的管理单位、运营事件的责任方、校车线路的运营方都指向它，因此「不要这个
// 机构了」分成两步，与 facility-types 同构：
//
//   1. status='retired' —— 停用。既有引用照常，只是不再作为新建时的可选项。
//   2. DELETE —— 仅当五处引用全为零时允许，真正把行删掉。
//
// 五个外键都是 on delete set null，物理删除不会报错但会静默抹掉历史指向，
// 所以删除前必须自己数引用。
// ---------------------------------------------------------------------------

const STATUSES = ["active", "retired"] as const;
type OrganizationStatus = (typeof STATUSES)[number];

/** 可选的机构类型。中文名在 src/admin/pages/OrganizationsPage.tsx 的 KIND_LABELS。 */
export const KINDS = ["department", "school", "company", "vendor", "government", "operator", "other"] as const;

interface OrganizationRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  merchants: number;
  sources: number;
  events: number;
  buildings: number;
  transit: number;
}

interface OrganizationUsage {
  merchants: number;
  sources: number;
  events: number;
  buildings: number;
  transit: number;
}

const USAGE_SELECT = `(select count(*) from merchant_outlets m where m.organization_id=o.id) as merchants,
       (select count(*) from data_sources s where s.organization_id=o.id) as sources,
       (select count(*) from operational_events e where e.responsible_organization_id=o.id) as events,
       (select count(*) from buildings b where b.managing_organization_id=o.id) as buildings,
       (select count(*) from transit_routes r where r.operator_id=o.id) as transit`;

function usageOf(row: OrganizationRow): OrganizationUsage {
  return {
    merchants: Number(row.merchants),
    sources: Number(row.sources),
    events: Number(row.events),
    buildings: Number(row.buildings),
    transit: Number(row.transit),
  };
}

function usageTotal(usage: OrganizationUsage): number {
  return usage.merchants + usage.sources + usage.events + usage.buildings + usage.transit;
}

/** GET /api/admin/organizations —— 全量机构（含停用）+ 每处引用计数。 */
export async function listOrganizations(env: Env): Promise<Response> {
  const rows = await all<OrganizationRow>(
    env.DB,
    `select o.id,o.name,o.kind,o.status,o.created_at as createdAt,o.updated_at as updatedAt,
       ${USAGE_SELECT}
       from organizations o order by o.status='retired',o.name,o.id`,
  );
  return json({
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      usage: usageOf(row),
    })),
    kinds: KINDS,
  });
}

export async function createOrganization(request: Request, env: Env, principal: SessionPrincipal, requestId: string): Promise<Response> {
  const body = exactObject(await readJson<unknown>(request), "organization", ["name", "kind"]);
  const id = makeId("org");
  const now = isoNow();
  await env.DB.prepare("insert into organizations(id,name,kind,status,created_at,updated_at) values(?,?,?,'active',?,?)")
    .bind(id, requiredString(body.name, "name", 200), oneOf(body.kind, "kind", KINDS), now, now).run();
  await audit(env, principal, "organization.create", "organization", id, requestId, null, body);
  return json({ id }, { status: 201 });
}

export async function updateOrganization(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  id: string,
  requestId: string,
): Promise<Response> {
  const before = await first<Record<string, unknown>>(
    env.DB,
    "select id,name,kind,status from organizations where id=?",
    [id],
  );
  if (!before) throw new HttpError(404, "not_found", "Organization does not exist");
  const body = partialObject(await readJson<unknown>(request), "organizationUpdate", ["name", "kind", "status"]);
  const name = Object.hasOwn(body, "name") ? requiredString(body.name, "name", 200) : String(before.name);
  const kind = Object.hasOwn(body, "kind") ? oneOf(body.kind, "kind", KINDS) : String(before.kind);
  const status = Object.hasOwn(body, "status")
    ? oneOf<OrganizationStatus>(body.status, "status", STATUSES)
    : String(before.status);
  const now = isoNow();
  await env.DB.prepare("update organizations set name=?,kind=?,status=?,updated_at=? where id=?")
    .bind(name, kind, status, now, id).run();
  await audit(env, principal, "organization.update", "organization", id, requestId, before, { name, kind, status });
  return json({ id });
}

export async function deleteOrganization(
  env: Env,
  principal: SessionPrincipal,
  id: string,
  requestId: string,
): Promise<Response> {
  const before = await first<OrganizationRow>(
    env.DB,
    `select o.id,o.name,o.kind,o.status,o.created_at as createdAt,o.updated_at as updatedAt,
       ${USAGE_SELECT}
       from organizations o where o.id=?`,
    [id],
  );
  if (!before) throw new HttpError(404, "not_found", "Organization does not exist");
  const usage = usageOf(before);
  const total = usageTotal(usage);
  if (total > 0) {
    throw new HttpError(409, "organization_in_use", `This organization is still referenced by ${total} records; retire it instead`);
  }
  await env.DB.prepare("delete from organizations where id=?").bind(id).run();
  await audit(env, principal, "organization.delete", "organization", id, requestId, before, null);
  return new Response(null, { status: 204 });
}
