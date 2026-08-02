/** 火忘式 analytics 上报；失败记录原因和 HTTP 状态，不记录事件内容。 */
export function recordAnalyticsEvent(payload: Record<string, unknown>): void {
  void fetch("/api/analytics/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
    .then((response) => {
      if (!response.ok) {
        console.error("Analytics event delivery failed", {
          reason: "http_status",
          status: response.status,
        });
      }
    })
    .catch(() => {
      console.error("Analytics event delivery failed", { reason: "network_error" });
    });
}
