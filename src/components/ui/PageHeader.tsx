import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";

/** 移动端子页头部：返回圆钮 + 标题/副标题 + 可选右侧操作。 */
export function PageHeader({
  title,
  subtitle,
  right,
  onBack,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  onBack?: () => void;
}) {
  const navigate = useNavigate();
  return (
    <header className="flex items-center gap-3 bg-surface px-4 pt-4 pb-3">
      <button
        type="button"
        aria-label="返回"
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-page text-ink active:bg-line"
        onClick={onBack ?? (() => navigate(-1))}
      >
        <ChevronLeft size={20} />
      </button>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-card">{title}</h1>
        {subtitle ? <div className="truncate text-aux text-sub">{subtitle}</div> : null}
      </div>
      {right}
    </header>
  );
}
