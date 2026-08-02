import { Check, Hexagon, MapPin, Route, Trash2, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { parseSvgViewBox } from "../../../shared/svg-geometry.mjs";
import * as admin from "../../lib/api/admin";
import type { CampusConfig, CampusKey } from "../../lib/types";
import type { OperationalEventRow, PlaceListItem, SpacesResponse } from "../adminTypes";
import {
  Chip,
  ErrorBanner,
  EVENT_TYPE_LABELS,
  Field,
  GhostButton,
  LoadingState,
  Panel,
  Pill,
  PrimaryButton,
  SEVERITY_LABELS,
  SelectField,
  TextArea,
  errorMessage,
  fmtDay,
  useAsyncData,
} from "../components/primitives";

// ---------------------------------------------------------------------------
// A6 运营事件 · 地图编辑器（点 / 区域 / 路径三种几何绘制，写 svg_viewbox）
//
// 两种模式共用同一画布：
//   create — /admin/operations/new：事件主体 + 几何一次性 POST
//   edit   — /admin/operations/:id/edit：只改几何，经
//            PUT /api/admin/operations/:id/locations（replace-all）保存；
//            事件主体在本页只读，改文案仍走详情页。
// ---------------------------------------------------------------------------

const EVENT_TYPES = [
  { key: "maintenance", label: "维修", severity: "warning" },
  { key: "activity", label: "活动", severity: "info" },
  { key: "closure", label: "关闭", severity: "critical" },
  { key: "notice", label: "通知", severity: "info" },
] as const;

function eventTypeMetadata(key: (typeof EVENT_TYPES)[number]["key"]): (typeof EVENT_TYPES)[number] {
  const metadata = EVENT_TYPES.find((item) => item.key === key);
  if (!metadata) throw new Error(`Unknown event type ${key}`);
  return metadata;
}

type Vert = [number, number];
type DrawMode = "point" | "area" | "path";

interface PlacedPoint {
  campusKey: string;
  x: number;
  y: number;
}

interface PlacedShape {
  campusKey: string;
  vertices: Vert[];
}

const AREA_COLOR = "#f59e0b";
const POINT_COLOR = "#1e80c1";
const PATH_COLOR = "#1e80c1";

function viewBoxOf(svgRaw: string): { x: number; y: number; w: number; h: number } {
  const viewBox = parseSvgViewBox(svgRaw);
  return { x: viewBox.x, y: viewBox.y, w: viewBox.width, h: viewBox.height };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function dist(a: Vert, b: Vert): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function shapeExtent(vertices: Vert[]): string {
  const xs = vertices.map((v) => v[0]);
  const ys = vertices.map((v) => v[1]);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  return `${Math.round(w)}×${Math.round(h)}`;
}

function pathLength(vertices: Vert[]): number {
  let sum = 0;
  for (let i = 1; i < vertices.length; i++) sum += dist(vertices[i - 1], vertices[i]);
  return sum;
}

/**
 * campuses[].code is the canonical key ("baoshan"); ids are "campus_baoshan".
 * Both forms are accepted so the lookup never silently misses — a failed match
 * blocks the save instead of writing a campus-less (all-campus) event.
 */
function campusKeyOfRow(row: { code: string }): CampusKey {
  const code = row.code.trim().toLowerCase();
  if (code !== "baoshan" && code !== "jiading" && code !== "yanchang") {
    throw new Error(`未知校区代码：${row.code}`);
  }
  return code;
}

const CAMPUS_DISPLAY: Record<CampusKey, Omit<CampusConfig, "id" | "key" | "label" | "mapVersionId" | "svgRaw">> = {
  baoshan: { focusPoint: { x: 0.48, y: 0.43 }, scaleMultiplier: 1.78, minScaleMultiplier: 1, edgePaddingRatio: 0.18, selectionEdgePaddingRatio: 0.3, selectionScaleMultiplier: 2.15 },
  jiading: { focusPoint: { x: 0.37, y: 0.5 }, scaleMultiplier: 3.05, minScaleMultiplier: 1, edgePaddingRatio: 0.3, selectionEdgePaddingRatio: 0.4, selectionScaleMultiplier: 2.4 },
  yanchang: { focusPoint: { x: 0.52, y: 0.46 }, scaleMultiplier: 0.8, minScaleMultiplier: 1, edgePaddingRatio: 0.2, selectionEdgePaddingRatio: 0.32, selectionScaleMultiplier: 1.35 },
};

function isVert(value: unknown): value is Vert {
  return Array.isArray(value) && value.length === 2
    && typeof value[0] === "number" && Number.isFinite(value[0])
    && typeof value[1] === "number" && Number.isFinite(value[1]);
}

function vertsOf(value: unknown): Vert[] {
  if (!Array.isArray(value)) throw new Error("几何坐标必须是数组");
  return value.map((vertex, index) => {
    if (!isVert(vertex)) throw new Error(`第 ${index + 1} 个几何坐标无效`);
    return [vertex[0], vertex[1]];
  });
}

/** Drops the duplicated closing vertex a GeoJSON ring carries. */
function openRing(ring: Vert[]): Vert[] {
  if (ring.length >= 2) {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) return ring.slice(0, -1);
  }
  return ring;
}

type EventWithLocations = OperationalEventRow & {
  targets?: Array<{ targetType: string; targetId: string }>;
  locations?: admin.OperationLocationRow[];
};

export function OperationCreatePage() {
  const navigate = useNavigate();
  const { id: routeId } = useParams();
  const editing = Boolean(routeId);
  const mapRef = useRef<HTMLDivElement | null>(null);

  const { state } = useAsyncData(async (signal) => {
    const [spaces, places, maps, operations] = await Promise.all([
      admin.listSpaces<SpacesResponse>(signal),
      admin.listAdminPlaces<PlaceListItem>(signal),
      admin.listMapVersions(signal),
      routeId ? admin.listAdminOperations<EventWithLocations>(signal) : Promise.resolve(null),
    ]);
    const event = routeId ? operations?.items.find((item) => item.id === routeId) : undefined;
    if (routeId && !event) throw new Error("事件不存在");
    const campusRows = spaces.campuses.filter((row) => row.status === "active");
    const campusMaps = maps.items.filter((map) => map.campusId && !map.floorId && ["ready", "published"].includes(map.lifecycleStatus));
    const campuses = await Promise.all(campusRows.map(async (row) => {
      const key = campusKeyOfRow(row);
      const map = campusMaps.find((candidate) => candidate.campusId === row.id);
      if (!map) throw new Error(`校区 ${row.name} 没有可用校园地图版本`);
      const svgRaw = await admin.fetchAdminMapAssetSvg(map.id, signal);
      return { id: row.id, key, label: row.name, mapVersionId: map.id, svgRaw, ...CAMPUS_DISPLAY[key] } satisfies CampusConfig;
    }));
    if (!campuses.length) throw new Error("没有可用校区地图");
    return { spaces, places: places.items, maps: maps.items, campuses, event };
  }, [routeId]);

  const [eventType, setEventType] = useState<(typeof EVENT_TYPES)[number]["key"]>("maintenance");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [expectedEndsAt, setExpectedEndsAt] = useState("");
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [targetPick, setTargetPick] = useState("");
  const [campusKey, setCampusKey] = useState<CampusKey>("baoshan");
  // 绘制状态：mode=当前工具；draft=进行中的顶点；point/area/path=已完成几何
  const [mode, setMode] = useState<DrawMode | null>(null);
  const [draft, setDraft] = useState<Vert[]>([]);
  const [cursor, setCursor] = useState<Vert | null>(null);
  const [point, setPoint] = useState<PlacedPoint | null>(null);
  const [area, setArea] = useState<PlacedShape | null>(null);
  const [path, setPath] = useState<PlacedShape | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hydrated, setHydrated] = useState(false);

  const campuses = state.status === "ready" ? state.data!.campuses : [];
  const campus = campuses.find((candidate) => candidate.key === campusKey);
  const vb = useMemo(() => campus ? viewBoxOf(campus.svgRaw) : null, [campus]);
  // 闭合吸附半径（viewBox 单位）；双击去重 epsilon
  const snapR = vb ? vb.w / 50 : null;
  const dedupeEps = vb ? vb.w / 500 : null;

  const drafting = mode === "area" || mode === "path";
  const minVertices = mode === "area" ? 3 : 2;
  const draftReady = draft.length >= minVertices;

  const loadedEvent = state.status === "ready" ? state.data!.event : undefined;
  const campusRows = state.status === "ready" ? state.data!.spaces.campuses : [];

  // 编辑模式：把已存的 svg_viewbox 几何回显到画布（只做一次，避免覆盖用户改动）
  useEffect(() => {
    if (!editing || hydrated || !loadedEvent) return;
    if (!Array.isArray(loadedEvent.locations)) {
      setError("事件位置数据缺失");
      setHydrated(true);
      return;
    }
    const locations = loadedEvent.locations;
    const anchorCampusId = locations.find((location) => location.campusId)?.campusId ?? null;
    const row = anchorCampusId ? campusRows.find((candidate) => candidate.id === anchorCampusId) : undefined;
    if (anchorCampusId && !row) {
      setError(`事件位置引用了未知校区 ${anchorCampusId}`);
      setHydrated(true);
      return;
    }
    const restoredKey = row ? campusKeyOfRow(row) : campusKey;

    try {
      for (const location of locations) {
        if (location.crs !== "svg_viewbox" || typeof location.geometryJson !== "string") {
          throw new Error(`位置 ${location.id} 缺少 svg_viewbox 几何`);
        }
        const geometry = JSON.parse(location.geometryJson) as { type?: string; coordinates?: unknown };
        if (location.role === "event_location") {
          if (geometry.type !== "Point" || !isVert(geometry.coordinates)) throw new Error("事件点几何无效");
          setPoint({ campusKey: restoredKey, x: geometry.coordinates[0], y: geometry.coordinates[1] });
        } else if (location.role === "impact_area") {
          if (geometry.type !== "Polygon" || !Array.isArray(geometry.coordinates) || geometry.coordinates.length !== 1) {
            throw new Error("影响区域几何无效");
          }
          const ring = openRing(vertsOf(geometry.coordinates[0]));
          if (ring.length < 3) throw new Error("影响区域至少需要三个顶点");
          setArea({ campusKey: restoredKey, vertices: ring });
        } else if (location.role === "route_shape") {
          if (geometry.type !== "LineString") throw new Error("路径几何无效");
          const vertices = vertsOf(geometry.coordinates);
          if (vertices.length < 2) throw new Error("路径至少需要两个顶点");
          setPath({ campusKey: restoredKey, vertices });
        } else {
          throw new Error(`事件位置包含不支持的角色 ${location.role}`);
        }
      }
    } catch (reason) {
      setError(errorMessage(reason, "事件位置数据无效"));
    }
    setCampusKey(restoredKey);
    setHydrated(true);
  }, [editing, hydrated, loadedEvent, campusRows, campuses, campusKey]);

  function toViewBox(event: React.MouseEvent<HTMLDivElement>): Vert | null {
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

  function clearAllGeometry() {
    setPoint(null);
    setArea(null);
    setPath(null);
    clearDrawing();
  }

  function toggleMode(next: DrawMode) {
    if (mode === next) {
      clearDrawing();
      return;
    }
    setDraft([]);
    setMode(next);
  }

  const commitDraft = useCallback(() => {
    if (!draftReady) return;
    if (mode === "area") setArea({ campusKey, vertices: draft });
    if (mode === "path") setPath({ campusKey, vertices: draft });
    clearDrawing();
  }, [draftReady, mode, campusKey, draft, clearDrawing]);

  function handleMapClick(event: React.MouseEvent<HTMLDivElement>) {
    if (snapR === null || dedupeEps === null) return;
    const at = toViewBox(event);
    if (!at) return;
    if (mode === "point") {
      setPoint({ campusKey, x: at[0], y: at[1] });
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

  if (state.status === "loading") return <LoadingState label={editing ? "加载事件与几何…" : "加载…"} />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  if (!campus || !vb) return <ErrorBanner message="当前校区没有可用地图" />;
  const places = state.data!.places;
  const event = state.data!.event;

  const typeMeta = eventTypeMetadata(eventType);

  // 该校区当前可用的地图版本（ready / published）。带上它，发布校验才能把
  // 事件几何和 release 里的地图版本对上（releases.ts 的 map-version warning）。
  const campusRow = campusRows.find((row) => campusKeyOfRow(row) === campusKey);
  const selectedCampus = campuses.find((candidate) => candidate.key === campusKey);
  const mapVersion = selectedCampus ? state.data!.maps.find((version) => version.id === selectedCampus.mapVersionId) : undefined;

  /** 三种 role 的几何 → locations 载荷；点在最前，成为 primary binding。 */
  function buildLocations(): admin.OperationLocationInput[] {
    if (!campusRow || !mapVersion) throw new Error("当前校区缺少 canonical 地图版本");
    const base = {
      campusId: campusRow.id,
      buildingPlaceId: null,
      floorId: null,
      indoorSpaceId: null,
      mapVersionId: mapVersion.id,
      mapFeatureId: null,
      crs: "svg_viewbox",
      locationHint: null,
      precisionLevel: "exact" as const,
      accuracyMeters: null,
      sourceId: null,
      validFrom: null,
      validTo: null,
    };
    const locations: admin.OperationLocationInput[] = [];
    if (point && point.campusKey === campusKey) {
      locations.push({
        ...base,
        role: "event_location",
        geometryType: "Point",
        geometry: { type: "Point", coordinates: [point.x, point.y] },
        isPrimary: locations.length === 0,
      });
    }
    if (area && area.campusKey === campusKey) {
      locations.push({
        ...base,
        role: "impact_area",
        geometryType: "Polygon",
        geometry: { type: "Polygon", coordinates: [[...area.vertices, area.vertices[0]]] },
        isPrimary: locations.length === 0,
      });
    }
    if (path && path.campusKey === campusKey) {
      locations.push({
        ...base,
        role: "route_shape",
        geometryType: "LineString",
        geometry: { type: "LineString", coordinates: path.vertices },
        isPrimary: locations.length === 0,
      });
    }
    return locations;
  }

  const hasGeometry = Boolean(
    (point && point.campusKey === campusKey) ||
    (area && area.campusKey === campusKey) ||
    (path && path.campusKey === campusKey),
  );

  async function save() {
    if (draft.length > 0) { setError("请先完成（Enter）或取消（Esc）正在绘制的图形"); return; }
    // 校区必须显式解析成 campuses 行，否则事件会泛化到所有校区
    if (!campus) { setError("当前校区没有可用地图"); return; }
    if (hasGeometry && (!campusRow || !mapVersion)) {
      setError(`未能在后端找到校区「${campus.label}」（code=${campusKey}），无法保存几何；请先在校区管理中确认该校区存在`);
      return;
    }
    if (!editing) {
      if (!title.trim()) { setError("请填写标题"); return; }
      if (!startsAt) { setError("请选择开始时间"); return; }
    }
    setBusy(true);
    setError("");
    try {
      if (editing && routeId) {
        // replace-all：这里提交的就是该事件几何的全集，空数组即清空
        await admin.replaceOperationLocations(routeId, buildLocations());
        navigate(`/admin/operations/${routeId}`);
        return;
      }
      await admin.createOperation({
        eventType,
        severity: typeMeta.severity,
        title: title.trim(),
        description: description.trim() || null,
        startsAt: new Date(startsAt).toISOString(),
        expectedEndsAt: expectedEndsAt ? new Date(expectedEndsAt).toISOString() : null,
        autoExpireAt: null,
        sourceId: null,
        responsibleOrganizationId: null,
        targets: targetIds.map((id) => ({ type: "place", id, impactType: "affected" })),
        locations: buildLocations(),
      });
      navigate("/admin/operations");
    } catch (err) {
      setError(errorMessage(err, "保存失败"));
    } finally {
      setBusy(false);
    }
  }

  // 尺寸以 viewBox 宽度为基准（与 M8 叠加层同一约定）
  const unit = vb.w / 40;

  const statusText = (() => {
    const coords = cursor ? `x ${cursor[0]} · y ${cursor[1]} ｜ ` : "";
    if (mode === "point") return `${coords}单击地图放置事件位置点，Esc 退出`;
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
    const committed = [point, area, path].filter(Boolean).length;
    return committed > 0 ? "在左侧选择 点 / 区域 / 路径 可重新绘制替换" : "在左侧选择 点 / 区域 / 路径 开始绘制";
  })();

  const DRAW_TOOLS: Array<{ key: DrawMode; label: string; icon: typeof MapPin }> = [
    { key: "point", label: "点", icon: MapPin },
    { key: "area", label: "区域", icon: Hexagon },
    { key: "path", label: "路径", icon: Route },
  ];

  return (
    <div className="grid grid-cols-[420px_1fr] items-start gap-4">
      {/* 左：表单 */}
      <Panel padded={false}>
        <div className="space-y-4 p-5">
          <div>
            <p className="text-card">{editing ? "编辑事件几何" : "新建运营事件"}</p>
            <p className="mt-0.5 text-aux text-sub">
              {editing ? "只改地图几何 · 事件文案与进展在详情页维护" : "第 2 步 · 在地图上标注位置"}
            </p>
          </div>

          {editing ? (
            /* 编辑模式：事件主体只读，明确与几何编辑隔开 */
            <div className="rounded-lg bg-page px-3.5 py-3">
              <p className="text-body font-medium text-ink">{event?.title}</p>
              <p className="mt-1 text-label text-sub">
                {event ? EVENT_TYPE_LABELS[event.eventType] ?? event.eventType : ""}
                {event?.severity ? ` · ${SEVERITY_LABELS[event.severity] ?? event.severity}` : ""}
                {event?.startsAt ? ` · ${fmtDay(event.startsAt)} 起` : ""}
              </p>
              <p className="mt-1.5 text-label text-sub">标题、时间等信息请在事件详情页修改。</p>
            </div>
          ) : (
            <>
              <div>
                <p className="mb-2 text-label text-sub">类型</p>
                <div className="flex gap-2">
                  {EVENT_TYPES.map((t) => (
                    <Chip key={t.key} active={eventType === t.key} onClick={() => setEventType(t.key)}>
                      {t.label}
                    </Chip>
                  ))}
                </div>
              </div>
              <Field label="标题" onChange={setTitle} placeholder="如 东区食堂燃气检修" value={title} />
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1.5 block text-label text-sub">开始时间</span>
                  <input className="h-9 w-full rounded-lg border border-line px-3 text-body outline-none focus:border-primary" onChange={(e) => setStartsAt(e.target.value)} type="datetime-local" value={startsAt} />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-label text-sub">预计恢复（选填）</span>
                  <input className="h-9 w-full rounded-lg border border-line bg-surface px-3 text-body outline-none focus:border-primary" onChange={(e) => setExpectedEndsAt(e.target.value)} type="datetime-local" value={expectedEndsAt} />
                </label>
              </div>
              <TextArea label="描述（选填）" onChange={setDescription} rows={3} value={description} />

              <div>
                <p className="mb-2 text-label text-sub">关联对象（楼宇 / 地点）</p>
                <div className="flex gap-2">
                  <div className="flex-1">
                    <SelectField
                      onChange={setTargetPick}
                      options={places.filter((p) => !targetIds.includes(p.id)).map((p) => ({ value: p.id, label: p.displayName ?? p.id }))}
                      placeholder="选择地点"
                      value={targetPick}
                    />
                  </div>
                  <GhostButton
                    className="h-9"
                    disabled={!targetPick}
                    onClick={() => { setTargetIds((cur) => [...cur, targetPick]); setTargetPick(""); }}
                  >
                    添加
                  </GhostButton>
                </div>
                {targetIds.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {targetIds.map((id) => (
                      <Pill key={id} tone="info">
                        {places.find((p) => p.id === id)?.displayName ?? id}
                        <button className="ml-1" onClick={() => setTargetIds((cur) => cur.filter((t) => t !== id))} type="button">×</button>
                      </Pill>
                    ))}
                  </div>
                ) : null}
              </div>
            </>
          )}

          <div>
            <p className="mb-2 text-label text-sub">位置与影响范围</p>
            <div className="flex items-center gap-2">
              <span className="text-aux text-sub">添加</span>
              {DRAW_TOOLS.map((tool) => {
                const Icon = tool.icon;
                return (
                  <Chip key={tool.key} active={mode === tool.key} onClick={() => toggleMode(tool.key)}>
                    <span className="inline-flex items-center gap-1">
                      <Icon size={13} />
                      {tool.label}
                    </span>
                  </Chip>
                );
              })}
            </div>

            <div className="mt-2 space-y-2">
              {point && point.campusKey === campusKey ? (
                <div className="flex items-center justify-between rounded-lg bg-page px-3.5 py-2.5">
                  <div className="flex items-center gap-2 text-body">
                    <MapPin size={15} style={{ color: POINT_COLOR }} />
                    <span className="font-medium">事件位置</span>
                    <span className="text-sub">x {point.x} · y {point.y}</span>
                  </div>
                  <button className="text-sub hover:text-error" onClick={() => setPoint(null)} type="button">
                    <Trash2 size={15} />
                  </button>
                </div>
              ) : null}

              {area && area.campusKey === campusKey ? (
                <div className="flex items-center justify-between rounded-lg bg-page px-3.5 py-2.5">
                  <div className="flex items-center gap-2 text-body">
                    <Hexagon size={15} style={{ color: AREA_COLOR }} />
                    <span className="font-medium">影响区域</span>
                    <span className="text-sub">{area.vertices.length} 顶点 · 跨度 {shapeExtent(area.vertices)}</span>
                  </div>
                  <button className="text-sub hover:text-error" onClick={() => setArea(null)} type="button">
                    <Trash2 size={15} />
                  </button>
                </div>
              ) : null}

              {path && path.campusKey === campusKey ? (
                <div className="flex items-center justify-between rounded-lg bg-page px-3.5 py-2.5">
                  <div className="flex items-center gap-2 text-body">
                    <Route size={15} style={{ color: PATH_COLOR }} />
                    <span className="font-medium">绕行路径</span>
                    <span className="text-sub">{path.vertices.length} 顶点 · 长 {Math.round(pathLength(path.vertices))}</span>
                  </div>
                  <button className="text-sub hover:text-error" onClick={() => setPath(null)} type="button">
                    <Trash2 size={15} />
                  </button>
                </div>
              ) : null}

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
                      onClick={() => setDraft((cur) => cur.slice(0, -1))}
                      title="撤销顶点（Backspace）"
                      type="button"
                    >
                      <Undo2 size={15} />
                    </button>
                    <button
                      className="rounded-md p-1.5 text-sub hover:bg-line hover:text-error"
                      onClick={() => setDraft([])}
                      title="清空重画"
                      type="button"
                    >
                      <Trash2 size={15} />
                    </button>
                    <button
                      className="rounded-md p-1.5 text-sub hover:bg-line hover:text-success disabled:opacity-40"
                      disabled={!draftReady}
                      onClick={commitDraft}
                      title={mode === "area" ? "闭合区域（Enter）" : "完成路径（Enter）"}
                      type="button"
                    >
                      <Check size={15} />
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            <p className="mt-2 text-label leading-relaxed text-sub">
              事件位置、影响区域、绕行路径各可标注一处，重新绘制会覆盖原有标注。
              {editing ? "保存后画布上留下的内容即最终结果，全部删除则清空标注。" : null}
            </p>

            {/* 校区必须显式命中后端 campuses 行，匹配不到就阻断保存 */}
            <div className="mt-3 rounded-lg bg-page px-3.5 py-2.5">
              <div className="flex items-center justify-between gap-2 text-label">
                <span className="text-sub">校区绑定</span>
                {campusRow ? (
                  <span className="text-ink">{campusRow.name}</span>
                ) : (
                  <span className="text-error">未匹配到「{campus.label}」</span>
                )}
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-2 text-label">
                <span className="text-sub">地图版本</span>
                {mapVersion ? (
                  <span className="text-ink">{mapVersion.versionLabel}</span>
                ) : (
                  <span className="text-sub">该校区暂无可用的地图版本</span>
                )}
              </div>
            </div>

          </div>

          <ErrorBanner message={error} />
          <div className="flex gap-3">
            <GhostButton className="flex-1" onClick={() => navigate(editing && routeId ? `/admin/operations/${routeId}` : "/admin/operations")}>
              取消
            </GhostButton>
            <PrimaryButton className="flex-[2]" disabled={busy} onClick={save}>
              {busy ? "保存中…" : editing ? "保存几何" : "保存草稿"}
            </PrimaryButton>
          </div>
        </div>
      </Panel>

      {/* 右：地图 */}
      <Panel padded={false} className="overflow-hidden">
        <div className="flex items-center gap-2 px-5 pt-4">
          {campuses.map((c) => (
            <Chip key={c.key} active={campusKey === c.key} onClick={() => { setCampusKey(c.key); clearAllGeometry(); }}>
              {c.label}
            </Chip>
          ))}
        </div>
        <div className="p-4">
          <div className="relative">
            <div
              ref={mapRef}
              className={`h-[560px] overflow-hidden rounded-lg bg-map-ground [&>svg]:h-full [&>svg]:w-full ${mode ? "cursor-crosshair" : ""}`}
              onClick={handleMapClick}
              onDoubleClick={handleMapDoubleClick}
              onMouseLeave={() => setCursor(null)}
              onMouseMove={handleMapMove}
              dangerouslySetInnerHTML={{ __html: campus.svgRaw }}
            />
            <svg
              className="pointer-events-none absolute inset-0 h-full w-full"
              preserveAspectRatio="xMidYMid meet"
              viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
            >
              {/* 已完成：影响区域 */}
              {area && area.campusKey === campusKey ? (
                <g>
                  <polygon
                    points={area.vertices.map(([x, y]) => `${x},${y}`).join(" ")}
                    fill={AREA_COLOR}
                    fillOpacity={0.15}
                    stroke={AREA_COLOR}
                    strokeDasharray={`${unit * 0.3} ${unit * 0.22}`}
                    strokeWidth={unit * 0.09}
                  />
                  {area.vertices.map(([x, y], i) => (
                    <circle key={i} cx={x} cy={y} r={unit * 0.16} fill="#fff" stroke={AREA_COLOR} strokeWidth={unit * 0.07} />
                  ))}
                </g>
              ) : null}

              {/* 已完成：绕行路径 */}
              {path && path.campusKey === campusKey ? (
                <g>
                  <polyline
                    fill="none"
                    points={path.vertices.map(([x, y]) => `${x},${y}`).join(" ")}
                    stroke={PATH_COLOR}
                    strokeDasharray={`${unit * 0.35} ${unit * 0.25}`}
                    strokeLinecap="round"
                    strokeWidth={unit * 0.12}
                  />
                  <circle cx={path.vertices[0][0]} cy={path.vertices[0][1]} r={unit * 0.2} fill="#fff" stroke={PATH_COLOR} strokeWidth={unit * 0.08} />
                  <circle
                    cx={path.vertices[path.vertices.length - 1][0]}
                    cy={path.vertices[path.vertices.length - 1][1]}
                    r={unit * 0.2}
                    fill={PATH_COLOR}
                  />
                </g>
              ) : null}

              {/* 已完成：事件位置点 */}
              {point && point.campusKey === campusKey ? (
                <g>
                  <circle cx={point.x} cy={point.y} r={vb.w / 90} fill={POINT_COLOR} opacity={0.25} />
                  <circle cx={point.x} cy={point.y} r={vb.w / 200} fill={POINT_COLOR} stroke="#fff" strokeWidth={vb.w / 500} />
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
                  {mode === "area" && draftReady && cursor && dist(cursor, draft[0]) <= vb.w / 50 ? (
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
        </div>
        <p className="px-5 pb-4 text-center text-label text-sub">{statusText}</p>
      </Panel>
    </div>
  );
}
