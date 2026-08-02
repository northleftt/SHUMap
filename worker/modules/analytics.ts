import type { Env } from "../types/cloudflare";
import { HttpError, noContent, readJsonLimited } from "../lib/http";
import { enforcePublicRateLimit } from "../lib/public-rate-limit";
import { isoNow, jsonString, makeId, objectValue, optionalString, requiredString } from "../lib/values";

const MAX_ANALYTICS_BYTES = 8 * 1024;

export async function recordAnalyticsEvent(request: Request, env: Env): Promise<Response> {
  await enforcePublicRateLimit(request, env, "analytics", 3_000);
  const body = await readJsonLimited<Record<string, unknown>>(request, MAX_ANALYTICS_BYTES);
  const eventType = requiredString(body.eventType, "eventType", 50);
  if (eventType !== "map_view" && eventType !== "poi_view") {
    throw new HttpError(400, "validation_error", "Invalid analytics eventType");
  }
  const metadata = body.meta === undefined ? {} : objectValue(body.meta, "meta");
  await env.DB.prepare(
    `insert into analytics_events(id,event_type,campus,place_id,place_name,metadata_json,created_at)
     values(?,?,?,?,?,?,?)`,
  ).bind(
    makeId("analytics"),
    eventType,
    optionalString(body.campus, "campus", 100),
    optionalString(body.poiId, "poiId", 100),
    optionalString(body.poiName, "poiName", 200),
    jsonString(metadata),
    isoNow(),
  ).run();
  return noContent();
}
