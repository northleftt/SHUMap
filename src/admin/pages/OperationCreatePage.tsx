import { Check, Hexagon, MapPin, Route, Trash2, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as admin from "../../lib/api/admin";
import { campusConfigs } from "../../lib/release/mapData";
import type { PlaceListItem, SpacesResponse } from "../adminTypes";
import {
  Chip,
  ErrorBanner,
  Field,
  GhostButton,
  InfoNote,
  LoadingState,
  Panel,
  Pill,
  PrimaryButton,
  SelectField,
  TextArea,
  errorMessage,
  useAsyncData,
} from "../components/primitives";

// ---------------------------------------------------------------------------
// A6 新建运营事件 · 地图编辑器（点 / 区域 / 路径三种几何绘制，写 svg_viewbox）
// ---------------------------------------------------------------------------

const EVENT_TYPES = [
  { key: "maintenance", label: "维修", severity: "warning" },
  { key: "activity", label: "活动", severity: "info" },
  { key: "closure", label: "关闭", severity: "critical" },
  { key: "notice", label: "通知", severity: "info" },
] as const;

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
  const match = svgRaw.match(/viewBox="([^"]+)"/);
  const parts = (match?.[1] ?? "0 0 1000 1000").split(/[\s,]+/).map(Number);
  return { x: parts[0] ?? 0, y: parts[1] ?? 0, w: parts[2] ?? 1000, h: parts[3] ?? 1000 };
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

export function OperationCreatePage() {
  const navigate = useNavigate();
  const mapRef = useRef<HTMLDivElement | null>(null);

  const { state } = useAsyncData(async (signal) => {
    const [spaces, places] = await Promise.all([
      admin.listSpaces<SpacesResponse>(signal),
      admin.listAdminPlaces<PlaceListItem>(signal),
    ]);
    return { spaces, places: places.items };
  }, []);

  const [eventType, setEventType] = useState<(typeof EVENT_TYPES)[number]["key"]>("maintenance");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [expectedEndsAt, setExpectedEndsAt] = useState("");
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [targetPick, setTargetPick] = useState("");
  const [campusKey, setCampusKey] = useState(campusConfigs[0]?.key ?? "baoshan");
  // 绘制状态：mode=当前工具；draft=进行中的顶点；point/area/path=已完成几何
  const [mode, setMode] = useState<DrawMode | null>(null);
  const [draft, setDraft] = useState<Vert[]>([]);
  const [cursor, setCursor] = useState<Vert | null>(null);
  const [point, setPoint] = useState<PlacedPoint | null>(null);
  const [area, setArea] = useState<PlacedShape | null>(null);
  const [path, setPath] = useState<PlacedShape | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const campus = campusConfigs.find((c) => c.key === campusKey) ?? campusConfigs[0];
  const vb = useMemo(() => viewBoxOf(campus.svgRaw), [campus]);
  // 闭合吸附半径（viewBox 单位）；双击去重 epsilon
  const snapR = vb.w / 50;
  const dedupeEps = vb.w / 500;

  const drafting = mode === "area" || mode === "path";
  const minVertices = mode === "area" ? 3 : 2;
  const draftReady = draft.length >= minVertices;

  function toViewBox(event: React.MouseEvent<HTMLDivElement>): Vert | null {
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

  function clearDrawing() {
    setMode(null);
    setDraft([]);
    setCursor(null);
  }

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

  function commitDraft() {
    if (!draftReady) return;
    if (mode === "area") setArea({ campusKey, vertices: draft });
    if (mode === "path") setPath({ campusKey, vertices: draft });
    clearDrawing();
  }

  function handleMapClick(event: React.MouseEvent<HTMLDivElement>) {
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
  });

  if (state.status === "loading") return <LoadingState label="加载…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  const places = state.data!.places;

  const typeMeta = EVENT_TYPES.find((t) => t.key === eventType) ?? EVENT_TYPES[0];

  async function save() {
    if (!title.trim()) { setError("请填写标题"); return; }
    if (!startsAt) { setError("请选择开始时间"); return; }
    if (draft.length > 0) { setError("请先完成（Enter）或取消（Esc）正在绘制的图形"); return; }
    setBusy(true);
    setError("");
    try {
      const campusRow = state.data!.spaces.campuses.find(
        (c) => c.code === campusKey || c.name.includes(campus.label.replace("校区", "")),
      );
      const locations: Record<string, unknown>[] = [];
      if (point && point.campusKey === campusKey) {
        locations.push({
          role: "event_location",
          campusId: campusRow?.id,
          geometryType: "Point",
          geometry: { type: "Point", coordinates: [point.x, point.y] },
          crs: "svg_viewbox",
        });
      }
      if (area && area.campusKey === campusKey) {
        const ring = [...area.vertices, area.vertices[0]];
        locations.push({
          role: "impact_area",
          campusId: campusRow?.id,
          geometryType: "Polygon",
          geometry: { type: "Polygon", coordinates: [ring] },
          crs: "svg_viewbox",
        });
      }
      if (path && path.campusKey === campusKey) {
        locations.push({
          role: "route_shape",
          campusId: campusRow?.id,
          geometryType: "LineString",
          geometry: { type: "LineString", coordinates: path.vertices },
          crs: "svg_viewbox",
        });
      }
      await admin.createOperation({
        eventType,
        severity: typeMeta.severity,
        title: title.trim(),
        description: description.trim() || undefined,
        startsAt: new Date(startsAt).toISOString(),
        expectedEndsAt: expectedEndsAt ? new Date(expectedEndsAt).toISOString() : undefined,
        targets: targetIds.map((id) => ({ type: "place", id })),
        locations,
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
    const coords = cursor ? `x ${cursor[0]} · y ${cursor[1]}（svg_viewbox）｜ ` : "";
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
            <p className="text-card">新建运营事件</p>
            <p className="mt-0.5 text-aux text-sub">第 2 步 · 在地图上标注位置</p>
          </div>
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
                    <span className="text-sub">Point · x {point.x} · y {point.y}</span>
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
                    <span className="text-sub">Polygon · {area.vertices.length} 顶点 · 跨度 {shapeExtent(area.vertices)}</span>
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
                    <span className="text-sub">LineString · {path.vertices.length} 顶点 · 长 {Math.round(pathLength(path.vertices))}</span>
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

              {!point && !area && !path && draft.length === 0 ? (
                <InfoNote>选择上方 点 / 区域 / 路径 后在右侧地图绘制（均为可选）。</InfoNote>
              ) : null}
            </div>

            <p className="mt-2 text-label leading-relaxed text-sub">
              位置随事件保存，发布后移动端可见；坐标存 svg_viewbox。事件位置（Point）、影响区域（Polygon）、绕行路径（LineString）各一份，重画自动替换。
            </p>
          </div>

          <ErrorBanner message={error} />
          <div className="flex gap-3">
            <GhostButton className="flex-1" onClick={() => navigate("/admin/operations")}>取消</GhostButton>
            <PrimaryButton className="flex-[2]" disabled={busy} onClick={save}>
              {busy ? "保存中…" : "保存草稿"}
            </PrimaryButton>
          </div>
        </div>
      </Panel>

      {/* 右：地图 */}
      <Panel padded={false} className="overflow-hidden">
        <div className="flex items-center gap-2 px-5 pt-4">
          {campusConfigs.map((c) => (
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
                  {mode === "area" && draftReady && cursor && dist(cursor, draft[0]) <= snapR ? (
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
