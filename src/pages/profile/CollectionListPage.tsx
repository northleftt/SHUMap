import { Check, Lock, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Chip, ChipRow } from "../../components/ui/Chip";
import { EmptyState } from "../../components/ui/EmptyState";
import { PageHeader } from "../../components/ui/PageHeader";
import { useNow } from "../../lib/hooks/useNow";
import { useRelease } from "../../lib/release/ReleaseContext";
import { useCollectionTasks, type CollectionStatus } from "../../lib/storage/collectionTasks";
import { useIdentity } from "../../lib/storage/identity";

const STATUS_META: Record<CollectionStatus, { label: string; className: string }> = {
  pending: { label: "未采集", className: "bg-page text-sub" },
  collecting: { label: "采集中", className: "bg-primary-container text-primary" },
  submitted: { label: "已提交", className: "bg-success-bg text-success" },
  accepted: { label: "已采纳", className: "bg-success-bg text-success" },
  needs_recollection: { label: "需补采", className: "bg-warning-bg text-warning" },
};

function syncLabel(lastSyncAt: string | null, now: number): string {
  if (!lastSyncAt) return "等待同步";
  const minutes = Math.floor((now - new Date(lastSyncAt).getTime()) / 60_000);
  if (minutes < 1) return "最后更新 刚刚";
  if (minutes < 60) return `最后更新 ${minutes} 分钟前`;
  return `最后更新 ${Math.floor(minutes / 60)} 小时前`;
}

/** M12 数据采集列表：服务端锁定、草稿同步和提交状态。 */
export function CollectionListPage() {
  const navigate = useNavigate();
  const { release } = useRelease();
  const { tasks, startCollection, lastSyncAt, collectedCount, polling, error, reload } = useCollectionTasks();
  const [identity] = useIdentity();
  const [campus, setCampus] = useState<string | null>(null);
  const now = useNow(30_000);

  const buildings = useMemo(() => release?.buildings ?? [], [release]);
  const campusLabels = useMemo(
    () => Array.from(new Set(buildings.map((b) => b.campusLabel).filter(Boolean))),
    [buildings],
  );
  const visible = useMemo(
    () => (campus ? buildings.filter((b) => b.campusLabel === campus) : buildings),
    [buildings, campus],
  );

  const handleStart = async (buildingId: string) => {
    if (await startCollection(buildingId)) navigate(`/collect/${encodeURIComponent(buildingId)}`);
  };

  return (
    <div className="flex h-full flex-col bg-page">
      <PageHeader title="数据采集" onBack={() => navigate("/profile")} />

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        {/* 同步条 */}
        <button
          type="button"
          className={`mt-2 flex w-full items-center justify-between rounded-2xl px-4 py-3 ${error ? "bg-error-bg" : "bg-success-bg"}`}
          onClick={() => void reload()}
        >
          <div className={`flex items-center gap-2 text-aux font-medium ${error ? "text-error" : "text-success"}`}>
            <Check size={15} />
            {error || `已同步 · ${syncLabel(lastSyncAt, now)}`}
          </div>
          <RefreshCw size={16} className={`${error ? "text-error" : "text-success"} ${polling ? "animate-spin" : ""}`} />
        </button>

        {/* 进度卡 */}
        <div className="mt-3 rounded-2xl bg-surface p-4 shadow-card">
          <div className="text-emphasis">已采集 {collectedCount} 栋</div>
          <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-page">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${buildings.length ? Math.min(100, (collectedCount / buildings.length) * 100) : 0}%` }}
            />
          </div>
        </div>

        {/* 校区 chips */}
        <ChipRow className="mt-4">
          <Chip active={campus === null} variant="outline" onClick={() => setCampus(null)}>
            全部
          </Chip>
          {campusLabels.map((label) => (
            <Chip key={label} active={campus === label} variant="outline" onClick={() => setCampus(label)}>
              {label.replace("校区", "")}
            </Chip>
          ))}
        </ChipRow>

        {/* 楼宇列表 */}
        <div className="mt-3 overflow-hidden rounded-2xl bg-surface shadow-card">
          {visible.length === 0 ? (
            <EmptyState title="暂无楼宇" subtitle="当前校区没有可采集的楼宇" />
          ) : (
            visible.map((building, index) => {
              const task = tasks[building.poiKey];
              const status = task?.status ?? "pending";
              const meta = STATUS_META[status];
              const lockExpired = status === "collecting" && Boolean(task?.lockExpiresAt) && new Date(task!.lockExpiresAt!).getTime() <= now;
              const lockedByOther =
                status === "collecting" && task && !task.owned && !lockExpired;
              const mine = Boolean(task?.owned);

              return (
                <div
                  key={building.poiKey}
                  className={`flex items-center gap-3 px-4 py-3.5 ${index > 0 ? "border-t border-line" : ""}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-body font-semibold text-ink">{building.name}</div>
                    <div className="mt-0.5 text-aux text-sub">{building.campusLabel}</div>
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-label ${meta.className}`}>
                    {meta.label}
                    {task?.assignee && status !== "pending" ? ` · ${task.assignee}` : ""}
                  </span>
                  {lockedByOther ? (
                    <Lock size={16} className="shrink-0 text-sub" />
                  ) : status === "submitted" || status === "accepted" ? (
                    <button
                      type="button"
                      className="shrink-0 text-body font-medium text-sub"
                      onClick={() => navigate(`/collect/${encodeURIComponent(building.poiKey)}`)}
                    >
                      查看 ›
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="shrink-0 text-body font-medium text-primary"
                      onClick={() => void handleStart(building.poiKey)}
                    >
                    {status === "needs_recollection" ? "补采 ›" : lockExpired ? "重新领取 ›" : mine ? "继续采集 ›" : "开始采集 ›"}
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
