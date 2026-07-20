import { useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { useBreakpoint } from "../../lib/hooks/useBreakpoint";
import { BottomTabBar, TAB_BAR_HEIGHT } from "./BottomTabBar";
import { DesktopRail } from "./DesktopRail";

/**
 * 用户侧响应式壳：<768 底部 Tab 栏；≥768 左侧图标栏（≥1024 三栏由各页面自己布局）。
 * 不再有桌面伪手机壳。
 */
export function AppLayout() {
  const breakpoint = useBreakpoint();
  const isMobile = breakpoint === "mobile";
  const location = useLocation();
  const mapOwnsBottomInset = location.pathname === "/map";

  // iOS 键盘弹起压缩 visualViewport 时保持布局钉住（仅移动端）
  useEffect(() => {
    if (!isMobile) return;
    const visualViewport = window.visualViewport;
    let resetTimerIds: number[] = [];

    const keepViewportPinned = () => {
      const active = document.activeElement;
      const isTextField =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable);
      if (!isTextField) return;
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    };

    const handleFocusIn = () => {
      keepViewportPinned();
      resetTimerIds.forEach((timerId) => window.clearTimeout(timerId));
      resetTimerIds = [0, 80, 180, 320].map((delay) => window.setTimeout(keepViewportPinned, delay));
    };

    document.addEventListener("focusin", handleFocusIn);
    window.addEventListener("scroll", keepViewportPinned, { passive: true });
    visualViewport?.addEventListener("scroll", keepViewportPinned);
    visualViewport?.addEventListener("resize", keepViewportPinned);

    return () => {
      resetTimerIds.forEach((timerId) => window.clearTimeout(timerId));
      document.removeEventListener("focusin", handleFocusIn);
      window.removeEventListener("scroll", keepViewportPinned);
      visualViewport?.removeEventListener("scroll", keepViewportPinned);
      visualViewport?.removeEventListener("resize", keepViewportPinned);
    };
  }, [isMobile]);

  return (
    <div
      className="flex h-full w-full bg-page text-ink"
      style={{ ["--tab-bar-height" as string]: `${TAB_BAR_HEIGHT}px` }}
    >
      {!isMobile && <DesktopRail />}
      <div className="relative min-w-0 flex-1">
        <main
          className="h-full w-full"
          style={{
            paddingBottom: isMobile && !mapOwnsBottomInset
              ? `calc(${TAB_BAR_HEIGHT}px + env(safe-area-inset-bottom))`
              : undefined,
          }}
        >
          <Outlet />
        </main>
        {isMobile && <BottomTabBar />}
      </div>
    </div>
  );
}
