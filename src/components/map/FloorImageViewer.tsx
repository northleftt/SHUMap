import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, LoadingState } from "../ui/EmptyState";

// ---------------------------------------------------------------------------
// 楼层平面图位图查看器
//
// 楼层图不再是 SVG map_version，而是每层一张位图（floors.image_media_id →
// /api/public/media/<id>）。底图是 <img>，用 CSS transform（translate + scale，
// origin 0 0）做 pan/zoom：
//   屏幕坐标 = base.pos + scale · 图内坐标 + translate
// base 是 scale=1 时整图适配容器后的位置与尺寸，由容器尺寸与图片原始尺寸算出。
// ---------------------------------------------------------------------------

type Size = { width: number; height: number };
type Point = { x: number; y: number };
type Transform = { scale: number; x: number; y: number };

const DEFAULT_CONTAINER: Size = { width: 390, height: 520 };
const MIN_SCALE = 1;
const MAX_SCALE = 6;
const ZOOM_STEP = 1.25;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_TOLERANCE = 28;

const IDENTITY: Transform = { scale: 1, x: 0, y: 0 };

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** 整图适配容器（保持图片宽高比，短边留白居中）。 */
function fitRect(image: Size, container: Size): { x: number; y: number; width: number; height: number } {
  const fit = Math.min(container.width / Math.max(image.width, 1), container.height / Math.max(image.height, 1));
  const width = image.width * fit;
  const height = image.height * fit;
  return { x: (container.width - width) / 2, y: (container.height - height) / 2, width, height };
}

/**
 * 约束平移范围：图片不能完全拖出容器。缩放后的边比容器短时任其在容器内移动，
 * 比容器长时边缘不能露出空白。缩放本身在调用方卡 [MIN_SCALE, MAX_SCALE]。
 */
function clampTransform(transform: Transform, base: { x: number; y: number; width: number; height: number }, container: Size): Transform {
  const scaledWidth = transform.scale * base.width;
  const scaledHeight = transform.scale * base.height;
  const minX = Math.min(-base.x, container.width - base.x - scaledWidth);
  const maxX = Math.max(-base.x, container.width - base.x - scaledWidth);
  const minY = Math.min(-base.y, container.height - base.y - scaledHeight);
  const maxY = Math.max(-base.y, container.height - base.y - scaledHeight);
  return { scale: transform.scale, x: clamp(transform.x, minX, maxX), y: clamp(transform.y, minY, maxY) };
}

/** 以容器内某点为锚做缩放：锚点下的图内坐标在缩放前后保持不动。 */
function zoomTransformAt(current: Transform, anchor: Point, factor: number, base: { x: number; y: number; width: number; height: number }, container: Size): Transform {
  const scale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE);
  const ratio = scale / Math.max(current.scale, 1e-6);
  return clampTransform(
    {
      scale,
      x: anchor.x - base.x - ratio * (anchor.x - base.x - current.x),
      y: anchor.y - base.y - ratio * (anchor.y - base.y - current.y),
    },
    base,
    container,
  );
}

interface FloorImageViewerProps {
  /** 楼层图位图地址（/api/public/media/<id>）。 */
  src: string;
  alt: string;
}

export function FloorImageViewer(props: FloorImageViewerProps) {
  return <FloorImageCanvas key={props.src} {...props} />;
}

function FloorImageCanvas({ src, alt }: FloorImageViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const transformRef = useRef<Transform>(IDENTITY);
  const gestureRef = useRef({
    pointers: new Map<number, Point>(),
    panFrom: null as Point | null,
    pinch: null as { distance: number; transform: Transform; center: Point } | null,
    lastTap: null as { time: number; point: Point } | null,
  });

  const [container, setContainer] = useState<Size>(DEFAULT_CONTAINER);
  const [imageSize, setImageSize] = useState<Size | null>(null);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");
  const [transform, setTransform] = useState<Transform>(IDENTITY);

  const base = useMemo(() => (imageSize ? fitRect(imageSize, container) : null), [imageSize, container]);

  function applyTransform(next: Transform) {
    transformRef.current = next;
    setTransform(next);
  }

  // 每张图拥有独立状态，缓存命中的 onLoad 不会被后续初始化覆盖。
  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      setContainer({ width: rect.width, height: rect.height });
    });
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // 容器尺寸变化时把当前视野重新卡回合法范围（旋转屏幕 / 侧栏开合）
  useEffect(() => {
    if (!base) return;
    applyTransform(clampTransform(transformRef.current, base, container));
  }, [base, container]);

  // React 的 onWheel 是被动监听，preventDefault 不生效；滚轮缩放必须挂原生监听。
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    function handleWheel(event: WheelEvent) {
      event.preventDefault();
      const currentBase = base;
      if (!currentBase) return;
      const rect = element!.getBoundingClientRect();
      applyTransform(zoomTransformAt(
        transformRef.current,
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP,
        currentBase,
        container,
      ));
    }
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, [base, container]);

  /** 客户端坐标 → 容器内局部坐标。 */
  function toLocal(point: Point): Point {
    const rect = containerRef.current?.getBoundingClientRect();
    return { x: point.x - (rect?.left ?? 0), y: point.y - (rect?.top ?? 0) };
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!base) return;
    const gesture = gestureRef.current;
    gesture.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture(event.pointerId);
    if (gesture.pointers.size === 1) {
      gesture.panFrom = { x: event.clientX, y: event.clientY };
      gesture.pinch = null;
      // 双击 / 双击中（触摸没有可靠的 dblclick，统一在 pointerdown 里自己判）
      const now = Date.now();
      const point = { x: event.clientX, y: event.clientY };
      const last = gesture.lastTap;
      gesture.lastTap = { time: now, point };
      if (last && now - last.time <= DOUBLE_TAP_MS && distance(last.point, point) <= DOUBLE_TAP_TOLERANCE) {
        gesture.lastTap = null;
        gesture.panFrom = null;
        const target = transformRef.current.scale > MIN_SCALE + 0.05 ? MIN_SCALE : DOUBLE_TAP_SCALE;
        applyTransform(zoomTransformAt(transformRef.current, toLocal(point), target / transformRef.current.scale, base, container));
      }
    } else if (gesture.pointers.size === 2) {
      const [a, b] = Array.from(gesture.pointers.values());
      gesture.panFrom = null;
      gesture.pinch = { distance: distance(a, b), transform: transformRef.current, center: toLocal(midpoint(a, b)) };
    }
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!base) return;
    const gesture = gestureRef.current;
    if (!gesture.pointers.has(event.pointerId)) return;
    gesture.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (gesture.pinch && gesture.pointers.size >= 2) {
      const [a, b] = Array.from(gesture.pointers.values());
      const next = distance(a, b);
      if (gesture.pinch.distance <= 0 || next <= 0) return;
      applyTransform(zoomTransformAt(gesture.pinch.transform, gesture.pinch.center, next / gesture.pinch.distance, base, container));
      return;
    }

    if (!gesture.panFrom) return;
    const dx = event.clientX - gesture.panFrom.x;
    const dy = event.clientY - gesture.panFrom.y;
    gesture.panFrom = { x: event.clientX, y: event.clientY };
    const current = transformRef.current;
    applyTransform(clampTransform({ ...current, x: current.x + dx, y: current.y + dy }, base, container));
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

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full touch-none overflow-hidden bg-surface outline-none focus-visible:ring-2 focus-visible:ring-primary"
      tabIndex={0}
      role="region"
      aria-label={alt}
      onKeyDown={event => {
        if (!base) return;
        if (event.key === "0") { event.preventDefault(); applyTransform(IDENTITY); }
        if (["+", "=", "-"].includes(event.key)) { event.preventDefault(); applyTransform(zoomTransformAt(transformRef.current, {x: container.width / 2, y: container.height / 2}, event.key === "-" ? 1 / ZOOM_STEP : ZOOM_STEP, base, container)); }
      }}
      onPointerCancel={handlePointerUp}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      {loadedSrc !== src ? (
        <div className="grid h-full place-items-center">
          <LoadingState label="正在加载平面图…" />
        </div>
      ) : null}
      {/* base 还没算出来（图片未加载）时 img 也要挂着，否则永远拿不到 naturalSize */}
      <img
        alt={alt}
        className="absolute max-w-none select-none"
        draggable={false}
        onError={() => setLoadError("图片读取失败")}
        onLoad={(event) => {
          const image = event.currentTarget;
          setImageSize({ width: image.naturalWidth, height: image.naturalHeight });
          setLoadedSrc(src);
        }}
        src={src}
        style={{
          left: base?.x ?? 0,
          top: base?.y ?? 0,
          width: base?.width,
          height: base?.height,
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          transformOrigin: "0 0",
          visibility: base && loadedSrc === src ? "visible" : "hidden",
        }}
      />

      <div className="absolute bottom-3 right-3 flex flex-col overflow-hidden rounded-xl bg-surface shadow-card" onPointerDown={event => event.stopPropagation()}>
        <button type="button" aria-label="适应窗口" className="grid h-9 min-w-9 place-items-center px-2 text-label text-ink hover:bg-page" onClick={() => applyTransform(IDENTITY)}>适应</button>
        <button
          aria-label="放大"
          className="grid h-9 w-9 place-items-center text-ink active:bg-page"
          onClick={() => {
            if (!base) return;
            applyTransform(zoomTransformAt(transformRef.current, { x: container.width / 2, y: container.height / 2 }, ZOOM_STEP, base, container));
          }}
          type="button"
        >
          +
        </button>
        <button
          aria-label="缩小"
          className="grid h-9 w-9 place-items-center border-t border-line text-ink active:bg-page"
          onClick={() => {
            if (!base) return;
            applyTransform(zoomTransformAt(transformRef.current, { x: container.width / 2, y: container.height / 2 }, 1 / ZOOM_STEP, base, container));
          }}
          type="button"
        >
          −
        </button>
      </div>
    </div>
  );
}
