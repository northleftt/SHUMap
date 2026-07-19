import { useEffect, useState } from "react";
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
// A7 地点编辑器（表单 + 位置/楼层 + 修订历史）
// ---------------------------------------------------------------------------

interface RevisionRow {
  id: string;
  revision_no: number;
  editorial_status: string;
  display_name: string;
  created_by?: string | null;
  created_at: string;
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
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [aliases, setAliases] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // 用当前修订初始化表单
  useEffect(() => {
    if (detail.state.status !== "ready" || !detail.state.data) return;
    const place = detail.state.data.place as Record<string, unknown>;
    setName(String(place.display_name ?? ""));
    setKindId(String(place.kind_id ?? ""));
    setCampusId(place.campus_id ? String(place.campus_id) : "");
    setStableCode(place.stable_code ? String(place.stable_code) : "");
    setSummary(place.summary ? String(place.summary) : "");
    setDescription(place.description ? String(place.description) : "");
    const names = detail.state.data.names as Array<Record<string, unknown>>;
    setAliases(names.filter((n) => n.name_type === "alias").map((n) => String(n.name)).join("、"));
  }, [detail.state]);

  if (!isNew && detail.state.status === "loading") return <LoadingState label="加载地点…" />;
  if (!isNew && detail.state.status === "error") return <ErrorBanner message={detail.state.message ?? "加载失败"} />;

  const kinds = meta.state.status === "ready" ? meta.state.data!.ref.placeKinds : [];
  const campuses = meta.state.status === "ready" ? meta.state.data!.spaces.campuses : [];
  const data = detail.state.status === "ready" ? detail.state.data : null;
  const revisions = ((data?.revisions ?? []) as RevisionRow[]).slice(0, 8);
  const currentRevision = revisions.find((r) => r.editorial_status === "draft" || r.editorial_status === "in_review");
  const locations = (data?.locations ?? []) as Array<Record<string, unknown>>;
  const floors = (data?.floors ?? []) as Array<Record<string, unknown>>;

  async function save(thenSubmit: boolean) {
    if (!name.trim()) { setError("请填写名称"); return; }
    if (isNew && !kindId) { setError("请选择类型"); return; }
    setBusy(true);
    setError("");
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
          aliases: aliases.split(/[、,，]/).map((a) => a.trim()).filter(Boolean),
        });
        placeId = created.id;
        revisionId = created.revisionId;
      } else {
        const created = await admin.createPlaceRevision(placeId, {
          displayName: name.trim(),
          summary: summary.trim() || undefined,
          description: description.trim() || undefined,
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
              <Field label="楼栋代码" onChange={setStableCode} placeholder="如 LIB-01" value={stableCode} />
              <Field label="别名（、分隔）" onChange={setAliases} placeholder="如 图书馆、上图" value={aliases} />
            </div>
          </div>
          <TextArea label="简介" onChange={setSummary} placeholder="一句话介绍" rows={2} value={summary} />
          <TextArea label="详细描述" onChange={setDescription} placeholder="开放时间、注意事项等" rows={4} value={description} />
          <ErrorBanner message={error} />
          <div className="flex gap-3">
            <GhostButton className="flex-1" disabled={busy} onClick={() => save(false)}>保存草稿</GhostButton>
            <PrimaryButton className="flex-[2]" disabled={busy} onClick={() => save(true)}>
              {busy ? "处理中…" : "提交审核 →"}
            </PrimaryButton>
          </div>
        </div>
      </Panel>

      {/* 右：位置楼层 + 修订历史 */}
      <div className="space-y-4 self-start">
        <Panel title="位置与楼层">
          {locations.length === 0 && floors.length === 0 ? (
            <InfoNote>暂无位置锚点与楼层数据；地图标注在新建运营事件的地图编辑器中以 svg_viewbox 坐标落点。</InfoNote>
          ) : (
            <div className="space-y-3">
              {locations.map((loc, i) => (
                <div key={i} className="flex items-center gap-2.5 text-body">
                  <Pill tone={loc.isPrimary || loc.is_primary ? "info" : "neutral"}>{String(loc.role ?? "位置")}</Pill>
                  <span className="text-sub">
                    {String(loc.anchor_type ?? loc.anchorType ?? "point")} · {String(loc.crs ?? "svg_viewbox")}
                  </span>
                </div>
              ))}
              {floors.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {floors.map((floor) => (
                    <Pill key={String(floor.id)}>{String(floor.display_name ?? floor.displayName ?? floor.level_code)}</Pill>
                  ))}
                </div>
              ) : null}
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
