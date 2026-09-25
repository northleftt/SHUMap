export const FEATURE_FEEDBACK_KEY = "shumap.feature-feedback";
export const FEEDBACK_PROMPTS: Record<string, string> = {
  search: "你觉得搜索好用吗？",
  shuttle: "你觉得校车查询好用吗？",
};
export function feedbackState(page: string): { submittedAt?: string; dismissedAt?: string } {
  try { return wx.getStorageSync(FEATURE_FEEDBACK_KEY)?.[page] || {}; } catch { return {}; }
}
export function feedbackHidden(page: string): boolean {
  const state = feedbackState(page);
  return Boolean(state.submittedAt || state.dismissedAt);
}
export function markFeedback(page: string, field: "submittedAt" | "dismissedAt"): void {
  const saved = wx.getStorageSync(FEATURE_FEEDBACK_KEY);
  const store = saved && typeof saved === "object" ? saved : {};
  wx.setStorageSync(FEATURE_FEEDBACK_KEY, { ...store, [page]: { ...store[page], [field]: new Date().toISOString() } });
}
