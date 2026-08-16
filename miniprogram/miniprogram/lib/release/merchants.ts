import type { MerchantMenuItem, MerchantSummary, ReleaseMerchant } from "./types";

function contractError(merchantId: string, field: string, expectation: string): Error {
  return new Error(`Release merchant ${merchantId} ${field} ${expectation}`);
}

function optionalString(merchantId: string, field: string, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw contractError(merchantId, field, "must be a string when present");
  return value.trim();
}

function objectField(merchantId: string, field: string, value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw contractError(merchantId, field, "must be an object or null");
  }
  return value as Record<string, unknown>;
}

function objectText(
  merchantId: string,
  field: string,
  value: unknown,
  property: string,
): string {
  const object = objectField(merchantId, field, value);
  if (object === null) return "";
  return optionalString(merchantId, `${field}.${property}`, object[property]);
}

function menu(merchantId: string, value: unknown): MerchantMenuItem[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw contractError(merchantId, "content.menu", "must be an array");
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw contractError(merchantId, `content.menu[${index}]`, "must be an object");
    }
    const item = raw as Record<string, unknown>;
    const name = optionalString(merchantId, `content.menu[${index}].name`, item.name);
    if (!name) throw contractError(merchantId, `content.menu[${index}].name`, "must be non-empty");
    return {
      name,
      price: optionalString(merchantId, `content.menu[${index}].price`, item.price),
      description: optionalString(merchantId, `content.menu[${index}].description`, item.description),
    };
  });
}

function media(merchantId: string, value: unknown): MerchantSummary["media"] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw contractError(merchantId, "content.media", "must be an array");
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw contractError(merchantId, `content.media[${index}]`, "must be an object");
    }
    const item = raw as Record<string, unknown>;
    if (item.role !== "cover" && item.role !== "gallery") {
      throw contractError(merchantId, `content.media[${index}].role`, "must be cover or gallery");
    }
    const url = optionalString(merchantId, `content.media[${index}].url`, item.url);
    if (!url) throw contractError(merchantId, `content.media[${index}].url`, "must be non-empty");
    const alt = optionalString(merchantId, `content.media[${index}].alt`, item.alt);
    const caption = optionalString(merchantId, `content.media[${index}].caption`, item.caption);
    const floorLevelCode = optionalString(merchantId, `content.media[${index}].floorLevelCode`, item.floorLevelCode);
    return {
      role: item.role,
      url,
      ...(alt ? { alt } : {}),
      ...(caption ? { caption } : {}),
      ...(floorLevelCode ? { floorLevelCode } : {}),
    };
  });
}

export function normalizeMerchant(merchant: ReleaseMerchant): MerchantSummary {
  const content = objectField(merchant.id, "content", merchant.content);
  if (content === null) throw contractError(merchant.id, "content", "must be an object");
  return {
    id: merchant.id,
    name: merchant.displayName,
    businessType: optionalString(merchant.id, "businessType", merchant.businessType),
    openingHours: objectText(merchant.id, "openingHours", merchant.openingHours, "text"),
    stallCode: optionalString(merchant.id, "content.stallCode", content.stallCode),
    phone: objectText(merchant.id, "contact", merchant.contact, "phone"),
    avgPrice: optionalString(merchant.id, "content.avgPrice", content.avgPrice),
    summary: optionalString(merchant.id, "content.summary", content.summary),
    media: media(merchant.id, content.media),
    floorId: merchant.floorId,
    menu: menu(merchant.id, content.menu),
  };
}

export function groupMerchantsByPlace(merchants: ReleaseMerchant[]): Map<string, MerchantSummary[]> {
  const byPlace = new Map<string, MerchantSummary[]>();
  for (const merchant of merchants) {
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
