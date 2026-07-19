import type { ReactNode } from "react";

export type StatusTone = "success" | "warning" | "error" | "info" | "neutral";

const TONE_CLASSES: Record<StatusTone, string> = {
  success: "bg-success-bg text-success",
  warning: "bg-warning-bg text-warning",
  error: "bg-error-bg text-error",
  info: "bg-primary-container text-primary",
  neutral: "bg-page text-sub",
};

/**
 * 状态 pill。全局状态色规范：草稿/已结束=neutral，待审核=warning，
 * 已发布/进行中/当前线上=success，已排期=info，已驳回/校验失败=error。
 */
export function StatusPill({ tone, children, className = "" }: { tone: StatusTone; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-label ${TONE_CLASSES[tone]} ${className}`}>
      {children}
    </span>
  );
}
