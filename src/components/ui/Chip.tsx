import type { ReactNode } from "react";

/** 筛选标签；全局约定：所在行均可横向滑动（ChipRow）。 */
export function Chip({
  active,
  children,
  onClick,
  variant = "filled",
}: {
  active?: boolean;
  children: ReactNode;
  onClick?: () => void;
  /** filled: 灰底（白卡上）；outline: 白底描边（灰底页面上） */
  variant?: "filled" | "outline";
}) {
  const base = "shrink-0 h-9 rounded-full px-4 text-body transition-colors select-none";
  const cls = active
    ? "bg-primary text-white"
    : variant === "filled"
      ? "bg-page text-ink active:bg-line"
      : "bg-surface text-ink border border-line active:bg-page";
  return (
    <button type="button" className={`${base} ${cls}`} onClick={onClick}>
      {children}
    </button>
  );
}

export function ChipRow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`flex gap-2 overflow-x-auto scrollbar-hidden ${className}`}>{children}</div>;
}
