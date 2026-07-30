import { MapPin, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { fetchMapAssetSvg } from "../../lib/api/public";
import * as admin from "../../lib/api/admin";
import type { FacilityDetailResponse, FacilityListItem, PlaceListItem, ReferenceDataResponse, SpacesResponse } from "../adminTypes";
import {
  EditorialPill,
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
// A11 设施编辑器
//
// 两条保存通道（同地点编辑器）：
//   1. 名称 / 服务时间 / 收费 / 位置描述 / 备注 → 新建修订草稿，经审核发布；
//   2. 设施类型 / 所属楼宇 / 楼层 / 服务位置落点 → 即时生效。
//
// 第二类在修订表里没有对应列（修订只存文案），因此直接写库并记审计。
// ---------------------------------------------------------------------------

interface PlanPoint {
  x: number;
  y: number;
}

export function FacilityEditorPage() {
  const { id = "" } = useParams();
  const isNew = id === "new";
  const navigate = useNavigate();

  const { state, reload } = useAsyncData(async (signal) => {
    const [ref, spaces, places, facilities, detail, maps] = await Promise.all([
      admin.listReferenceData<ReferenceDataResponse>(signal),
      admin.listSpaces<SpacesResponse>(signal),
      admin.listAdminPlaces<PlaceListItem>(signal),
      isNew ? Promise.resolve({ items: [] as FacilityListItem[] }) : admin.listFacilities<FacilityListItem>(signal),
      isNew ? Promise.resolve(null) : admin.getFacility<FacilityDetailResponse>(id, signal),
      admin.listMapVersions(signal),
    ]);
    return { ref, spaces, places: places.items, facilities: facilities.items, detail, maps: maps.items };
  }, [id, isNew]);

  const [name, setName] = useState("");
  const [typeId, setTypeId] = useState("");
  const [hostPlaceId, setHostPlaceId] = useState("");
  const [floorId, setFloorId] = useState("");
  const [hours, setHours] = useState("");
  const [fee, setFee] = useState("");
  const [locationText, setLocationText] = useState("");
  const [note, setNote] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [baseContent, setBaseContent] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (state.status !== "ready" || isNew) return;
    const item = state.data!.facilities.find((f) => f.id === id);
    const detail = state.data!.detail?.facility;
    if (!item) return;
    setName(String(item.displayName ?? ""));
    setTypeId(String(item.facilityTypeId ?? ""));
    setHostPlaceId(item.hostPlaceId ? String(item.hostPlaceId) : "");
    setFloorId(item.floorId ? String(item.floorId) : "");
    if (!detail) return;
    try {
      const serviceHours = JSON.parse(String(detail.service_hours_json ?? "null")) as { text?: unknown } | null;
      setHours(typeof serviceHours?.text === "string" ? serviceHours.text : "");
    } catch {
      setHours("");
    }
    let content: Record<string, unknown> = {};
    try {
      content = JSON.parse(String(detail.content_json ?? "{}")) as Record<string, unknown>;
    } catch {
      content = {};
    }
    setBaseContent(content);
    setFee(typeof content.fee === "string" ? content.fee : "");
    setLocationText(typeof content.locationDescription === "string" ? content.locationDescription : "");
    setNote(typeof content.note === "string" ? content.note : "");
    setSourceId(detail.source_id ? String(detail.source_id) : "");
  }, [state, id, isNew]);

  if (state.status === "loading") return <LoadingState label="加载设施…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  const data = state.data!;
  const item = isNew ? null : data.facilities.find((f) => f.id === id) ?? null;
  const reviewLocked = item?.editorialStatus === "in_review";
  const floors = data.spaces.floors.filter((f) => !hostPlaceId || f.buildingPlaceId === hostPlaceId);
  const existingAnchor = (data.detail?.locations ?? [])[0] as Record<string, unknown> | undefined;

  async function save(thenSubmit: boolean) {
    if (!name.trim()) { setError("请填写名称"); return; }
    if (!typeId) { setError("请选择设施类型"); return; }
    setBusy(true);
    setError("");
    setNotice("");
    const content = { ...baseContent };
    for (const [key, value] of [["fee", fee], ["locationDescription", locationText], ["note", note]] as const) {
      if (value.trim()) content[key] = value.trim();
      else delete content[key];
    }
    try {
      let revisionId = "";
      if (isNew) {
        const created = await admin.createFacility({
          facilityTypeId: typeId,
          hostPlaceId: hostPlaceId || undefined,
          floorId: floorId || undefined,
          displayName: name.trim(),
          serviceHours: hours.trim() ? { text: hours.trim() } : undefined,
          content,
          sourceId: sourceId || undefined,
        });
        revisionId = created.revisionId;
      } else {
        // 挂接关系先落库（即时生效），再提交正文修订（走审核）。
        await admin.updateFacility(id, {
          facilityTypeId: typeId,
          hostPlaceId: hostPlaceId || null,
          floorId: floorId || null,
        });
        const created = await admin.createFacilityRevision(id, {
          displayName: name.trim(),
          serviceHours: hours.trim() ? { text: hours.trim() } : undefined,
          content,
          sourceId: sourceId || undefined,
        });
        revisionId = created.id;
      }
      if (thenSubmit && revisionId) await admin.submitRevision("facility", revisionId);
      navigate("/admin/content?tab=facilities");
    } catch (err) {
      setError(errorMessage(err, "保存失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-[1fr_400px] gap-4">
      <Panel padded={false} className="self-start">
        <div className="flex items-center gap-3 p-5 pb-0">
          <input
            className="h-12 flex-1 rounded-lg border border-line px-4 text-emphasis outline-none focus:border-primary"
            onChange={(e) => setName(e.target.value)}
            placeholder="设施名称"
            value={name}
          />
          {item ? <EditorialPill status={item.editorialStatus} /> : null}
        </div>
        <div className="space-y-4 p-5">
          <div>
            <p className="mb-3 text-emphasis">挂接位置</p>
            <div className="grid grid-cols-2 gap-3">
              <SelectField
                label="设施类型"
                onChange={setTypeId}
                options={data.ref.facilityTypes.map((t) => ({ value: t.id, label: t.name }))}
                placeholder="选择类型"
                value={typeId}
              />
              <SelectField
                label="所属楼宇"
                onChange={(v) => { setHostPlaceId(v); setFloorId(""); }}
                options={data.places.map((p) => ({ value: p.id, label: p.displayName ?? p.id }))}
                placeholder="选择楼宇"
                value={hostPlaceId}
              />
              <SelectField
                label="楼层"
                onChange={setFloorId}
                options={floors.map((f) => ({ value: f.id, label: f.displayName }))}
                placeholder={hostPlaceId ? (floors.length ? "选择楼层" : "该楼宇暂无楼层") : "先选楼宇"}
                value={floorId}
              />
            </div>
            {hostPlaceId && floors.length === 0 ? (
              <p className="mt-2 text-label text-sub">该楼宇还没有楼层，可在对应地点的编辑页添加。</p>
            ) : null}
          </div>
          <div>
            <p className="mb-3 text-emphasis">服务内容</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="服务时间" onChange={setHours} placeholder="如 与楼宇一致 08:00-22:00" value={hours} />
              <Field label="收费标准" onChange={setFee} placeholder="如 黑白 0.3 元/页" value={fee} />
            </div>
          </div>
          <TextArea label="位置描述（用户看到的文字引导）" onChange={setLocationText} placeholder="如 2 层服务台旁" rows={2} value={locationText} />
          <TextArea label="备注" onChange={setNote} rows={2} value={note} />
          <SelectField
            label="数据来源"
            onChange={setSourceId}
            options={data.ref.sources.map((s) => ({ value: s.id, label: s.title }))}
            placeholder="不指定"
            value={sourceId}
          />
          {!isNew ? (
            <InfoNote tone="info">
              设施类型、所属楼宇和楼层保存后立即生效；名称、服务时间、收费和位置描述需提交审核通过并发布后对用户可见。
            </InfoNote>
          ) : null}
          {reviewLocked ? <InfoNote tone="warning">当前修订正在审核，处理完成后才能继续编辑。</InfoNote> : null}
          <ErrorBanner message={error} />
          {notice ? <InfoNote tone="info">{notice}</InfoNote> : null}
          <div className="flex gap-3">
            <GhostButton className="flex-1" disabled={busy || reviewLocked} onClick={() => save(false)}>保存草稿</GhostButton>
            <PrimaryButton className="flex-[2]" disabled={busy || reviewLocked} onClick={() => save(true)}>
              {busy ? "处理中…" : "提交审核 →"}
            </PrimaryButton>
          </div>
        </div>
      </Panel>

      <div className="space-y-4 self-start">
        {isNew ? (
          <Panel title="服务位置">
            <InfoNote>保存设施后可在此标注它在楼层图上的位置。</InfoNote>
          </Panel>
        ) : (
          <ServicePositionPanel
            existingAnchor={existingAnchor}
            facilityId={id}
            floorId={floorId}
            mapVersions={data.maps}
            onDone={(message) => { setNotice(message); reload(); }}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 服务位置：楼层图点选落点，或无图时填文字引导
// ---------------------------------------------------------------------------

function parseViewBox(svgRaw: string) {
  const match = svgRaw.match(/viewBox\s*=\s*"([^"]+)"/i);
  if (!match) return { x: 0, y: 0, width: 1000, height: 1000 };
  const [x, y, width, height] = match[1].trim().split(/[\s,]+/).map(Number);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return { x: 0, y: 0, width: 1000, height: 1000 };
  }
  return { x, y, width, height };
}

function pointFromAnchor(anchor: Record<string, unknown> | undefined): PlanPoint | null {
  const raw = anchor?.geometry_json;
  if (typeof raw !== "string") return null;
  try {
    const geometry = JSON.parse(raw) as { type?: string; coordinates?: unknown };
    if (geometry.type !== "Point" || !Array.isArray(geometry.coordinates)) return null;
    const [x, y] = geometry.coordinates as number[];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  } catch {
    return null;
  }
}

function ServicePositionPanel({
  facilityId,
  floorId,
  mapVersions,
  existingAnchor,
  onDone,
}: {
  facilityId: string;
  floorId: string;
  mapVersions: admin.MapVersionRow[];
  existingAnchor: Record<string, unknown> | undefined;
  onDone: (message: string) => void;
}) {
  const [point, setPoint] = useState<PlanPoint | null>(null);
  const [hint, setHint] = useState("");
  const [svgRaw, setSvgRaw] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const hostRef = useRef<HTMLDivElement>(null);

  // 该楼层已发布的平面图版本（svg_viewbox 才能与徽章坐标同系）。
  const plan = useMemo(
    () =>
      mapVersions.find(
        (version) =>
          version.floorId === floorId &&
          version.coordinateSpaceType === "svg_viewbox" &&
          ["ready", "published"].includes(version.lifecycleStatus),
      ) ?? null,
    [mapVersions, floorId],
  );

  useEffect(() => {
    setPoint(pointFromAnchor(existingAnchor));
    setHint(typeof existingAnchor?.location_hint === "string" ? existingAnchor.location_hint : "");
  }, [existingAnchor]);

  useEffect(() => {
    if (!plan) { setSvgRaw(null); return; }
    const controller = new AbortController();
    setSvgRaw(null);
    setLoadError("");
    fetchMapAssetSvg(plan.id, controller.signal)
      .then(setSvgRaw)
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(err instanceof Error ? err.message : "底图读取失败");
      });
    return () => controller.abort();
  }, [plan]);

  const viewBox = useMemo(() => (svgRaw ? parseViewBox(svgRaw) : null), [svgRaw]);

  // 底图内联展示：只读，点击落点由外层容器接管。
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !svgRaw) return;
    host.innerHTML = svgRaw;
    const svg = host.querySelector("svg");
    if (svg) {
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      svg.style.display = "block";
      svg.style.pointerEvents = "none";
    }
    return () => { host.innerHTML = ""; };
  }, [svgRaw]);

  async function persist(nextPoint: PlanPoint | null, nextHint: string) {
    setBusy(true);
    setError("");
    try {
      await admin.replaceFacilityLocation(facilityId, {
        point: nextPoint,
        mapVersionId: nextPoint && plan ? plan.id : null,
        locationHint: nextHint.trim() || null,
      });
      onDone(nextPoint ? "已保存服务位置落点" : nextHint.trim() ? "已保存位置引导文字" : "已清除服务位置");
    } catch (err) {
      setError(errorMessage(err, "保存位置失败"));
    } finally {
      setBusy(false);
    }
  }

  /** 容器内点击 → viewBox 坐标。底图按 xMidYMid meet 居中等比缩放，需还原留白。 */
  function handleClick(event: React.MouseEvent<HTMLDivElement>) {
    if (!viewBox) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const scale = Math.min(rect.width / viewBox.width, rect.height / viewBox.height);
    const drawnWidth = viewBox.width * scale;
    const drawnHeight = viewBox.height * scale;
    const offsetX = (rect.width - drawnWidth) / 2;
    const offsetY = (rect.height - drawnHeight) / 2;
    const localX = event.clientX - rect.left - offsetX;
    const localY = event.clientY - rect.top - offsetY;
    if (localX < 0 || localY < 0 || localX > drawnWidth || localY > drawnHeight) return;
    setPoint({
      x: Number((viewBox.x + localX / scale).toFixed(2)),
      y: Number((viewBox.y + localY / scale).toFixed(2)),
    });
  }

  const markerStyle = useMemo(() => {
    if (!point || !viewBox) return null;
    return {
      left: `${((point.x - viewBox.x) / viewBox.width) * 100}%`,
      top: `${((point.y - viewBox.y) / viewBox.height) * 100}%`,
    };
  }, [point, viewBox]);

  return (
    <Panel
      title="服务位置"
      action={point || hint.trim() ? <Pill tone="info">已标注</Pill> : null}
    >
      <div className="space-y-3">
        {!floorId ? (
          <InfoNote>先为设施指定楼层，才能在楼层图上标注位置。</InfoNote>
        ) : !plan ? (
          <InfoNote>该楼层还没有已发布的平面图，可先填写位置引导文字。</InfoNote>
        ) : loadError ? (
          <InfoNote tone="warning">平面图加载失败：{loadError}</InfoNote>
        ) : !svgRaw ? (
          <p className="py-6 text-center text-body text-sub">正在加载平面图…</p>
        ) : (
          <>
            <p className="text-label text-sub">在图上点击设施所在位置</p>
            <div
              className="relative h-[260px] cursor-crosshair overflow-hidden rounded-lg border border-line bg-surface"
              onClick={handleClick}
            >
              <div className="absolute inset-0" ref={hostRef} />
              {markerStyle ? (
                <span
                  className="pointer-events-none absolute grid h-7 w-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-primary text-white shadow-card"
                  style={markerStyle}
                >
                  <MapPin size={15} />
                </span>
              ) : null}
            </div>
          </>
        )}

        <Field
          label="位置引导文字"
          onChange={setHint}
          placeholder="如 3 层电梯厅右侧"
          value={hint}
        />

        <div className="flex gap-2">
          <PrimaryButton className="flex-1" disabled={busy} onClick={() => persist(point, hint)}>
            {busy ? "处理中…" : "保存位置"}
          </PrimaryButton>
          {point || hint.trim() ? (
            <GhostButton
              danger
              disabled={busy}
              onClick={() => { setPoint(null); setHint(""); void persist(null, ""); }}
            >
              <Trash2 size={14} />
              清除
            </GhostButton>
          ) : null}
        </div>
        <InfoNote tone="info">位置标注保存后，会出现在用户看到的楼层图上。</InfoNote>
        <ErrorBanner message={error} />
      </div>
    </Panel>
  );
}
