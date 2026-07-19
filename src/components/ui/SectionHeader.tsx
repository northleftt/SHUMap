import type { ReactNode } from "react";

/** 分区标题 + 可选右侧链接（如「全部 ›」）。 */
export function SectionHeader({ title, action, className = "" }: { title: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={`flex items-center justify-between ${className}`}>
      <h2 className="text-emphasis">{title}</h2>
      {action ? <div className="text-aux text-sub">{action}</div> : null}
    </div>
  );
}
