import { Inbox } from "lucide-react";
import type { ReactNode } from "react";

export function EmptyState({ icon, title, subtitle, action }: { icon?: ReactNode; title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-full bg-primary-container text-primary">
        {icon ?? <Inbox size={24} />}
      </div>
      <div className="text-emphasis">{title}</div>
      {subtitle ? <div className="text-aux text-sub whitespace-pre-line">{subtitle}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function LoadingState({ label = "加载中…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 px-6 py-12 text-aux text-sub">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-primary" />
      {label}
    </div>
  );
}
