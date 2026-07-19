import type { ReactNode } from "react";

export function Card({ children, className = "", onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  return (
    <div className={`rounded-2xl bg-surface shadow-card ${onClick ? "cursor-pointer" : ""} ${className}`} onClick={onClick}>
      {children}
    </div>
  );
}
