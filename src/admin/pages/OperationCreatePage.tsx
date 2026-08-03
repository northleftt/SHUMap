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
  type CanvasGeometry,
} from "../components/CampusMapCanvas";
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
//
// 画布本身（反投影、绘制状态机、叠加层）在 CampusMapCanvas 里，地点与设施编辑
// 器共用同一份。
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

type EventWithLocations = OperationalEventRow & {
  targets?: Array<{ targetType: string; targetId: string }>;
  locations?: admin.OperationLocationRow[];
};

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
  const [startsAt, setStartsAt] = useState("");
  const [expectedEndsAt, setExpectedEndsAt] = useState("");
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [targetPick, setTargetPick] = useState("");
  const [campusKey, setCampusKey] = useState<CampusKey>("baoshan");
  const [geometry, setGeometry] = useState<CanvasGeometry | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hydrated, setHydrated] = useState(false);

  const ready = state.status === "ready";
  const campusRows = ready ? state.data!.spaces.campuses : [];
  const mapVersions = ready ? state.data!.maps : [];

  const canvas = useCampusMapCanvas({
    tools: ["point", "area", "path"],
    value: geometry,
    onChange: setGeometry,
    campusKey,
    onCampusChange: setCampusKey,
    campuses: campusRows,
    mapVersions,
    enabled: ready,
    labels: { point: "事件位置", area: "影响区域", path: "绕行路径" },
    toolsHint: "在左侧",
  });

  const loadedEvent = ready ? state.data!.event : undefined;

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
    const restored: CanvasGeometry = { campusKey: restoredKey, point: null, area: null, path: null };

    try {
      for (const location of locations) {
        if (location.crs !== "svg_viewbox" || typeof location.geometryJson !== "string") {
          throw new Error(`位置 ${location.id} 缺少 svg_viewbox 几何`);
        }
        const geometry = JSON.parse(location.geometryJson) as { type?: string; coordinates?: unknown };
        if (location.role === "event_location") {
          if (geometry.type !== "Point" || !isVert(geometry.coordinates)) throw new Error("事件点几何无效");
          restored.point = [geometry.coordinates[0], geometry.coordinates[1]];
        } else if (location.role === "impact_area") {
          if (geometry.type !== "Polygon" || !Array.isArray(geometry.coordinates) || geometry.coordinates.length !== 1) {
            throw new Error("影响区域几何无效");
          }
          const ring = openRing(vertsOf(geometry.coordinates[0]));
          if (ring.length < 3) throw new Error("影响区域至少需要三个顶点");
          restored.area = ring;
        } else if (location.role === "route_shape") {
          if (geometry.type !== "LineString") throw new Error("路径几何无效");
          const vertices = vertsOf(geometry.coordinates);
          if (vertices.length < 2) throw new Error("路径至少需要两个顶点");
          restored.path = vertices;
        } else {
          throw new Error(`事件位置包含不支持的角色 ${location.role}`);
        }
      }
    } catch (reason) {
      setError(errorMessage(reason, "事件位置数据无效"));
    }
    // 出错也把已解析出的部分留在画布上，与解析前的行为一致
    if (restored.point || restored.area || restored.path) setGeometry(restored);
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

  const typeMeta = eventTypeMetadata(eventType);

  // 该校区当前可用的地图版本（ready / published）。带上它，发布校验才能把
  // 事件几何和 release 里的地图版本对上（releases.ts 的 map-version warning）。
  const campusRow = campusRows.find((row) => campusKeyOfRow(row) === campusKey);
  const mapVersion = state.data!.maps.find((version) => version.id === campus.mapVersionId);

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
    const drawn = canvas.geometry;
    if (drawn?.point) {
      locations.push({
        ...base,
        role: "event_location",
        geometryType: "Point",
        geometry: { type: "Point", coordinates: [drawn.point[0], drawn.point[1]] },
        isPrimary: locations.length === 0,
      });
    }
    if (drawn?.area) {
      locations.push({
        ...base,
        role: "impact_area",
        geometryType: "Polygon",
        geometry: { type: "Polygon", coordinates: [[...drawn.area, drawn.area[0]]] },
        isPrimary: locations.length === 0,
      });
    }
    if (drawn?.path) {
      locations.push({
        ...base,
        role: "route_shape",
        geometryType: "LineString",
        geometry: { type: "LineString", coordinates: drawn.path },
        isPrimary: locations.length === 0,
      });
    }
    return locations;
  }

  const hasGeometry = Boolean(canvas.geometry);

  async function save() {
    if (canvas.draft.length > 0) { setError("请先完成（Enter）或取消（Esc）正在绘制的图形"); return; }
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
            <CampusMapCanvasTools canvas={canvas} />

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
