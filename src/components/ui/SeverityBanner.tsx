import { AlertTriangle, ChevronRight, Info, Wrench } from "lucide-react";

const SEVERITY_STYLE = {
  info: { bg: "bg-primary-container", text: "text-primary", Icon: Info },
  warning: { bg: "bg-warning-bg", text: "text-warning", Icon: Wrench },
  critical: { bg: "bg-error-bg", text: "text-error", Icon: AlertTriangle },
} as const;

export type Severity = keyof typeof SEVERITY_STYLE;

export function severityOf(value: string | undefined): Severity {
  return value === "warning" || value === "critical" ? value : "info";
}

/** M2 POI 详情通栏运营信息横幅；无事件时槽位整体隐藏（调用方不渲染）。 */
export function SeverityBanner({ severity, title, onClick }: { severity: Severity; title: string; onClick?: () => void }) {
  const { bg, text, Icon } = SEVERITY_STYLE[severity];
  return (
    <button type="button" className={`flex w-full items-center gap-2.5 px-4 py-3 ${bg} ${text}`} onClick={onClick}>
      <Icon size={17} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate text-left text-emphasis">{title}</span>
      <ChevronRight size={16} className="shrink-0 opacity-70" />
    </button>
  );
}

export function SeverityIcon({ severity, size = 17 }: { severity: Severity; size?: number }) {
  const { text, Icon } = SEVERITY_STYLE[severity];
  return <Icon size={size} className={text} />;
}
