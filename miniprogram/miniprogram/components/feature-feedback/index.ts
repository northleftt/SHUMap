import { feedbackHidden, markFeedback } from "../../lib/feature-feedback";
Component({
  properties: { page: String, prompt: String },
  data: { hidden: false },
  lifetimes: { attached() { this.refresh(); } },
  pageLifetimes: { show() { this.refresh(); } },
  methods: {
    refresh() { this.setData({ hidden: feedbackHidden(this.data.page) }); },
    open() { wx.navigateTo({ url: `/pages/feature-feedback/feature-feedback?page=${encodeURIComponent(this.data.page)}` }); },
    dismiss() {
      try { markFeedback(this.data.page, "dismissedAt"); } catch { /* 本次仍收起入口 */ }
      this.setData({ hidden: true });
    },
  },
});
