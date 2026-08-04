import type { Env } from "../types/cloudflare";
import { first } from "./db";
import { HttpError } from "./http";

/**
 * 为一个类型自己的筛选标签挑一个没被占用的 key。
 *
 * 标签与类型是一对一的：库里 19 个标签、19 个成员，一个标签从来没有装过两样东西。
 * 于是「先建标签、再把类型放进去」这一步对维护者只是负担——他想的是「加一类地点」，
 * 不是「给它找个容器」。现在新建类型时后台自己建标签，key 沿用类型的 id / code，
 * 因为它只是发布产物和前台 URL 里的稳定标识，不是给人读的。
 *
 * 撞名时往后加序号而不是报错：key 是维护者不关心的字段，为它中断一次创建不合理。
 * 分组能力仍在（map_filter_members 支持一个标签挂多个成员），只是不再挡在创建路径上。
 */
export async function allocateMapFilterKey(env: Env, base: string): Promise<string> {
  // map_filter_categories.key 的格式要求是「字母开头 + 字母数字下划线连字符」。
  const normalized = base.toLowerCase().replace(/[^a-z0-9_-]/g, "_").replace(/^[^a-z]+/, "") || "filter";
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const candidate = attempt === 1 ? normalized : `${normalized}_${attempt}`;
    const taken = await first<{ id: string }>(
      env.DB,
      "select id from map_filter_categories where key=?",
      [candidate],
    );
    if (!taken) return candidate;
  }
  throw new HttpError(409, "map_filter_key_exhausted", "Could not allocate a map filter key");
}

export async function assertActivePlaceKind(env: Env, kindId: string): Promise<void> {
  const kind = await first<{ id: string }>(
    env.DB,
    `select pk.id
       from place_kinds pk
       join map_filter_members m on m.place_kind_id=pk.id
       join map_filter_categories c on c.id=m.category_id and c.active=1
      where pk.id=?`,
    [kindId],
  );
  if (!kind) {
    throw new HttpError(400, "inactive_place_kind", "Place kind must exist and belong to an active map filter");
  }
}

export async function assertActiveFacilityType(env: Env, facilityTypeId: string): Promise<void> {
  const type = await first<{ id: string }>(
    env.DB,
    `select t.id
       from facility_types t
       join map_filter_members m on m.facility_type_id=t.id
       join map_filter_categories c on c.id=m.category_id and c.active=1
      where t.id=? and t.status='active'`,
    [facilityTypeId],
  );
  if (!type) {
    throw new HttpError(400, "inactive_facility_type", "Facility type must be enabled and belong to an active map filter");
  }
}

export async function assertActiveMerchantMapFilter(env: Env): Promise<void> {
  const member = await first<{ id: string }>(
    env.DB,
    `select m.id
       from map_filter_members m
       join map_filter_categories c on c.id=m.category_id and c.active=1
      where m.includes_merchants=1`,
  );
  if (!member) throw new HttpError(400, "inactive_merchant_filter", "Merchants must belong to an active map filter");
}
