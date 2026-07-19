import type { ReactNode } from "react";

/** M2 楼内设施指引：圆形图标徽章 + 文字标签（去矩形化）。 */
export function IconBadge({ icon, label, onClick }: { icon: ReactNode; label: string; onClick?: () => void }) {
  return (
    <button type="button" className="flex shrink-0 items-center gap-1.5" onClick={onClick}>
      <span className="grid h-8 w-8 place-items-center rounded-full bg-primary-container text-primary">{icon}</span>
      <span className="text-body text-ink">{label}</span>
    </button>
  );
}
