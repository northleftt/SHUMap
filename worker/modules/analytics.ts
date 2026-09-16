import type { Env } from "../types/cloudflare";
import { all } from "../lib/db";
import { HttpError, json, noContent, readJsonLimited } from "../lib/http";
import { enforcePublicRateLimit } from "../lib/public-rate-limit";
import { isoNow, jsonString, makeId, objectValue, optionalString, requiredString } from "../lib/values";

const MAX_ANALYTICS_BYTES = 8 * 1024;

// 与 migrations-v2/0030_analytics_event_types.sql 的 CHECK 保持一致；
// 新增事件类型必须同步改这两处。
export const ANALYTICS_EVENT_TYPES = [
  "map_view",
  "poi_view",
  "page_view",
  "search",
  "shuttle_query",
  "dining_view",
  "popup_open",
  "popup_close",
] as const;

const MAX_SUMMARY_DAYS = 90;

export async function recordAnalyticsEvent(request: Request, env: Env): Promise<Response> {
  await enforcePublicRateLimit(request, env, "analytics", 3_000);
  const body = await readJsonLimited<Record<string, unknown>>(request, MAX_ANALYTICS_BYTES);
  const eventType = requiredString(body.eventType, "eventType", 50);
  if (!(ANALYTICS_EVENT_TYPES as readonly string[]).includes(eventType)) {
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

interface EventTypeCountRow {
  event_type: string;
  event_count: number;
}

interface DailyCountRow extends EventTypeCountRow {
  day: string;
}

interface TopPlaceRow {
  place_id: string;
  place_name: string | null;
  view_count: number;
}

/** 管理端埋点统计：按事件类型汇总 + 按天拆分 + POI 曝光榜，窗口 ?days=（默认 7，上限 90）。 */
export async function getAnalyticsSummary(env: Env, url: URL): Promise<Response> {
  const daysParam = url.searchParams.get("days");
  let days = 7;
  if (daysParam !== null) {
    days = Number(daysParam);
    if (!Number.isSafeInteger(days) || days < 1 || days > MAX_SUMMARY_DAYS) {
      throw new HttpError(400, "validation_error", `days must be an integer between 1 and ${MAX_SUMMARY_DAYS}`);
    }
  }
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const [totals, daily, topPlaces] = await Promise.all([
    all<EventTypeCountRow>(
      env.DB,
      `select event_type, count(*) as event_count
         from analytics_events
        where created_at >= ?
        group by event_type
        order by event_count desc`,
      [since],
    ),
    all<DailyCountRow>(
      env.DB,
      `select substr(created_at, 1, 10) as day, event_type, count(*) as event_count
         from analytics_events
        where created_at >= ?
        group by day, event_type
        order by day desc, event_count desc`,
      [since],
    ),
    all<TopPlaceRow>(
      env.DB,
      `select place_id, max(place_name) as place_name, count(*) as view_count
         from analytics_events
        where event_type = 'poi_view' and place_id is not null and created_at >= ?
        group by place_id
        order by view_count desc
        limit 20`,
      [since],
    ),
  ]);
  return json({ days, since, totals, daily, topPlaces });
}
