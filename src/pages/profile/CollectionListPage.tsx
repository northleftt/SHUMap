import { Check, CloudOff, Lock, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Chip, ChipRow } from "../../components/ui/Chip";
import { EmptyState, LoadingState } from "../../components/ui/EmptyState";
import { PageHeader } from "../../components/ui/PageHeader";
import { useNow } from "../../lib/hooks/useNow";
import { useRelease } from "../../lib/release/ReleaseContext";
import type { LoadedRelease } from "../../lib/release/mapData";
import {
  collectionStats,
  isLockExpired,
  useCollectionTasks,
  type CollectionStatus,
} from "../../lib/storage/collectionTasks";

const STATUS_META: Record<CollectionStatus, { label: string; className: string }> = {
  pending: { label: "待采集", className: "bg-page text-sub" },
  collecting: { label: "采集中", className: "bg-primary-container text-primary" },
  submitted: { label: "已提交", className: "bg-success-bg text-success" },
  accepted: { label: "已采纳", className: "bg-success-bg text-success" },
  needs_recollection: { label: "需重采", className: "bg-warning-bg text-warning" },
};

function syncLabel(lastSyncAt: string | null, now: number): string {
  if (!lastSyncAt) return "等待同步";
  const minutes = Math.floor((now - new Date(lastSyncAt).getTime()) / 60_000);
  if (minutes < 1) return "最后更新 刚刚";
  if (minutes < 60) return `最后更新 ${minutes} 分钟前`;
  return `最后更新 ${Math.floor(minutes / 60)} 小时前`;
}

/**
 * M12 数据采集列表。
 *
 * 楼宇清单来自当前发布清单（每栋楼都是潜在任务），采集状态全部来自服务器，
 * 因此任何设备都能看到所有志愿者的进展：谁在采哪栋、采到哪一步。
 */
export function CollectionListPage() {
  const releaseState = useRelease();
  if (releaseState.status === "loading") {
    return <div className="h-full bg-page"><LoadingState label="正在加载采集楼宇…" /></div>;
  }
  if (releaseState.status !== "ready") {
    return (
      <div className="h-full bg-page px-5 pt-16">
        <EmptyState
          title={releaseState.status === "empty" ? "采集楼宇尚未发布" : "发布数据加载失败"}
          subtitle={releaseState.status === "empty" ? "当前没有可采集的楼宇" : "请检查网络后重试"}
        />
      </div>
    );
  }
  return <ReadyCollectionListPage release={releaseState.release} />;
}

function ReadyCollectionListPage({ release }: { release: LoadedRelease }) {
  const navigate = useNavigate();
  const { tasks, startCollection, lastSyncAt, polling, error, reload, pendingCount } = useCollectionTasks();
  const [campus, setCampus] = useState<string | null>(null);
  const now = useNow(30_000);

  const buildings = release.buildings;
  const campusLabels = useMemo(
    () => Array.from(new Set(buildings.map((b) => b.campusLabel).filter(Boolean))),
    [buildings],
  );
  const visible = useMemo(
    () => (campus ? buildings.filter((b) => b.campusLabel === campus) : buildings),
    [buildings, campus],
  );
  // 统计始终覆盖全部楼宇，不随校区筛选变化。
  const stats = useMemo(
    () => collectionStats(buildings.map((b) => b.poiKey), tasks, now),
    [buildings, tasks, now],
  );
  const doneCount = stats.submitted + stats.accepted;

  const handleStart = async (buildingId: string) => {
    if (await startCollection(buildingId)) navigate(`/collect/${encodeURIComponent(buildingId)}`);
  };

  return (
    <div className="flex h-full flex-col bg-page">
      <PageHeader title="数据采集" onBack={() => navigate("/profile")} />

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        {/* 同步条：点击手动刷新 */}
        <button
          type="button"
          aria-label="刷新采集进展"
          className={`mt-2 flex w-full items-center justify-between rounded-2xl px-4 py-3 ${error ? "bg-error-bg" : "bg-success-bg"}`}
          onClick={() => void reload()}
        >
          <div className={`flex items-center gap-2 text-aux font-medium ${error ? "text-error" : "text-success"}`}>
            {error ? <CloudOff size={15} /> : <Check size={15} />}
            {error || `已同步 · ${syncLabel(lastSyncAt, now)}`}
          </div>
          <RefreshCw size={16} className={`${error ? "text-error" : "text-success"} ${polling ? "animate-spin" : ""}`} />
        </button>

        {pendingCount > 0 ? (
          <p className="mt-2 text-aux text-warning">
            {pendingCount} 栋楼的草稿还留在本机，网络恢复后会自动上传
          </p>
        ) : null}

        {/* 进度卡 + 统计条 */}
        <div className="mt-3 rounded-2xl bg-surface p-4 shadow-card">
          <div className="flex items-baseline justify-between">
            <div className="text-emphasis">已采集 {doneCount} 栋</div>
            <div className="text-aux text-sub">共 {stats.total} 栋</div>
          </div>
          <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-page">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${stats.total ? Math.min(100, (doneCount / stats.total) * 100) : 0}%` }}
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-aux text-sub">
            <span>已提交 {stats.submitted}</span>
            {stats.accepted > 0 ? <span className="text-success">已采纳 {stats.accepted}</span> : null}
            <span className="text-primary">采集中 {stats.collecting}</span>
            <span>待采集 {stats.pending}</span>
            {stats.needsRecollection > 0 ? (
              <span className="text-warning">需重采 {stats.needsRecollection}</span>
            ) : null}
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
              const lockExpired = isLockExpired(task, now);
              // 别人领取且锁还没过期：本机只能看，不能改。
              const lockedByOther = task?.status === "collecting" && !task.owned && !lockExpired;
              const mine = Boolean(task?.owned);
              // 锁过期的楼回到待采集，谁都可以接手。
              const status: CollectionStatus = !task
                ? "pending"
                : task.status === "collecting" && lockExpired && !mine
                  ? "pending"
                  : task.status;
              const meta = STATUS_META[status];
              const who = task?.assignee ? (mine ? "我" : task.assignee) : null;
              const showWho = who && status !== "pending";

              return (
                <div
                  key={building.poiKey}
                  className={`flex items-center gap-3 px-4 py-3.5 ${index > 0 ? "border-t border-line" : ""}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-body font-semibold text-ink">{building.name}</div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-aux text-sub">
                      <span className="truncate">{building.campusLabel}</span>
                      {task?.pendingSync ? <span className="shrink-0 text-warning">· 待同步</span> : null}
                    </div>
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-label ${meta.className}`}>
                    {meta.label}
                    {showWho ? ` · ${who}` : ""}
                  </span>
                  {lockedByOther ? (
                    <span
                      className="flex shrink-0 items-center gap-1 text-aux text-sub"
                      title={`${task?.assignee ?? "其他志愿者"} 正在采集`}
                    >
                      <Lock size={15} />
                    </span>
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
                      {status === "needs_recollection"
                        ? "重采 ›"
                        : lockExpired
                          ? "重新领取 ›"
                          : mine
                            ? "继续采集 ›"
                            : "开始采集 ›"}
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
