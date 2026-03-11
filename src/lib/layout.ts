import { useEffect, useRef, useState } from "react";

const DESIGN_HEIGHT = 874;
const DESIGN_TAB_TOP = 785;
const MIN_TAB_BAR_HEIGHT_PX = 82;
const MAX_TAB_BAR_HEIGHT_PX = 96;
const SHEET_SIDE_INSET_RATIO = 0.04;
const MIN_SHEET_SIDE_INSET_PX = 12;
const MAX_SHEET_SIDE_INSET_PX = 18;
const TOP_INSET_RATIO = 0.03;
const MIN_TOP_INSET_PX = 18;
const MAX_TOP_INSET_PX = 28;
const MAX_SHELL_WIDTH_PX = 420;
const MIN_DESKTOP_SHELL_WIDTH_PX = 360;
const DESKTOP_SHELL_BASE_PX = 180;
const DESKTOP_SHELL_WIDTH_RATIO = 0.28;
const MAP_FADE_MIN_HEIGHT_PX = 220;
const MAP_FADE_MAX_HEIGHT_PX = 320;
const CAMPUS_SWITCHER_OFFSET_MIN_PX = 6;
const CAMPUS_SWITCHER_OFFSET_MAX_PX = 10;

function readViewport() {
  const visual = window.visualViewport;
  const hasFinePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  const layoutWidth = Math.round(window.innerWidth);
  const layoutHeight = Math.round(window.innerHeight);
  const visualWidth = Math.round(visual?.width ?? layoutWidth);
  const visualHeight = Math.round(visual?.height ?? layoutHeight);

  return {
    width: visualWidth,
    height: visualHeight,
    layoutHeight,
    visualHeight,
    hasFinePointer,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function computeMetrics(screenWidth: number, screenHeight: number, hasFinePointer: boolean) {
  const scale = screenHeight / DESIGN_HEIGHT;
  const contentHeight = screenHeight;
  const tabBarHeight = clamp(
    Math.round((DESIGN_HEIGHT - DESIGN_TAB_TOP) * scale),
    MIN_TAB_BAR_HEIGHT_PX,
    MAX_TAB_BAR_HEIGHT_PX,
  );
  const sheetSideInset = clamp(
    Math.round(screenWidth * SHEET_SIDE_INSET_RATIO),
    MIN_SHEET_SIDE_INSET_PX,
    MAX_SHEET_SIDE_INSET_PX,
  );
  const topInset = clamp(
    Math.round(screenHeight * TOP_INSET_RATIO),
    MIN_TOP_INSET_PX,
    MAX_TOP_INSET_PX,
  );
  const isDesktopPreview = hasFinePointer;
  const desktopShellWidth = clamp(
    Math.round(DESKTOP_SHELL_BASE_PX + screenWidth * DESKTOP_SHELL_WIDTH_RATIO),
    MIN_DESKTOP_SHELL_WIDTH_PX,
    MAX_SHELL_WIDTH_PX,
  );
  const shellWidth = isDesktopPreview
    ? Math.min(screenWidth, desktopShellWidth)
    : screenWidth;
  const usableMapHeight = contentHeight - tabBarHeight;
  const isCompactHeight = screenHeight < 780;
  const isShortHeight = screenHeight < 700;
  const isNarrowWidth = screenWidth < 370;
  const mapFadeOverlayHeight = clamp(
    Math.round(usableMapHeight * (isShortHeight ? 0.26 : 0.34)),
    MAP_FADE_MIN_HEIGHT_PX,
    MAP_FADE_MAX_HEIGHT_PX,
  );
  const campusSwitcherOffsetX = clamp(
    Math.round(screenWidth * 0.02),
    CAMPUS_SWITCHER_OFFSET_MIN_PX,
    CAMPUS_SWITCHER_OFFSET_MAX_PX,
  );

  return {
    screenWidth,
    screenHeight,
    scale,
    tabBarHeight,
    sheetSideInset,
    topInset,
    shellWidth,
    isDesktopPreview,
    usableMapHeight,
    isCompactHeight,
    isShortHeight,
    isNarrowWidth,
    mapFadeOverlayHeight,
    campusSwitcherOffsetX,
  };
}

export function useViewportMetrics() {
  const initialViewport = readViewport();
  const stableMobileHeightRef = useRef(
    initialViewport.hasFinePointer
      ? initialViewport.height
      : Math.max(initialViewport.layoutHeight, initialViewport.visualHeight),
  );
  const previousWidthRef = useRef(initialViewport.width);
  const [metrics, setMetrics] = useState(() =>
    computeMetrics(
      initialViewport.width,
      stableMobileHeightRef.current,
      initialViewport.hasFinePointer,
    ),
  );

  useEffect(() => {
    const visualViewport = window.visualViewport;
    const handleResize = () => {
      const viewport = readViewport();
      const widthChangedSignificantly = Math.abs(viewport.width - previousWidthRef.current) > 80;

      if (viewport.hasFinePointer) {
        stableMobileHeightRef.current = viewport.height;
      } else {
        const observedHeight = Math.max(viewport.layoutHeight, viewport.visualHeight);
        if (widthChangedSignificantly || observedHeight > stableMobileHeightRef.current) {
          stableMobileHeightRef.current = observedHeight;
        }
      }

      previousWidthRef.current = viewport.width;
      setMetrics(
        computeMetrics(
          viewport.width,
          viewport.hasFinePointer ? viewport.height : stableMobileHeightRef.current,
          viewport.hasFinePointer,
        ),
      );
    };

    window.addEventListener("resize", handleResize);
    visualViewport?.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      visualViewport?.removeEventListener("resize", handleResize);
    };
  }, []);

  return metrics;
}

export function scaleDesignY(designY: number, screenHeight: number) {
  return Math.round((designY / DESIGN_HEIGHT) * screenHeight);
}
