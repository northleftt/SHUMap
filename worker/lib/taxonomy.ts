import type { Env } from "../types/cloudflare";
import { first } from "./db";
import { HttpError } from "./http";

export async function assertActiveMapFilterCategory(env: Env, categoryId: string): Promise<void> {
  const category = await first<{ id: string }>(
    env.DB,
    "select id from map_filter_categories where id=? and active=1",
    [categoryId],
  );
  if (!category) throw new HttpError(400, "inactive_map_filter", "Map filter must exist and be active");
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
