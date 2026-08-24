import { useEffect, useRef, useState } from "react";
import {
  SHEET_CLOSE_THRESHOLD_PX,
  dampSheetTop,
  resolveSheetDragOwner,
  sheetDragVelocity,
  sheetGestureOwner,
  shouldClosePoiOnRelease,
  snapModeWithVelocity,
  type SheetGestureOwner,
} from "./sheetGesture";

/** 抽屉内纵向滚动框的标记属性（判定「落点在列表里」用，别在 hook 里硬编码结构）。 */
export const SHEET_SCROLL_ATTR = "data-sheet-scroll";
/** 拖拽把手的标记属性（把手上的手势无条件归抽屉）。 */
export const SHEET_HANDLE_ATTR = "data-sheet-handle";

interface DragState {
  fromHandle: boolean;
  owner: SheetGestureOwner;
  /** 首次位移到达容差后定死的归属；非 null 之后整个手势不再易主。 */
  resolved: "sheet" | "scroll" | null;
  startX: number;
  startY: number;
  startTop: number;
  scrollTop: number;
  /** 速度采样：只留最后两点（全程平均会把中途的犹豫算进去，甩动判不出来）。 */
  prevSample: { y: number; t: number } | null;
  lastSample: { y: number; t: number } | null;
}

/**
 * 底部抽屉拖拽：**整卡可拖**（2026-08-24 起命中区从把手扩到整张卡片），
 * 松手按位移 + 速度吸附到最近的允许档位。
 *
 * 手势归属按落点判定（sheetGesture.ts，与小程序端同一套规则）：落在标了
 * SHEET_SCROLL_ATTR 的纵向滚动框里归列表，落在别处归卡片；results / poi 档
 * 额外保留「滚到顶继续下拉」的出口。
 *
 * 触摸监听走原生 addEventListener + passive:false：React 的合成 touchmove 是
 * 被动的，preventDefault 会被忽略；而原生滚动一旦启动就直接给 pointercancel，
 * 用指针事件来不及抢。鼠标端仍走把手 / 卡片空白处的 pointerdown。
 */
export function useSheetDrag<TMode extends string>({
  mode,
  topForMode,
  allowedModes,
  onModeChange,
  onClose,
  closeThresholdPx = SHEET_CLOSE_THRESHOLD_PX,
  pullDownExitModes,
  onClaim,
  onDropToLowerMode,
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
  /** 保留「滚到顶继续下拉 = 降档」出口的档位（默认 results / poi） */
  pullDownExitModes?: readonly string[];
  /** 抽屉抢到手势时回调（收键盘、抑制随后的列表行点击） */
  onClaim?: () => void;
  /** 落到更矮的档位时回调（把列表滚回顶部，否则列表停在中间看起来像坏了） */
  onDropToLowerMode?: () => void;
}) {
  const [dragOffset, setDragOffset] = useState(0);
  const sheetRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  // 事件回调在原生监听器里跑，用 ref 取最新值（监听器只挂一次，不随渲染重挂）
  const latest = useRef({
    mode,
    topForMode,
    allowedModes,
    onModeChange,
    onClose,
    closeThresholdPx,
    pullDownExitModes,
    onClaim,
    onDropToLowerMode,
  });
  latest.current = {
    mode,
    topForMode,
    allowedModes,
    onModeChange,
    onClose,
    closeThresholdPx,
    pullDownExitModes,
    onClaim,
    onDropToLowerMode,
  };

  /** 落点所在的纵向滚动框（找不到返回 null = 整卡可拖）。 */
  function scrollAreaOf(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    const area = target.closest<HTMLElement>(`[${SHEET_SCROLL_ATTR}]`);
    return area && sheetRef.current?.contains(area) ? area : null;
  }

  function beginDrag({
    target,
    x,
    y,
  }: {
    target: EventTarget | null;
    x: number;
    y: number;
  }) {
    const { mode: currentMode, topForMode: top, pullDownExitModes: exitModes } = latest.current;
    const fromHandle = target instanceof Element && Boolean(target.closest(`[${SHEET_HANDLE_ATTR}]`));
    const area = fromHandle ? null : scrollAreaOf(target);
    // 内容没溢出的框（最近查看只一两条）不该吃掉手势——此时整卡可拖
    const scrollable = area ? area.scrollHeight - area.clientHeight > 1 : false;
    const owner = sheetGestureOwner({
      mode: currentMode,
      fromHandle,
      inScrollArea: Boolean(area),
      scrollable,
      pullDownExitModes: exitModes,
    });
    dragRef.current = {
      fromHandle,
      owner,
      // owner=scroll 已经没有悬念，直接定死
      resolved: owner === "scroll" ? "scroll" : null,
      startX: x,
      startY: y,
      startTop: top(currentMode),
      scrollTop: area ? area.scrollTop : 0,
      prevSample: null,
      lastSample: { y, t: Date.now() },
    };
  }

  /** 返回 true = 本帧归抽屉（调用方需要 preventDefault 掉原生滚动）。 */
  function moveDrag(x: number, y: number): boolean {
    const state = dragRef.current;
    if (!state) return false;
    state.prevSample = state.lastSample;
    state.lastSample = { y, t: Date.now() };

    if (!state.resolved) {
      const resolved = resolveSheetDragOwner({
        owner: state.owner,
        fromHandle: state.fromHandle,
        deltaX: x - state.startX,
        deltaY: y - state.startY,
        scrollTop: state.scrollTop,
      });
      if (!resolved) return false;
      state.resolved = resolved;
      if (resolved === "sheet") {
        // 抢到手势：收键盘 / 抑制随后的列表行点击，并把起点重置到当前位置
        // （判定用掉的那 8px 不该算进位移，否则松手落档会偏）。
        latest.current.onClaim?.();
        state.startX = x;
        state.startY = y;
      } else {
        dragRef.current = null;
        return false;
      }
    }
    if (state.resolved !== "sheet") return false;

    const { mode: currentMode, topForMode: top, allowedModes: allowed, onClose: close } = latest.current;
    const delta = y - state.startY;
    if (close) {
      // poi 档只允许下拉（内容矮于上限时不该能往上拽出空白）
      setDragOffset(Math.max(0, delta));
      return true;
    }
    // 越界给阻尼而不是硬停（手感上更像「到底了」，松手仍由吸附拉回）
    const tops = allowed(currentMode).map(top);
    const minTop = tops.length ? Math.min(...tops) : top(currentMode);
    const maxTop = tops.length ? Math.max(...tops) : top(currentMode);
    setDragOffset(dampSheetTop(state.startTop + delta, minTop, maxTop) - state.startTop);
    return true;
  }

  function endDrag(y: number | null) {
    const state = dragRef.current;
    dragRef.current = null;
    setDragOffset(0);
    // 让给列表滚动的手势：抽屉不动（也不吸附，避免把列表滚动误判成拖拽）
    if (!state || state.resolved !== "sheet") return;
    const {
      mode: currentMode,
      topForMode: top,
      allowedModes: allowed,
      onModeChange: change,
      onClose: close,
      closeThresholdPx: threshold,
      onDropToLowerMode: onDrop,
    } = latest.current;
    const endY = y ?? state.lastSample?.y ?? state.startY;
    const totalOffset = endY - state.startY;
    const velocity = sheetDragVelocity(state.prevSample, state.lastSample);

    if (close) {
      if (shouldClosePoiOnRelease(totalOffset, velocity, threshold)) close();
      return;
    }
    const candidates = allowed(currentMode);
    if (candidates.length === 0) return;
    const next = snapModeWithVelocity({
      releasedTop: state.startTop + totalOffset,
      velocity,
      candidates,
      topForMode: top,
      currentMode,
    });
    if (!next || next === currentMode) return;
    // 降档（顶边下移 = 可见带变短）时列表回顶
    if (top(next) > top(currentMode)) onDrop?.();
    change(next);
  }

  // 触摸：原生监听 + passive:false，抢到手势后每帧 preventDefault 掉原生滚动。
  useEffect(() => {
    const element = sheetRef.current;
    if (!element) return;

    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch || event.touches.length > 1) return;
      beginDrag({ target: event.target, x: touch.clientX, y: touch.clientY });
    };
    const onTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;
      if (moveDrag(touch.clientX, touch.clientY) && event.cancelable) event.preventDefault();
    };
    const onTouchEnd = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      endDrag(touch ? touch.clientY : null);
    };

    element.addEventListener("touchstart", onTouchStart, { passive: true });
    element.addEventListener("touchmove", onTouchMove, { passive: false });
    element.addEventListener("touchend", onTouchEnd);
    element.addEventListener("touchcancel", onTouchEnd);
    return () => {
      element.removeEventListener("touchstart", onTouchStart);
      element.removeEventListener("touchmove", onTouchMove);
      element.removeEventListener("touchend", onTouchEnd);
      element.removeEventListener("touchcancel", onTouchEnd);
    };
    // 监听器只挂一次（回调读 latest ref）；卸载时清理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 鼠标端：把手 / 卡片空白处按下拖动（滚轮照旧滚列表）。
   * 触摸走上面的原生监听，这里只接鼠标，避免同一手势被处理两次。
   */
  const handlePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType !== "mouse") return;
    beginDrag({ target: event.target, x: event.clientX, y: event.clientY });
    if (!dragRef.current) return;
    // 鼠标端不存在原生滚动抢手势的问题，按下即归抽屉（落在列表里的除外）
    if (dragRef.current.resolved === "scroll") {
      dragRef.current = null;
      return;
    }
    dragRef.current.resolved = "sheet";
    latest.current.onClaim?.();

    const onPointerMove = (moveEvent: PointerEvent) => {
      moveDrag(moveEvent.clientX, moveEvent.clientY);
    };
    const onPointerUp = (upEvent: PointerEvent) => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      endDrag(upEvent.clientY);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  };

  /** 把手键盘操作（a11y）：上下方向键在允许档位间移动，Esc 关闭可关闭档。 */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const { mode: currentMode, topForMode: top, allowedModes: allowed, onModeChange: change, onClose: close } =
      latest.current;
    if (event.key === "Escape" && close) {
      event.preventDefault();
      close();
      return;
    }
    const step = event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    // top 降序 = 抽屉由矮到高
    const ordered = [...allowed(currentMode)].sort((a, b) => top(b) - top(a));
    const from = ordered.indexOf(currentMode);
    if (from < 0) return;
    const next = ordered[Math.max(0, Math.min(ordered.length - 1, from + step))];
    if (next !== currentMode) {
      if (top(next) > top(currentMode)) latest.current.onDropToLowerMode?.();
      change(next);
    }
  };

  const dragging = dragRef.current?.resolved === "sheet";

  return { dragOffset, dragging, sheetRef, handlePointerDown, handleKeyDown };
}
