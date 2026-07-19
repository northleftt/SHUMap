import { MapPin, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
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
// A6 新建运营事件 · 简化地图编辑器（点击放点，写 svg_viewbox Point；
// 区域/路径绘制留待下轮）
// ---------------------------------------------------------------------------

const EVENT_TYPES = [
  { key: "maintenance", label: "维修", severity: "warning" },
  { key: "activity", label: "活动", severity: "info" },
  { key: "closure", label: "关闭", severity: "critical" },
  { key: "notice", label: "通知", severity: "info" },
] as const;

interface PlacedPoint {
  campusKey: string;
  x: number;
  y: number;
}

function viewBoxOf(svgRaw: string): { x: number; y: number; w: number; h: number } {
  const match = svgRaw.match(/viewBox="([^"]+)"/);
  const parts = (match?.[1] ?? "0 0 1000 1000").split(/[\s,]+/).map(Number);
  return { x: parts[0] ?? 0, y: parts[1] ?? 0, w: parts[2] ?? 1000, h: parts[3] ?? 1000 };
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
  const [point, setPoint] = useState<PlacedPoint | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const campus = campusConfigs.find((c) => c.key === campusKey) ?? campusConfigs[0];
  const vb = useMemo(() => viewBoxOf(campus.svgRaw), [campus]);

  if (state.status === "loading") return <LoadingState label="加载…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  const places = state.data!.places;

  const typeMeta = EVENT_TYPES.find((t) => t.key === eventType) ?? EVENT_TYPES[0];

  function handleMapClick(event: React.MouseEvent<HTMLDivElement>) {
    const rect = mapRef.current?.getBoundingClientRect();
    if (!rect) return;
    // preserveAspectRatio="xMidYMid meet" 反推 viewBox 坐标
    const scale = Math.min(rect.width / vb.w, rect.height / vb.h);
    const offsetX = (rect.width - vb.w * scale) / 2;
    const offsetY = (rect.height - vb.h * scale) / 2;
    const x = vb.x + (event.clientX - rect.left - offsetX) / scale;
    const y = vb.y + (event.clientY - rect.top - offsetY) / scale;
    setPoint({ campusKey, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
  }

  async function save() {
    if (!title.trim()) { setError("请填写标题"); return; }
    if (!startsAt) { setError("请选择开始时间"); return; }
    setBusy(true);
    setError("");
    try {
      const campusRow = state.data!.spaces.campuses.find(
        (c) => c.code === campusKey || c.name.includes(campus.label.replace("校区", "")),
      );
      await admin.createOperation({
        eventType,
        severity: typeMeta.severity,
        title: title.trim(),
        description: description.trim() || undefined,
        startsAt: new Date(startsAt).toISOString(),
        expectedEndsAt: expectedEndsAt ? new Date(expectedEndsAt).toISOString() : undefined,
        targets: targetIds.map((id) => ({ type: "place", id })),
        locations: point
          ? [
              {
                role: "event_location",
                campusId: campusRow?.id,
                geometryType: "Point",
                geometry: { type: "Point", coordinates: [point.x, point.y] },
                crs: "svg_viewbox",
              },
            ]
          : [],
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
              <input className="h-9 w-full rounded-lg border border-line px-3 text-body outline-none focus:border-primary" onChange={(e) => setExpectedEndsAt(e.target.value)} type="datetime-local" value={expectedEndsAt} />
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
            {point ? (
              <div className="flex items-center justify-between rounded-lg bg-page px-3.5 py-2.5">
                <div className="flex items-center gap-2 text-body">
                  <MapPin size={15} className="text-primary" />
                  <span className="font-medium">事件位置</span>
                  <span className="text-sub">Point · x {point.x} · y {point.y}</span>
                </div>
                <button className="text-sub hover:text-error" onClick={() => setPoint(null)} type="button">
                  <Trash2 size={15} />
                </button>
              </div>
            ) : (
              <InfoNote>在右侧地图上单击放置事件位置（可选）。</InfoNote>
            )}
            <p className="mt-2 text-label leading-relaxed text-sub">
              位置随事件保存，发布后移动端可见；坐标存 svg_viewbox 并绑定当前地图版本。区域 / 路径绘制下轮提供。
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
            <Chip key={c.key} active={campusKey === c.key} onClick={() => { setCampusKey(c.key); setPoint(null); }}>
              {c.label}
            </Chip>
          ))}
        </div>
        <div className="p-4">
          <div className="relative">
            <div
              ref={mapRef}
              className="h-[560px] cursor-crosshair overflow-hidden rounded-lg bg-map-ground [&>svg]:h-full [&>svg]:w-full"
              onClick={handleMapClick}
              dangerouslySetInnerHTML={{ __html: campus.svgRaw }}
            />
            {point && point.campusKey === campusKey ? (
              <svg
                className="pointer-events-none absolute inset-0 h-full w-full"
                preserveAspectRatio="xMidYMid meet"
                viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
              >
                <circle cx={point.x} cy={point.y} r={vb.w / 90} fill="#1e80c1" opacity={0.25} />
                <circle cx={point.x} cy={point.y} r={vb.w / 200} fill="#1e80c1" stroke="#fff" strokeWidth={vb.w / 500} />
              </svg>
            ) : null}
          </div>
        </div>
        <p className="px-5 pb-4 text-center text-label text-sub">
          {point && point.campusKey === campusKey ? `x ${point.x} · y ${point.y}（svg_viewbox）｜单击重新放置` : "单击地图添加事件位置点"}
        </p>
      </Panel>
    </div>
  );
}
