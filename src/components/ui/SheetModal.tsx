import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * 底部弹卡（M7 班次预览 / M13 楼层详情）：scrim + 底部卡片。
 * - 点 scrim 或下拉关闭
 * - expandable 时上拉半屏 → 全屏（全局交互约定）
 */
export function SheetModal({
  open,
  onClose,
  children,
  expandable = false,
  initialHeight = 0.55,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  expandable?: boolean;
  /** 初始高度（视口比例 0-1），expandable 时上拉扩展到 0.92 */
  initialHeight?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const dragState = useRef<{ startY: number; dragging: boolean }>({ startY: 0, dragging: false });

  useEffect(() => {
    if (open) {
      setExpanded(false);
      setDragOffset(0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const heightRatio = expanded ? 0.92 : initialHeight;

  const onPointerDown = (event: React.PointerEvent) => {
    dragState.current = { startY: event.clientY, dragging: true };
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent) => {
    if (!dragState.current.dragging) return;
    const delta = event.clientY - dragState.current.startY;
    if (delta > 0) setDragOffset(delta);
  };
  const onPointerEnd = (event: React.PointerEvent) => {
    if (!dragState.current.dragging) return;
    dragState.current.dragging = false;
    const delta = event.clientY - dragState.current.startY;
    setDragOffset(0);
    if (delta > 90) onClose();
    else if (expandable && delta < -50) setExpanded(true);
    else if (expandable && delta > 50 && expanded) setExpanded(false);
  };

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} />
      <div
        className="absolute inset-x-0 bottom-0 flex flex-col rounded-t-4xl bg-surface shadow-sheet transition-[height] duration-200"
        style={{ height: `${heightRatio * 100}%`, transform: dragOffset ? `translateY(${dragOffset}px)` : undefined, transitionProperty: dragOffset ? "none" : "height" }}
      >
        <div
          className="flex shrink-0 cursor-grab justify-center pt-2.5 pb-1.5 touch-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        >
          <div className="h-1 w-9 rounded-full bg-line" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
