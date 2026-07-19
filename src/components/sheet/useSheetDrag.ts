import { useRef, useState } from "react";

/**
 * 底部抽屉拖拽：handle 按下后跟踪位移，松手吸附到最近的允许档位。
 * 从旧 MapPage 的内联拖拽逻辑抽出的通用版。
 */
export function useSheetDrag<TMode extends string>({
  mode,
  topForMode,
  allowedModes,
  onModeChange,
  onClose,
  closeThresholdPx = 70,
}: {
  mode: TMode;
  /** 各档位 sheet 顶边距视口顶部的 px */
  topForMode: (mode: TMode) => number;
  /** 当前可吸附的档位集合 */
  allowedModes: (mode: TMode) => TMode[];
  onModeChange: (mode: TMode) => void;
  /** 可关闭模式（poi 详情）下拉超过阈值时触发；提供后该模式不参与吸附 */
  onClose?: () => void;
  closeThresholdPx?: number;
}) {
  const [dragOffset, setDragOffset] = useState(0);
  const dragRef = useRef<{ startY: number; startTop: number } | null>(null);

  const handlePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    event.preventDefault();
    dragRef.current = { startY: event.clientY, startTop: topForMode(mode) };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (!dragRef.current) return;
      setDragOffset(moveEvent.clientY - dragRef.current.startY);
    };

    const handlePointerUp = (upEvent: PointerEvent) => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      if (!dragRef.current) return;
      const totalOffset = upEvent.clientY - dragRef.current.startY;
      const startTop = dragRef.current.startTop;
      dragRef.current = null;
      setDragOffset(0);

      if (onClose) {
        if (totalOffset > closeThresholdPx) onClose();
        return;
      }

      const candidates = allowedModes(mode);
      if (candidates.length === 0) return;
      const projectedTop = startTop + totalOffset;
      const next = candidates.reduce((closest, current) =>
        Math.abs(projectedTop - topForMode(current)) < Math.abs(projectedTop - topForMode(closest)) ? current : closest,
      );
      if (next !== mode) onModeChange(next);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  };

  return { dragOffset, handlePointerDown };
}
