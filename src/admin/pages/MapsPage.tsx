import { Map as MapIcon, Upload } from "lucide-react";
import { useState } from "react";
import * as admin from "../../lib/api/admin";
import type { MapVersion, ReferenceDataResponse, SpacesResponse } from "../adminTypes";
import {
  Chip,
  EmptyState,
  ErrorBanner,
  InfoNote,
  LoadingState,
  Panel,
  Pill,
  PrimaryButton,
  SelectField,
  Field,
  errorMessage,
  fmtDateTime,
  useAsyncData,
} from "../components/primitives";

// ---------------------------------------------------------------------------
// A10 地图版本管理（版本列表 + SVG 上传管线）
// ---------------------------------------------------------------------------

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const LIFECYCLE_META: Record<string, { label: string; tone: "ok" | "info" | "warning" | "neutral" }> = {
  published: { label: "当前使用", tone: "ok" },
  ready: { label: "就绪", tone: "info" },
  importing: { label: "导入中", tone: "warning" },
  archived: { label: "已归档", tone: "neutral" },
  draft: { label: "草稿", tone: "warning" },
};

export function MapsPage() {
  const { state, reload } = useAsyncData(async (signal) => {
    const [maps, spaces, ref] = await Promise.all([
      admin.listMapVersions(signal),
      admin.listSpaces<SpacesResponse>(signal),
      admin.listReferenceData<ReferenceDataResponse>(signal),
    ]);
    return { maps: maps.items, spaces, ref };
  }, []);

  const [campusFilter, setCampusFilter] = useState("all");
  const [campusId, setCampusId] = useState("");
  const [versionLabel, setVersionLabel] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");

  if (state.status === "loading") return <LoadingState label="加载底图版本…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  const data = state.data!;
  const campuses = data.spaces.campuses;
  const campusName = (id: string | null) => campuses.find((c) => c.id === id)?.name ?? "—";
  const visible = data.maps.filter((m) => campusFilter === "all" || m.campusId === campusFilter);

  async function startImport() {
    if (!file) { setError("请先选择 SVG 文件"); return; }
    if (!campusId) { setError("请选择校区"); return; }
    if (!versionLabel.trim()) { setError("请填写版本号"); return; }
    setBusy(true);
    setError("");
    setProgress("");
    try {
      const bytes = await file.arrayBuffer();
      const hash = await sha256Hex(bytes);
      setProgress("创建上传意图…");
      const intent = await admin.createMapUploadIntent({
        assetType: "campus_svg",
        originalName: file.name,
        contentType: "image/svg+xml",
        byteSize: bytes.byteLength,
        sha256: hash,
        sourceId: sourceId || null,
      });
      setProgress("上传底图内容…");
      await admin.uploadMediaContent(intent.mediaAssetId, bytes, "image/svg+xml");
      setProgress("创建导入任务…");
      const job = await admin.createImportJob({
        mediaAssetId: intent.mediaAssetId,
        campusId,
        versionLabel: versionLabel.trim(),
        coordinateSpaceType: "svg_viewbox",
        coordinateSpace: {},
      });
      setProgress(`导入任务已创建（${job.status}）。导入为异步队列处理，完成后底图版本状态更新为 ready。`);
      setFile(null);
      setVersionLabel("");
      reload();
    } catch (err) {
      setError(errorMessage(err, "上传失败"));
      setProgress("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Chip active={campusFilter === "all"} onClick={() => setCampusFilter("all")}>全部 {data.maps.length}</Chip>
        {campuses.map((c) => (
          <Chip key={c.id} active={campusFilter === c.id} onClick={() => setCampusFilter(c.id)}>
            {c.name.replace("校区", "")} {data.maps.filter((m) => m.campusId === c.id).length}
          </Chip>
        ))}
      </div>

      <div className="grid grid-cols-[1fr_420px] items-start gap-4">
        {/* 版本列表 */}
        <Panel padded={false}>
          <div className="divide-y divide-line">
            {visible.map((version: MapVersion) => {
              const meta = LIFECYCLE_META[version.lifecycleStatus] ?? { label: version.lifecycleStatus, tone: "neutral" as const };
              return (
                <div key={version.id} className="flex items-center gap-3 px-5 py-4">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary-container text-primary">
                    <MapIcon size={17} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-body font-semibold text-ink">
                      {campusName(version.campusId)} · {version.versionLabel}
                    </p>
                    <p className="mt-0.5 text-aux text-sub">
                      {version.coordinateSpaceType} · {version.featureCount} 要素
                    </p>
                    <div className="mt-1.5 flex items-center gap-2">
                      <Pill tone={meta.tone}>{meta.label}</Pill>
                      <span className="text-label text-sub">更新于 {fmtDateTime(version.createdAt)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
            {visible.length === 0 ? <div className="p-5"><EmptyState label="暂无底图版本，请先上传 SVG" /></div> : null}
          </div>
          <p className="px-5 pb-4 text-label text-sub">map_versions · coordinate_space_type / 要素 = map_features</p>
        </Panel>

        {/* 上传新版本 */}
        <Panel title="上传新版本">
          <div className="space-y-3.5">
            <label
              className={`flex h-36 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed text-sub transition-colors ${
                file ? "border-primary bg-primary-container/40" : "border-line hover:border-primary"
              }`}
            >
              <Upload size={22} />
              <span className="text-body font-medium">{file ? file.name : "拖拽校园 SVG 地图到此处，或点击选择文件"}</span>
              <span className="text-label">上传走 upload-intents → R2，导入走 import-jobs</span>
              <input
                accept=".svg,image/svg+xml"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                type="file"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <SelectField
                label="校区"
                onChange={setCampusId}
                options={campuses.map((c) => ({ value: c.id, label: c.name }))}
                placeholder="选择校区"
                value={campusId}
              />
              <Field label="版本号" onChange={setVersionLabel} placeholder="如 2026-07-01" value={versionLabel} />
            </div>
            <SelectField
              label="数据来源（可选）"
              onChange={setSourceId}
              options={data.ref.sources.map((s) => ({ value: s.id, label: s.title }))}
              placeholder="不指定"
              value={sourceId}
            />
            <PrimaryButton className="w-full" disabled={busy} onClick={startImport}>
              {busy ? "处理中…" : "开始导入"}
            </PrimaryButton>
            {progress ? <InfoNote tone="info">{progress}</InfoNote> : null}
            <ErrorBanner message={error} />
            <InfoNote>导入完成 = 新版本 ready；随下次发布（A5）生效，旧版本自动归档。</InfoNote>
          </div>
        </Panel>
      </div>
    </div>
  );
}
