// 火忘式 analytics 上报（对齐 Web 端 src/lib/analytics.ts）：
// 失败只记原因不带事件内容，绝不阻塞 UI、不出 toast。
import { apiPost } from "./api";

/** poi_view 的打开来源（对齐 Web 端 openPoi 的 source 参数）。 */
export type AnalyticsPoiSource = "map_object" | "search_result" | "deep_link";

export function recordAnalyticsEvent(payload: Record<string, unknown>): void {
  apiPost("/api/analytics/events", payload).catch(() => {
    console.error("Analytics event delivery failed", { reason: "request_failed" });
  });
}

/** 页面浏览埋点：页面 onShow/onLoad 里调一次，meta.page 区分页面。 */
export function recordPageView(page: string): void {
  recordAnalyticsEvent({ eventType: "page_view", meta: { page } });
}
