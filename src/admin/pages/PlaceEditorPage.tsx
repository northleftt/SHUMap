import { Layers, Plus, Trash2, Upload, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import * as admin from "../../lib/api/admin";
import {
  arrayValue,
  jsonObject,
  nullableString,
  objectValue,
  oneOf,
  optionalString,
  requiredString,
  stringValue,
} from "../../lib/dataContract";
import type { Floor, PlaceDetailResponse, ReferenceDataResponse, SpacesResponse } from "../adminTypes";
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
  Chip,
  MarkerScaleField,
  TextArea,
  errorMessage,
  fmtDateTime,
  useAsyncData,
} from "../components/primitives";

import { LocationEditor, ALL_ROLES, finalizeLocationDrafts, locationDraftFromApi, locationInput, type LocationDraft } from "../components/LocationEditor";
import { MediaPanel, readMedia, type MediaRow } from "../components/MediaPanel";
import { markerScaleFromContent } from "../../lib/map/markerScale";
import type { PlaceContent } from "../../../shared/revision-contract";

// ---------------------------------------------------------------------------
// A7 地点编辑器
//
// 正文、结构字段和位置统一写入修订草稿，经审核后原子应用。
// ---------------------------------------------------------------------------

interface RevisionRow {
  id: string;
  revision_no: number;
  editorial_status: string;
  display_name: string;
  created_by?: string | null;
  created_at: string;
}

interface FactRow {
  id?: string;
  label: string;
  value: string;
}

/** 食堂楼层供餐：meals 决定该层参与哪些餐别，stallTypes 是品类自由标签。 */
type DiningMeal = "breakfast" | "lunner" | "latenight";

interface DiningFloorRow {
  levelCode: string;
  meals: DiningMeal[];
  stallTypes: string[];
}

const DINING_MEAL_OPTIONS: Array<{ value: DiningMeal; label: string }> = [
  { value: "breakfast", label: "早餐" },
  { value: "lunner", label: "午晚餐" },
  { value: "latenight", label: "夜宵" },
];

interface PlaceBuildingStructure {
  buildingCode: string | null;
  managingOrganizationId: string | null;
  publicAccessLevel: "public" | "restricted" | "private" | "unknown";
}

interface PlaceEditorRevision {
  displayName: string;
  summary: string;
  description: string;
  sourceId: string;
  kindId: string;
  campusId: string;
  parentPlaceId: string;
  stableCode: string;
  aliases: string[];
  building: PlaceBuildingStructure | null;
  locations: LocationDraft[];
  content: PlaceContent;
  facts: FactRow[];
  media: MediaRow[];
}

interface PlaceEditorData {
  response: PlaceDetailResponse;
  revision: PlaceEditorRevision;
  lifecycleStatus: admin.PlaceLifecycle;
}

const PLACE_LIFECYCLES = ["planned", "active", "temporarily_closed", "retired"] as const;

const PLACE_LIFECYCLE_LABELS: Record<admin.PlaceLifecycle, string> = {
  planned: "筹建中",
  active: "启用",
  temporarily_closed: "暂时关闭",
  retired: "已停用",
};

/** 表单固定展示的四条信息；其余自定义条目原样保留。 */
const FACT_LABELS = ["开放时间", "联系电话", "所属单位", "进入方式"] as const;

const FACT_PLACEHOLDERS: Record<string, string> = {
  开放时间: "如 周一至周五 08:00-22:00",
  联系电话: "如 6613 5200",
  所属单位: "如 图书馆管理处",
  进入方式: "如 刷校园卡进入",
};

function readFacts(value: unknown): FactRow[] {
  return arrayValue(value, "place_revisions.content_json.detail.facts").map((raw, index) => {
    const field = `place_revisions.content_json.detail.facts[${index}]`;
    const record = objectValue(raw, field);
    const id = optionalString(record.id, `${field}.id`);
    return {
      ...(id === undefined ? {} : { id }),
      label: requiredString(record.label, `${field}.label`),
      value: stringValue(record.value, `${field}.value`),
    };
  });
}

/** content.dining 缺字段等于「没填过供餐信息」，不是数据坏了，与 readMedia 同口径。 */
function readDiningFloors(value: unknown): DiningFloorRow[] {
  if (value === undefined || value === null) return [];
  const dining = objectValue(value, "place_revisions.content_json.dining");
  if (dining.floors === undefined || dining.floors === null) return [];
  return arrayValue(dining.floors, "place_revisions.content_json.dining.floors").map((raw, index) => {
    const field = `place_revisions.content_json.dining.floors[${index}]`;
    const row = objectValue(raw, field);
    return {
      levelCode: requiredString(row.levelCode, `${field}.levelCode`),
      meals: arrayValue(row.meals, `${field}.meals`)
        .map((meal, mealIndex) => oneOf(meal, `${field}.meals[${mealIndex}]`, ["breakfast", "lunner", "latenight"] as const)),
      stallTypes: arrayValue(row.stallTypes, `${field}.stallTypes`)
        .map((stall, stallIndex) => requiredString(stall, `${field}.stallTypes[${stallIndex}]`)),
    };
  });
}

function parsePlaceEditorData(response: PlaceDetailResponse): PlaceEditorData {
  const place = objectValue(response.place, "place");
  const structure = jsonObject(place.structure_json, "place_revisions.structure_json");
  const content = jsonObject(place.content_json, "place_revisions.content_json");
  const detail = objectValue(content.detail, "place_revisions.content_json.detail");
  const aliases = arrayValue(structure.aliases, "place_revisions.structure_json.aliases")
    .map((value, index) => requiredString(value, `place_revisions.structure_json.aliases[${index}]`));
  const buildingValue = structure.building;
  let building: PlaceBuildingStructure | null;
  if (buildingValue === null) {
    building = null;
  } else {
    const record = objectValue(buildingValue, "place_revisions.structure_json.building");
    building = {
      buildingCode: nullableString(record.buildingCode, "place_revisions.structure_json.building.buildingCode"),
      managingOrganizationId: nullableString(record.managingOrganizationId, "place_revisions.structure_json.building.managingOrganizationId"),
      publicAccessLevel: oneOf(
        record.publicAccessLevel,
        "place_revisions.structure_json.building.publicAccessLevel",
        ["public", "restricted", "private", "unknown"] as const,
      ),
    };
  }
  const locations = arrayValue(structure.locations, "place_revisions.structure_json.locations")
    .map((location, index) => locationDraftFromApi(objectValue(location, `place_revisions.structure_json.locations[${index}]`), index));
  return {
    response,
    lifecycleStatus: oneOf(place.lifecycle_status, "places.lifecycle_status", PLACE_LIFECYCLES),
    revision: {
      displayName: requiredString(place.display_name, "place_revisions.display_name"),
      summary: nullableString(place.summary, "place_revisions.summary") ?? "",
      description: nullableString(place.description, "place_revisions.description") ?? "",
      sourceId: nullableString(place.source_id, "place_revisions.source_id") ?? "",
      kindId: requiredString(structure.kindId, "place_revisions.structure_json.kindId"),
      campusId: nullableString(structure.campusId, "place_revisions.structure_json.campusId") ?? "",
      parentPlaceId: nullableString(structure.parentPlaceId, "place_revisions.structure_json.parentPlaceId") ?? "",
      stableCode: nullableString(structure.stableCode, "place_revisions.structure_json.stableCode") ?? "",
      aliases,
      building,
      locations,
      content: content as PlaceContent,
      facts: readFacts(detail.facts),
      media: readMedia(detail.media),
    },
  };
}

export function PlaceEditorPage() {
  const { id = "" } = useParams();
  const isNew = id === "new";
  const navigate = useNavigate();

  const detail = useAsyncData(
    async (signal) => {
      if (isNew) return null;
      return parsePlaceEditorData(await admin.getAdminPlace<PlaceDetailResponse>(id, signal));
    },
    [id, isNew],
  );
  const meta = useAsyncData(async (signal) => {
    const [spaces, ref, maps] = await Promise.all([
      admin.listSpaces<SpacesResponse>(signal),
      admin.listReferenceData<ReferenceDataResponse>(signal),
      admin.listMapVersions(signal),
    ]);
    return { spaces, ref, mapVersions: maps.items };
  }, []);

  const [name, setName] = useState("");
  const [kindId, setKindId] = useState("");
  const [campusId, setCampusId] = useState("");
  const [parentPlaceId, setParentPlaceId] = useState("");
  const [stableCode, setStableCode] = useState("");
  const [hasBuildingStructure, setHasBuildingStructure] = useState(false);
  const [buildingCode, setBuildingCode] = useState("");
  const [managingOrganizationId, setManagingOrganizationId] = useState("");
  const [publicAccessLevel, setPublicAccessLevel] = useState<PlaceBuildingStructure["publicAccessLevel"]>("unknown");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [aliases, setAliases] = useState("");
  const [facts, setFacts] = useState<FactRow[]>([]);
  const [media, setMedia] = useState<MediaRow[]>([]);
  const [diningFloors, setDiningFloors] = useState<DiningFloorRow[]>([]);
  const [baseContent, setBaseContent] = useState<PlaceContent>({ detail: { facts: [], media: [] } });
  const [markerSize, setMarkerSize] = useState(1);
  const [sourceId, setSourceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [locationDrafts, setLocationDrafts] = useState<LocationDraft[]>([]);
  const [lifecycleStatus, setLifecycleStatus] = useState<admin.PlaceLifecycle>("active");
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [lifecycleNotice, setLifecycleNotice] = useState("");
  const [lifecycleError, setLifecycleError] = useState("");

  // 用当前修订初始化表单
  useEffect(() => {
    if (detail.state.status !== "ready" || detail.state.data === null) return;
    const revision = detail.state.data.revision;
    setLifecycleStatus(detail.state.data.lifecycleStatus);
    setName(revision.displayName);
    setKindId(revision.kindId);
    setCampusId(revision.campusId);
    setParentPlaceId(revision.parentPlaceId);
    setStableCode(revision.stableCode);
    setHasBuildingStructure(revision.building !== null);
    setBuildingCode(revision.building?.buildingCode ?? "");
    setManagingOrganizationId(revision.building?.managingOrganizationId ?? "");
    setPublicAccessLevel(revision.building?.publicAccessLevel ?? "unknown");
    setSummary(revision.summary);
    setDescription(revision.description);
    setBaseContent(revision.content);
    setMarkerSize(markerScaleFromContent(revision.content));
    setFacts(revision.facts);
    setMedia(revision.media);
    setDiningFloors(readDiningFloors(revision.content.dining));
    setSourceId(revision.sourceId);
    setAliases(revision.aliases.join("、"));
    setLocationDrafts(revision.locations);
  }, [detail.state]);

  if (!isNew && detail.state.status === "loading") return <LoadingState label="加载地点…" />;
  if (!isNew && detail.state.status === "error") return <ErrorBanner message={detail.state.message} />;
  if (meta.state.status === "loading") return <LoadingState label="加载地点分类与空间数据…" />;
  if (meta.state.status === "error") return <ErrorBanner message={meta.state.message} />;

  const kinds = meta.state.data.ref.placeKinds;
  const campuses = meta.state.data.spaces.campuses;
  const parentPlaces = meta.state.data.spaces.buildings.filter((building) => building.placeId !== id);
  const data = detail.state.status === "ready" ? detail.state.data : null;
  const revisions = data === null ? [] : (data.response.revisions as RevisionRow[]).slice(0, 8);
  const currentRevision = revisions.find((r) => r.editorial_status === "in_review")
    ?? revisions.find((r) => r.editorial_status === "draft");
  const reviewLocked = currentRevision?.editorial_status === "in_review";
  const floors = data === null ? [] : data.response.floors;

  function factValue(label: string): string {
    return facts.find((fact) => fact.label === label)?.value ?? "";
  }

  function setFactValue(label: string, value: string) {
    setFacts((rows) => {
      const index = rows.findIndex((row) => row.label === label);
      if (index === -1) return value.trim() ? [...rows, { label, value }] : rows;
      const next = [...rows];
      next[index] = { ...next[index], label, value };
      return next;
    });
  }

  /** 详细信息与图片写回 content.detail，其余内容字段原样保留。 */
  function composeContent(): PlaceContent {
    const previousDetail = objectValue(baseContent.detail, "place content.detail");
    const keptFacts = facts
      .map((fact) => ({ ...(fact.id === undefined ? {} : { id: fact.id }), label: fact.label.trim(), value: fact.value.trim() }))
      .filter((fact) => fact.label && fact.value);
    const nextDetail: PlaceContent["detail"] = { ...previousDetail, facts: keptFacts, media };
    const next: PlaceContent = { ...baseContent, detail: nextDetail };
    // 食堂专属：楼层供餐信息；非食堂类型不保留 dining，避免类型改走后留脏数据。
    if (kindId === "canteen") {
      next.dining = { floors: diningFloors };
    } else {
      delete next.dining;
    }
    // 图钉大小：标准档不落字段，保持 content 干净；非标准写 content.marker.size。
    if (markerSize === 1) {
      delete next.marker;
    } else {
      next.marker = { size: markerSize };
    }
    return next;
  }

  async function save(thenSubmit: boolean) {
    if (!name.trim()) { setError("请填写名称"); return; }
    if (!kindId) { setError("请选择类型"); return; }
    try {
      setBusy(true);
      setError("");
      setNotice("");
      const aliasList = aliases.split(/[、,，]/).map((a) => a.trim()).filter(Boolean);
      const content = composeContent();
      // finalize 同时收敛主要位置：空行占位 primary 被滤掉后一个都不剩，保存照样 400。
      const locations = finalizeLocationDrafts(locationDrafts)
        .map((location) => locationInput(hasBuildingStructure ? {
          ...location,
          campusId,
          buildingPlaceId: isNew ? "" : id,
        } : location));
      let placeId = id;
      let revisionId = "";
      if (isNew) {
        const created = await admin.createPlace({
          displayName: name.trim(),
          summary: summary.trim() || null,
          description: description.trim() || null,
          content,
          sourceId: sourceId || null,
          structure: {
            kindId,
            campusId: campusId || null,
            parentPlaceId: parentPlaceId || null,
            stableCode: stableCode.trim() || null,
            aliases: aliasList,
            locations,
            building: hasBuildingStructure ? {
              buildingCode: buildingCode.trim() || null,
              managingOrganizationId: managingOrganizationId || null,
              publicAccessLevel,
            } : null,
          },
        });
        placeId = created.id;
        revisionId = created.revisionId;
      } else {
        const created = await admin.createPlaceRevision(placeId, {
          displayName: name.trim(),
          summary: summary.trim() || null,
          description: description.trim() || null,
          content,
          sourceId: sourceId || null,
          structure: {
            kindId,
            campusId: campusId || null,
            parentPlaceId: parentPlaceId || null,
            stableCode: stableCode.trim() || null,
            aliases: aliasList,
            building: hasBuildingStructure ? {
              buildingCode: buildingCode.trim() || null,
              managingOrganizationId: managingOrganizationId || null,
              publicAccessLevel,
            } : null,
            locations,
          },
        });
        revisionId = created.id;
      }
      if (thenSubmit) await admin.submitRevision("place", revisionId);
      navigate("/admin/content");
    } catch (err) {
      setError(errorMessage(err, "保存失败"));
    } finally {
      setBusy(false);
    }
  }

  /**
   * 生命周期即时生效，不进修订流：楼今天封闭就得今天从地图上拿掉，等审核就晚了。
   * 停用会失效位置绑定；重新启用时后端把轮廓绑回去，不必等下一次修订审核。
   */
  async function applyLifecycle(next: admin.PlaceLifecycle) {
    setLifecycleBusy(true);
    setLifecycleError("");
    setLifecycleNotice("");
    try {
      await admin.updatePlaceLifecycle(id, next);
      setLifecycleStatus(next);
      setLifecycleNotice(`已改为「${PLACE_LIFECYCLE_LABELS[next]}」`);
    } catch (err) {
      setLifecycleError(errorMessage(err, "修改地点状态失败"));
    } finally {
      setLifecycleBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-[1fr_400px] gap-4">
      {/* 左：表单 */}
      <Panel padded={false} className="self-start">
        <div className="flex items-center gap-3 p-5 pb-0">
          <input
            className="h-12 flex-1 rounded-lg border border-line px-4 text-emphasis outline-none focus:border-primary"
            onChange={(e) => setName(e.target.value)}
            placeholder="地点名称"
            value={name}
          />
          {currentRevision ? <EditorialPill status={currentRevision.editorial_status} /> : null}
        </div>
        <div className="space-y-4 p-5">
          <div>
            <p className="mb-3 text-emphasis">基本信息</p>
            <div className="grid grid-cols-2 gap-3">
              <SelectField
                label="类型"
                onChange={setKindId}
                options={kinds.map((k) => ({ value: k.id, label: k.name }))}
                placeholder="选择类型"
                value={kindId}
              />
              <SelectField
                label="校区"
                onChange={setCampusId}
                options={campuses.map((c) => ({ value: c.id, label: c.name }))}
                placeholder="选择校区"
                value={campusId}
              />
              <SelectField
                label="父地点"
                onChange={setParentPlaceId}
                options={parentPlaces.map((place) => ({ value: place.placeId, label: place.displayName ?? place.placeId }))}
                placeholder="不指定"
                value={parentPlaceId}
              />
              <Field label="地点编号" onChange={setStableCode} placeholder="如 LIB-01" value={stableCode} />
              <label className="flex items-center gap-2 self-end rounded-lg border border-line px-3 py-2 text-body text-ink">
                <input
                  checked={hasBuildingStructure}
                  disabled={floors.length > 0 && hasBuildingStructure}
                  onChange={(event) => setHasBuildingStructure(event.target.checked)}
                  type="checkbox"
                />
                作为楼宇维护楼层结构
              </label>
              {hasBuildingStructure ? (
                <>
                  <Field label="楼栋代码" onChange={setBuildingCode} placeholder="如 A1" value={buildingCode} />
                  <SelectField
                    label="管理单位"
                    onChange={setManagingOrganizationId}
                    options={meta.state.data.ref.organizations.map((organization) => ({ value: organization.id, label: organization.name }))}
                    placeholder="不指定"
                    value={managingOrganizationId}
                  />
                  <SelectField
                    label="开放级别"
                    onChange={(value) => setPublicAccessLevel(oneOf(value, "publicAccessLevel", ["public", "restricted", "private", "unknown"] as const))}
                    options={[
                      { value: "public", label: "公开" },
                      { value: "restricted", label: "有限开放" },
                      { value: "private", label: "不对外开放" },
                      { value: "unknown", label: "未知" },
                    ]}
                    value={publicAccessLevel}
                  />
                </>
              ) : null}
              <Field label="别名（、分隔）" onChange={setAliases} placeholder="如 图书馆、上图" value={aliases} />
              <MarkerScaleField
                onChange={setMarkerSize}
                value={markerSize}
                />
            </div>
            <p className="mt-2 text-aux text-sub">仅对楼外图钉生效；楼宇以轮廓高亮呈现，无图钉。改动经审核发布后生效。</p>
          </div>
          <TextArea label="简介" onChange={setSummary} placeholder="一句话介绍" rows={2} value={summary} />
          <TextArea label="详细描述" onChange={setDescription} placeholder="注意事项、历史沿革等" rows={4} value={description} />

          {/* 详细信息：用户在地点详情页看到的信息行 */}
          <div>
            <p className="mb-3 text-emphasis">详细信息</p>
            <div className="grid grid-cols-2 gap-3">
              {FACT_LABELS.map((label) => (
                <Field
                  key={label}
                  label={label}
                  onChange={(value) => setFactValue(label, value)}
                  placeholder={FACT_PLACEHOLDERS[label]}
                  value={factValue(label)}
                />
              ))}
            </div>
            {facts.some((fact) => !FACT_LABELS.includes(fact.label as (typeof FACT_LABELS)[number])) ? (
              <div className="mt-3 space-y-2">
                <p className="text-label text-sub">其他信息</p>
                {facts.map((fact, index) =>
                  FACT_LABELS.includes(fact.label as (typeof FACT_LABELS)[number]) ? null : (
                    <div key={`${fact.label}:${index}`} className="flex items-start gap-2">
                      <div className="grid flex-1 grid-cols-[160px_1fr] gap-2">
                        <Field
                          onChange={(value) =>
                            setFacts((rows) => rows.map((row, i) => (i === index ? { ...row, label: value } : row)))
                          }
                          placeholder="名称"
                          value={fact.label}
                        />
                        <Field
                          onChange={(value) =>
                            setFacts((rows) => rows.map((row, i) => (i === index ? { ...row, value } : row)))
                          }
                          placeholder="内容"
                          value={fact.value}
                        />
                      </div>
                      <GhostButton danger onClick={() => setFacts((rows) => rows.filter((_, i) => i !== index))}>
                        <Trash2 size={14} />
                      </GhostButton>
                    </div>
                  ),
                )}
              </div>
            ) : null}
          </div>

          <SelectField
            label="数据来源"
            onChange={setSourceId}
            options={meta.state.data.ref.sources.map((source) => ({ value: source.id, label: source.title }))}
            placeholder="不指定"
            value={sourceId}
          />
          {reviewLocked ? <InfoNote tone="warning">当前内容正在审核，处理完成后才能继续编辑。</InfoNote> : null}
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

      {/* 右：图片 + 楼层 + 位置 + 修订历史 */}
      <div className="space-y-4 self-start">
        <MediaPanel
          disabled={reviewLocked}
          media={media}
          onChange={setMedia}
        />

        {isNew ? (
          <Panel title="楼层">
            <InfoNote>保存后可添加楼层</InfoNote>
          </Panel>
        ) : (
          <FloorPanel
            dining={kindId === "canteen" ? { rows: diningFloors, onChange: setDiningFloors } : undefined}
            floors={floors}
            isBuilding={hasBuildingStructure}
            onDone={(message) => { setNotice(message); detail.reload(); }}
            placeId={id}
          />
        )}

        <LocationEditor
          buildingCampusId={campusId || null}
          disabled={reviewLocked}
          entityPlaceId={isNew ? null : id}
          isBuilding={hasBuildingStructure}
          mapVersions={meta.state.data.mapVersions}
          onChange={setLocationDrafts}
          roles={hasBuildingStructure ? undefined : ALL_ROLES.filter((role) => role !== "footprint")}
          spaces={meta.state.data.spaces}
          value={locationDrafts}
        />

        {isNew ? null : (
          <Panel title="地点状态">
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {PLACE_LIFECYCLES.map((status) => (
                  <GhostButton
                    disabled={lifecycleBusy || status === lifecycleStatus}
                    key={status}
                    onClick={() => void applyLifecycle(status)}
                  >
                    {status === lifecycleStatus ? `当前：${PLACE_LIFECYCLE_LABELS[status]}` : PLACE_LIFECYCLE_LABELS[status]}
                  </GhostButton>
                ))}
              </div>
              <ErrorBanner message={lifecycleError} />
              {lifecycleNotice ? <InfoNote tone="info">{lifecycleNotice}</InfoNote> : null}
              <p className="text-label text-sub">
                「已停用」的地点不再进入发布产物，前台地图与搜索都看不到；重新选「启用」即可恢复，楼宇轮廓会一并回到地图上。
              </p>
            </div>
          </Panel>
        )}

        {!isNew ? (
          <Panel title="修订历史" padded={false}>
            {currentRevision ? (
              <div className="px-5 pt-1">
                <InfoNote tone="warning">
                  当前{currentRevision.editorial_status === "draft" ? "草稿" : "待审核"} #{currentRevision.revision_no} · 尚未发布
                </InfoNote>
              </div>
            ) : null}
            <div className="divide-y divide-line px-5 py-2">
              {revisions.map((rev) => (
                <div key={rev.id} className="flex items-center gap-3 py-2.5 text-body">
                  <span className="w-8 font-medium">#{rev.revision_no}</span>
                  <EditorialPill status={rev.editorial_status} />
                  <span className="flex-1 text-aux text-sub">{fmtDateTime(rev.created_at)}</span>
                  {rev.editorial_status === "approved" ? <span className="text-aux text-sub">当前线上</span> : null}
                </div>
              ))}
              {revisions.length === 0 ? <p className="py-4 text-body text-sub">暂无修订记录</p> : null}
            </div>
          </Panel>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 楼层管理：列出 / 新增 / 改显示名
// ---------------------------------------------------------------------------

/** 楼层编号规范化：与后端 floors.ts 的 canonicalLevelCode 同口径，
 *  "3" / "f3" / "F03" / "3F" → "F3"，"b1" / "B01" / "1B" → "B1"；不合法返回 null。
 *  之前这里只认 F<n>/B<n>，用户按中文习惯填「3F」会被前端误拒，而后端本来收。 */
export function canonicalFloorLevelCode(levelCode: string): string | null {
  const code = levelCode.trim().toUpperCase();
  const above = code.match(/^(?:F(\d{1,3})|(\d{1,3})F?)$/);
  if (above) return `F${Number(above[1] ?? above[2])}`;
  const below = code.match(/^(?:B(\d{1,2})|(\d{1,2})B)$/);
  if (below) return `B${Number(below[1] ?? below[2])}`;
  return null;
}

/** "F3" → "3 层"、"B1" → "地下 1 层"；不合法的编号原样返回（提交时后端会给出可读 400）。 */
function suggestFloorName(levelCode: string): string {
  const code = canonicalFloorLevelCode(levelCode);
  if (code === null) return levelCode.trim();
  if (code.startsWith("F")) return `${Number(code.slice(1))} 层`;
  return `地下 ${Number(code.slice(1))} 层`;
}

/** 楼层排序值：地下为负，地上为正。 */
function suggestFloorOrder(levelCode: string): number {
  const code = canonicalFloorLevelCode(levelCode);
  if (code === null) throw new Error(`不支持的楼层编号：${levelCode}`);
  return code.startsWith("F") ? Number(code.slice(1)) : -Number(code.slice(1));
}

function FloorPanel({
  placeId,
  floors,
  isBuilding,
  dining,
  onDone,
}: {
  placeId: string;
  floors: Floor[];
  isBuilding: boolean;
  /** 食堂专属：楼层餐别/品类编辑。非食堂类型不传，面板不渲染这块。 */
  dining?: { rows: DiningFloorRow[]; onChange: (rows: DiningFloorRow[]) => void };
  onDone: (message: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [levelCode, setLevelCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function addFloor() {
    const code = levelCode.trim();
    if (!code) { setError("请填写楼层编号"); return; }
    setBusy(true);
    setError("");
    try {
      const created = await admin.createFloor({
        buildingPlaceId: placeId,
        levelCode: code,
        levelOrder: suggestFloorOrder(code),
        displayName: displayName.trim() || suggestFloorName(code),
        isPublic: true,
      });
      // 新楼层的供餐行默认空餐别空品类，让管理员自己填。key 必须用服务端落库的
      // 原始 levelCode（worker 只 trim 不规范化），否则填 "3" 时行挂到 "F3" 上，
      // 之后按 floor.levelCode 永远匹配不到，餐别/品类静默丢失。
      dining?.onChange([...dining.rows, { levelCode: created.levelCode, meals: [], stallTypes: [] }]);
      setLevelCode("");
      setDisplayName("");
      setAdding(false);
      onDone(`已添加楼层 ${displayName.trim() || suggestFloorName(code)}`);
    } catch (err) {
      setError(errorMessage(err, "添加楼层失败"));
    } finally {
      setBusy(false);
    }
  }

  async function renameFloor(floorId: string) {
    const next = editingName.trim();
    if (!next) { setError("请填写楼层名称"); return; }
    setBusy(true);
    setError("");
    try {
      await admin.updateFloor(floorId, { displayName: next });
      setEditingId(null);
      onDone(`已更新楼层名称为 ${next}`);
    } catch (err) {
      setError(errorMessage(err, "更新楼层失败"));
    } finally {
      setBusy(false);
    }
  }

  // 楼层平面图是每层一张位图（0032 起）：直传 PUT /api/admin/floors/:id/image，上传即替换。
  async function uploadPlan(floor: Floor, file: File) {
    setBusy(true);
    setError("");
    try {
      await admin.uploadFloorImage(floor.id, file, file.type);
      onDone(`已更新 ${floor.displayName} 的平面图`);
    } catch (err) {
      setError(errorMessage(err, "上传平面图失败"));
    } finally {
      setBusy(false);
    }
  }

  async function togglePublic(floor: Floor) {
    setBusy(true);
    setError("");
    try {
      const hidden = floor.isPublic === 0;
      await admin.updateFloor(floor.id, { isPublic: hidden });
      onDone(`${floor.displayName} 已${hidden ? "对外显示" : "对外隐藏"}`);
    } catch (err) {
      setError(errorMessage(err, "更新楼层可见性失败"));
    } finally {
      setBusy(false);
    }
  }

  async function removeFloor(floor: Floor) {
    if (!window.confirm(`确认删除楼层「${floor.displayName}」？该操作不可恢复。`)) return;
    setBusy(true);
    setError("");
    try {
      await admin.deleteFloor(floor.id);
      dining?.onChange(dining.rows.filter((row) => row.levelCode !== floor.levelCode));
      onDone(`已删除楼层 ${floor.displayName}`);
    } catch (err) {
      // 有设施/商户/锚点挂着时服务端回 409 floor_in_use，明细在 message 里。
      setError(errorMessage(err, "删除楼层失败"));
    } finally {
      setBusy(false);
    }
  }

  const sorted = [...floors].sort((a, b) => a.levelOrder - b.levelOrder);

  /** 按 levelCode upsert 供餐行；该楼层还没有行时以空行起步。 */
  function changeDiningRow(next: DiningFloorRow) {
    if (!dining) return;
    const index = dining.rows.findIndex((row) => row.levelCode === next.levelCode);
    dining.onChange(index === -1 ? [...dining.rows, next] : dining.rows.map((row, i) => (i === index ? next : row)));
  }

  return (
    <Panel
      title={`楼层${sorted.length ? `（${sorted.length}）` : ""}`}
      action={
        isBuilding ? (
          <GhostButton disabled={busy} onClick={() => setAdding((value) => !value)}>
            <Plus size={14} />
            添加楼层
          </GhostButton>
        ) : null
      }
    >
      <div className="space-y-3">
        {adding && isBuilding ? (
          <div className="space-y-2 rounded-lg border border-line p-3">
            <div className="grid grid-cols-2 gap-2">
              <Field
                label="楼层编号"
                onChange={(value) => {
                  setLevelCode(value);
                  setDisplayName(value.trim() ? suggestFloorName(value) : "");
                }}
                placeholder="如 3 或 B1"
                value={levelCode}
              />
              <Field label="显示名称" onChange={setDisplayName} placeholder="如 3 层" value={displayName} />
            </div>
            <div className="flex gap-2">
              <PrimaryButton className="flex-1" disabled={busy} onClick={addFloor}>
                {busy ? "处理中…" : "确认添加"}
              </PrimaryButton>
              <GhostButton disabled={busy} onClick={() => { setAdding(false); setError(""); }}>取消</GhostButton>
            </div>
          </div>
        ) : null}

        {sorted.length === 0 ? (
          <InfoNote>还没有楼层</InfoNote>
        ) : (
          <div className="divide-y divide-line">
            {sorted.map((floor) => {
              const floorId = floor.id;
              const label = floor.displayName;
              const code = floor.levelCode;
              const hidden = floor.isPublic === 0;
              if (editingId === floorId) {
                return (
                  <div key={floorId} className="flex items-center gap-2 py-2">
                    <div className="flex-1">
                      <Field onChange={setEditingName} placeholder="楼层名称" value={editingName} />
                    </div>
                    <PrimaryButton disabled={busy} onClick={() => renameFloor(floorId)}>保存</PrimaryButton>
                    <GhostButton disabled={busy} onClick={() => { setEditingId(null); setError(""); }}>取消</GhostButton>
                  </div>
                );
              }
              return (
                <div key={floorId} className="py-2.5">
                  <div className="flex items-center gap-3 text-body">
                  {floor.imageUrl ? (
                    <img
                      alt={`${label} 平面图`}
                      className="h-9 w-9 shrink-0 rounded-lg border border-line object-cover"
                      src={floor.imageUrl}
                    />
                  ) : (
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary-container text-primary">
                      <Layers size={16} />
                    </span>
                  )}
                  <div className="min-w-0">
                    <span className="font-medium text-ink">{label}</span>
                    <span className="ml-1.5 text-label text-sub">{code}</span>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      {floor.imageUrl ? <Pill tone="ok">有平面图</Pill> : <Pill tone="neutral">无平面图</Pill>}
                      {hidden ? <Pill>不对外展示</Pill> : null}
                    </div>
                  </div>
                  <span className="flex-1" />
                  <label
                    className={`inline-flex shrink-0 items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-label text-ink transition-colors ${
                      busy ? "cursor-wait opacity-60" : "cursor-pointer hover:border-primary hover:text-primary"
                    }`}
                  >
                    <Upload size={13} />
                    {floor.imageUrl ? "替换平面图" : "上传平面图"}
                    <input
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      disabled={busy}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (file) void uploadPlan(floor, file);
                      }}
                      type="file"
                    />
                  </label>
                  <button
                    className="shrink-0 text-aux font-medium text-primary"
                    disabled={busy}
                    onClick={() => togglePublic(floor)}
                    type="button"
                  >
                    {hidden ? "对外显示" : "对外隐藏"}
                  </button>
                  <button
                    className="shrink-0 text-aux font-medium text-primary"
                    disabled={busy}
                    onClick={() => { setEditingId(floorId); setEditingName(label); setError(""); }}
                    type="button"
                  >
                    重命名
                  </button>
                  <button
                    className="shrink-0 text-aux font-medium text-primary"
                    disabled={busy}
                    onClick={() => removeFloor(floor)}
                    type="button"
                  >
                    删除
                  </button>
                  </div>
                  {dining ? (
                    <DiningFloorEditor
                      onChange={changeDiningRow}
                      row={dining.rows.find((row) => row.levelCode === code) ?? { levelCode: code, meals: [], stallTypes: [] }}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
        <ErrorBanner message={error} />
      </div>
    </Panel>
  );
}

/** 食堂楼层行下的餐别/品类编辑区：餐别是固定三选多，品类是自由文本标签。 */
function DiningFloorEditor({
  row,
  onChange,
}: {
  row: DiningFloorRow;
  onChange: (row: DiningFloorRow) => void;
}) {
  const [stallInput, setStallInput] = useState("");

  function addStall() {
    const value = stallInput.trim();
    setStallInput("");
    if (!value || row.stallTypes.includes(value)) return;
    onChange({ ...row, stallTypes: [...row.stallTypes, value] });
  }

  return (
    <div className="ml-12 mt-2 space-y-2 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-10 shrink-0 text-label text-sub">餐别</span>
        {DINING_MEAL_OPTIONS.map((option) => (
          <Chip
            active={row.meals.includes(option.value)}
            key={option.value}
            onClick={() =>
              onChange({
                ...row,
                meals: row.meals.includes(option.value)
                  ? row.meals.filter((meal) => meal !== option.value)
                  : [...row.meals, option.value],
              })
            }
          >
            {option.label}
          </Chip>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-10 shrink-0 text-label text-sub">品类</span>
        {row.stallTypes.map((stall) => (
          <span
            className="inline-flex h-8 items-center gap-1 rounded-full bg-primary-container px-3 text-aux font-medium text-primary"
            key={stall}
          >
            {stall}
            <button
              aria-label={`删除品类 ${stall}`}
              onClick={() => onChange({ ...row, stallTypes: row.stallTypes.filter((value) => value !== stall) })}
              type="button"
            >
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          className="h-8 w-24 rounded-lg border border-line px-2 text-aux outline-none focus:border-primary"
          onChange={(event) => setStallInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addStall();
            }
          }}
          placeholder="如 自选"
          value={stallInput}
        />
        <button className="text-aux font-medium text-primary" onClick={addStall} type="button">
          添加
        </button>
      </div>
    </div>
  );
}
