import { useEffect, useMemo, useRef, useState } from "react";
import { parseSvgViewBox, type SvgViewBox } from "../../../shared/svg-geometry.mjs";
import { fetchMapAssetSvg } from "../../lib/api/public";
import { FacilityGlyph } from "../../lib/facilityIcons";
import { sanitizeSvg } from "../../lib/svg/sanitize";
import { EmptyState, LoadingState } from "../ui/EmptyState";

// ---------------------------------------------------------------------------
// M5 楼层平面图画布
//
// 底图来自线上资产（GET /api/public/maps/:mapVersionId/asset），内联为 DOM 后
// 靠改写 viewBox 做 pan/zoom（与 MapCanvas 同一套思路，但楼层图没有校区那套
// focusPoint/scaleMultiplier 配置，初始视野固定为整图适配）。
//
// 设施徽章不画进 SVG，而是按视口换算成绝对定位的 HTML 节点，这样图标可以直接
// 复用 lucide 组件与 M2 徽章样式。视野窗口的宽高比始终与容器一致，因此
// viewBox 坐标 → 屏幕坐标是线性映射。
// ---------------------------------------------------------------------------

export interface FloorPlanAnchor {
  /** entity_locations 绑定 id，仅作 React key */
  id: string;
  facilityId: string;
  /** svg_viewbox 坐标 */
  x: number;
  y: number;
  label: string;
  typeCode: string;
  /**
   * 管理员在后台给这个设施类型选的 icon_key（含自定义图标的 custom- 键）。
   *
   * 为什么不在这里按 typeCode 自己查：这个组件手上没有 release manifest，而
   * typeCode → 图标的猜测只对出厂九类成立（见 facilityIcons 的
   * FACILITY_TYPE_CODE_ICON_KEYS）。由调用方解析好传进来，后台新建的类型才能显示对。
   */
  iconKey: string | null;
}

type Size = { width: number; height: number };
type Point = { x: number; y: number };
type ViewWindow = { x: number; y: number; width: number; height: number };

const DEFAULT_CONTAINER: Size = { width: 390, height: 520 };
const MAX_ZOOM = 8;
const EDGE_PADDING_RATIO = 0.12;
const ZOOM_STEP = 1.25;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 底图 SVG 来自上传资产而非仓库内静态文件，内联进应用 DOM 前先净化：
 * innerHTML 不执行 <script>，但 on* 事件属性、javascript: href、foreignObject
 * 里的 HTML 都会活过来。白名单之外一律剥掉，解析失败返回 null 由调用方报错。
 */
/** 整图适配容器（保持容器宽高比，短边留白居中）。 */
function fitWindow(viewBox: SvgViewBox, container: Size): ViewWindow {
  const containerAspect = container.width / Math.max(container.height, 1);
  const boxAspect = viewBox.width / viewBox.height;
  let width = viewBox.width;
  let height = viewBox.height;
  if (containerAspect > boxAspect) width = viewBox.height * containerAspect;
  else height = viewBox.width / containerAspect;
  return {
    x: viewBox.x + (viewBox.width - width) / 2,
    y: viewBox.y + (viewBox.height - height) / 2,
    width,
    height,
  };
}

/**
 * 约束缩放级别与平移范围。缩放两端都要卡住：放大到 minWidth（MAX_ZOOM），
 * 缩小到 maxWidth（整图适配视野），否则手势可以把图缩成一个点。
 */
function clampWindow(
  window: ViewWindow,
  viewBox: SvgViewBox,
  minWidth: number,
  maxWidth: number,
): ViewWindow {
  const width = clamp(window.width, minWidth, Math.max(minWidth, maxWidth));
  const height = window.height * (width / Math.max(window.width, 1e-6));
  const padX = viewBox.width * EDGE_PADDING_RATIO;
  const padY = viewBox.height * EDGE_PADDING_RATIO;
  const minX = viewBox.x - padX;
  const maxX = viewBox.x + Math.max(0, viewBox.width - width) + padX;
  const minY = viewBox.y - padY;
  const maxY = viewBox.y + Math.max(0, viewBox.height - height) + padY;
  return {
    width,
    height,
    x: clamp(window.x, minX, Math.max(minX, maxX)),
    y: clamp(window.y, minY, Math.max(minY, maxY)),
  };
}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** 底图只做展示：禁掉交互与文字选中，避免手势被 SVG 内部元素吞掉。 */
const PLAN_STYLE = `
  svg { shape-rendering: geometricPrecision; text-rendering: geometricPrecision; }
  svg * { pointer-events: none; }
`;

interface FloorPlanCanvasProps {
  mapVersionId: string;
  anchors: FloorPlanAnchor[];
  selectedFacilityId: string | null;
  onSelectFacility: (facilityId: string | null) => void;
}

export function FloorPlanCanvas({
  mapVersionId,
  anchors,
  selectedFacilityId,
  onSelectFacility,
}: FloorPlanCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const windowRef = useRef<ViewWindow | null>(null);
  const initializedRef = useRef(false);
  const gestureRef = useRef({
    pointers: new Map<number, Point>(),
    panFrom: null as Point | null,
    pinch: null as { distance: number; window: ViewWindow; center: Point } | null,
  });

  const [svgRaw, setSvgRaw] = useState<string | null>(null);
  const [viewBox, setViewBox] = useState<SvgViewBox | null>(null);
  const [loadError, setLoadError] = useState("");
  const [container, setContainer] = useState<Size>(DEFAULT_CONTAINER);
  const [viewWindow, setViewWindow] = useState<ViewWindow | null>(null);

  const maxWidth = useMemo(() => viewBox ? fitWindow(viewBox, container).width : null, [viewBox, container]);
  const minWidth = maxWidth === null ? null : maxWidth / MAX_ZOOM;

  // 切换楼层 = 换 mapVersionId，重新取图并重置视野
  useEffect(() => {
    const controller = new AbortController();
    setSvgRaw(null);
    setViewBox(null);
    setViewWindow(null);
    windowRef.current = null;
    setLoadError("");
    initializedRef.current = false;
    fetchMapAssetSvg(mapVersionId, controller.signal)
      .then((raw) => {
        const parsedViewBox = parseSvgViewBox(raw);
        setViewBox(parsedViewBox);
        setSvgRaw(raw);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(error instanceof Error ? error.message : "底图读取失败");
      });
    return () => controller.abort();
  }, [mapVersionId]);

  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      setContainer({ width: rect.width, height: rect.height });
    });
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // 内联底图 DOM
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !svgRaw) return;
    const sanitized = sanitizeSvg(svgRaw);
    if (!sanitized) {
      setLoadError("底图不是有效的 SVG");
      return;
    }
    host.innerHTML = sanitized;
    const svg = host.querySelector("svg");
    if (!svg) {
      setLoadError("底图不是有效的 SVG");
      return;
    }
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.style.display = "block";
    svg.style.userSelect = "none";
    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = PLAN_STYLE;
    svg.prepend(style);
    svgRef.current = svg;
    const current = windowRef.current;
    if (current) svg.setAttribute("viewBox", `${current.x} ${current.y} ${current.width} ${current.height}`);
    return () => {
      svgRef.current = null;
      host.innerHTML = "";
    };
  }, [svgRaw]);

  // 首次拿到底图尺寸/容器尺寸后适配整图；之后容器变化只保持中心与覆盖范围
  useEffect(() => {
    if (!svgRaw || !viewBox || minWidth === null || maxWidth === null) return;
    if (!initializedRef.current) {
      initializedRef.current = true;
      setViewWindow(clampWindow(fitWindow(viewBox, container), viewBox, minWidth, maxWidth));
      return;
    }
    setViewWindow((current) => {
      if (!current) return clampWindow(fitWindow(viewBox, container), viewBox, minWidth, maxWidth);
      const centerX = current.x + current.width / 2;
      const centerY = current.y + current.height / 2;
      const aspect = container.width / Math.max(container.height, 1);
      const width = current.width;
      const height = width / aspect;
      return clampWindow({ x: centerX - width / 2, y: centerY - height / 2, width, height }, viewBox, minWidth, maxWidth);
    });
  }, [svgRaw, viewBox, container, minWidth, maxWidth]);

  useEffect(() => {
    if (!viewWindow) return;
    windowRef.current = viewWindow;
    svgRef.current?.setAttribute("viewBox", `${viewWindow.x} ${viewWindow.y} ${viewWindow.width} ${viewWindow.height}`);
  }, [viewWindow]);

  /** 以容器内某点为锚做缩放。 */
  function zoomAt(local: Point, factor: number) {
    if (!viewBox || minWidth === null || maxWidth === null) return;
    setViewWindow((current) => {
      if (!current) return null;
      const ratioX = local.x / Math.max(container.width, 1);
      const ratioY = local.y / Math.max(container.height, 1);
      const worldX = current.x + current.width * ratioX;
      const worldY = current.y + current.height * ratioY;
      const width = current.width / factor;
      const height = current.height / factor;
      return clampWindow(
        { x: worldX - width * ratioX, y: worldY - height * ratioY, width, height },
        viewBox,
        minWidth,
        maxWidth,
      );
    });
  }

  /** 客户端坐标 → 容器内局部坐标。手势里存的是 {x,y} 客户端点，事件是 clientX/clientY。 */
  function toLocal(point: Point): Point {
    const rect = containerRef.current?.getBoundingClientRect();
    return { x: point.x - (rect?.left ?? 0), y: point.y - (rect?.top ?? 0) };
  }

  function localPoint(event: { clientX: number; clientY: number }): Point {
    return toLocal({ x: event.clientX, y: event.clientY });
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    gesture.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture(event.pointerId);
    if (gesture.pointers.size === 1) {
      gesture.panFrom = { x: event.clientX, y: event.clientY };
      gesture.pinch = null;
    } else if (gesture.pointers.size === 2) {
      const [a, b] = Array.from(gesture.pointers.values());
      const currentWindow = windowRef.current;
      if (!currentWindow) return;
      gesture.panFrom = null;
      gesture.pinch = { distance: distance(a, b), window: currentWindow, center: toLocal(midpoint(a, b)) };
    }
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!viewBox || minWidth === null || maxWidth === null) return;
    const gesture = gestureRef.current;
    if (!gesture.pointers.has(event.pointerId)) return;
    gesture.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (gesture.pinch && gesture.pointers.size >= 2) {
      const [a, b] = Array.from(gesture.pointers.values());
      const next = distance(a, b);
      if (gesture.pinch.distance <= 0 || next <= 0) return;
      const factor = next / gesture.pinch.distance;
      const start = gesture.pinch.window;
      const ratioX = gesture.pinch.center.x / Math.max(container.width, 1);
      const ratioY = gesture.pinch.center.y / Math.max(container.height, 1);
      const worldX = start.x + start.width * ratioX;
      const worldY = start.y + start.height * ratioY;
      const width = start.width / factor;
      const height = start.height / factor;
      setViewWindow(
        clampWindow({ x: worldX - width * ratioX, y: worldY - height * ratioY, width, height }, viewBox, minWidth, maxWidth),
      );
      return;
    }

    if (!gesture.panFrom) return;
    const dx = event.clientX - gesture.panFrom.x;
    const dy = event.clientY - gesture.panFrom.y;
    gesture.panFrom = { x: event.clientX, y: event.clientY };
    setViewWindow((current) =>
      current ? clampWindow(
        {
          ...current,
          x: current.x - (dx / Math.max(container.width, 1)) * current.width,
          y: current.y - (dy / Math.max(container.height, 1)) * current.height,
        },
        viewBox,
        minWidth,
        maxWidth,
      ) : null,
    );
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    gesture.pointers.delete(event.pointerId);
    gesture.pinch = null;
    const remaining = Array.from(gesture.pointers.values());
    gesture.panFrom = remaining.length === 1 ? remaining[0] : null;
  }

  if (loadError) {
    return (
      <div className="grid h-full place-items-center">
        <EmptyState title="平面图加载失败" subtitle={loadError} />
      </div>
    );
  }
  if (!svgRaw || !viewBox || !viewWindow) {
    return (
      <div className="grid h-full place-items-center">
        <LoadingState label="正在加载平面图…" />
      </div>
    );
  }

  const scaleX = container.width / Math.max(viewWindow.width, 1e-6);
  const scaleY = container.height / Math.max(viewWindow.height, 1e-6);

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full touch-none overflow-hidden bg-surface"
      onPointerCancel={handlePointerUp}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onWheel={(event) => {
        event.preventDefault();
        zoomAt(localPoint(event), event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
      }}
    >
      <div ref={hostRef} className="absolute inset-0" />

      {anchors.map((anchor) => {
        const left = (anchor.x - viewWindow.x) * scaleX;
        const top = (anchor.y - viewWindow.y) * scaleY;
        if (left < -40 || top < -40 || left > container.width + 40 || top > container.height + 40) return null;
        const active = anchor.facilityId === selectedFacilityId;
        return (
          <button
            key={anchor.id}
            aria-label={anchor.label}
            className="absolute grid h-8 w-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full shadow-card ring-2 ring-white transition-transform"
            data-facility-id={anchor.facilityId}
            style={{
              left,
              top,
              backgroundColor: active ? "var(--color-primary)" : "var(--color-primary-container)",
              color: active ? "#ffffff" : "var(--color-primary)",
              transform: `translate(-50%, -50%) scale(${active ? 1.15 : 1})`,
            }}
            onClick={() => onSelectFacility(active ? null : anchor.facilityId)}
            type="button"
          >
            <FacilityGlyph iconKey={anchor.iconKey} ink={active ? "white" : "primary"} size={16} />
          </button>
        );
      })}

      <div className="absolute bottom-3 right-3 flex flex-col overflow-hidden rounded-xl bg-surface shadow-card">
        <button
          aria-label="放大"
          className="grid h-9 w-9 place-items-center text-ink active:bg-page"
          onClick={() => zoomAt({ x: container.width / 2, y: container.height / 2 }, ZOOM_STEP)}
          type="button"
        >
          +
        </button>
        <button
          aria-label="缩小"
          className="grid h-9 w-9 place-items-center border-t border-line text-ink active:bg-page"
          onClick={() => zoomAt({ x: container.width / 2, y: container.height / 2 }, 1 / ZOOM_STEP)}
          type="button"
        >
          −
        </button>
      </div>
    </div>
  );
}
