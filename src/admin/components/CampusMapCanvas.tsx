import { Check, Hexagon, MapPin, Route, Trash2, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseSvgViewBox } from "../../../shared/svg-geometry.mjs";
import * as admin from "../../lib/api/admin";
import type { GeometryType, JsonObject } from "../../../shared/revision-contract";
import type { CampusConfig, CampusKey } from "../../lib/types";
import type { Campus } from "../adminTypes";
import { Chip, EmptyState, ErrorBanner, errorMessage } from "./primitives";

// ---------------------------------------------------------------------------
// 校园底图绘制画布（点 / 区域 / 路径，坐标写 svg_viewbox）
//
// 从 A6 运营事件页抽出：运营事件、地点位置、设施服务位置共用同一套
// preserveAspectRatio 反投影与绘制状态机，否则三处各写一遍必然漂移。
//
// 拆成 hook + 三块视图而不是一个整体组件，是因为运营事件页的工具栏在左侧表单
// 面板内、底图在右侧面板内，两者不在同一棵子树，一个组件无法同时渲染；各面板
// 的内外边距也归调用方，抽出来的视图不带自己的布局假设。
// ---------------------------------------------------------------------------

export type CanvasTool = "point" | "area" | "path";
export type CanvasVert = [number, number];

/** 画布上的已完成几何；campusKey 记录这些坐标属于哪张校园底图。 */
export interface CanvasGeometry {
  campusKey: CampusKey;
  point: CanvasVert | null;
  /** 开放环：不含 GeoJSON 收尾的重复点。 */
  area: CanvasVert[] | null;
  path: CanvasVert[] | null;
}

/** 已取到底图的校区；id / mapVersionId 供调用方拼位置载荷。 */
export type CanvasCampus = CampusConfig;

const AREA_COLOR = "#f59e0b";
const POINT_COLOR = "#1e80c1";
const PATH_COLOR = "#1e80c1";

/** chip 与清单的固定顺序，与 tools 传入顺序无关。 */
const TOOL_ORDER: readonly CanvasTool[] = ["point", "area", "path"];
const TOOL_ICONS: Record<CanvasTool, typeof MapPin> = { point: MapPin, area: Hexagon, path: Route };
const TOOL_COLORS: Record<CanvasTool, string> = { point: POINT_COLOR, area: AREA_COLOR, path: PATH_COLOR };
const TOOL_NAMES: Record<CanvasTool, string> = { point: "点", area: "区域", path: "路径" };

export function viewBoxOf(svgRaw: string): { x: number; y: number; w: number; h: number } {
  const viewBox = parseSvgViewBox(svgRaw);
  return { x: viewBox.x, y: viewBox.y, w: viewBox.width, h: viewBox.height };
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function dist(a: CanvasVert, b: CanvasVert): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function shapeExtent(vertices: CanvasVert[]): string {
  const xs = vertices.map((v) => v[0]);
  const ys = vertices.map((v) => v[1]);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  return `${Math.round(w)}×${Math.round(h)}`;
}

export function pathLength(vertices: CanvasVert[]): number {
  let sum = 0;
  for (let i = 1; i < vertices.length; i++) sum += dist(vertices[i - 1], vertices[i]);
  return sum;
}

/**
 * campuses[].code is the canonical key ("baoshan"); ids are "campus_baoshan".
 * Both forms are accepted so the lookup never silently misses — a failed match
 * blocks the save instead of writing a campus-less (all-campus) event.
 */
export function campusKeyOfRow(row: { code: string }): CampusKey {
  const code = row.code.trim().toLowerCase();
  if (code !== "baoshan" && code !== "jiading" && code !== "yanchang") {
    throw new Error(`未知校区代码：${row.code}`);
  }
  return code;
}

export const CAMPUS_DISPLAY: Record<CampusKey, Omit<CampusConfig, "id" | "key" | "label" | "mapVersionId" | "svgRaw">> = {
  baoshan: { focusPoint: { x: 0.48, y: 0.43 }, scaleMultiplier: 1.78, minScaleMultiplier: 1, edgePaddingRatio: 0.18, selectionEdgePaddingRatio: 0.3, selectionScaleMultiplier: 2.15 },
  jiading: { focusPoint: { x: 0.37, y: 0.5 }, scaleMultiplier: 3.05, minScaleMultiplier: 1, edgePaddingRatio: 0.3, selectionEdgePaddingRatio: 0.4, selectionScaleMultiplier: 2.4 },
  yanchang: { focusPoint: { x: 0.52, y: 0.46 }, scaleMultiplier: 0.8, minScaleMultiplier: 1, edgePaddingRatio: 0.2, selectionEdgePaddingRatio: 0.32, selectionScaleMultiplier: 1.35 },
};

export function isVert(value: unknown): value is CanvasVert {
  return Array.isArray(value) && value.length === 2
    && typeof value[0] === "number" && Number.isFinite(value[0])
    && typeof value[1] === "number" && Number.isFinite(value[1]);
}

export function vertsOf(value: unknown): CanvasVert[] {
  if (!Array.isArray(value)) throw new Error("几何坐标必须是数组");
  return value.map((vertex, index) => {
    if (!isVert(vertex)) throw new Error(`第 ${index + 1} 个几何坐标无效`);
    return [vertex[0], vertex[1]];
  });
}

/** Drops the duplicated closing vertex a GeoJSON ring carries. */
export function openRing(ring: CanvasVert[]): CanvasVert[] {
  if (ring.length >= 2) {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) return ring.slice(0, -1);
  }
  return ring;
}

/** 画布产出的坐标系；写库时必须与 mapVersionId 同时给出。 */
export const CANVAS_CRS = "svg_viewbox";

/**
 * 单图形位置（地点 / 设施每行只有一处几何）：画布几何 → GeoJSON。
 * 取哪一块由 tool 决定，因此一行位置永远只写一种几何类型。
 */
export function geoJsonOfCanvas(
  geometry: CanvasGeometry,
  tool: CanvasTool,
): { geometryType: GeometryType; geometry: JsonObject } | null {
  if (tool === "point") {
    if (!geometry.point) return null;
    return { geometryType: "Point", geometry: { type: "Point", coordinates: [geometry.point[0], geometry.point[1]] } };
  }
  if (tool === "area") {
    if (!geometry.area) return null;
    return { geometryType: "Polygon", geometry: { type: "Polygon", coordinates: [[...geometry.area, geometry.area[0]]] } };
  }
  if (!geometry.path) return null;
  return { geometryType: "LineString", geometry: { type: "LineString", coordinates: geometry.path } };
}

/** 单图形位置：已存 GeoJSON → 画布几何；形状与 tool 不符即抛，不静默丢弃。 */
export function canvasOfGeoJson(value: unknown, tool: CanvasTool, campusKey: CampusKey, field: string): CanvasGeometry {
  const blank: CanvasGeometry = { campusKey, point: null, area: null, path: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} 必须是 GeoJSON 对象`);
  const { type, coordinates } = value as { type?: unknown; coordinates?: unknown };
  if (tool === "point") {
    if (type !== "Point" || !isVert(coordinates)) throw new Error(`${field} 必须是一个有效的 Point`);
    return { ...blank, point: [coordinates[0], coordinates[1]] };
  }
  if (tool === "area") {
    if (type !== "Polygon" || !Array.isArray(coordinates) || coordinates.length !== 1) {
      throw new Error(`${field} 必须是单环 Polygon`);
    }
    const ring = openRing(vertsOf(coordinates[0]));
    if (ring.length < 3) throw new Error(`${field} 至少需要三个顶点`);
    return { ...blank, area: ring };
  }
  if (type !== "LineString") throw new Error(`${field} 必须是 LineString`);
  const vertices = vertsOf(coordinates);
  if (vertices.length < 2) throw new Error(`${field} 至少需要两个顶点`);
  return { ...blank, path: vertices };
}

/** 单图形位置回显时按已存 geometryType 选工具；MultiPolygon 画不出来。 */
export function canvasToolOfGeometryType(geometryType: GeometryType): CanvasTool | null {
  if (geometryType === "Point") return "point";
  if (geometryType === "Polygon") return "area";
  if (geometryType === "LineString") return "path";
  return null;
}

function shapeOf(geometry: CanvasGeometry | null, tool: CanvasTool): CanvasVert | CanvasVert[] | null {
  if (!geometry) return null;
  return tool === "point" ? geometry.point : tool === "area" ? geometry.area : geometry.path;
}

/**
 * 一行位置只存一处几何，而画布握着三个槽位。调用方传进去的 value 永远是单槽位，
 * 所以 hook 合并后最多两个非空槽：旧的那个引用未变，新画的是新引用，按引用即可
 * 认出该留哪一个。不做这步收敛，写载荷时另一个形状会被无声丢掉。
 */
export function pickSingleShape(
  previous: CanvasGeometry | null,
  next: CanvasGeometry | null,
): { tool: CanvasTool; geometry: CanvasGeometry } | null {
  if (!next) return null;
  const drawn = TOOL_ORDER.filter((tool) => shapeOf(next, tool) !== null);
  if (drawn.length === 0) return null;
  const fresh = drawn.filter((tool) => shapeOf(next, tool) !== shapeOf(previous, tool));
  const tool = (fresh.length > 0 ? fresh : drawn)[0];
  const blank: CanvasGeometry = { campusKey: next.campusKey, point: null, area: null, path: null };
  if (tool === "point") return { tool, geometry: { ...blank, point: next.point } };
  if (tool === "area") return { tool, geometry: { ...blank, area: next.area } };
  return { tool, geometry: { ...blank, path: next.path } };
}

/** 校区级底图版本：ready / published 且不挂楼层。 */
export function campusMapVersions(mapVersions: admin.MapVersionRow[]): admin.MapVersionRow[] {
  return mapVersions.filter((map) => map.campusId && !map.floorId && ["ready", "published"].includes(map.lifecycleStatus));
}

/**
 * 画布坐标必须同时带 crs 与 mapVersionId 才能过 normalizeLocationInput，
 * 所以调用方写载荷前一律经这里把 campusKey 解析成实打实的两个 id。
 */
export function campusMapBinding(
  campusKey: CampusKey,
  campuses: Campus[],
  mapVersions: admin.MapVersionRow[],
): { campusId: string; mapVersionId: string } {
  const row = campuses.find((candidate) => candidate.code.trim().toLowerCase() === campusKey);
  if (!row) throw new Error(`未能在后端找到校区代码 ${campusKey}`);
  const map = campusMapVersions(mapVersions).find((candidate) => candidate.campusId === row.id);
  if (!map) throw new Error(`校区 ${row.name} 没有可用校园地图版本`);
  return { campusId: row.id, mapVersionId: map.id };
}

/**
 * 底图 SVG 按地图版本缓存：一页上可能同时挂多块画布（位置编辑器每行一块），
 * 缓存放在模块层，同一张底图只取一次。
 */
const svgCache = new Map<string, Promise<string>>();

function campusSvg(mapVersionId: string): Promise<string> {
  const cached = svgCache.get(mapVersionId);
  if (cached) return cached;
  const pending = admin.fetchAdminMapAssetSvg(mapVersionId);
  // 失败不留在缓存里，否则一次网络抖动会让这张底图永久取不到。
  pending.catch(() => svgCache.delete(mapVersionId));
  svgCache.set(mapVersionId, pending);
  return pending;
}

export interface CampusMapCanvasOptions {
  /** 提供哪几种工具；渲染顺序固定为 点 / 区域 / 路径。 */
  tools: readonly CanvasTool[];
  value: CanvasGeometry | null;
  onChange: (next: CanvasGeometry | null) => void;
  campusKey: CampusKey | null;
  /** 不传即锁定校区，不渲染切换 chip。 */
  onCampusChange?: (key: CampusKey) => void;
  campuses: Campus[];
  mapVersions: admin.MapVersionRow[];
  /** false 时不取底图，用于面板未展开或调用方数据未就绪。 */
  enabled?: boolean;
  /** 只读：底图与已完成图形照常显示，但不能再画。 */
  disabled?: boolean;
  /** 已完成图形在清单与状态行里的称呼，如「事件位置」。 */
  labels?: Partial<Record<CanvasTool, string>>;
  /** 拼在空闲状态行开头的工具栏方位，如「在左侧」。 */
  toolsHint?: string;
}

export interface CampusMapCanvasState {
  status: "loading" | "ready" | "error";
  message: string;
  campuses: CanvasCampus[];
  campus: CanvasCampus | null;
  campusKey: CampusKey | null;
  selectableCampuses: boolean;
  disabled: boolean;
  tools: readonly CanvasTool[];
  labels: Record<CanvasTool, string>;
  mode: CanvasTool | null;
  draft: CanvasVert[];
  cursor: CanvasVert | null;
  drafting: boolean;
  draftReady: boolean;
  /** 与当前校区一致的已完成几何；不一致时为 null。 */
  geometry: CanvasGeometry | null;
  statusText: string;
  viewBox: { x: number; y: number; w: number; h: number } | null;
  unit: number;
  mapRef: React.RefObject<HTMLDivElement | null>;
  toggleMode(tool: CanvasTool): void;
  commitDraft(): void;
  undoVertex(): void;
  resetDraft(): void;
  clearShape(tool: CanvasTool): void;
  selectCampus(key: CampusKey): void;
  handleMapClick(event: React.MouseEvent<HTMLDivElement>): void;
  handleMapDoubleClick(): void;
  handleMapMove(event: React.MouseEvent<HTMLDivElement>): void;
  handleMapLeave(): void;
}

export function useCampusMapCanvas(options: CampusMapCanvasOptions): CampusMapCanvasState {
  const {
    tools,
    value,
    onChange,
    campusKey,
    onCampusChange,
    campuses,
    mapVersions,
    enabled = true,
    disabled = false,
    toolsHint = "",
  } = options;
  const labels: Record<CanvasTool, string> = { point: "位置", area: "区域", path: "路径", ...options.labels };
  const mapRef = useRef<HTMLDivElement | null>(null);

  const [loaded, setLoaded] = useState<CanvasCampus[] | null>(null);
  const [loadError, setLoadError] = useState("");
  // 绘制状态：mode=当前工具；draft=进行中的顶点；已完成几何由 value 承载
  const [mode, setMode] = useState<CanvasTool | null>(null);
  const [draft, setDraft] = useState<CanvasVert[]>([]);
  const [cursor, setCursor] = useState<CanvasVert | null>(null);

  const activeRows = useMemo(() => campuses.filter((row) => row.status === "active"), [campuses]);
  const campusMaps = useMemo(() => campusMapVersions(mapVersions), [mapVersions]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setLoadError("");
    Promise.all(activeRows.map(async (row) => {
      const key = campusKeyOfRow(row);
      const map = campusMaps.find((candidate) => candidate.campusId === row.id);
      if (!map) throw new Error(`校区 ${row.name} 没有可用校园地图版本`);
      const svgRaw = await campusSvg(map.id);
      return { id: row.id, key, label: row.name, mapVersionId: map.id, svgRaw, ...CAMPUS_DISPLAY[key] } satisfies CanvasCampus;
    })).then((list) => {
      if (!active) return;
      if (!list.length) throw new Error("没有可用校区地图");
      setLoaded(list);
    }).catch((reason: unknown) => {
      if (!active) return;
      setLoadError(errorMessage(reason, "校园底图加载失败"));
    });
    return () => { active = false; };
  }, [enabled, activeRows, campusMaps]);

  const list = loaded ?? [];
  const campus = campusKey ? list.find((candidate) => candidate.key === campusKey) ?? null : null;
  const vb = useMemo(() => campus ? viewBoxOf(campus.svgRaw) : null, [campus]);
  // 闭合吸附半径（viewBox 单位）；双击去重 epsilon
  const snapR = vb ? vb.w / 50 : null;
  const dedupeEps = vb ? vb.w / 500 : null;

  const drafting = mode === "area" || mode === "path";
  const minVertices = mode === "area" ? 3 : 2;
  const draftReady = draft.length >= minVertices;

  const geometry = value && campusKey && value.campusKey === campusKey ? value : null;

  function toViewBox(event: React.MouseEvent<HTMLDivElement>): CanvasVert | null {
    if (!vb) return null;
    const rect = mapRef.current?.getBoundingClientRect();
    if (!rect) return null;
    // preserveAspectRatio="xMidYMid meet" 反推 viewBox 坐标
    const scale = Math.min(rect.width / vb.w, rect.height / vb.h);
    const offsetX = (rect.width - vb.w * scale) / 2;
    const offsetY = (rect.height - vb.h * scale) / 2;
    const x = vb.x + (event.clientX - rect.left - offsetX) / scale;
    const y = vb.y + (event.clientY - rect.top - offsetY) / scale;
    return [round1(x), round1(y)];
  }

  const clearDrawing = useCallback(() => {
    setMode(null);
    setDraft([]);
    setCursor(null);
  }, []);

  /** 只写当前校区；三种图形各自独立，全空即回 null。 */
  const commit = useCallback((patch: Partial<Omit<CanvasGeometry, "campusKey">>) => {
    if (!campusKey) return;
    const next: CanvasGeometry = { ...(geometry ?? { point: null, area: null, path: null }), campusKey, ...patch };
    onChange(next.point || next.area || next.path ? next : null);
  }, [campusKey, geometry, onChange]);

  function toggleMode(next: CanvasTool) {
    if (disabled) return;
    if (mode === next) {
      clearDrawing();
      return;
    }
    setDraft([]);
    setMode(next);
  }

  const commitDraft = useCallback(() => {
    if (!draftReady) return;
    if (mode === "area") commit({ area: draft });
    if (mode === "path") commit({ path: draft });
    clearDrawing();
  }, [draftReady, mode, draft, commit, clearDrawing]);

  function handleMapClick(event: React.MouseEvent<HTMLDivElement>) {
    if (snapR === null || dedupeEps === null) return;
    const at = toViewBox(event);
    if (!at) return;
    if (mode === "point") {
      commit({ point: at });
      setMode(null);
      return;
    }
    if (!drafting) return;
    // 区域：点击起点附近即闭合
    if (mode === "area" && draft.length >= 3 && dist(at, draft[0]) <= snapR) {
      commitDraft();
      return;
    }
    // 双击会先触发两次 click，同位置顶点去重
    const last = draft[draft.length - 1];
    if (last && dist(at, last) <= dedupeEps) return;
    setDraft((cur) => [...cur, at]);
  }

  function handleMapDoubleClick() {
    if (drafting) commitDraft();
  }

  function handleMapMove(event: React.MouseEvent<HTMLDivElement>) {
    if (!mode) return;
    setCursor(toViewBox(event));
  }

  // 键盘：Enter 完成 / Backspace 撤销顶点 / Esc 取消
  useEffect(() => {
    if (!mode) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        clearDrawing();
      } else if (event.key === "Enter" && drafting) {
        commitDraft();
      } else if (event.key === "Backspace" && drafting) {
        setDraft((cur) => cur.slice(0, -1));
      } else {
        return;
      }
      event.preventDefault();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode, drafting, clearDrawing, commitDraft]);

  const offered = TOOL_ORDER.filter((tool) => tools.includes(tool));

  const statusText = (() => {
    const coords = cursor ? `x ${cursor[0]} · y ${cursor[1]} ｜ ` : "";
    if (mode === "point") return `${coords}单击地图放置${labels.point}点，Esc 退出`;
    if (mode === "area") {
      return draftReady
        ? `${coords}顶点 ${draft.length} ｜ 单击起点闭合，或双击 / 回车完成；Backspace 撤销，Esc 取消`
        : `${coords}顶点 ${draft.length} ｜ 单击添加顶点（至少 3 个），Esc 取消`;
    }
    if (mode === "path") {
      return draftReady
        ? `${coords}顶点 ${draft.length} ｜ 双击或回车完成；Backspace 撤销，Esc 取消`
        : `${coords}顶点 ${draft.length} ｜ 单击添加顶点（至少 2 个），Esc 取消`;
    }
    const names = offered.map((tool) => TOOL_NAMES[tool]).join(" / ");
    const committed = geometry ? [geometry.point, geometry.area, geometry.path].filter(Boolean).length : 0;
    return committed > 0 ? `${toolsHint}选择 ${names} 可重新绘制替换` : `${toolsHint}选择 ${names} 开始绘制`;
  })();

  return {
    status: loadError ? "error" : loaded ? "ready" : "loading",
    message: loadError,
    campuses: list,
    campus,
    campusKey,
    selectableCampuses: Boolean(onCampusChange),
    disabled,
    tools: offered,
    labels,
    mode,
    draft,
    cursor,
    drafting,
    draftReady,
    geometry,
    statusText,
    viewBox: vb,
    unit: vb ? vb.w / 40 : 0,
    mapRef,
    toggleMode,
    commitDraft,
    undoVertex: () => setDraft((cur) => cur.slice(0, -1)),
    resetDraft: () => setDraft([]),
    clearShape: (tool) => { if (!disabled) commit({ [tool]: null }); },
    selectCampus: (key) => {
      if (disabled || key === campusKey) return;
      onCampusChange?.(key);
      // 换校区就换了坐标系，旧坐标在新底图上没有意义。
      onChange(null);
      clearDrawing();
    },
    handleMapClick,
    handleMapDoubleClick,
    handleMapMove,
    handleMapLeave: () => setCursor(null),
  };
}

/** 校区切换 chip；锁定校区时不渲染任何东西。 */
export function CampusMapCanvasChips({ canvas }: { canvas: CampusMapCanvasState }) {
  if (!canvas.selectableCampuses) return null;
  return <>
    {canvas.campuses.map((candidate) => (
      <Chip active={canvas.campusKey === candidate.key} key={candidate.key} onClick={() => canvas.selectCampus(candidate.key)}>
        {candidate.label}
      </Chip>
    ))}
  </>;
}

function shapeMetric(geometry: CanvasGeometry | null, tool: CanvasTool): string | null {
  if (!geometry) return null;
  if (tool === "point") return geometry.point ? `x ${geometry.point[0]} · y ${geometry.point[1]}` : null;
  if (tool === "area") return geometry.area ? `${geometry.area.length} 顶点 · 跨度 ${shapeExtent(geometry.area)}` : null;
  return geometry.path ? `${geometry.path.length} 顶点 · 长 ${Math.round(pathLength(geometry.path))}` : null;
}

/** 工具 chip + 已完成图形清单 + 绘制中操作条。 */
export function CampusMapCanvasTools({ canvas }: { canvas: CampusMapCanvasState }) {
  const { draft, drafting, draftReady, geometry, labels, mode } = canvas;
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="text-aux text-sub">添加</span>
        {canvas.tools.map((tool) => {
          const Icon = TOOL_ICONS[tool];
          return (
            <Chip active={mode === tool} key={tool} onClick={() => canvas.toggleMode(tool)}>
              <span className="inline-flex items-center gap-1">
                <Icon size={13} />
                {TOOL_NAMES[tool]}
              </span>
            </Chip>
          );
        })}
      </div>

      <div className="mt-2 space-y-2">
        {canvas.tools.map((tool) => {
          const metric = shapeMetric(geometry, tool);
          if (metric === null) return null;
          const Icon = TOOL_ICONS[tool];
          return (
            <div className="flex items-center justify-between rounded-lg bg-page px-3.5 py-2.5" key={tool}>
              <div className="flex items-center gap-2 text-body">
                <Icon size={15} style={{ color: TOOL_COLORS[tool] }} />
                <span className="font-medium">{labels[tool]}</span>
                <span className="text-sub">{metric}</span>
              </div>
              <button className="text-sub hover:text-error" onClick={() => canvas.clearShape(tool)} type="button">
                <Trash2 size={15} />
              </button>
            </div>
          );
        })}

        {drafting && draft.length > 0 ? (
          <div className="flex items-center justify-between rounded-lg border border-dashed border-line px-3.5 py-2.5">
            <div className="flex items-center gap-2 text-body">
              {mode === "area" ? <Hexagon size={15} style={{ color: AREA_COLOR }} /> : <Route size={15} style={{ color: PATH_COLOR }} />}
              <span className="font-medium">绘制中</span>
              <span className="text-sub">{draft.length} 顶点</span>
            </div>
            <div className="flex items-center gap-1">
              <button
                className="rounded-md p-1.5 text-sub hover:bg-line hover:text-ink disabled:opacity-40"
                disabled={draft.length === 0}
                onClick={canvas.undoVertex}
                title="撤销顶点（Backspace）"
                type="button"
              >
                <Undo2 size={15} />
              </button>
              <button
                className="rounded-md p-1.5 text-sub hover:bg-line hover:text-error"
                onClick={canvas.resetDraft}
                title="清空重画"
                type="button"
              >
                <Trash2 size={15} />
              </button>
              <button
                className="rounded-md p-1.5 text-sub hover:bg-line hover:text-success disabled:opacity-40"
                disabled={!draftReady}
                onClick={canvas.commitDraft}
                title={mode === "area" ? "闭合区域（Enter）" : "完成路径（Enter）"}
                type="button"
              >
                <Check size={15} />
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}

/** 底图 + 叠加层。外层留白与状态行归调用方。 */
export function CampusMapCanvasView({
  canvas,
  height = "h-[560px]",
}: {
  canvas: CampusMapCanvasState;
  height?: string;
}) {
  const { campus, cursor, draft, drafting, geometry, mode, unit, viewBox: vb } = canvas;
  if (canvas.status === "loading") return <p className="py-6 text-center text-body text-sub">正在加载校园底图…</p>;
  if (canvas.status === "error") return <ErrorBanner message={canvas.message} />;
  if (!canvas.campusKey) return <EmptyState label="先选择校区" />;
  if (!campus || !vb) return <EmptyState label="当前校区没有可用地图" />;

  return (
    <div className="relative">
      <div
        ref={canvas.mapRef}
        className={`${height} overflow-hidden rounded-lg bg-map-ground [&>svg]:h-full [&>svg]:w-full ${mode ? "cursor-crosshair" : ""}`}
        onClick={canvas.handleMapClick}
        onDoubleClick={canvas.handleMapDoubleClick}
        onMouseLeave={canvas.handleMapLeave}
        onMouseMove={canvas.handleMapMove}
        dangerouslySetInnerHTML={{ __html: campus.svgRaw }}
      />
      <svg
        className="pointer-events-none absolute inset-0 h-full w-full"
        preserveAspectRatio="xMidYMid meet"
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
      >
        {/* 已完成：区域 */}
        {geometry?.area ? (
          <g>
            <polygon
              points={geometry.area.map(([x, y]) => `${x},${y}`).join(" ")}
              fill={AREA_COLOR}
              fillOpacity={0.15}
              stroke={AREA_COLOR}
              strokeDasharray={`${unit * 0.3} ${unit * 0.22}`}
              strokeWidth={unit * 0.09}
            />
            {geometry.area.map(([x, y], i) => (
              <circle key={i} cx={x} cy={y} r={unit * 0.16} fill="#fff" stroke={AREA_COLOR} strokeWidth={unit * 0.07} />
            ))}
          </g>
        ) : null}

        {/* 已完成：路径 */}
        {geometry?.path ? (
          <g>
            <polyline
              fill="none"
              points={geometry.path.map(([x, y]) => `${x},${y}`).join(" ")}
              stroke={PATH_COLOR}
              strokeDasharray={`${unit * 0.35} ${unit * 0.25}`}
              strokeLinecap="round"
              strokeWidth={unit * 0.12}
            />
            <circle cx={geometry.path[0][0]} cy={geometry.path[0][1]} r={unit * 0.2} fill="#fff" stroke={PATH_COLOR} strokeWidth={unit * 0.08} />
            <circle
              cx={geometry.path[geometry.path.length - 1][0]}
              cy={geometry.path[geometry.path.length - 1][1]}
              r={unit * 0.2}
              fill={PATH_COLOR}
            />
          </g>
        ) : null}

        {/* 已完成：位置点 */}
        {geometry?.point ? (
          <g>
            <circle cx={geometry.point[0]} cy={geometry.point[1]} r={vb.w / 90} fill={POINT_COLOR} opacity={0.25} />
            <circle cx={geometry.point[0]} cy={geometry.point[1]} r={vb.w / 200} fill={POINT_COLOR} stroke="#fff" strokeWidth={vb.w / 500} />
          </g>
        ) : null}

        {/* 绘制中预览 */}
        {drafting && draft.length > 0 ? (
          <g>
            {mode === "area" && draft.length >= 3 ? (
              <polygon
                points={draft.map(([x, y]) => `${x},${y}`).join(" ")}
                fill={AREA_COLOR}
                fillOpacity={0.08}
                stroke="none"
              />
            ) : null}
            <polyline
              fill="none"
              points={[...draft, ...(cursor ? [cursor] : [])].map(([x, y]) => `${x},${y}`).join(" ")}
              stroke={mode === "area" ? AREA_COLOR : PATH_COLOR}
              strokeDasharray={`${unit * 0.3} ${unit * 0.22}`}
              strokeLinecap="round"
              strokeWidth={unit * 0.1}
            />
            {mode === "area" && canvas.draftReady && cursor && dist(cursor, draft[0]) <= vb.w / 50 ? (
              <line
                x1={draft[draft.length - 1][0]}
                y1={draft[draft.length - 1][1]}
                x2={draft[0][0]}
                y2={draft[0][1]}
                stroke={AREA_COLOR}
                strokeWidth={unit * 0.1}
              />
            ) : null}
            {draft.map(([x, y], i) => (
              <circle
                key={i}
                cx={x}
                cy={y}
                r={i === 0 && mode === "area" ? unit * 0.24 : unit * 0.16}
                fill="#fff"
                stroke={mode === "area" ? AREA_COLOR : PATH_COLOR}
                strokeWidth={unit * 0.07}
              />
            ))}
            {cursor ? (
              <circle cx={cursor[0]} cy={cursor[1]} r={unit * 0.12} fill={mode === "area" ? AREA_COLOR : PATH_COLOR} opacity={0.6} />
            ) : null}
          </g>
        ) : null}

        {/* 点模式光标预览 */}
        {mode === "point" && cursor ? (
          <g>
            <circle cx={cursor[0]} cy={cursor[1]} r={vb.w / 90} fill={POINT_COLOR} opacity={0.2} />
            <circle cx={cursor[0]} cy={cursor[1]} r={vb.w / 200} fill={POINT_COLOR} opacity={0.6} />
          </g>
        ) : null}
      </svg>
    </div>
  );
}

/** chip + 工具 + 底图 + 状态行的常规竖排组合，给编辑器里的小画布用。 */
export function CampusMapCanvas({ height, ...options }: CampusMapCanvasOptions & { height?: string }) {
  const canvas = useCampusMapCanvas(options);
  return (
    <div className="space-y-2">
      {canvas.selectableCampuses ? (
        <div className="flex flex-wrap items-center gap-2">
          <CampusMapCanvasChips canvas={canvas} />
        </div>
      ) : null}
      <CampusMapCanvasTools canvas={canvas} />
      <CampusMapCanvasView canvas={canvas} height={height} />
      <p className="text-center text-label text-sub">{canvas.statusText}</p>
    </div>
  );
}
