import { Plus, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import * as admin from "../../lib/api/admin";
import type { PlaceDetailResponse, ReferenceDataResponse, SpacesResponse } from "../adminTypes";
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
  fmtDateTime,
  useAsyncData,
} from "../components/primitives";

// ---------------------------------------------------------------------------
// A7 地点编辑器
//
// 两条保存通道，因为承载能力不同：
//   1. 名称 / 简介 / 详细描述 / 详细信息 / 图片 → 新建修订草稿，经审核发布；
//   2. 类型 / 校区 / 楼栋代码 / 别名 / 楼层 → PATCH 即时生效。
//
// 第二类字段在修订表里没有对应列（修订只存文案），无法用「草稿→审核→发布」承载，
// 因此直接写库并记审计。这是有意的设计边界，不是简化实现。
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
  label: string;
  value: string;
}

interface MediaRow {
  role: "cover" | "gallery";
  url: string;
  alt?: string;
  caption?: string;
}

/** 表单固定展示的四条信息；其余自定义条目原样保留。 */
const FACT_LABELS = ["开放时间", "联系电话", "所属单位", "进入方式"] as const;

const FACT_PLACEHOLDERS: Record<string, string> = {
  开放时间: "如 周一至周五 08:00-22:00",
  联系电话: "如 6613 5200",
  所属单位: "如 图书馆管理处",
  进入方式: "如 刷校园卡进入",
};

function readFacts(detail: Record<string, unknown>): FactRow[] {
  if (!Array.isArray(detail.facts)) return [];
  const rows: FactRow[] = [];
  for (const raw of detail.facts) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const label = typeof record.label === "string" ? record.label.trim() : "";
    if (!label) continue;
    rows.push({ label, value: typeof record.value === "string" ? record.value : String(record.value ?? "") });
  }
  return rows;
}

function readMedia(detail: Record<string, unknown>): MediaRow[] {
  const rows: MediaRow[] = [];
  if (Array.isArray(detail.media)) {
    for (const raw of detail.media) {
      if (!raw || typeof raw !== "object") continue;
      const record = raw as Record<string, unknown>;
      const url = typeof record.url === "string" ? record.url.trim() : "";
      if (!url) continue;
      rows.push({
        role: record.role === "cover" ? "cover" : "gallery",
        url,
        ...(typeof record.alt === "string" && record.alt ? { alt: record.alt } : {}),
        ...(typeof record.caption === "string" && record.caption ? { caption: record.caption } : {}),
      });
    }
    return rows;
  }
  // 早期内容只有单张封面/展示图两个字段，读进来后一律按列表维护。
  for (const [key, role] of [["coverImageUrl", "cover"], ["galleryImageUrl", "gallery"]] as const) {
    const value = detail[key];
    if (typeof value === "string" && value.trim()) rows.push({ role, url: value.trim() });
  }
  return rows;
}

/** 一个地点只有一张封面：设定新封面时把其余降为展示图。 */
function withCover(rows: MediaRow[], index: number): MediaRow[] {
  return rows.map((row, i) => ({ ...row, role: i === index ? "cover" : "gallery" }));
}

export function PlaceEditorPage() {
  const { id = "" } = useParams();
  const isNew = id === "new";
  const navigate = useNavigate();

  const detail = useAsyncData(
    (signal) => (isNew ? Promise.resolve(null) : admin.getAdminPlace<PlaceDetailResponse>(id, signal)),
    [id, isNew],
  );
  const meta = useAsyncData(async (signal) => {
    const [spaces, ref] = await Promise.all([
      admin.listSpaces<SpacesResponse>(signal),
      admin.listReferenceData<ReferenceDataResponse>(signal),
    ]);
    return { spaces, ref };
  }, []);

  const [name, setName] = useState("");
  const [kindId, setKindId] = useState("");
  const [campusId, setCampusId] = useState("");
  const [stableCode, setStableCode] = useState("");
  const [buildingCode, setBuildingCode] = useState("");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [aliases, setAliases] = useState("");
  const [facts, setFacts] = useState<FactRow[]>([]);
  const [media, setMedia] = useState<MediaRow[]>([]);
  const [baseContent, setBaseContent] = useState<Record<string, unknown>>({});
  const [sourceId, setSourceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // 用当前修订初始化表单
  useEffect(() => {
    if (detail.state.status !== "ready" || !detail.state.data) return;
    const place = detail.state.data.place as Record<string, unknown>;
    setName(String(place.display_name ?? ""));
    setKindId(String(place.kind_id ?? ""));
    setCampusId(place.campus_id ? String(place.campus_id) : "");
    setStableCode(place.stable_code ? String(place.stable_code) : "");
    setBuildingCode(place.building_code ? String(place.building_code) : "");
    setSummary(place.summary ? String(place.summary) : "");
    setDescription(place.description ? String(place.description) : "");
    let content: Record<string, unknown> = {};
    try {
      content = JSON.parse(String(place.content_json ?? "{}")) as Record<string, unknown>;
    } catch {
      content = {};
    }
    setBaseContent(content);
    const detailBlock = content.detail && typeof content.detail === "object" && !Array.isArray(content.detail)
      ? (content.detail as Record<string, unknown>)
      : {};
    setFacts(readFacts(detailBlock));
    setMedia(readMedia(detailBlock));
    setSourceId(place.source_id ? String(place.source_id) : "");
    const names = detail.state.data.names as Array<Record<string, unknown>>;
    setAliases(names.filter((n) => n.name_type === "alias").map((n) => String(n.name)).join("、"));
  }, [detail.state]);

  if (!isNew && detail.state.status === "loading") return <LoadingState label="加载地点…" />;
  if (!isNew && detail.state.status === "error") return <ErrorBanner message={detail.state.message ?? "加载失败"} />;

  const kinds = meta.state.status === "ready" ? meta.state.data!.ref.placeKinds : [];
  const campuses = meta.state.status === "ready" ? meta.state.data!.spaces.campuses : [];
  const data = detail.state.status === "ready" ? detail.state.data : null;
  const revisions = ((data?.revisions ?? []) as RevisionRow[]).slice(0, 8);
  const currentRevision = revisions.find((r) => r.editorial_status === "in_review")
    ?? revisions.find((r) => r.editorial_status === "draft");
  const reviewLocked = currentRevision?.editorial_status === "in_review";
  const locations = (data?.locations ?? []) as Array<Record<string, unknown>>;
  const floors = (data?.floors ?? []) as Array<Record<string, unknown>>;
  const isBuilding = kindId === "building";

  function factValue(label: string): string {
    return facts.find((fact) => fact.label === label)?.value ?? "";
  }

  function setFactValue(label: string, value: string) {
    setFacts((rows) => {
      const index = rows.findIndex((row) => row.label === label);
      if (index === -1) return value.trim() ? [...rows, { label, value }] : rows;
      const next = [...rows];
      next[index] = { label, value };
      return next;
    });
  }

  /** 详细信息与图片写回 content.detail，其余内容字段原样保留。 */
  function composeContent(): Record<string, unknown> {
    const previousDetail = baseContent.detail && typeof baseContent.detail === "object" && !Array.isArray(baseContent.detail)
      ? (baseContent.detail as Record<string, unknown>)
      : {};
    const keptFacts = facts
      .map((fact) => ({ label: fact.label.trim(), value: fact.value.trim() }))
      .filter((fact) => fact.label && fact.value);
    const keptMedia = media
      .map((row) => ({ role: row.role, url: row.url.trim(), ...(row.alt ? { alt: row.alt } : {}), ...(row.caption ? { caption: row.caption } : {}) }))
      .filter((row) => row.url);
    const nextDetail: Record<string, unknown> = { ...previousDetail, facts: keptFacts, media: keptMedia };
    if (!keptFacts.length) delete nextDetail.facts;
    if (!keptMedia.length) delete nextDetail.media;
    // 列表化后单图字段不再是数据源，留着会与列表打架。
    delete nextDetail.coverImageUrl;
    delete nextDetail.galleryImageUrl;
    const cover = keptMedia.find((row) => row.role === "cover");
    if (cover) nextDetail.coverImageUrl = cover.url;
    const content = { ...baseContent };
    if (Object.keys(nextDetail).length) content.detail = nextDetail;
    else delete content.detail;
    return content;
  }

  async function save(thenSubmit: boolean) {
    if (!name.trim()) { setError("请填写名称"); return; }
    if (!kindId) { setError("请选择类型"); return; }
    setBusy(true);
    setError("");
    setNotice("");
    const aliasList = aliases.split(/[、,，]/).map((a) => a.trim()).filter(Boolean);
    const content = composeContent();
    try {
      let placeId = id;
      let revisionId = "";
      if (isNew) {
        const created = await admin.createPlace({
          kindId,
          campusId: campusId || undefined,
          stableCode: stableCode.trim() || undefined,
          displayName: name.trim(),
          summary: summary.trim() || undefined,
          description: description.trim() || undefined,
          content,
          sourceId: sourceId || undefined,
          aliases: aliasList,
          ...(buildingCode.trim() ? { building: { buildingCode: buildingCode.trim() } } : {}),
        });
        placeId = created.id;
        revisionId = created.revisionId;
      } else {
        // 结构字段先落库（即时生效），再提交正文修订（走审核）。
        await admin.updatePlace(placeId, {
          kindId,
          campusId: campusId || null,
          stableCode: stableCode.trim() || null,
          ...(isBuilding ? { buildingCode: buildingCode.trim() || null } : {}),
          aliases: aliasList,
        });
        const created = await admin.createPlaceRevision(placeId, {
          displayName: name.trim(),
          summary: summary.trim() || undefined,
          description: description.trim() || undefined,
          content,
          sourceId: sourceId || undefined,
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
              <Field label="地点编号" onChange={setStableCode} placeholder="如 LIB-01" value={stableCode} />
              {isBuilding ? (
                <Field label="楼栋代码" onChange={setBuildingCode} placeholder="如 A1" value={buildingCode} />
              ) : null}
              <Field label="别名（、分隔）" onChange={setAliases} placeholder="如 图书馆、上图" value={aliases} />
            </div>
          </div>
          <TextArea label="简介" onChange={setSummary} placeholder="一句话介绍" rows={2} value={summary} />
          <TextArea label="详细描述" onChange={setDescription} placeholder="注意事项、历史沿革等" rows={4} value={description} />

          {/* 详细信息：用户在地点详情页看到的信息行 */}
          <div>
            <p className="mb-1 text-emphasis">详细信息</p>
            <p className="mb-3 text-label text-sub">填写的条目会显示在用户端地点详情页，留空则不展示</p>
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
            options={(meta.state.status === "ready" ? meta.state.data!.ref.sources : []).map((source) => ({ value: source.id, label: source.title }))}
            placeholder="不指定"
            value={sourceId}
          />
          {!isNew ? (
            <InfoNote tone="info">
              类型、校区、地点编号、楼栋代码和别名保存后立即生效；名称、简介、详细信息和图片需提交审核通过并发布后对用户可见。
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

      {/* 右：图片 + 楼层 + 位置 + 修订历史 */}
      <div className="space-y-4 self-start">
        <PhotoPanel
          disabled={reviewLocked}
          media={media}
          onChange={setMedia}
          onError={setError}
        />

        {isNew ? (
          <Panel title="楼层">
            <InfoNote>保存地点后可在此添加楼层。</InfoNote>
          </Panel>
        ) : (
          <FloorPanel
            floors={floors}
            isBuilding={isBuilding}
            onDone={(message) => { setNotice(message); detail.reload(); }}
            placeId={id}
          />
        )}

        <Panel title="地图位置">
          {locations.length === 0 ? (
            <InfoNote>该地点还没有地图落点。</InfoNote>
          ) : (
            <div className="space-y-3">
              {locations.map((loc, i) => (
                <div key={i} className="flex items-center gap-2.5 text-body">
                  <Pill tone={loc.isPrimary || loc.is_primary ? "info" : "neutral"}>
                    {loc.isPrimary || loc.is_primary ? "主要位置" : "附加位置"}
                  </Pill>
                  <span className="text-sub">
                    {loc.location_hint ? String(loc.location_hint) : "已标注坐标"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Panel>

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
            <p className="px-5 pb-4 text-label text-sub">提交审核并通过后，新修订将自动取代当前线上版本</p>
          </Panel>
        ) : (
          <Panel title="提示">
            <InfoNote tone="info">新地点保存后为草稿状态，提交审核通过并发布新版本后对线上可见。</InfoNote>
          </Panel>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 图片列表：直传 + 缩略图 + 设为封面 / 删除
// ---------------------------------------------------------------------------

function PhotoPanel({
  media,
  onChange,
  onError,
  disabled,
}: {
  media: MediaRow[];
  onChange: (rows: MediaRow[]) => void;
  onError: (message: string) => void;
  disabled: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    onError("");
    try {
      const added: MediaRow[] = [];
      for (const file of Array.from(files)) {
        const result = await admin.uploadAdminMedia(file);
        added.push({ role: media.length + added.length === 0 ? "cover" : "gallery", url: result.url });
      }
      onChange([...media, ...added]);
    } catch (err) {
      onError(errorMessage(err, "图片上传失败"));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <Panel
      title={`图片${media.length ? `（${media.length}）` : ""}`}
      action={
        <GhostButton disabled={disabled || uploading} onClick={() => fileRef.current?.click()}>
          <Upload size={14} />
          {uploading ? "上传中…" : "上传图片"}
        </GhostButton>
      }
    >
      <input
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        multiple
        onChange={(e) => void upload(e.target.files)}
        ref={fileRef}
        type="file"
      />
      {media.length === 0 ? (
        <InfoNote>还没有图片。上传后需提交审核并发布，用户端才会看到。</InfoNote>
      ) : (
        <div className="space-y-2">
          {media.map((row, index) => (
            <div key={`${row.url}:${index}`} className="flex items-center gap-3 rounded-lg border border-line p-2">
              <img alt="" className="h-14 w-20 shrink-0 rounded object-cover" src={row.url} />
              <div className="min-w-0 flex-1">
                {row.role === "cover" ? <Pill tone="info">封面</Pill> : null}
                <p className="mt-1 truncate text-label text-sub">{row.url}</p>
              </div>
              {row.role === "cover" ? null : (
                <GhostButton disabled={disabled} onClick={() => onChange(withCover(media, index))}>
                  设为封面
                </GhostButton>
              )}
              <GhostButton danger disabled={disabled} onClick={() => onChange(media.filter((_, i) => i !== index))}>
                <Trash2 size={14} />
              </GhostButton>
            </div>
          ))}
          <InfoNote tone="info">封面图会作为地点详情页的首图展示。</InfoNote>
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 楼层管理：列出 / 新增 / 改显示名
// ---------------------------------------------------------------------------

/** "3" → "3 层"、"B1" → "地下 1 层"，其余原样。 */
function suggestFloorName(levelCode: string): string {
  const code = levelCode.trim().toUpperCase();
  const above = code.match(/^F?(\d{1,3})$/);
  if (above) return `${Number(above[1])} 层`;
  const below = code.match(/^B(\d{1,2})$/);
  if (below) return `地下 ${Number(below[1])} 层`;
  return levelCode.trim();
}

/** 楼层排序值：地下为负，地上为正，非数字编码排到最后。 */
function suggestFloorOrder(levelCode: string, fallback: number): number {
  const code = levelCode.trim().toUpperCase();
  const above = code.match(/^F?(\d{1,3})$/);
  if (above) return Number(above[1]);
  const below = code.match(/^B(\d{1,2})$/);
  if (below) return -Number(below[1]);
  return fallback;
}

function FloorPanel({
  placeId,
  floors,
  isBuilding,
  onDone,
}: {
  placeId: string;
  floors: Array<Record<string, unknown>>;
  isBuilding: boolean;
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
      await admin.createFloor({
        buildingPlaceId: placeId,
        levelCode: code,
        levelOrder: suggestFloorOrder(code, floors.length + 1),
        displayName: displayName.trim() || suggestFloorName(code),
      });
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

  const sorted = [...floors].sort((a, b) => Number(a.level_order ?? 0) - Number(b.level_order ?? 0));

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
        {!isBuilding ? (
          <InfoNote>只有建筑类型的地点可以维护楼层。把类型改为「建筑」并保存后即可添加。</InfoNote>
        ) : null}

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
          isBuilding ? <InfoNote>还没有楼层。添加楼层后即可为设施指定所在楼层。</InfoNote> : null
        ) : (
          <div className="divide-y divide-line">
            {sorted.map((floor) => {
              const floorId = String(floor.id);
              const label = String(floor.display_name ?? floor.displayName ?? floor.level_code ?? "");
              const code = String(floor.level_code ?? floor.levelCode ?? "");
              const hidden = Number(floor.is_public ?? 1) === 0;
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
                <div key={floorId} className="flex items-center gap-3 py-2.5 text-body">
                  <span className="font-medium text-ink">{label}</span>
                  <span className="text-label text-sub">{code}</span>
                  {hidden ? <Pill>不对外展示</Pill> : null}
                  <span className="flex-1" />
                  <button
                    className="text-aux font-medium text-primary"
                    onClick={() => { setEditingId(floorId); setEditingName(label); setError(""); }}
                    type="button"
                  >
                    重命名
                  </button>
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
