// Merchant outlet projection from the release manifest.
//
// Merchants have no page of their own: per the v2 design each outlet is grouped
// onto its host place (`hostPlaceId`) and rendered inside that place's M2 POI
// detail, reusing the same layout plus the optional extension fields (menu,
// stall code, average price).
//
// This module is deliberately free of asset imports so it can be unit-tested.

import type { ReleaseMerchant } from "../api/types";
import type { MerchantMenuItem, MerchantSummary } from "../types";

function stringField(source: Record<string, unknown> | null | undefined, ...keys: string[]): string {
  if (!source) return "";
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

/** opening_hours_json / contact_json are free-form; accept a plain string or {text|phone}. */
function textOf(value: unknown, ...keys: string[]): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") return stringField(value as Record<string, unknown>, ...keys);
  return "";
}

function normalizeMenu(value: unknown): MerchantMenuItem[] {
  if (!Array.isArray(value)) return [];
  const items: MerchantMenuItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const name = stringField(record, "name", "title");
    if (!name) continue;
    items.push({
      name,
      price: stringField(record, "price"),
      description: stringField(record, "description", "desc"),
    });
  }
  return items;
}

/** Project a manifest merchant row onto the front-end display model. */
export function normalizeMerchant(merchant: ReleaseMerchant): MerchantSummary {
  const content = merchant.content ?? {};
  return {
    id: merchant.id,
    name: merchant.displayName,
    businessType: typeof merchant.businessType === "string" ? merchant.businessType.trim() : "",
    openingHours: textOf(merchant.openingHours, "text", "summary", "hours"),
    stallCode: stringField(content, "stallCode", "stallNo", "stall"),
    phone: textOf(merchant.contact, "phone", "tel", "mobile"),
    avgPrice: stringField(content, "avgPrice", "averagePrice", "perCapita"),
    summary: stringField(content, "summary", "description"),
    floorId: merchant.floorId ?? null,
    menu: normalizeMenu(content.menu),
  };
}

/**
 * Group manifest merchants by host place. Outlets without a `hostPlaceId` are
 * dropped: with no standalone merchant page they have nowhere to render.
 */
export function groupMerchantsByPlace(
  merchants: ReleaseMerchant[] | null | undefined,
): Map<string, MerchantSummary[]> {
  const byPlace = new Map<string, MerchantSummary[]>();
  for (const merchant of merchants ?? []) {
    if (!merchant.hostPlaceId) continue;
    const list = byPlace.get(merchant.hostPlaceId) ?? [];
    list.push(normalizeMerchant(merchant));
    byPlace.set(merchant.hostPlaceId, list);
  }
  for (const list of byPlace.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  }
  return byPlace;
}
