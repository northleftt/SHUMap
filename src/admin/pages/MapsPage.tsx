import { Map as MapIcon, Upload } from "lucide-react";
import { useState } from "react";
import * as admin from "../../lib/api/admin";
import type { Floor, MapLifecycleStatus, MapVersion, ReferenceDataResponse, SpacesResponse } from "../adminTypes";
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

const LIFECYCLE_META: Record<MapLifecycleStatus, { label: string; tone: "ok" | "info" | "warning" | "neutral" }> = {
  published: { label: "当前使用", tone: "ok" },
  ready: { label: "就绪", tone: "info" },
  archived: { label: "已归档", tone: "neutral" },
  draft: { label: "草稿", tone: "warning" },
  rejected: { label: "已拒绝", tone: "neutral" },
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
  const [targetKind, setTargetKind] = useState<"campus" | "floor">("campus");
  const [campusId, setCampusId] = useState("");
  const [buildingPlaceId, setBuildingPlaceId] = useState("");
  const [floorId, setFloorId] = useState("");
  const [versionLabel, setVersionLabel] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");

  if (state.status === "loading") return <LoadingState label="加载底图版本…" />;
  if (state.status === "error") return <ErrorBanner message={state.message} />;
  const data = state.data;
  const campuses = data.spaces.campuses;
  const buildings = data.spaces.buildings;
  const floors = data.spaces.floors;
  const campusName = (id: string) => {
    const campus = campuses.find((candidate) => candidate.id === id);
    if (!campus) throw new Error(`底图版本引用了不存在的校区 ${id}`);
    return campus.name;
  };
  const floorById = new Map(floors.map((f) => [f.id, f]));
  const buildingByPlaceId = new Map(buildings.map((b) => [b.placeId, b]));
  const floorOptions: Floor[] = buildingPlaceId
    ? floors.filter((f) => f.buildingPlaceId === buildingPlaceId)
    : [];

  /** 楼层版本的 campus_id 为 null（schema 二选一约束），归属校区经楼宇解析。 */
  function versionCampusId(version: MapVersion): string | null {
    if (version.campusId) return version.campusId;
    if (!version.floorId) throw new Error(`底图版本 ${version.id} 没有校区或楼层目标`);
    const floor = floorById.get(version.floorId);
    if (!floor) throw new Error(`底图版本 ${version.id} 引用了不存在的楼层 ${version.floorId}`);
    const building = buildingByPlaceId.get(floor.buildingPlaceId);
    if (!building) throw new Error(`楼层 ${floor.id} 引用了不存在的楼宇 ${floor.buildingPlaceId}`);
    if (!building.campusId) throw new Error(`楼宇 ${building.placeId} 没有校区`);
    return building.campusId;
  }

  /** 列表主标题：校区图显示校区，楼层图显示「楼宇 · 楼层」。 */
  function versionTarget(version: MapVersion): string {
    if (version.campusId) return campusName(version.campusId);
    if (!version.floorId) throw new Error(`底图版本 ${version.id} 没有校区或楼层目标`);
    const floor = floorById.get(version.floorId);
    if (!floor) throw new Error(`底图版本 ${version.id} 引用了不存在的楼层 ${version.floorId}`);
    const building = buildingByPlaceId.get(floor.buildingPlaceId);
    if (!building) throw new Error(`楼层 ${floor.id} 引用了不存在的楼宇 ${floor.buildingPlaceId}`);
    if (!building.displayName) throw new Error(`楼宇 ${building.placeId} 没有当前名称`);
    return `${building.displayName} · ${floor.displayName}`;
  }

  const visible = data.maps.filter((m) => campusFilter === "all" || versionCampusId(m) === campusFilter);

  async function startImport() {
    if (!file) { setError("请先选择 SVG 文件"); return; }
    if (targetKind === "campus" && !campusId) { setError("请选择校区"); return; }
    if (targetKind === "floor" && !floorId) { setError("请选择楼宇与楼层"); return; }
    if (!versionLabel.trim()) { setError("请填写版本号"); return; }
    setBusy(true);
    setError("");
    setProgress("");
    try {
      const bytes = await file.arrayBuffer();
      const raw = new TextDecoder().decode(bytes);
      const parsed = new DOMParser().parseFromString(raw, "image/svg+xml");
      if (parsed.querySelector("parsererror") || parsed.documentElement.tagName.toLowerCase() !== "svg") {
        throw new Error("文件不是有效的 SVG");
      }
      const hash = await sha256Hex(bytes);
      setProgress("创建上传意图…");
      const intent = await admin.createMapUploadIntent({
        assetType: targetKind === "floor" ? "floor_svg" : "campus_svg",
        originalName: file.name,
        contentType: "image/svg+xml",
        byteSize: bytes.byteLength,
        sha256: hash,
        sourceId: sourceId || null,
      });
      setProgress("上传底图内容…");
      await admin.uploadMediaContent(intent.mediaAssetId, bytes, "image/svg+xml");
      setProgress("创建导入任务…");
      // map_versions 的 check 约束是 campus_id / floor_id 二选一，import-jobs 同样要求恰好一个。
      const job = await admin.createImportJob({
        mediaAssetId: intent.mediaAssetId,
        campusId: targetKind === "campus" ? campusId : null,
        floorId: targetKind === "floor" ? floorId : null,
        versionLabel: versionLabel.trim(),
      });
      setProgress("已提交导入，正在后台处理，完成后版本会显示为就绪。");
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
            {c.name.replace("校区", "")} {data.maps.filter((m) => versionCampusId(m) === c.id).length}
          </Chip>
        ))}
      </div>

      <div className="grid grid-cols-[1fr_420px] items-start gap-4">
        {/* 版本列表 */}
        <Panel padded={false}>
          <div className="divide-y divide-line">
            {visible.map((version: MapVersion) => {
              const meta = LIFECYCLE_META[version.lifecycleStatus];
              return (
                <div key={version.id} className="flex items-center gap-3 px-5 py-4">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary-container text-primary">
                    <MapIcon size={17} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-body font-semibold text-ink">
                      {versionTarget(version)} · {version.versionLabel}
                    </p>
                    <p className="mt-0.5 text-aux text-sub">
                      {version.floorId ? "楼层图" : "校区图"} · {version.featureCount} 个图形
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
              <input
                accept=".svg,image/svg+xml"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                type="file"
              />
            </label>
            {/* 目标二选一：校区底图 或 某楼宇的某楼层平面图（map_versions 的 check 约束） */}
            <div className="flex gap-2">
              <Chip active={targetKind === "campus"} onClick={() => { setTargetKind("campus"); setError(""); }}>校区底图</Chip>
              <Chip active={targetKind === "floor"} onClick={() => { setTargetKind("floor"); setError(""); }}>楼层平面图</Chip>
            </div>
            {targetKind === "campus" ? (
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
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <SelectField
                    label="楼宇"
                    onChange={(value) => { setBuildingPlaceId(value); setFloorId(""); }}
                    options={buildings.map((b) => ({
                      value: b.placeId,
                      label: `${b.displayName ?? b.placeId}${b.campusId ? ` · ${campusName(b.campusId).replace("校区", "")}` : ""}`,
                    }))}
                    placeholder="选择楼宇"
                    value={buildingPlaceId}
                  />
                  <SelectField
                    disabled={!buildingPlaceId}
                    label="楼层"
                    onChange={setFloorId}
                    options={floorOptions.map((f) => ({ value: f.id, label: f.displayName || f.levelCode }))}
                    placeholder={buildingPlaceId && floorOptions.length === 0 ? "该楼宇暂无楼层" : "选择楼层"}
                    value={floorId}
                  />
                </div>
                <Field label="版本号" onChange={setVersionLabel} placeholder="如 2026-07-01" value={versionLabel} />
              </>
            )}
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
          </div>
        </Panel>
      </div>
    </div>
  );
}
