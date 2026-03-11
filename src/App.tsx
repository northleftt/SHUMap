import { useEffect } from "react";
import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import { BottomTabBar } from "./components/BottomTabBar";
import { useViewportMetrics } from "./lib/layout";
import { MapPage } from "./pages/MapPage";
import { PlaceholderPage } from "./pages/PlaceholderPage";
import { ShuttlePage } from "./pages/ShuttlePage";

function AppLayout() {
  const metrics = useViewportMetrics();

  useEffect(() => {
    if (metrics.isDesktopPreview) {
      return;
    }

    const visualViewport = window.visualViewport;
    let resetTimerIds: number[] = [];

    const keepViewportPinned = () => {
      const active = document.activeElement;
      const isTextField =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable);

      if (!isTextField) {
        return;
      }

      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    };

    const handleFocusIn = () => {
      keepViewportPinned();
      resetTimerIds.forEach((timerId) => window.clearTimeout(timerId));
      resetTimerIds = [0, 80, 180, 320].map((delay) =>
        window.setTimeout(keepViewportPinned, delay),
      );
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
  }, [metrics.isDesktopPreview]);

  return (
    <div
      className={`fixed inset-0 overflow-hidden ${
        metrics.isDesktopPreview ? "grid place-items-center p-4" : ""
      }`}
    >
      <div
        className={`relative overflow-hidden bg-[var(--color-page)] text-[var(--color-text)] ${
          metrics.isDesktopPreview
            ? "rounded-[36px] shadow-[0_24px_80px_rgba(15,23,42,0.18)]"
            : ""
        }`}
        style={{
          ["--tab-bar-height" as string]: `${metrics.tabBarHeight}px`,
          height: `${metrics.screenHeight}px`,
          width: `${metrics.shellWidth}px`,
        }}
      >
        <main className="h-full w-full">
          <Outlet />
        </main>
        <BottomTabBar height={metrics.tabBarHeight} />
      </div>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<Navigate to="/map" replace />} />
        <Route path="/map" element={<MapPage />} />
        <Route path="/shuttle" element={<ShuttlePage />} />
        <Route
          path="/offcampus"
          element={
            <PlaceholderPage
              title="校外"
              subtitle="功能还在更新当中，以后再来吧。"
            />
          }
        />
        <Route
          path="/profile"
          element={
            <PlaceholderPage
              title="我的"
              subtitle="这里会放意见反馈、设置和关于入口，当前先保留占位。"
            />
          }
        />
      </Route>
    </Routes>
  );
}
