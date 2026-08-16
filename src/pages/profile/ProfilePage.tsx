import { Check, ChevronRight, ClipboardList, Clock, Info, MessageSquare, Pencil, Settings, Star } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Avatar } from "../../components/ui/Avatar";
import { StatusPill, type StatusTone } from "../../components/ui/StatusPill";
import { useRelease } from "../../lib/release/ReleaseContext";
import { useLocalStore } from "../../lib/storage/localStore";
import type { CollectionTaskMap } from "../../lib/storage/collectionTasks";
import { useFavorites } from "../../lib/storage/favorites";
import { useIdentity } from "../../lib/storage/identity";
import { useRecents } from "../../lib/storage/recents";
import { useSubmissionsLog, type LocalSubmissionStatus } from "../../lib/storage/submissionsLog";

/**
 * 身份/登录入口开关。当前公共端不做账号体系，资料卡与昵称编辑整体隐藏；
 * 本地身份仍在后台保留，反馈署名与数据采集认领继续使用默认昵称。
 */
const SHOW_LOGIN: boolean = false;

const SUBMISSION_STATUS: Record<LocalSubmissionStatus, { label: string; tone: StatusTone }> = {
  pending: { label: "已提交", tone: "warning" },
  in_review: { label: "审核中", tone: "warning" },
  accepted: { label: "已采纳", tone: "success" },
  partially_accepted: { label: "部分采纳", tone: "success" },
  rejected: { label: "未采纳", tone: "error" },
  withdrawn: { label: "已撤回", tone: "neutral" },
};

function formatSubmitDate(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 身份编辑（本地 mock） */
function IdentityEditor({ onClose }: { onClose: () => void }) {
  const [identity, setIdentity] = useIdentity();
  const [name, setName] = useState(identity.name);
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} />
      <div className="absolute inset-x-4 top-1/3 rounded-2xl bg-surface p-5 shadow-floating">
        <h3 className="text-card">编辑昵称</h3>
        <p className="mt-1 text-aux text-sub">昵称仅保存在本机</p>
        <input
          className="mt-3 w-full rounded-xl bg-page px-3.5 py-2.5 text-body text-ink outline-none"
          value={name}
          maxLength={12}
          onChange={(event) => setName(event.target.value)}
        />
        <button
          type="button"
          className="mt-4 w-full rounded-full bg-primary py-2.5 text-body font-semibold text-white active:bg-primary-pressed"
          onClick={() => {
            if (name.trim()) setIdentity((prev) => ({ ...prev, name: name.trim() }));
            onClose();
          }}
        >
          保存
        </button>
      </div>
    </div>
  );
}

/** M10 我的。 */
export function ProfilePage() {
  const navigate = useNavigate();
  const [identity] = useIdentity();
  const { favorites } = useFavorites();
  const { recents } = useRecents();
  const { submissions, refreshStatuses } = useSubmissionsLog();
  const [collectionTasks] = useLocalStore<CollectionTaskMap>("shumap.collection-tasks", {});
  const collectedCount = Object.values(collectionTasks).filter((task) => task.status === "submitted" || task.status === "accepted").length;
  const releaseState = useRelease();
  const [editing, setEditing] = useState(false);
  // 进页面时把未终态的反馈拿服务端状态刷一遍（静默失败）。「我的反馈」此前
  // 永远停在「已提交」，不是没人处理，是状态回不来。
  useEffect(() => {
    void refreshStatuses();
  }, [refreshStatuses]);

  const menu = [
    {
      icon: <Star size={19} className="text-ink" />,
      label: "我的收藏",
      right: favorites.length > 0 ? `${favorites.length} 个地点` : undefined,
      onClick: () => navigate("/map"),
    },
    {
      icon: <Clock size={19} className="text-ink" />,
      label: "最近查看",
      right: recents.length > 0 ? `${recents.length} 条` : undefined,
      onClick: () => navigate("/map"),
    },
    {
      icon: <ClipboardList size={19} className="text-primary" />,
      label: "志愿者数据采集",
      right: collectedCount > 0 ? `已采集 ${collectedCount} 栋` : undefined,
      onClick: () => navigate("/collect"),
    },
    {
      icon: <MessageSquare size={19} className="text-ink" />,
      label: "意见反馈",
      onClick: () => navigate("/feedback"),
    },
    {
      icon: <Info size={19} className="text-ink" />,
      label: "关于 SHUMap",
      right: "v2.0",
      onClick: () => {},
    },
    {
      icon: <Settings size={19} className="text-ink" />,
      label: "设置",
      onClick: () => {},
    },
  ];

  return (
    <div className="h-full overflow-y-auto bg-page pb-6">
      <h1 className="px-5 pb-4 pt-6 text-title">我的</h1>

      {/* 资料卡 */}
      {SHOW_LOGIN ? (
        <div className="mx-4 flex items-center gap-3.5 rounded-2xl bg-surface p-4 shadow-card">
          <Avatar name={identity.name} size={52} />
          <div className="min-w-0 flex-1">
            <div className="text-card">{identity.name}</div>
            <div className="mt-0.5 text-aux text-sub">学号 {identity.studentId}</div>
          </div>
          <button
            type="button"
            className="flex items-center gap-1 text-body font-medium text-primary"
            onClick={() => setEditing(true)}
          >
            <Pencil size={13} />
            编辑 ›
          </button>
        </div>
      ) : null}

      {/* 我的反馈 */}
      <div className={`mx-4 ${SHOW_LOGIN ? "mt-5" : ""}`}>
        <div className="flex items-center justify-between">
          <h2 className="text-emphasis">我的反馈</h2>
          <button type="button" className="text-aux text-sub" onClick={() => navigate("/feedback")}>
            全部 ›
          </button>
        </div>
        <div className="mt-2.5 rounded-2xl bg-surface shadow-card">
          {submissions.length === 0 ? (
            <div className="px-4 py-6 text-center text-aux text-sub">
              还没有提交过反馈
              <button type="button" className="ml-1 text-primary" onClick={() => navigate("/feedback")}>
                去反馈 ›
              </button>
            </div>
          ) : (
            submissions.slice(0, 3).map((submission, index) => {
              const status = SUBMISSION_STATUS[submission.status];
              return (
                <div key={submission.id} className={`px-4 py-3.5 ${index > 0 ? "border-t border-line" : ""}`}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 truncate text-body font-semibold text-ink">{submission.title}</div>
                    <StatusPill tone={status.tone}>{status.label}</StatusPill>
                  </div>
                  <div className="mt-1 text-aux text-sub">
                    {submission.targetName ? `${submission.targetName} · ` : ""}
                    {formatSubmitDate(submission.createdAt)} 提交
                  </div>
                  {submission.note ? (
                    <div className="mt-1 flex items-center gap-1 text-aux text-success">
                      <Check size={13} />
                      {submission.note}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* 菜单 */}
      <div className="mx-4 mt-5 overflow-hidden rounded-2xl bg-surface shadow-card">
        {menu.map((item, index) => (
          <button
            key={item.label}
            type="button"
            className={`flex w-full items-center gap-3 px-4 py-3.5 text-left active:bg-page ${
              index > 0 ? "border-t border-line" : ""
            }`}
            onClick={item.onClick}
          >
            {item.icon}
            <span className="flex-1 text-body font-medium text-ink">{item.label}</span>
            {item.right ? <span className="text-aux text-sub">{item.right}</span> : null}
            <ChevronRight size={16} className="text-sub" />
          </button>
        ))}
      </div>

      <div className="mt-6 text-center text-label text-sub">
        SHUMap v2.0 · 数据版本 {releaseState.status === "ready" ? releaseState.release.version : "—"}
      </div>

      {SHOW_LOGIN && editing ? <IdentityEditor onClose={() => setEditing(false)} /> : null}
    </div>
  );
}
