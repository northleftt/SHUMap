import { MapPin, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import * as admin from "../../lib/api/admin";
import {
  arrayValue,
  jsonObject,
  nullablePositiveInteger,
  nullableSingleTextObject,
  nullableString,
  objectValue,
  oneOf,
  optionalString,
  requiredString,
} from "../../lib/dataContract";
import type { FacilityDetailResponse, PlaceListItem, ReferenceDataResponse, SpacesResponse } from "../adminTypes";
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
  MarkerScaleField,
  TextArea,
  errorMessage,
  useAsyncData,
} from "../components/primitives";

import { MediaPanel, readMedia, type MediaRow } from "../components/MediaPanel";
import { LocationEditor, finalizeLocationDrafts, locationDraftFromApi, locationInput, type LocationDraft } from "../components/LocationEditor";
import { sanitizeSvg } from "../../lib/svg/sanitize";
import { parseSvgViewBox } from "../../../shared/svg-geometry.mjs";
import { markerScaleFromContent } from "../../lib/map/markerScale";
import type { FacilityContent } from "../../../shared/revision-contract";

// ---------------------------------------------------------------------------
// A11 设施编辑器
//
// 文案、设施挂接关系与楼层图服务落点统一进入修订审核。
// ---------------------------------------------------------------------------

/**
 * 楼外设施可用的位置用途。
 *
 * 不含 service_position：那一条由下面的「服务位置」面板独占（楼层平面图点选），
 * 两处都能编同一行会互相覆盖。楼外的设施（露天充电桩、快递柜、自助售货机）
 * 在校区图上点，用 primary_display / centroid 这些角色。navigation_target 供
 * 导航终点用，画布选点后自动换算成 GCJ-02 经纬度。
 */
const FACILITY_LOCATION_ROLES = [
  "primary_display", "centroid", "main_entrance", "accessible_entrance", "navigation_target", "other",
] as const;

interface PlanPoint {
  x: number;
  y: number;
}

type FacilityOperationalStatus = "available" | "partially_available" | "unavailable" | "unknown";

interface FacilityEditorRevision {
  displayName: string;
  facilityTypeId: string;
  hostPlaceId: string;
  floorId: string;
  indoorSpaceId: string;
  quantity: number | null;
  operationalStatus: FacilityOperationalStatus;
  serviceHours: string;
  content: FacilityContent;
  media: MediaRow[];
  fee: string;
  locationDescription: string;
  note: string;
  sourceId: string;
  editorialStatus: "draft" | "in_review" | "approved" | "rejected" | "superseded";
  locations: LocationDraft[];
}

function parseFacilityEditorRevision(response: FacilityDetailResponse): FacilityEditorRevision {
  const facility = objectValue(response.facility, "facility");
  const structure = jsonObject(facility.structure_json, "facility_revisions.structure_json");
  const content = jsonObject(facility.content_json, "facility_revisions.content_json");
  const locations = arrayValue(structure.locations, "facility_revisions.structure_json.locations")
    .map((location, index) => locationDraftFromApi(objectValue(location, `facility_revisions.structure_json.locations[${index}]`), index));
  return {
    displayName: requiredString(facility.display_name, "facility_revisions.display_name"),
    facilityTypeId: requiredString(structure.facilityTypeId, "facility_revisions.structure_json.facilityTypeId"),
    hostPlaceId: nullableString(structure.hostPlaceId, "facility_revisions.structure_json.hostPlaceId") ?? "",
    floorId: nullableString(structure.floorId, "facility_revisions.structure_json.floorId") ?? "",
    indoorSpaceId: nullableString(structure.indoorSpaceId, "facility_revisions.structure_json.indoorSpaceId") ?? "",
    quantity: nullablePositiveInteger(structure.quantity, "facility_revisions.structure_json.quantity"),
    operationalStatus: oneOf(
      structure.operationalStatus,
      "facility_revisions.structure_json.operationalStatus",
      ["available", "partially_available", "unavailable", "unknown"] as const,
    ),
    serviceHours: nullableSingleTextObject(facility.service_hours_json, "facility_revisions.service_hours_json", "text"),
    content: content as FacilityContent,
    media: readMedia(content.media),
    fee: optionalString(content.fee, "facility_revisions.content_json.fee") ?? "",
    locationDescription: optionalString(content.locationDescription, "facility_revisions.content_json.locationDescription") ?? "",
    note: optionalString(content.note, "facility_revisions.content_json.note") ?? "",
    sourceId: nullableString(facility.source_id, "facility_revisions.source_id") ?? "",
    editorialStatus: oneOf(
      facility.editorial_status,
      "facility_revisions.editorial_status",
      ["draft", "in_review", "approved", "rejected", "superseded"] as const,
    ),
    locations,
  };
}

export function FacilityEditorPage() {
  const { id = "" } = useParams();
  const isNew = id === "new";
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialBuildingPlaceId = isNew ? searchParams.get("buildingPlaceId") ?? "" : "";
  const initialFloorId = isNew ? searchParams.get("floorId") ?? "" : "";

  const { state } = useAsyncData(async (signal) => {
    const [ref, spaces, places, detail, maps] = await Promise.all([
      admin.listReferenceData<ReferenceDataResponse>(signal),
      admin.listSpaces<SpacesResponse>(signal),
      admin.listAdminPlaces<PlaceListItem>(signal),
      isNew ? Promise.resolve(null) : admin.getFacility<FacilityDetailResponse>(id, signal),
      admin.listMapVersions(signal),
    ]);
    return {
      ref,
      spaces,
      places: places.items,
      detail,
      editor: detail ? parseFacilityEditorRevision(detail) : null,
      maps: maps.items,
    };
  }, [id, isNew]);

  const [name, setName] = useState("");
  const [typeId, setTypeId] = useState("");
  const [hostPlaceId, setHostPlaceId] = useState("");
  const [floorId, setFloorId] = useState("");
  const [indoorSpaceId, setIndoorSpaceId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [operationalStatus, setOperationalStatus] = useState<FacilityOperationalStatus>("unknown");
  const [hours, setHours] = useState("");
  const [fee, setFee] = useState("");
  const [locationText, setLocationText] = useState("");
  const [note, setNote] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [baseContent, setBaseContent] = useState<FacilityContent>({});
  const [markerSize, setMarkerSize] = useState(1);
  const [media, setMedia] = useState<MediaRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [locationDrafts, setLocationDrafts] = useState<LocationDraft[]>([]);

  useEffect(() => {
    if (state.status !== "ready") return;
    if (isNew) {
      const floor = state.data.spaces.floors.find((candidate) => candidate.id === initialFloorId);
      if (initialFloorId && floor && floor.buildingPlaceId === initialBuildingPlaceId) {
        setHostPlaceId(initialBuildingPlaceId);
        setFloorId(initialFloorId);
      }
      return;
    }
    const editor = state.data!.editor;
    if (!editor) throw new Error("Facility detail is missing");
    setName(editor.displayName);
    setTypeId(editor.facilityTypeId);
    setHostPlaceId(editor.hostPlaceId);
    setFloorId(editor.floorId);
    setIndoorSpaceId(editor.indoorSpaceId);
    setQuantity(editor.quantity === null ? "" : String(editor.quantity));
    setOperationalStatus(editor.operationalStatus);
    setHours(editor.serviceHours);
    setBaseContent(editor.content);
    setMarkerSize(markerScaleFromContent(editor.content));
    setMedia(editor.media);
    setFee(editor.fee);
    setLocationText(editor.locationDescription);
    setNote(editor.note);
    setSourceId(editor.sourceId);
    setLocationDrafts(editor.locations);
  }, [state, id, initialBuildingPlaceId, initialFloorId, isNew]);

  if (state.status === "loading") return <LoadingState label="加载设施…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  const data = state.data!;
  const editor = data.editor;
  const reviewLocked = editor?.editorialStatus === "in_review";
  const floors = data.spaces.floors.filter((f) => !hostPlaceId || f.buildingPlaceId === hostPlaceId);
  const indoorSpaces = data.spaces.spaces.filter((space) => !floorId || space.floorId === floorId);
  const existingAnchor = locationDrafts.find((location) => location.role === "service_position");
  // 楼外设施没有宿主楼宇，校区只能来自设施自己选的校区图；挂在楼里时跟随楼宇。
  const hostCampusId = hostPlaceId
    ? data.places.find((place) => place.id === hostPlaceId)?.campusId ?? null
    : null;

  async function save(thenSubmit: boolean) {
    if (!name.trim()) { setError("请填写名称"); return; }
    if (!typeId) { setError("请选择设施类型"); return; }
    const parsedQuantity = quantity.trim() ? Number(quantity) : null;
    if (parsedQuantity !== null && (!Number.isInteger(parsedQuantity) || parsedQuantity <= 0)) { setError("数量必须是正整数"); return; }
    setBusy(true);
    setError("");
    const content = { ...baseContent };
    if (media.length) content.media = media;
    else delete content.media;
    for (const [key, value] of [["fee", fee], ["locationDescription", locationText], ["note", note]] as const) {
      if (value.trim()) content[key] = value.trim();
      else delete content[key];
    }
    // 图钉大小：标准档不落字段；非标准写 content.marker.size。
    if (markerSize === 1) delete content.marker;
    else content.marker = { size: markerSize };
    try {
      let revisionId = "";
      if (isNew) {
        const created = await admin.createFacility({
          displayName: name.trim(),
          serviceHours: hours.trim() ? { text: hours.trim() } : null,
          content,
          sourceId: sourceId || null,
          structure: {
            facilityTypeId: typeId,
            hostPlaceId: hostPlaceId || null,
            floorId: floorId || null,
            indoorSpaceId: indoorSpaceId || null,
            quantity: parsedQuantity,
            operationalStatus,
            locations: finalizeLocationDrafts(locationDrafts).map(locationInput),
          },
        });
        revisionId = created.revisionId;
      } else {
        const created = await admin.createFacilityRevision(id, {
          displayName: name.trim(),
          serviceHours: hours.trim() ? { text: hours.trim() } : null,
          content,
          sourceId: sourceId || null,
          structure: {
            facilityTypeId: typeId,
            hostPlaceId: hostPlaceId || null,
            floorId: floorId || null,
            indoorSpaceId: indoorSpaceId || null,
            quantity: parsedQuantity,
            operationalStatus,
            locations: finalizeLocationDrafts(locationDrafts).map(locationInput),
          },
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
          {editor ? <EditorialPill status={editor.editorialStatus} /> : null}
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
                onChange={(v) => {
                  setHostPlaceId(v);
                  setFloorId("");
                  setIndoorSpaceId("");
                  // 服务位置草稿绑的是旧楼旧层的平面图（floorId + mapVersionId 都在
                  // 行里），留着它会把设施标到已经不属于它的楼层图上。
                  setLocationDrafts((rows) => rows.filter((location) => location.role !== "service_position"));
                }}
                options={data.places.map((p) => ({ value: p.id, label: p.displayName ?? p.id }))}
                placeholder="选择楼宇"
                value={hostPlaceId}
              />
              <SelectField
                label="楼层"
                onChange={(value) => {
                  setFloorId(value);
                  setIndoorSpaceId("");
                  // 同上：楼层一换，服务位置草稿里的 floorId/平面图版本就过期了。
                  setLocationDrafts((rows) => rows.filter((location) => location.role !== "service_position"));
                }}
                options={floors.map((f) => ({ value: f.id, label: f.displayName }))}
                placeholder={hostPlaceId ? (floors.length ? "选择楼层" : "该楼宇暂无楼层") : "先选楼宇"}
                value={floorId}
              />
              <SelectField
                label="室内空间"
                onChange={setIndoorSpaceId}
                options={indoorSpaces.map((space) => ({ value: space.id, label: space.displayName }))}
                placeholder={floorId ? "不指定" : "先选楼层"}
                value={indoorSpaceId}
              />
              <Field label="数量" onChange={setQuantity} placeholder="如 2" type="number" value={quantity} />
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
          <div>
            <MarkerScaleField
              onChange={setMarkerSize}
              value={markerSize}
              />
            <p className="mt-1.5 text-aux text-sub">仅对楼外图钉生效；楼内设施不出图钉。改动经审核发布后生效。</p>
          </div>
          {reviewLocked ? <InfoNote tone="warning">当前修订正在审核，处理完成后才能继续编辑。</InfoNote> : null}
          <ErrorBanner message={error} />
          <div className="flex gap-3">
            <GhostButton className="flex-1" disabled={busy || reviewLocked} onClick={() => save(false)}>保存草稿</GhostButton>
            <PrimaryButton className="flex-[2]" disabled={busy || reviewLocked} onClick={() => save(true)}>
              {busy ? "处理中…" : "提交审核 →"}
            </PrimaryButton>
          </div>
        </div>
      </Panel>

      <div className="space-y-4 self-start">
        <MediaPanel disabled={reviewLocked} media={media} onChange={setMedia} />
        <ServicePositionPanel
          buildingPlaceId={hostPlaceId}
          disabled={reviewLocked}
          existingAnchor={existingAnchor}
          floorId={floorId}
          indoorSpaceId={indoorSpaceId}
          mapVersions={data.maps}
          onChange={(next) => {
            setLocationDrafts((rows) => {
              const index = rows.findIndex((location) => location.role === "service_position");
              if (!next) return index === -1 ? rows : rows.filter((_, rowIndex) => rowIndex !== index);
              const normalized = { ...next, isPrimary: index === -1 ? !rows.some((location) => location.isPrimary) : rows[index].isPrimary };
              if (index === -1) return [...rows, normalized];
              return rows.map((location, rowIndex) => rowIndex === index ? normalized : location);
            });
          }}
        />

        {/* 楼外设施：挂不到楼层的点位（室外充电桩、路边直饮水）在校区图上点。
            service_position 归上面的楼层图面板，这里按角色过滤掉，两处不会打架。 */}
        <LocationEditor
          buildingCampusId={hostCampusId}
          disabled={reviewLocked}
          entityPlaceId={hostPlaceId || null}
          mapVersions={data.maps}
          onChange={(rows) => {
            // 两个面板共写一个数组：合并后要重新收敛主要位置（ finalize 内部也
            // 会顺手丢掉空行），否则服务位置与楼外新行可能同时亮着 isPrimary。
            setLocationDrafts((current) => finalizeLocationDrafts([
              ...current.filter((location) => location.role === "service_position"),
              ...rows,
            ]));
          }}
          roles={FACILITY_LOCATION_ROLES}
          spaces={data.spaces}
          title="楼外位置"
          value={locationDrafts.filter((location) => location.role !== "service_position")}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 服务位置：楼层图点选落点，或无图时填文字引导
// ---------------------------------------------------------------------------

function pointFromAnchor(anchor: LocationDraft | undefined): PlanPoint | null {
  const geometry = anchor?.origin?.geometry;
  if (geometry === undefined || geometry === null) return null;
  if (!geometry || typeof geometry !== "object" || Array.isArray(geometry)) {
    throw new Error("Facility service position geometry must be an object");
  }
  const { type, coordinates } = geometry as Record<string, unknown>;
  if (type !== "Point" || !Array.isArray(coordinates) || coordinates.length !== 2) {
    throw new Error("Facility service position must be a GeoJSON Point");
  }
  const [x, y] = coordinates;
  if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) {
    throw new Error("Facility service position coordinates must be finite numbers");
  }
  return { x, y };
}

function ServicePositionPanel({
  buildingPlaceId,
  disabled,
  floorId,
  indoorSpaceId,
  mapVersions,
  existingAnchor,
  onChange,
}: {
  buildingPlaceId: string;
  disabled: boolean;
  floorId: string;
  indoorSpaceId: string;
  mapVersions: admin.MapVersionRow[];
  existingAnchor: LocationDraft | undefined;
  onChange: (value: LocationDraft | null) => void;
}) {
  const [point, setPoint] = useState<PlanPoint | null>(null);
  const [hint, setHint] = useState("");
  const [svgRaw, setSvgRaw] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");
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
    setHint(existingAnchor?.locationHint ?? "");
  }, [existingAnchor]);

  useEffect(() => {
    if (!plan) { setSvgRaw(null); return; }
    const controller = new AbortController();
    setSvgRaw(null);
    setLoadError("");
    admin.fetchAdminMapAssetSvg(plan.id, controller.signal)
      .then(setSvgRaw)
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(err instanceof Error ? err.message : "底图读取失败");
      });
    return () => controller.abort();
  }, [plan]);

  const viewBox = useMemo(() => (svgRaw ? parseSvgViewBox(svgRaw) : null), [svgRaw]);

  // 底图内联展示：只读，点击落点由外层容器接管。
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !svgRaw) return;
    const safeSvg = sanitizeSvg(svgRaw);
    if (!safeSvg) return;
    host.innerHTML = safeSvg;
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

  function apply(nextPoint: PlanPoint | null, nextHint: string) {
    setError("");
    const trimmedHint = nextHint.trim();
    if (!nextPoint && !trimmedHint) {
      onChange(null);
      return;
    }
    if (!floorId) {
      setError("请先选择设施所在楼层");
      return;
    }
    let mapVersionId: string | null = null;
    if (nextPoint) {
      if (!plan) {
        setError("当前楼层没有可用于坐标绑定的平面图");
        return;
      }
      mapVersionId = plan.id;
    }
    onChange(locationDraftFromApi({
      campusId: null,
      buildingPlaceId: buildingPlaceId || null,
      floorId,
      indoorSpaceId: indoorSpaceId || null,
      role: "service_position",
      isPrimary: existingAnchor?.isPrimary ?? true,
      geometryType: nextPoint ? "Point" : null,
      ...(nextPoint ? { geometry: { type: "Point", coordinates: [nextPoint.x, nextPoint.y] } } : {}),
      crs: nextPoint ? "svg_viewbox" : null,
      mapVersionId,
      mapFeatureId: null,
      locationHint: trimmedHint || null,
      precisionLevel: nextPoint ? "exact" : "floor",
      accuracyMeters: null,
      sourceId: null,
      validFrom: null,
      validTo: null,
    }, 0));
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
          <PrimaryButton className="flex-1" disabled={disabled} onClick={() => apply(point, hint)}>
            应用到修订草稿
          </PrimaryButton>
          {point || hint.trim() ? (
            <GhostButton
              danger
              disabled={disabled}
              onClick={() => { setPoint(null); setHint(""); apply(null, ""); }}
            >
              <Trash2 size={14} />
              清除
            </GhostButton>
          ) : null}
        </div>
        <ErrorBanner message={error} />
      </div>
    </Panel>
  );
}
