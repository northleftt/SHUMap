/** 火忘式 analytics 上报；同源 /api/analytics/events，失败静默。 */
export function recordAnalyticsEvent(payload: Record<string, unknown>): void {
  fetch("/api/analytics/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}
