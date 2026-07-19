import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

/** 通用列表行：左侧图标/徽章 + 标题/副标题 + 右侧槽位（默认 chevron）。 */
export function ListRow({
  icon,
  title,
  subtitle,
  right,
  onClick,
  showChevron,
  className = "",
}: {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  onClick?: () => void;
  showChevron?: boolean;
  className?: string;
}) {
  const chevron = showChevron ?? Boolean(onClick);
  return (
    <div
      className={`flex items-center gap-3 px-4 py-3.5 ${onClick ? "cursor-pointer active:bg-page" : ""} ${className}`}
      onClick={onClick}
      role={onClick ? "button" : undefined}
    >
      {icon ? <div className="shrink-0">{icon}</div> : null}
      <div className="min-w-0 flex-1">
        <div className="truncate text-emphasis">{title}</div>
        {subtitle ? <div className="mt-0.5 truncate text-aux text-sub">{subtitle}</div> : null}
      </div>
      {right}
      {chevron ? <ChevronRight size={16} className="shrink-0 text-sub" /> : null}
    </div>
  );
}
