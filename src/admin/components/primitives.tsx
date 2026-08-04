import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../../lib/api/client";

// ---------------------------------------------------------------------------
// 管理后台共享原语（v2 设计令牌版）。色调规范与移动端一致：
// 草稿/已结束=neutral，待审核=warning，已发布/进行中=ok，已排期=info，驳回/失败=error。
// ---------------------------------------------------------------------------

export type Tone = "ok" | "warning" | "error" | "info" | "neutral";

export const toneClass: Record<Tone, string> = {
  ok: "bg-success-bg text-success",
  warning: "bg-warning-bg text-warning",
  error: "bg-error-bg text-error",
  info: "bg-primary-container text-primary",
  neutral: "bg-chip text-sub",
};

export function Pill({ tone = "neutral", children, className = "" }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex h-5.5 shrink-0 items-center rounded-full px-2 text-label font-medium ${toneClass[tone]} ${className}`}>
      {children}
    </span>
  );
}

// 编辑状态（place/facility/merchant revision、运营事件共用）
export const EDITORIAL_LABELS: Record<string, string> = {
  draft: "草稿",
  in_review: "待审核",
  approved: "已发布",
  rejected: "已驳回",
  superseded: "已取代",
};

export const EDITORIAL_TONE: Record<string, Tone> = {
  draft: "neutral",
  in_review: "warning",
  approved: "ok",
  rejected: "error",
  superseded: "neutral",
};

export function EditorialPill({ status }: { status: string | null | undefined }) {
  const key = status ?? "draft";
  return <Pill tone={EDITORIAL_TONE[key] ?? "neutral"}>{EDITORIAL_LABELS[key] ?? key}</Pill>;
}

export const SEVERITY_LABELS: Record<string, string> = {
  info: "通知",
  warning: "警告",
  critical: "紧急",
};

export const SEVERITY_TONE: Record<string, Tone> = {
  info: "info",
  warning: "warning",
  critical: "error",
};

export const OPERATIONAL_STATUS_LABELS: Record<string, string> = {
  scheduled: "已排期",
  active: "进行中",
  resolved: "已结束",
  expired: "已结束",
  cancelled: "已取消",
};

export const OPERATIONAL_STATUS_TONE: Record<string, Tone> = {
  scheduled: "info",
  active: "ok",
  resolved: "neutral",
  expired: "neutral",
  cancelled: "neutral",
};

export const EVENT_TYPE_LABELS: Record<string, string> = {
  maintenance: "维修",
  activity: "活动",
  closure: "关闭",
  notice: "通知",
};

// ---------------------------------------------------------------------------
// 容器 / 表单
// ---------------------------------------------------------------------------

export function Panel({
  title,
  action,
  children,
  className = "",
  padded = true,
}: {
  title?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section className={`rounded-xl bg-surface ${className}`}>
      {title || action ? (
        <header className="flex min-h-12 items-center justify-between gap-3 px-5 pt-4">
          <h2 className="text-emphasis">{title}</h2>
          {action}
        </header>
      ) : null}
      <div className={padded ? "p-5" : ""}>{children}</div>
    </section>
  );
}

const inputClass =
  "h-9 w-full rounded-lg border border-line bg-surface px-3 text-body text-ink outline-none placeholder:text-sub focus:border-primary";

export function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  disabled = false,
}: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      {label ? <span className="mb-1.5 block text-label text-sub">{label}</span> : null}
      <input className={`${inputClass} disabled:cursor-not-allowed disabled:bg-page disabled:text-sub`} disabled={disabled} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} type={type} value={value} />
    </label>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  placeholder,
  disabled = false,
}: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      {label ? <span className="mb-1.5 block text-label text-sub">{label}</span> : null}
      <select className={`${inputClass} disabled:cursor-not-allowed disabled:bg-page disabled:text-sub`} disabled={disabled} onChange={(e) => onChange(e.target.value)} value={value}>
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

export function TextArea({
  label,
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <label className="block">
      {label ? <span className="mb-1.5 block text-label text-sub">{label}</span> : null}
      <textarea
        className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-body text-ink outline-none placeholder:text-sub focus:border-primary"
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        value={value}
      />
    </label>
  );
}

// ---------------------------------------------------------------------------
// 按钮 / Chips
// ---------------------------------------------------------------------------

export function PrimaryButton({
  children,
  onClick,
  disabled,
  type = "button",
  className = "",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
}) {
  return (
    <button
      className={`inline-flex h-10 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-body font-semibold text-white transition-colors hover:bg-primary-pressed disabled:opacity-50 ${className}`}
      disabled={disabled}
      onClick={onClick}
      type={type}
    >
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  onClick,
  disabled,
  danger,
  className = "",
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  className?: string;
  /** 悬浮提示。禁用状态下用来说明为什么点不了。 */
  title?: string;
}) {
  return (
    <button
      className={`inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border bg-surface px-4 text-body font-semibold disabled:opacity-50 ${
        danger ? "border-error/40 text-error" : "border-line text-ink"
      } ${className}`}
      disabled={disabled}
      onClick={onClick}
      title={title}
      type="button"
    >
      {children}
    </button>
  );
}

export function Chip({
  active,
  children,
  onClick,
}: {
  active?: boolean;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      className={`inline-flex h-8 shrink-0 items-center rounded-full px-3.5 text-aux font-medium transition-colors ${
        active ? "bg-primary text-white" : "bg-surface text-ink hover:bg-primary-container"
      }`}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// 状态展示
// ---------------------------------------------------------------------------

export function ErrorBanner({ message }: { message: string }) {
  if (!message) return null;
  return <p className="rounded-lg bg-error-bg px-4 py-3 text-body font-medium text-error">{message}</p>;
}

export function InfoNote({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "warning" | "info" }) {
  const cls = tone === "warning" ? "bg-warning-bg text-warning" : tone === "info" ? "bg-primary-container text-primary" : "bg-chip text-sub";
  return <p className={`rounded-lg px-4 py-3 text-aux leading-relaxed ${cls}`}>{children}</p>;
}

export function LoadingState({ label = "加载中…" }: { label?: string }) {
  return <p className="rounded-xl bg-surface px-4 py-12 text-center text-body text-sub">{label}</p>;
}

export function EmptyState({ label }: { label: string }) {
  return <p className="rounded-lg bg-page px-4 py-8 text-center text-body text-sub">{label}</p>;
}

export function errorMessage(err: unknown, defaultMessage: string): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : defaultMessage;
}

// ---------------------------------------------------------------------------
// 时间格式化
// ---------------------------------------------------------------------------

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** ISO → "07-18 21:30"（本地时区）。无效输入原样返回。 */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ISO → "M/D"（用于事件日期范围）。 */
export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return iso;
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return fmtDateTime(iso);
}

// ---------------------------------------------------------------------------
// 异步数据 hook（列表页共用）
// ---------------------------------------------------------------------------

export type AsyncDataState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; message: string };

export function useAsyncData<T>(loader: (signal: AbortSignal) => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<AsyncDataState<T>>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    loader(controller.signal)
      .then((data) => setState({ status: "ready", data }))
      .catch((err) => {
        if (controller.signal.aborted) return;
        setState({ status: "error", message: errorMessage(err, "加载失败") });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return { state, reload };
}
