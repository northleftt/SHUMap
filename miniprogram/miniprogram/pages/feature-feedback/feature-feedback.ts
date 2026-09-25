import { apiPost } from "../../lib/api";
import { FEEDBACK_PROMPTS, feedbackHidden, markFeedback } from "../../lib/feature-feedback";
import { APP_SHARE_TITLE, enableShareMenus, sharePath } from "../../lib/share";
Page({
  data: { prompt: "", rating: 0, reason: "", busy: false, error: "", done: false, stars: [1, 2, 3, 4, 5] },
  onLoad(query: Record<string, string>) {
    enableShareMenus();
    this.pageKey = query.page;
    if (!FEEDBACK_PROMPTS[this.pageKey] || feedbackHidden(this.pageKey)) { wx.navigateBack(); return; }
    this.setData({ prompt: FEEDBACK_PROMPTS[this.pageKey] });
  },
  selectRating(e: any) { if (!this.data.busy) this.setData({ rating: Number(e.currentTarget.dataset.value) }); },
  onReason(e: any) { this.setData({ reason: e.detail.value }); },
  async submit() {
    if (!this.data.rating || this.data.busy || this.data.done || !FEEDBACK_PROMPTS[this.pageKey]) return;
    this.setData({ busy: true, error: "" });
    try {
      const reason = this.data.reason.trim();
      await apiPost("/api/public/feature-feedback", { page: this.pageKey, rating: this.data.rating, ...(reason ? { reason } : {}) });
      this.setData({ done: true });
      // 成功即持久化，感谢画面留在独立页面，返回时入口自然消失。
      try { markFeedback(this.pageKey, "submittedAt"); } catch { /* 存储异常不改变已提交结果 */ }
    } catch (err) { this.setData({ error: err instanceof Error ? err.message : "提交失败，请稍后重试" }); }
    finally { this.setData({ busy: false }); }
  },
  onShareAppMessage() { return { title: APP_SHARE_TITLE, path: sharePath(this.pageKey === "shuttle" ? "/pages/shuttle/shuttle" : "/pages/map/map") }; },
  onShareTimeline() { return { title: APP_SHARE_TITLE }; },
  finish() { wx.navigateBack(); },
});
