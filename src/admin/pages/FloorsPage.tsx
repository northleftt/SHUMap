import { ExternalLink, Layers, Plus, Trash2, Upload } from "lucide-react";
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
  useAsyncData,
} from "../components/primitives";

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
  { key: "mapVersions", label: "底图版本" },
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

/** 平面图位图只接受这三种格式（与 worker PUT /floors/:id/image 一致）。 */
const PLAN_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp";
const PLAN_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

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
  const [levelOrder, setLevelOrder] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadingFloorId, setUploadingFloorId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  if (state.status === "loading") return <LoadingState label="加载楼层…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  const { building, items } = state.data;

  async function addFloor() {
    if (!levelCode.trim()) { setError("请填写楼层编号，如 F3 或 B1"); return; }
    const order = Number(levelOrder);
    if (!Number.isFinite(order)) { setError("请填写排序号（数字，小的排前面）"); return; }
    setBusy(true);
    setError("");
    try {
      // levelCode 是自由文本，展示顺序完全由客户端提供的 levelOrder 决定。
      const created = await admin.createFloor({
        buildingPlaceId,
        levelCode: levelCode.trim(),
        levelOrder: order,
        displayName: displayName.trim(),
        isPublic: true,
      });
      setNotice(`已添加 ${created.displayName ?? levelCode.trim()}`);
      setLevelCode("");
      setDisplayName("");
      setLevelOrder("");
      setAdding(false);
      reload();
    } catch (err) {
      setError(floorError(err, "添加楼层失败"));
    } finally {
      setBusy(false);
    }
  }

  async function uploadPlanImage(floor: admin.FloorOverviewRow, file: File) {
    if (file.size > PLAN_IMAGE_MAX_BYTES) { setError("平面图不能超过 8 MiB"); return; }
    setUploadingFloorId(floor.id);
    setError("");
    try {
      await admin.uploadFloorImage(floor.id, file, file.type);
      setNotice(`${floor.displayName} 平面图已更新`);
      reload();
    } catch (err) {
      setError(floorError(err, "上传平面图失败"));
    } finally {
      setUploadingFloorId(null);
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
            <GhostButton
              disabled={busy}
              onClick={() => {
                setAdding((value) => {
                  // 打开表单时给个默认排序号：现有楼层数 + 1
                  if (!value && !levelOrder) setLevelOrder(String(items.length + 1));
                  return !value;
                });
              }}
            >
              <Plus size={14} />
              添加楼层
            </GhostButton>
          }
        >
          {adding ? (
            <div className="space-y-3 border-b border-line px-5 pb-4">
              <div className="grid grid-cols-3 gap-3">
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
                <Field
                  label="排序（小的排前面）"
                  onChange={setLevelOrder}
                  placeholder="如 1"
                  value={levelOrder}
                />
              </div>
              <PrimaryButton disabled={busy} onClick={addFloor}>
                {busy ? "处理中…" : "添加"}
              </PrimaryButton>
            </div>
          ) : null}

          <div className="divide-y divide-line">
            {items.map((floor) => {
              const uploading = uploadingFloorId === floor.id;
              return (
                <div
                  key={floor.id}
                  className={`flex w-full cursor-pointer items-start gap-3 px-5 py-3.5 text-left transition-colors ${
                    selectedFloorId === floor.id ? "bg-primary-container/60" : "hover:bg-page"
                  }`}
                  onClick={() => setSelectedFloorId(floor.id)}
                  role="button"
                  tabIndex={0}
                >
                  {floor.imageUrl ? (
                    <img
                      alt={`${floor.displayName} 平面图`}
                      className="mt-0.5 h-9 w-9 shrink-0 rounded-lg border border-line object-cover"
                      src={floor.imageUrl}
                    />
                  ) : (
                    <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary-container text-primary">
                      <Layers size={17} />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-body font-semibold text-ink">
                      {floor.displayName}
                      <span className="ml-1.5 text-label text-sub">{floor.levelCode}</span>
                    </p>
                    <p className="mt-0.5 text-aux text-sub">{usageSummary(floor.usage)}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      {floor.imageUrl ? (
                        <Pill tone="ok">有平面图</Pill>
                      ) : (
                        <Pill tone="neutral">无平面图</Pill>
                      )}
                      {floor.isPublic ? null : <Pill tone="warning">对外隐藏</Pill>}
                      {floor.lifecycleStatus === "active" ? null : (
                        <Pill tone="neutral">{LIFECYCLE_LABELS[floor.lifecycleStatus] ?? floor.lifecycleStatus}</Pill>
                      )}
                    </div>
                  </div>
                  <label
                    className={`mt-1 inline-flex shrink-0 items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-label text-ink transition-colors ${
                      uploading ? "cursor-wait opacity-60" : "cursor-pointer hover:border-primary hover:text-primary"
                    }`}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <Upload size={13} />
                    {uploading ? "上传中…" : floor.imageUrl ? "替换平面图" : "上传平面图"}
                    <input
                      accept={PLAN_IMAGE_ACCEPT}
                      className="hidden"
                      disabled={uploading}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (file) void uploadPlanImage(floor, file);
                      }}
                      type="file"
                    />
                  </label>
                </div>
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
            <EmptyState label="从左侧选择一层，查看该层的设施 / 商户" />
          </Panel>
        )}
      </div>
    </div>
  );
}

function FloorDetail({
  floorId,
  busy,
  onDelete,
  onToggleVisibility,
}: {
  floorId: string;
  busy: boolean;
  onDelete: () => void;
  onToggleVisibility: () => void;
}) {
  const { state } = useAsyncData((signal) => admin.getFloorDetail(floorId, signal), [floorId]);
  const navigate = useNavigate();
  const [tab, setTab] = useState<"facilities" | "merchants">("facilities");

  if (state.status === "loading") return <LoadingState label="加载楼层详情…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  const { floor, facilities, merchants, usage } = state.data;

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
        </div>
      </Panel>

      <div className="flex gap-2">
        <Chip active={tab === "facilities"} onClick={() => setTab("facilities")}>设施 {facilities.length}</Chip>
        <Chip active={tab === "merchants"} onClick={() => setTab("merchants")}>商户 {merchants.length}</Chip>
      </div>

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
    </div>
  );
}
