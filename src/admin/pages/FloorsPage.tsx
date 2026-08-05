import { Building2, ExternalLink, Layers, Plus, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import * as admin from "../../lib/api/admin";
import { ApiError } from "../../lib/api/client";
import type { SpacesResponse } from "../adminTypes";
import {
  Chip,
  EmptyState,
  ErrorBanner,
  Field,
  GhostButton,
  InfoNote,
  LoadingState,
  Panel,
  Pill,
  PrimaryButton,
  SelectField,
  errorMessage,
  fmtDateTime,
  useAsyncData,
} from "../components/primitives";

const PLAN_STATUS_META: Record<string, { label: string; tone: "ok" | "info" | "warning" | "neutral" }> = {
  published: { label: "已发布", tone: "ok" },
  ready: { label: "就绪", tone: "info" },
  draft: { label: "导入中", tone: "warning" },
  archived: { label: "已归档", tone: "neutral" },
  rejected: { label: "已拒绝", tone: "neutral" },
};

const LIFECYCLE_LABELS: Record<string, string> = {
  active: "使用中",
  closed: "已封闭",
  retired: "已废弃",
  planned: "筹备中",
  temporarily_closed: "暂停营业",
};

const USAGE_LABELS: Array<{ key: keyof admin.FloorUsage; label: string }> = [
  { key: "facilities", label: "设施" },
  { key: "merchants", label: "商户" },
  { key: "spaces", label: "室内空间" },
  { key: "mapVersions", label: "平面图" },
  { key: "anchors", label: "位置锚点" },
];

const ERROR_TEXT: Record<string, string> = {
  floor_in_use: "这层还挂着内容，不能删除。请先把下面列出的设施 / 商户改到别层或下架，再删这一层。",
  floor_exists: "这栋楼已经有同编号的楼层了。",
  validation_error: "填写的内容不完整或不正确，请检查后重试。",
  forbidden: "当前账号没有维护楼层的权限。",
  not_found: "这个楼层不存在，可能已被其他人删除，刷新后再试。",
  media_not_ready: "图纸还没上传完成，请稍后重试。",
};

function floorError(err: unknown, defaultMessage: string): string {
  if (err instanceof ApiError) return ERROR_TEXT[err.code] ?? err.message;
  return errorMessage(err, defaultMessage);
}

function usageSummary(usage: admin.FloorUsage): string {
  const parts = USAGE_LABELS
    .filter(({ key }) => usage[key] > 0)
    .map(({ key, label }) => `${label} ${usage[key]}`);
  return parts.length ? parts.join(" · ") : "空层";
}

function usageTotal(usage: admin.FloorUsage): number {
  return USAGE_LABELS.reduce((sum, { key }) => sum + usage[key], 0);
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function FloorsPage() {
  const { state } = useAsyncData(async (signal) => {
    const spaces = await admin.listSpaces<SpacesResponse>(signal);
    return { spaces };
  }, []);

  const [buildingPlaceId, setBuildingPlaceId] = useState("");

  if (state.status === "loading") return <LoadingState label="加载楼宇…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  const buildings = state.data.spaces.buildings;
  const campuses = state.data.spaces.campuses;

  const campusName = (id: string | null) => {
    if (!id) return "";
    const campus = campuses.find((candidate) => candidate.id === id);
    return campus ? campus.name.replace("校区", "") : "";
  };

  return (
    <div className="space-y-4">
      <Panel title="选择楼宇">
        <SelectField
          label="楼宇"
          onChange={setBuildingPlaceId}
          options={buildings.map((building) => ({
            value: building.placeId,
            label: `${building.displayName ?? building.placeId}${
              building.campusId ? ` · ${campusName(building.campusId)}` : ""
            }`,
          }))}
          placeholder="选择要管理楼层的楼宇"
          value={buildingPlaceId}
        />
      </Panel>

      {buildingPlaceId ? <BuildingFloors buildingPlaceId={buildingPlaceId} /> : null}
    </div>
  );
}

function BuildingFloors({ buildingPlaceId }: { buildingPlaceId: string }) {
  const { state, reload } = useAsyncData(
    (signal) => admin.listBuildingFloors(buildingPlaceId, signal),
    [buildingPlaceId],
  );
  const [selectedFloorId, setSelectedFloorId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [levelCode, setLevelCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  if (state.status === "loading") return <LoadingState label="加载楼层…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  const { building, items } = state.data;

  async function addFloor() {
    if (!levelCode.trim()) { setError("请填写楼层编号，如 F3 或 B1"); return; }
    setBusy(true);
    setError("");
    try {
      // levelOrder 由服务端按编号推导，这里传 0 只是为了满足请求体的字段完整性校验。
      const created = await admin.createFloor({
        buildingPlaceId,
        levelCode: levelCode.trim(),
        levelOrder: 0,
        displayName: displayName.trim(),
        isPublic: true,
      });
      setNotice(`已添加 ${created.displayName ?? levelCode.trim()}`);
      setLevelCode("");
      setDisplayName("");
      setAdding(false);
      reload();
    } catch (err) {
      setError(floorError(err, "添加楼层失败"));
    } finally {
      setBusy(false);
    }
  }

  async function removeFloor(floor: admin.FloorOverviewRow) {
    if (!window.confirm(`确定删除 ${floor.displayName}？该层没有任何内容时才能删除。`)) return;
    setBusy(true);
    setError("");
    try {
      await admin.deleteFloor(floor.id);
      setNotice(`已删除 ${floor.displayName}`);
      if (selectedFloorId === floor.id) setSelectedFloorId(null);
      reload();
    } catch (err) {
      setError(floorError(err, "删除楼层失败"));
    } finally {
      setBusy(false);
    }
  }

  async function toggleVisibility(floor: admin.FloorOverviewRow) {
    setBusy(true);
    setError("");
    try {
      await admin.updateFloor(floor.id, { isPublic: !floor.isPublic });
      setNotice(`${floor.displayName} 已${floor.isPublic ? "对外隐藏" : "对外显示"}`);
      reload();
    } catch (err) {
      setError(floorError(err, "更新楼层失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {notice ? <InfoNote tone="info">{notice}</InfoNote> : null}
      <ErrorBanner message={error} />

      <div className="grid grid-cols-[420px_1fr] items-start gap-4">
        <Panel
          padded={false}
          title={`${building.displayName ?? building.placeId} · 楼层（${items.length}）`}
          action={
            <GhostButton disabled={busy} onClick={() => setAdding((value) => !value)}>
              <Plus size={14} />
              添加楼层
            </GhostButton>
          }
        >
          {adding ? (
            <div className="space-y-3 border-b border-line px-5 pb-4">
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="楼层编号"
                  onChange={setLevelCode}
                  placeholder="F3 或 B1"
                  value={levelCode}
                />
                <Field
                  label="显示名（留空自动生成）"
                  onChange={setDisplayName}
                  placeholder="如 3 层"
                  value={displayName}
                />
              </div>
              <PrimaryButton disabled={busy} onClick={addFloor}>
                {busy ? "处理中…" : "添加"}
              </PrimaryButton>
            </div>
          ) : null}

          <div className="divide-y divide-line">
            {items.map((floor) => {
              const activePlan = floor.plans.find(
                (plan) => plan.lifecycleStatus === "published" || plan.lifecycleStatus === "ready",
              );
              return (
                <button
                  key={floor.id}
                  className={`flex w-full items-start gap-3 px-5 py-3.5 text-left transition-colors ${
                    selectedFloorId === floor.id ? "bg-primary-container/60" : "hover:bg-page"
                  }`}
                  onClick={() => setSelectedFloorId(floor.id)}
                  type="button"
                >
                  <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary-container text-primary">
                    <Layers size={17} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-body font-semibold text-ink">
                      {floor.displayName}
                      <span className="ml-1.5 text-label text-sub">{floor.levelCode}</span>
                    </p>
                    <p className="mt-0.5 text-aux text-sub">{usageSummary(floor.usage)}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      {activePlan ? (
                        <Pill tone={PLAN_STATUS_META[activePlan.lifecycleStatus]?.tone ?? "neutral"}>
                          平面图 {PLAN_STATUS_META[activePlan.lifecycleStatus]?.label ?? activePlan.lifecycleStatus}
                        </Pill>
                      ) : (
                        <Pill tone="neutral">无平面图</Pill>
                      )}
                      {floor.isPublic ? null : <Pill tone="warning">对外隐藏</Pill>}
                      {floor.lifecycleStatus === "active" ? null : (
                        <Pill tone="neutral">{LIFECYCLE_LABELS[floor.lifecycleStatus] ?? floor.lifecycleStatus}</Pill>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
            {items.length === 0 ? (
              <div className="p-5">
                <EmptyState label="这栋楼还没有楼层，先用右上角添加" />
              </div>
            ) : null}
          </div>
        </Panel>

        {selectedFloorId ? (
          <FloorDetail
            busy={busy}
            floorId={selectedFloorId}
            onChanged={(message) => { setNotice(message); reload(); }}
            onDelete={() => {
              const floor = items.find((candidate) => candidate.id === selectedFloorId);
              if (floor) void removeFloor(floor);
            }}
            onToggleVisibility={() => {
              const floor = items.find((candidate) => candidate.id === selectedFloorId);
              if (floor) void toggleVisibility(floor);
            }}
          />
        ) : (
          <Panel title="楼层详情">
            <EmptyState label="从左侧选择一层，查看图纸与该层的设施 / 商户" />
          </Panel>
        )}
      </div>
    </div>
  );
}

function FloorDetail({
  floorId,
  busy,
  onChanged,
  onDelete,
  onToggleVisibility,
}: {
  floorId: string;
  busy: boolean;
  onChanged: (message: string) => void;
  onDelete: () => void;
  onToggleVisibility: () => void;
}) {
  const { state, reload } = useAsyncData((signal) => admin.getFloorDetail(floorId, signal), [floorId]);
  const navigate = useNavigate();
  const [tab, setTab] = useState<"plans" | "facilities" | "merchants" | "spaces">("plans");
  const [error, setError] = useState("");

  if (state.status === "loading") return <LoadingState label="加载楼层详情…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  const { floor, plans, facilities, merchants, spaces, anchors, usage } = state.data;

  const positionedCount = facilities.filter((facility) => facility.positionedCount > 0).length;

  return (
    <div className="space-y-4">
      <Panel
        title={`${floor.buildingName ?? floor.buildingPlaceId} · ${floor.displayName}`}
        action={
          <div className="flex gap-2">
            <GhostButton disabled={busy} onClick={onToggleVisibility}>
              {floor.isPublic ? "对外隐藏" : "对外显示"}
            </GhostButton>
            <GhostButton danger disabled={busy || usageTotal(usage) > 0} onClick={onDelete}>
              <Trash2 size={14} />
              删除
            </GhostButton>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {USAGE_LABELS.map(({ key, label }) => (
              <Pill key={key} tone={usage[key] > 0 ? "info" : "neutral"}>
                {label} {usage[key]}
              </Pill>
            ))}
          </div>
          {usageTotal(usage) > 0 ? (
            <InfoNote>该楼层仍有关联内容，无法删除。</InfoNote>
          ) : null}
          {facilities.length > 0 ? (
            <InfoNote tone={positionedCount === facilities.length ? "info" : "warning"}>
              已标注 {positionedCount} / {facilities.length}
            </InfoNote>
          ) : null}
          <ErrorBanner message={error} />
        </div>
      </Panel>

      <div className="flex gap-2">
        <Chip active={tab === "plans"} onClick={() => setTab("plans")}>平面图 {plans.length}</Chip>
        <Chip active={tab === "facilities"} onClick={() => setTab("facilities")}>设施 {facilities.length}</Chip>
        <Chip active={tab === "merchants"} onClick={() => setTab("merchants")}>商户 {merchants.length}</Chip>
        <Chip active={tab === "spaces"} onClick={() => setTab("spaces")}>室内空间 {spaces.length}</Chip>
      </div>

      {tab === "plans" ? (
        <FloorPlansPanel
          anchorCount={anchors.filter((anchor) => anchor.mapVersionId !== null).length}
          floorId={floorId}
          onChanged={(message) => { onChanged(message); reload(); }}
          onError={setError}
          plans={plans}
        />
      ) : null}

      {tab === "facilities" ? (
        <Panel
          padded={false}
          title="该层设施"
          action={
            <GhostButton
              onClick={() => navigate(`/admin/content/facilities/new?buildingPlaceId=${encodeURIComponent(floor.buildingPlaceId)}&floorId=${encodeURIComponent(floor.id)}`)}
            >
              <Plus size={14} />
              新增设施
            </GhostButton>
          }
        >
          <div className="divide-y divide-line">
            {facilities.map((facility) => (
              <div key={facility.id} className="flex items-center gap-3 px-5 py-3.5">
                <div className="min-w-0 flex-1">
                  <p className="text-body font-semibold text-ink">{facility.displayName}</p>
                  <p className="mt-0.5 text-aux text-sub">
                    {facility.facilityTypeName}
                    {facility.indoorSpaceId ? " · 已指定室内空间" : ""}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <Pill tone={facility.positionedCount > 0 ? "ok" : "warning"}>
                      {facility.positionedCount > 0 ? "已标位置" : "未标位置"}
                    </Pill>
                    {facility.lifecycleStatus === "active" ? null : (
                      <Pill tone="neutral">{LIFECYCLE_LABELS[facility.lifecycleStatus] ?? facility.lifecycleStatus}</Pill>
                    )}
                    {facility.editorialStatus === "in_review" ? <Pill tone="warning">修订待审</Pill> : null}
                  </div>
                </div>
                <GhostButton onClick={() => navigate(`/admin/content/facilities/${facility.id}`)}>
                  <ExternalLink size={14} />
                  编辑
                </GhostButton>
              </div>
            ))}
            {facilities.length === 0 ? (
              <div className="p-5"><EmptyState label="暂无设施" /></div>
            ) : null}
          </div>
        </Panel>
      ) : null}

      {tab === "merchants" ? (
        <Panel padded={false} title="该层商户">
          <div className="divide-y divide-line">
            {merchants.map((merchant) => (
              <div key={merchant.id} className="flex items-center gap-3 px-5 py-3.5">
                <div className="min-w-0 flex-1">
                  <p className="text-body font-semibold text-ink">{merchant.displayName ?? merchant.id}</p>
                  <p className="mt-0.5 text-aux text-sub">{merchant.businessType ?? "未填分类"}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <Pill tone={merchant.lifecycleStatus === "active" ? "ok" : "neutral"}>
                      {LIFECYCLE_LABELS[merchant.lifecycleStatus] ?? merchant.lifecycleStatus}
                    </Pill>
                    {merchant.editorialStatus === "in_review" ? <Pill tone="warning">修订待审</Pill> : null}
                  </div>
                </div>
                <GhostButton onClick={() => navigate(`/admin/content/merchants/${merchant.id}`)}>
                  <ExternalLink size={14} />
                  编辑
                </GhostButton>
              </div>
            ))}
            {merchants.length === 0 ? (
              <div className="p-5"><EmptyState label="暂无商户" /></div>
            ) : null}
          </div>
        </Panel>
      ) : null}

      {tab === "spaces" ? (
        <Panel padded={false} title="室内空间">
          <div className="divide-y divide-line">
            {spaces.map((space) => (
              <div key={space.id} className="flex items-center gap-3 px-5 py-3.5">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-chip text-sub">
                  <Building2 size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-body font-semibold text-ink">{space.displayName}</p>
                  <p className="mt-0.5 text-aux text-sub">
                    {space.spaceType}
                    {space.stableCode ? ` · ${space.stableCode}` : ""}
                  </p>
                </div>
              </div>
            ))}
            {spaces.length === 0 ? (
              <div className="p-5"><EmptyState label="这层还没有细分的室内空间" /></div>
            ) : null}
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

function FloorPlansPanel({
  floorId,
  plans,
  anchorCount,
  onChanged,
  onError,
}: {
  floorId: string;
  plans: admin.FloorPlanRow[];
  anchorCount: number;
  onChanged: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [versionLabel, setVersionLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");

  async function upload() {
    if (!file) { onError("请先选择 SVG 图纸"); return; }
    if (!versionLabel.trim()) { onError("请填写版本号"); return; }
    setBusy(true);
    onError("");
    setProgress("");
    try {
      const bytes = await file.arrayBuffer();
      const raw = new TextDecoder().decode(bytes);
      const parsed = new DOMParser().parseFromString(raw, "image/svg+xml");
      if (parsed.querySelector("parsererror") || parsed.documentElement.tagName.toLowerCase() !== "svg") {
        throw new Error("文件不是有效的 SVG");
      }
      setProgress("创建上传意图…");
      const intent = await admin.createMapUploadIntent({
        assetType: "floor_svg",
        originalName: file.name,
        contentType: "image/svg+xml",
        byteSize: bytes.byteLength,
        sha256: await sha256Hex(bytes),
      });
      setProgress("上传图纸…");
      await admin.uploadMediaContent(intent.mediaAssetId, bytes, "image/svg+xml");
      setProgress("创建导入任务…");
      await admin.createImportJob({
        mediaAssetId: intent.mediaAssetId,
        campusId: null,
        floorId,
        versionLabel: versionLabel.trim(),
      });
      setFile(null);
      setVersionLabel("");
      setProgress("");
      onChanged("图纸已提交导入，后台解析完成后状态变为就绪");
    } catch (err) {
      onError(floorError(err, "上传失败"));
      setProgress("");
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(plan: admin.FloorPlanRow, lifecycleStatus: "ready" | "archived") {
    setBusy(true);
    onError("");
    try {
      await admin.updateFloorPlanStatus(plan.id, lifecycleStatus);
      onChanged(`${plan.versionLabel} 已${lifecycleStatus === "ready" ? "启用" : "归档"}`);
    } catch (err) {
      onError(floorError(err, "更新图纸状态失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-[1fr_360px] items-start gap-4">
      <Panel padded={false} title="图纸版本">
        <div className="divide-y divide-line">
          {plans.map((plan) => {
            const meta = PLAN_STATUS_META[plan.lifecycleStatus] ?? { label: plan.lifecycleStatus, tone: "neutral" as const };
            const usable = plan.lifecycleStatus === "ready" || plan.lifecycleStatus === "published";
            return (
              <div key={plan.id} className="flex items-center gap-3 px-5 py-3.5">
                <div className="min-w-0 flex-1">
                  <p className="text-body font-semibold text-ink">{plan.versionLabel}</p>
                  <p className="mt-0.5 text-aux text-sub">
                    {plan.featureCount} 个图形 · {plan.coordinateSpaceType} · {fmtDateTime(plan.createdAt)}
                  </p>
                  <div className="mt-1.5"><Pill tone={meta.tone}>{meta.label}</Pill></div>
                </div>
                {plan.lifecycleStatus === "published" ? (
                  <span className="text-label text-sub">发布中的图纸由发版流程管理</span>
                ) : plan.lifecycleStatus === "draft" ? (
                  <span className="text-label text-sub">解析中…</span>
                ) : (
                  <GhostButton
                    disabled={busy}
                    onClick={() => void setStatus(plan, usable ? "archived" : "ready")}
                  >
                    {usable ? "归档" : "启用"}
                  </GhostButton>
                )}
              </div>
            );
          })}
          {plans.length === 0 ? (
            <div className="p-5"><EmptyState label="这层还没有平面图，右侧上传 SVG" /></div>
          ) : null}
        </div>
      </Panel>

      <Panel title="上传楼层图">
        <div className="space-y-3.5">
          <label
            className={`flex h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed text-sub transition-colors ${
              file ? "border-primary bg-primary-container/40" : "border-line hover:border-primary"
            }`}
          >
            <Upload size={20} />
            <span className="px-4 text-center text-body font-medium">
              {file ? file.name : "点击选择该层平面图 SVG"}
            </span>
            <input
              accept=".svg,image/svg+xml"
              className="hidden"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              type="file"
            />
          </label>
          <Field label="版本号" onChange={setVersionLabel} placeholder="如 2026-08-01" value={versionLabel} />
          <PrimaryButton className="w-full" disabled={busy} onClick={upload}>
            {busy ? "处理中…" : "开始导入"}
          </PrimaryButton>
          {progress ? <InfoNote tone="info">{progress}</InfoNote> : null}
          {anchorCount > 0 ? (
            <InfoNote tone="warning">
              当前图纸关联 {anchorCount} 个位置锚点
            </InfoNote>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}
