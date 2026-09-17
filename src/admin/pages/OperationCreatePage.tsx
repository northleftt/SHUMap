import { Hexagon, MapPin, Route, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import * as admin from "../../lib/api/admin";
import type { CampusKey } from "../../lib/types";
import type { OperationalEventRow, PlaceListItem, SpacesResponse } from "../adminTypes";
import {
  CampusMapCanvasChips,
  CampusMapCanvasTools,
  CampusMapCanvasView,
  campusKeyOfRow,
  isVert,
  openRing,
  useCampusMapCanvas,
  vertsOf,
  type CanvasExtraShape,
  type CanvasGeometry,
  type CanvasTool,
  type CanvasVert,
} from "../components/CampusMapCanvas";
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
// A6 运营事件 · 地图编辑器（点 / 区域 / 路径三种几何绘制，写 svg_viewbox）
//
// 两种模式共用同一画布与同一套表单：
//   create — /admin/operations/new：事件主体 + 几何一次性 POST
//   edit   — /admin/operations/:id/edit：主体走 PUT /api/admin/operations/:id，
//            几何走 PUT /api/admin/operations/:id/locations（replace-all）。
//            被驳回的事件在这里改完保存后回到 draft，重新排队审核。
//
// 画布每次只承载「正在画的那一个」形状；画完即追加进 shapes 清单（地图上有
// extras 只读回显），所以同一事件可以挂多个影响区域 / 多条绕行路径。
// 要改某个已存形状：在清单里删掉重画（画布不支持逐顶点编辑）。
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

/** 标注颜色预设；null = 跟随类型对应的 severity 默认色（双端同口径）。 */
const COLOR_PRESETS = ["#1e80c1", "#f59e0b", "#dc2626", "#7c3aed", "#059669", "#db2777", "#475569"] as const;

type EventWithLocations = OperationalEventRow & {
  targets?: Array<{ targetType: string; targetId: string }>;
  locations?: admin.OperationLocationRow[];
};

/** 画布工具 ↔ 位置角色；committed 形状存工具名，出库时映射成 role。 */
const TOOL_TO_ROLE = { point: "event_location", area: "impact_area", path: "route_shape" } as const;
const ROLE_TO_TOOL = { event_location: "point", impact_area: "area", route_shape: "path" } as const;
const TOOL_LABELS: Record<CanvasTool, string> = { point: "事件位置", area: "影响区域", path: "绕行路径" };
const TOOL_ICONS: Record<CanvasTool, typeof MapPin> = { point: MapPin, area: Hexagon, path: Route };

interface CommittedShape extends CanvasExtraShape {
  tool: CanvasTool;
}

/** ISO 时间戳 → datetime-local 输入框值（本地时区）。 */
function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (!Number.isFinite(date.valueOf())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function shapeMetric(shape: CommittedShape): string {
  if (shape.tool === "point") return `x ${shape.verts[0][0]} · y ${shape.verts[0][1]}`;
  return `${shape.verts.length} 顶点`;
}

export function OperationCreatePage() {
  const navigate = useNavigate();
  const { id: routeId } = useParams();
  const editing = Boolean(routeId);

  const { state } = useAsyncData(async (signal) => {
    const [spaces, places, maps, operations] = await Promise.all([
      admin.listSpaces<SpacesResponse>(signal),
      admin.listAdminPlaces<PlaceListItem>(signal),
      admin.listMapVersions(signal),
      routeId ? admin.listAdminOperations<EventWithLocations>(signal) : Promise.resolve(null),
    ]);
    const event = routeId ? operations?.items.find((item) => item.id === routeId) : undefined;
    if (routeId && !event) throw new Error("事件不存在");
    return { spaces, places: places.items, maps: maps.items, event };
  }, [routeId]);

  const [eventType, setEventType] = useState<(typeof EVENT_TYPES)[number]["key"]>("maintenance");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState<string | null>(null);
  const [startsAt, setStartsAt] = useState("");
  const [expectedEndsAt, setExpectedEndsAt] = useState("");
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [targetPick, setTargetPick] = useState("");
  const [campusKey, setCampusKey] = useState<CampusKey>("baoshan");
  const [geometry, setGeometry] = useState<CanvasGeometry | null>(null);
  const [shapes, setShapes] = useState<CommittedShape[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hydrated, setHydrated] = useState(false);

  const ready = state.status === "ready";
  const campusRows = ready ? state.data!.spaces.campuses : [];
  const mapVersions = ready ? state.data!.maps : [];

  /** 画完一个形状就挪进 shapes 清单，画布槽位清空，可以接着画下一个。 */
  function handleCanvasChange(next: CanvasGeometry | null) {
    if (!next) {
      setGeometry(null);
      return;
    }
    const appended: CommittedShape[] = [];
    if (next.point) appended.push({ key: crypto.randomUUID(), tool: "point", verts: [next.point] });
    if (next.area) appended.push({ key: crypto.randomUUID(), tool: "area", verts: next.area });
    if (next.path) appended.push({ key: crypto.randomUUID(), tool: "path", verts: next.path });
    if (appended.length > 0) {
      setShapes((current) => [...current, ...appended]);
      setGeometry(null);
      return;
    }
    setGeometry(next);
  }

  const canvas = useCampusMapCanvas({
    tools: ["point", "area", "path"],
    value: geometry,
    onChange: handleCanvasChange,
    campusKey,
    onCampusChange: (key) => {
      setCampusKey(key);
      // 换校区就换了坐标系，已存的形状在新底图上落在别处，只能一并清掉。
      setShapes([]);
    },
    campuses: campusRows,
    mapVersions,
    enabled: ready,
    extras: shapes,
    labels: { point: "事件位置", area: "影响区域", path: "绕行路径" },
    toolsHint: "在左侧",
  });

  const loadedEvent = ready ? state.data!.event : undefined;

  // 编辑模式：把事件主体与已存几何回显进表单/清单（只做一次，避免覆盖用户改动）
  useEffect(() => {
    if (!editing || hydrated || !loadedEvent) return;
    if (!Array.isArray(loadedEvent.locations)) {
      setError("事件位置数据缺失");
      setHydrated(true);
      return;
    }
    setEventType(eventTypeMetadata(loadedEvent.eventType as (typeof EVENT_TYPES)[number]["key"]).key);
    setTitle(loadedEvent.title);
    setDescription(loadedEvent.description ?? "");
    setColor(typeof loadedEvent.color === "string" ? loadedEvent.color : null);
    setStartsAt(isoToLocalInput(loadedEvent.startsAt));
    setExpectedEndsAt(isoToLocalInput(loadedEvent.expectedEndsAt));
    setTargetIds((loadedEvent.targets ?? []).filter((t) => t.targetType === "place").map((t) => t.targetId));

    const locations = loadedEvent.locations;
    const anchorCampusId = locations.find((location) => location.campusId)?.campusId ?? null;
    const row = anchorCampusId ? campusRows.find((candidate) => candidate.id === anchorCampusId) : undefined;
    if (anchorCampusId && !row) {
      setError(`事件位置引用了未知校区 ${anchorCampusId}`);
      setHydrated(true);
      return;
    }
    const restoredKey = row ? campusKeyOfRow(row) : campusKey;
    const restored: CommittedShape[] = [];

    try {
      for (const location of locations) {
        if (location.crs !== "svg_viewbox" || typeof location.geometryJson !== "string") {
          throw new Error(`位置 ${location.id} 缺少 svg_viewbox 几何`);
        }
        const geometry = JSON.parse(location.geometryJson) as { type?: string; coordinates?: unknown };
        const tool = ROLE_TO_TOOL[location.role];
        if (!tool) throw new Error(`事件位置包含不支持的角色 ${location.role}`);
        if (tool === "point") {
          if (geometry.type !== "Point" || !isVert(geometry.coordinates)) throw new Error("事件点几何无效");
          restored.push({ key: location.id, tool, verts: [geometry.coordinates as CanvasVert] });
        } else if (tool === "area") {
          if (geometry.type !== "Polygon" || !Array.isArray(geometry.coordinates) || geometry.coordinates.length !== 1) {
            throw new Error("影响区域几何无效");
          }
          const ring = openRing(vertsOf(geometry.coordinates[0]));
          if (ring.length < 3) throw new Error("影响区域至少需要三个顶点");
          restored.push({ key: location.id, tool, verts: ring });
        } else {
          if (geometry.type !== "LineString") throw new Error("路径几何无效");
          const vertices = vertsOf(geometry.coordinates);
          if (vertices.length < 2) throw new Error("路径至少需要两个顶点");
          restored.push({ key: location.id, tool, verts: vertices });
        }
      }
    } catch (reason) {
      setError(errorMessage(reason, "事件位置数据无效"));
    }
    // 出错也把已解析出的部分留在清单里，与解析前的行为一致
    setShapes(restored);
    setCampusKey(restoredKey);
    setHydrated(true);
  }, [editing, hydrated, loadedEvent, campusRows, campusKey]);

  if (state.status === "loading" || canvas.status === "loading") return <LoadingState label={editing ? "加载事件与几何…" : "加载…"} />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  if (canvas.status === "error") return <ErrorBanner message={canvas.message} />;
  const campus = canvas.campus;
  if (!campus || !canvas.viewBox) return <ErrorBanner message="当前校区没有可用地图" />;
  const places = state.data!.places;
  const event = state.data!.event;
  const ended = Boolean(event) && ["resolved", "expired", "cancelled"].includes(event!.operationalStatus);

  const typeMeta = eventTypeMetadata(eventType);

  // 该校区当前可用的地图版本（ready / published）。带上它，发布校验才能把
  // 事件几何和 release 里的地图版本对上（releases.ts 的 map-version warning）。
  const campusRow = campusRows.find((row) => campusKeyOfRow(row) === campusKey);
  const mapVersion = state.data!.maps.find((version) => version.id === campus.mapVersionId);

  /** 已存形状清单 → locations 载荷；点在最前，成为 primary binding。 */
  function buildLocations(): admin.OperationLocationInput[] {
    if (!campusRow || !mapVersion) throw new Error("当前校区缺少 canonical 地图版本");
    const base = {
      campusId: campusRow.id,
      buildingPlaceId: null,
      floorId: null,
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
    const ordered = [...shapes].sort((a, b) => {
      const order: Record<CanvasTool, number> = { point: 0, area: 1, path: 2 };
      return order[a.tool] - order[b.tool];
    });
    return ordered.map((shape, index) => {
      if (shape.tool === "point") {
        return {
          ...base,
          role: TOOL_TO_ROLE.point,
          geometryType: "Point" as const,
          geometry: { type: "Point", coordinates: [shape.verts[0][0], shape.verts[0][1]] },
          isPrimary: index === 0,
        };
      }
      if (shape.tool === "area") {
        return {
          ...base,
          role: TOOL_TO_ROLE.area,
          geometryType: "Polygon" as const,
          geometry: { type: "Polygon", coordinates: [[...shape.verts, shape.verts[0]]] },
          isPrimary: index === 0,
        };
      }
      return {
        ...base,
        role: TOOL_TO_ROLE.path,
        geometryType: "LineString" as const,
        geometry: { type: "LineString", coordinates: shape.verts },
        isPrimary: index === 0,
      };
    });
  }

  async function save() {
    if (canvas.draft.length > 0) { setError("请先完成（Enter）或取消（Esc）正在绘制的图形"); return; }
    // 校区必须显式解析成 campuses 行，否则事件会泛化到所有校区
    if (!campus) { setError("当前校区没有可用地图"); return; }
    if (shapes.length > 0 && (!campusRow || !mapVersion)) {
      setError(`未能在后端找到校区「${campus.label}」（code=${campusKey}），无法保存几何；请先在校区管理中确认该校区存在`);
      return;
    }
    if (!title.trim()) { setError("请填写标题"); return; }
    if (!startsAt) { setError("请选择开始时间"); return; }
    setBusy(true);
    setError("");
    const detailBody = {
      eventType,
      severity: typeMeta.severity,
      color,
      title: title.trim(),
      description: description.trim() || null,
      startsAt: new Date(startsAt).toISOString(),
      expectedEndsAt: expectedEndsAt ? new Date(expectedEndsAt).toISOString() : null,
      autoExpireAt: null,
      sourceId: null,
      responsibleOrganizationId: null,
      targets: targetIds.map((id) => ({ type: "place" as const, id, impactType: "affected" })),
    };
    try {
      if (editing && routeId) {
        // 主体与几何分两个端点；几何是 replace-all，清单里留下的内容即最终结果
        await admin.updateOperation(routeId, detailBody);
        await admin.replaceOperationLocations(routeId, buildLocations());
        navigate(`/admin/operations/${routeId}`);
        return;
      }
      await admin.createOperation({ ...detailBody, locations: buildLocations() });
      navigate("/admin/operations");
    } catch (err) {
      setError(errorMessage(err, "保存失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-[420px_1fr] items-start gap-4">
      {/* 左：表单 */}
      <Panel padded={false}>
        <div className="space-y-4 p-5">
          <div>
            <p className="text-card">{editing ? "编辑运营事件" : "新建运营事件"}</p>
            <p className="mt-0.5 text-aux text-sub">
              {editing ? "事件信息、标注颜色与地图几何都在这里修改" : "填写信息并在地图上标注位置"}
            </p>
          </div>

          {editing && event?.editorialStatus === "rejected" ? (
            <InfoNote tone="warning">
              该事件已被驳回{event.reviewNote ? `：${event.reviewNote}` : "。"}修改保存后会重新进入审核队列。
            </InfoNote>
          ) : null}
          {ended ? <InfoNote tone="warning">事件已结束，内容只读；如需移除请在详情页删除。</InfoNote> : null}

          <div>
            <p className="mb-2 text-label text-sub">类型</p>
            <div className="flex gap-2">
              {EVENT_TYPES.map((t) => (
                <Chip key={t.key} active={eventType === t.key} onClick={() => !ended && setEventType(t.key)}>
                  {t.label}
                </Chip>
              ))}
            </div>
          </div>
          <Field disabled={ended} label="标题" onChange={setTitle} placeholder="如 东区食堂燃气检修" value={title} />
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1.5 block text-label text-sub">开始时间</span>
              <input className="h-9 w-full rounded-lg border border-line px-3 text-body outline-none focus:border-primary" disabled={ended} onChange={(e) => setStartsAt(e.target.value)} type="datetime-local" value={startsAt} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-label text-sub">预计恢复（选填）</span>
              <input className="h-9 w-full rounded-lg border border-line bg-surface px-3 text-body outline-none focus:border-primary" disabled={ended} onChange={(e) => setExpectedEndsAt(e.target.value)} type="datetime-local" value={expectedEndsAt} />
            </label>
          </div>
          <TextArea disabled={ended} label="描述（选填）" onChange={setDescription} rows={3} value={description} />

          <div>
            <p className="mb-2 text-label text-sub">地图标注颜色</p>
            <div className="flex flex-wrap items-center gap-2">
              <Chip active={color === null} onClick={() => !ended && setColor(null)}>默认（随类型）</Chip>
              {COLOR_PRESETS.map((preset) => (
                <button
                  aria-label={`标注颜色 ${preset}`}
                  className={`h-7 w-7 rounded-full border-2 ${color === preset ? "border-ink" : "border-transparent"}`}
                  disabled={ended}
                  key={preset}
                  onClick={() => setColor(preset)}
                  style={{ backgroundColor: preset }}
                  type="button"
                />
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 text-label text-sub">关联对象（楼宇 / 地点）</p>
            <div className="flex gap-2">
              <div className="flex-1">
                <SelectField
                  disabled={ended}
                  onChange={setTargetPick}
                  options={places.filter((p) => !targetIds.includes(p.id)).map((p) => ({ value: p.id, label: p.displayName ?? p.id }))}
                  placeholder="选择地点"
                  value={targetPick}
                />
              </div>
              <GhostButton
                className="h-9"
                disabled={ended || !targetPick}
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
                    {!ended ? <button className="ml-1" onClick={() => setTargetIds((cur) => cur.filter((t) => t !== id))} type="button">×</button> : null}
                  </Pill>
                ))}
              </div>
            ) : null}
          </div>

          <div>
            <p className="mb-2 text-label text-sub">位置与影响范围</p>
            <CampusMapCanvasTools canvas={canvas} />

            {shapes.length > 0 ? (
              <div className="mt-2 space-y-2">
                {shapes.map((shape) => {
                  const Icon = TOOL_ICONS[shape.tool];
                  const ordinal = shapes.filter((s) => s.tool === shape.tool).indexOf(shape) + 1;
                  const total = shapes.filter((s) => s.tool === shape.tool).length;
                  return (
                    <div className="flex items-center justify-between rounded-lg bg-page px-3.5 py-2.5" key={shape.key}>
                      <div className="flex items-center gap-2 text-body">
                        <Icon size={15} className="text-primary" />
                        <span className="font-medium">{TOOL_LABELS[shape.tool]}{total > 1 ? ` ${ordinal}` : ""}</span>
                        <span className="text-sub">{shapeMetric(shape)}</span>
                      </div>
                      <button
                        className="text-sub hover:text-error disabled:opacity-40"
                        disabled={ended}
                        onClick={() => setShapes((current) => current.filter((s) => s.key !== shape.key))}
                        type="button"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : null}

            <p className="mt-2 text-label leading-relaxed text-sub">
              事件位置、影响区域、绕行路径都可标注多处：画完一个接着画下一个即可，清单里可单独删除重画。
              {editing ? "保存后清单里留下的内容即最终结果，全部删除则清空标注。" : null}
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
            {!ended ? (
              <PrimaryButton className="flex-[2]" disabled={busy} onClick={save}>
                {busy ? "保存中…" : editing ? (event?.editorialStatus === "rejected" ? "保存并重新提交审核" : "保存修改") : "保存草稿"}
              </PrimaryButton>
            ) : null}
          </div>
        </div>
      </Panel>

      {/* 右：地图 */}
      <Panel padded={false} className="overflow-hidden">
        <div className="flex items-center gap-2 px-5 pt-4">
          <CampusMapCanvasChips canvas={canvas} />
        </div>
        <div className="p-4">
          <CampusMapCanvasView canvas={canvas} />
        </div>
        <p className="px-5 pb-4 text-center text-label text-sub">{canvas.statusText}</p>
      </Panel>
    </div>
  );
}
