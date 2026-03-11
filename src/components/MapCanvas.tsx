import { useEffect, useMemo, useRef, useState } from "react";
import type { CampusConfig } from "../lib/types";

type Size = { width: number; height: number };
type Point = { x: number; y: number };
type ViewWindow = { x: number; y: number; width: number; height: number };

const FALLBACK_VIEWBOX_SIZE = 1000;
const DEFAULT_CONTAINER_SIZE: Size = { width: 390, height: 844 };
const MAX_ZOOM_SCALE = 6;
const DRAG_THRESHOLD_PX = 2;
const ZOOM_BUTTON_SCALE_FACTOR = 1.18;
const ZOOM_CONTROL_ANCHOR_OFFSET_PX = 48;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function parseViewBox(svgRaw: string) {
  const match = svgRaw.match(/viewBox="([^"]+)"/);
  if (!match) {
    return { width: FALLBACK_VIEWBOX_SIZE, height: FALLBACK_VIEWBOX_SIZE };
  }
  const [, values] = match;
  const [, , width, height] = values.split(/\s+/).map(Number);
  return { width, height };
}

function getDistance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function getMidpoint(a: Point, b: Point) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function createInitialViewport(
  campus: CampusConfig,
  viewBox: Size,
  container: Size,
) {
  const fitScale = Math.min(container.width / viewBox.width, container.height / viewBox.height);
  const scale = fitScale * campus.scaleMultiplier;
  const focusX = campus.focusPoint.x * viewBox.width;
  const focusY = campus.focusPoint.y * viewBox.height;
  return {
    scale,
    translateX: container.width / 2 - focusX * scale,
    translateY: container.height / 2 - focusY * scale,
  };
}

function viewportToWindow(
  viewport: ReturnType<typeof createInitialViewport>,
  container: Size,
): ViewWindow {
  return {
    x: -viewport.translateX / viewport.scale,
    y: -viewport.translateY / viewport.scale,
    width: container.width / viewport.scale,
    height: container.height / viewport.scale,
  };
}

function clampWindow(window: ViewWindow, viewBox: Size, edgePaddingRatio: number) {
  const padX = viewBox.width * edgePaddingRatio;
  const padY = viewBox.height * edgePaddingRatio;
  const maxX = Math.max(0, viewBox.width - window.width) + padX;
  const maxY = Math.max(0, viewBox.height - window.height) + padY;
  return {
    ...window,
    x: clamp(window.x, -padX, maxX),
    y: clamp(window.y, -padY, maxY),
  };
}

function getScale(window: ViewWindow, container: Size) {
  return container.width / window.width;
}

function getFitScale(viewBox: Size, container: Size) {
  return Math.min(container.width / viewBox.width, container.height / viewBox.height);
}

function getMinScale(campus: CampusConfig, viewBox: Size, container: Size) {
  return getFitScale(viewBox, container) * campus.minScaleMultiplier;
}

function createInitialWindow(campus: CampusConfig, viewBox: Size, container: Size) {
  return clampWindow(
    viewportToWindow(createInitialViewport(campus, viewBox, container), container),
    viewBox,
    campus.edgePaddingRatio,
  );
}

function createMapStyle() {
  return `
    svg {
      shape-rendering: geometricPrecision;
      text-rendering: geometricPrecision;
      image-rendering: optimizeQuality;
    }

    g[data-match="true"] path,
    g[data-match="true"] rect,
    g[data-match="true"] polygon,
    g[data-match="true"] ellipse,
    g[data-match="true"] circle,
    g[data-match="true"] polyline,
    g[data-match="true"] line {
      fill: rgba(215, 232, 243, 0.95) !important;
      stroke: #1e80c1 !important;
      stroke-width: 1.8 !important;
    }

    g[data-selected="true"] path,
    g[data-selected="true"] rect,
    g[data-selected="true"] polygon,
    g[data-selected="true"] ellipse,
    g[data-selected="true"] circle,
    g[data-selected="true"] polyline,
    g[data-selected="true"] line {
      fill: rgba(215, 232, 243, 1) !important;
      stroke: #1e80c1 !important;
      stroke-width: 3 !important;
    }
  `;
}

function findBuildingId(target: Element | null, validIds: string[]) {
  let current: Element | null = target;

  while (current) {
    const candidateId = current.getAttribute("id");
    if (candidateId && validIds.includes(candidateId)) {
      return candidateId;
    }
    current = current.parentElement;
  }

  return null;
}

function findBuildingIdAtPoint(
  clientX: number,
  clientY: number,
  validIds: string[],
) {
  const target = document.elementFromPoint(clientX, clientY);
  return findBuildingId(target, validIds);
}

function ZoomInIcon() {
  return (
    <svg aria-hidden="true" className="size-[18px]" viewBox="0 0 18 18" fill="none">
      <path d="M9 4.2V13.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M4.2 9H13.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function ZoomOutIcon() {
  return (
    <svg aria-hidden="true" className="size-[18px]" viewBox="0 0 18 18" fill="none">
      <path d="M4.2 9H13.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

interface MapCanvasProps {
  campus: CampusConfig;
  currentBuildingIds: string[];
  matchedIds: string[];
  selectedId: string | null;
  selectionFocusBounds?: {
    top: number;
    bottom: number;
  };
  onSelectBuilding: (svgElementId: string) => void;
  onTapEmpty?: () => void;
}

export function MapCanvas({
  campus,
  currentBuildingIds,
  matchedIds,
  selectedId,
  selectionFocusBounds,
  onSelectBuilding,
  onTapEmpty,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgHostRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const buildingIdsRef = useRef<string[]>(currentBuildingIds);
  const onSelectBuildingRef = useRef(onSelectBuilding);
  const onTapEmptyRef = useRef(onTapEmpty);
  const viewWindowRef = useRef<ViewWindow>({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  });
  const previousContainerRef = useRef<Size | null>(null);
  const previousCampusKeyRef = useRef(campus.key);
  const viewBox = useMemo(() => parseViewBox(campus.svgRaw), [campus.svgRaw]);
  const [containerSize, setContainerSize] = useState<Size>(DEFAULT_CONTAINER_SIZE);
  const [viewWindow, setViewWindow] = useState<ViewWindow>({
    x: 0,
    y: 0,
    width: viewBox.width,
    height: viewBox.height,
  });

  const gestureRef = useRef({
    pointers: new Map<number, Point>(),
    previousPanPoint: null as Point | null,
    pinchStart: null as
      | {
          distance: number;
          midpoint: Point;
          window: ViewWindow;
        }
      | null,
    dragged: false,
  });

  useEffect(() => {
    buildingIdsRef.current = currentBuildingIds;
  }, [currentBuildingIds]);

  useEffect(() => {
    onSelectBuildingRef.current = onSelectBuilding;
  }, [onSelectBuilding]);

  useEffect(() => {
    onTapEmptyRef.current = onTapEmpty;
  }, [onTapEmpty]);

  useEffect(() => {
    viewWindowRef.current = viewWindow;
  }, [viewWindow]);

  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setContainerSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!svgHostRef.current) {
      return;
    }

    svgHostRef.current.innerHTML = campus.svgRaw;
    const svg = svgHostRef.current.querySelector("svg");
    if (!svg) {
      return;
    }

    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.style.overflow = "hidden";
    svg.style.userSelect = "none";
    svg.style.display = "block";

    const styleElement = document.createElementNS("http://www.w3.org/2000/svg", "style");
    styleElement.textContent = createMapStyle();
    svg.prepend(styleElement);

    svgRef.current = svg;
    svg.setAttribute(
      "viewBox",
      `${viewWindowRef.current.x} ${viewWindowRef.current.y} ${viewWindowRef.current.width} ${viewWindowRef.current.height}`,
    );

    return () => {
      svgRef.current = null;
    };
  }, [campus.svgRaw, viewBox.height, viewBox.width]);

  useEffect(() => {
    const previousContainer = previousContainerRef.current;
    const campusChanged = previousCampusKeyRef.current !== campus.key;

    if (
      !previousContainer ||
      previousContainer.width <= 0 ||
      previousContainer.height <= 0 ||
      campusChanged
    ) {
      setViewWindow(createInitialWindow(campus, viewBox, containerSize));
    } else if (
      previousContainer.width !== containerSize.width ||
      previousContainer.height !== containerSize.height
    ) {
      setViewWindow((current) => {
        const centerX = current.x + current.width / 2;
        const centerY = current.y + current.height / 2;
        const nextAspect = containerSize.width / Math.max(containerSize.height, 1);
        const currentAspect = current.width / Math.max(current.height, 1);
        let nextWidth = current.width;
        let nextHeight = current.height;

        // On resize, preserve the current visible map coverage rather than the old zoom level.
        // This keeps the map from being cropped when the window gets narrower or shorter.
        if (nextAspect > currentAspect) {
          nextWidth = current.height * nextAspect;
        } else {
          nextHeight = current.width / nextAspect;
        }

        const minScale = getMinScale(campus, viewBox, containerSize);
        const nextScale = containerSize.width / nextWidth;

        if (nextScale < minScale) {
          nextWidth = containerSize.width / minScale;
          nextHeight = containerSize.height / minScale;
        }

        return clampWindow(
          {
            x: centerX - nextWidth / 2,
            y: centerY - nextHeight / 2,
            width: nextWidth,
            height: nextHeight,
          },
          viewBox,
          campus.edgePaddingRatio,
        );
      });
    }

    previousContainerRef.current = containerSize;
    previousCampusKeyRef.current = campus.key;
  }, [campus, containerSize, viewBox]);

  useEffect(() => {
    if (!svgRef.current) return;
    svgRef.current.setAttribute(
      "viewBox",
      `${viewWindow.x} ${viewWindow.y} ${viewWindow.width} ${viewWindow.height}`,
    );
  }, [viewWindow]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const matchedSet = new Set(matchedIds);
    for (const id of currentBuildingIds) {
      const group = svg.querySelector<SVGGElement>(`g[id="${id}"]`);
      if (!group) continue;
      group.dataset.match = matchedSet.has(id) ? "true" : "false";
      group.dataset.selected = selectedId === id ? "true" : "false";
      group.style.cursor = "pointer";
    }
  }, [currentBuildingIds, matchedIds, selectedId]);

  useEffect(() => {
    if (!selectedId || !svgRef.current) {
      return;
    }

    const target = svgRef.current.querySelector<SVGGElement>(`g[id="${selectedId}"]`);
    if (!target) {
      return;
    }

    const box = target.getBBox();
    const fitScale = Math.min(
      containerSize.width / viewBox.width,
      containerSize.height / viewBox.height,
    );
    const currentScale = getScale(viewWindowRef.current, containerSize);
    const nextScale = Math.max(currentScale, fitScale * campus.selectionScaleMultiplier);
    const nextWidth = containerSize.width / nextScale;
    const nextHeight = containerSize.height / nextScale;
    const safeTop = clamp(selectionFocusBounds?.top ?? 72, 0, containerSize.height - 1);
    const safeBottom = clamp(
      selectionFocusBounds?.bottom ?? containerSize.height - 120,
      safeTop + 40,
      containerSize.height,
    );
    const safePadding = Math.max(18, Math.min(36, (safeBottom - safeTop) * 0.08));
    const targetScreenY = safeTop + (safeBottom - safeTop) * 0.5;
    const boxCenterX = box.x + box.width / 2;
    const boxCenterY = box.y + box.height / 2;
    const idealY = boxCenterY - (targetScreenY / containerSize.height) * nextHeight;
    const minYForBoxVisible =
      box.y + box.height - ((safeBottom - safePadding) / containerSize.height) * nextHeight;
    const maxYForBoxVisible =
      box.y - ((safeTop + safePadding) / containerSize.height) * nextHeight;
    const nextY = clamp(idealY, minYForBoxVisible, maxYForBoxVisible);

    setViewWindow(
      clampWindow(
        {
          x: boxCenterX - nextWidth / 2,
          y: nextY,
          width: nextWidth,
          height: nextHeight,
        },
        viewBox,
        campus.selectionEdgePaddingRatio,
      ),
    );
  // viewWindow 通过 ref 读取，不列入依赖，避免每次平移/缩放都重新触发定位
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    campus.edgePaddingRatio,
    campus.selectionEdgePaddingRatio,
    campus.selectionScaleMultiplier,
    containerSize,
    selectedId,
    selectionFocusBounds,
    viewBox,
  ]);

  function zoomAt(point: Point, nextScale: number) {
    setViewWindow((current) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return current;
      const localX = point.x - rect.left;
      const localY = point.y - rect.top;
      const ratioX = localX / containerSize.width;
      const ratioY = localY / containerSize.height;
      const worldX = current.x + current.width * ratioX;
      const worldY = current.y + current.height * ratioY;
      const nextWidth = containerSize.width / nextScale;
      const nextHeight = containerSize.height / nextScale;

      return clampWindow(
        {
          x: worldX - nextWidth * ratioX,
          y: worldY - nextHeight * ratioY,
          width: nextWidth,
          height: nextHeight,
        },
        viewBox,
        campus.edgePaddingRatio,
      );
    });
  }

  function getZoomControlPoint() {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) {
      return null;
    }

    return {
      x: rect.right - ZOOM_CONTROL_ANCHOR_OFFSET_PX,
      y: rect.top + rect.height / 2,
    };
  }

  function handleZoomButtonClick(multiplier: number) {
    const point = getZoomControlPoint();
    if (!point) {
      return;
    }

    zoomAt(
      point,
      clamp(
        getScale(viewWindow, containerSize) * multiplier,
        getMinScale(campus, viewBox, containerSize),
        MAX_ZOOM_SCALE,
      ),
    );
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    const nextPoint = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current.pointers.set(event.pointerId, nextPoint);
    gestureRef.current.dragged = false;

    if (gestureRef.current.pointers.size === 1) {
      gestureRef.current.previousPanPoint = nextPoint;
    } else if (gestureRef.current.pointers.size === 2) {
      const points = [...gestureRef.current.pointers.values()];
      gestureRef.current.pinchStart = {
        distance: getDistance(points[0], points[1]),
        midpoint: getMidpoint(points[0], points[1]),
        window: viewWindow,
      };
    }
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!gestureRef.current.pointers.has(event.pointerId)) {
      return;
    }

    const nextPoint = { x: event.clientX, y: event.clientY };
    gestureRef.current.pointers.set(event.pointerId, nextPoint);

    if (gestureRef.current.pointers.size === 2 && gestureRef.current.pinchStart) {
      const [a, b] = [...gestureRef.current.pointers.values()];
      const distance = getDistance(a, b);
      const midpoint = getMidpoint(a, b);
      const ratio = distance / gestureRef.current.pinchStart.distance;
      const startScale = getScale(gestureRef.current.pinchStart.window, containerSize);
      const minScale = getMinScale(campus, viewBox, containerSize);
      const nextScale = clamp(
        startScale * ratio,
        minScale,
        MAX_ZOOM_SCALE,
      );

      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const localX = midpoint.x - rect.left;
      const localY = midpoint.y - rect.top;
      const ratioX = localX / containerSize.width;
      const ratioY = localY / containerSize.height;
      const worldX =
        gestureRef.current.pinchStart.window.x +
        gestureRef.current.pinchStart.window.width * ratioX;
      const worldY =
        gestureRef.current.pinchStart.window.y +
        gestureRef.current.pinchStart.window.height * ratioY;
      const nextWidth = containerSize.width / nextScale;
      const nextHeight = containerSize.height / nextScale;

      gestureRef.current.dragged = true;

      setViewWindow(
        clampWindow(
          {
            x: worldX - nextWidth * ratioX,
            y: worldY - nextHeight * ratioY,
            width: nextWidth,
            height: nextHeight,
          },
          viewBox,
          campus.edgePaddingRatio,
        ),
      );
      return;
    }

    if (gestureRef.current.previousPanPoint) {
      const deltaX = nextPoint.x - gestureRef.current.previousPanPoint.x;
      const deltaY = nextPoint.y - gestureRef.current.previousPanPoint.y;

      if (Math.abs(deltaX) > DRAG_THRESHOLD_PX || Math.abs(deltaY) > DRAG_THRESHOLD_PX) {
        gestureRef.current.dragged = true;
      }

      setViewWindow((current) => {
        const scale = getScale(current, containerSize);
        return clampWindow(
          {
            ...current,
            x: current.x - deltaX / scale,
            y: current.y - deltaY / scale,
          },
          viewBox,
          campus.edgePaddingRatio,
        );
      });
      gestureRef.current.previousPanPoint = nextPoint;
    }
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const hadSinglePointer = gestureRef.current.pointers.size === 1;
    const shouldSelect = hadSinglePointer && !gestureRef.current.dragged;

    gestureRef.current.pointers.delete(event.pointerId);
    if (gestureRef.current.pointers.size < 2) {
      gestureRef.current.pinchStart = null;
    }

    if (gestureRef.current.pointers.size === 1) {
      gestureRef.current.previousPanPoint = [...gestureRef.current.pointers.values()][0];
    } else {
      gestureRef.current.previousPanPoint = null;
    }

    if (shouldSelect) {
      const svgElementId = findBuildingIdAtPoint(
        event.clientX,
        event.clientY,
        buildingIdsRef.current,
      );
      if (svgElementId) {
        onSelectBuildingRef.current(svgElementId);
      } else {
        onTapEmptyRef.current?.();
      }
    }

    gestureRef.current.dragged = false;
  }

  function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
    const delta = event.deltaY > 0 ? -0.18 : 0.18;
    const minScale = getMinScale(campus, viewBox, containerSize);
    const nextScale = clamp(
      getScale(viewWindow, containerSize) * (1 + delta),
      minScale,
      MAX_ZOOM_SCALE,
    );
    zoomAt({ x: event.clientX, y: event.clientY }, nextScale);
  }

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden bg-[#f6f1e6]">
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at top, rgba(215,232,243,0.18), transparent 32%), linear-gradient(180deg, rgba(255,255,255,0.1), rgba(255,251,242,0.16))",
        }}
      />
      <div
        className="absolute inset-0 touch-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={handleWheel}
      >
        <div ref={svgHostRef} className="absolute inset-0" />
      </div>

      <div className="absolute right-4 top-1/2 z-20 -translate-y-1/2 overflow-hidden rounded-[18px] border border-white/80 bg-white/94 shadow-[var(--shadow-floating)] backdrop-blur-md">
        <button
          aria-label="放大地图"
          className="grid h-12 w-11 place-items-center text-[var(--color-text-muted)] transition-colors hover:bg-[rgba(241,245,249,0.8)]"
          onClick={() => handleZoomButtonClick(ZOOM_BUTTON_SCALE_FACTOR)}
          type="button"
        >
          <ZoomInIcon />
        </button>
        <div className="mx-2 h-px bg-[rgba(203,213,225,0.9)]" />
        <button
          aria-label="缩小地图"
          className="grid h-12 w-11 place-items-center text-[var(--color-text-muted)] transition-colors hover:bg-[rgba(241,245,249,0.8)]"
          onClick={() => handleZoomButtonClick(1 / ZOOM_BUTTON_SCALE_FACTOR)}
          type="button"
        >
          <ZoomOutIcon />
        </button>
      </div>
    </div>
  );
}
