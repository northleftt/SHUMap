import { getSubmissionStatus, type ServerSubmissionStatus } from "../api/public";
import { useLocalStore } from "./localStore";

const KEY = "shumap.submissions-log";

export type LocalSubmissionStatus = ServerSubmissionStatus;

/**
 * 我的反馈——本地提交记录 + 服务端状态回流。
 *
 * 记录本身仍存 localStorage（反馈可以匿名提，服务端没有「某人的全部提交」概念）；
 * 每条记录带创建时返回的提交 id，GET /api/public/submissions/:id 凭 id 查询
 * 处理状态（capability URL，见 worker/modules/submissions.ts 的 getSubmissionStatus），
 * 于是后台审了之后状态能回流，不必永远显示「已提交」。
 * 换设备 / 清缓存记录即丢——这是匿名反馈的固有属性，不是缺陷。
 */
export interface LocalSubmission {
  id: string;
  targetType: string;
  targetId?: string;
  targetName?: string;
  title: string;
  status: LocalSubmissionStatus;
  createdAt: string;
  note?: string;
}

/** 服务端已给出终态的提交不再重复查询。 */
function isSettled(status: LocalSubmissionStatus): boolean {
  return status === "accepted" || status === "partially_accepted" || status === "rejected" || status === "withdrawn";
}

export function useSubmissionsLog(): {
  submissions: LocalSubmission[];
  addSubmission: (entry: Omit<LocalSubmission, "createdAt" | "status"> & { status?: LocalSubmissionStatus }) => void;
  /** 拉服务端刷新未终态记录的处理状态；静默失败（离线 / 老 Worker 无此端点）。 */
  refreshStatuses: () => Promise<void>;
} {
  const [submissions, setSubmissions] = useLocalStore<LocalSubmission[]>(KEY, []);
  return {
    submissions,
    addSubmission: (entry) =>
      setSubmissions((prev) => [
        { ...entry, status: entry.status ?? "pending", createdAt: new Date().toISOString() },
        ...prev,
      ]),
    refreshStatuses: async () => {
      // 只查未终态的最近 20 条：老记录基本不会再变，全部轮询只是给限流添堵。
      const unsettled = submissions.filter((item) => !isSettled(item.status)).slice(0, 20);
      if (unsettled.length === 0) return;
      const updates = new Map<string, LocalSubmissionStatus>();
      await Promise.all(
        unsettled.map(async (item) => {
          try {
            const remote = await getSubmissionStatus(item.id);
            if (remote.status !== item.status) updates.set(item.id, remote.status);
          } catch {
            // 404（服务端数据被清）/ 网络失败都保持本地现状，下次再试。
          }
        }),
      );
      if (updates.size > 0) {
        setSubmissions((prev) => prev.map((item) => {
          const next = updates.get(item.id);
          return next ? { ...item, status: next } : item;
        }));
      }
    },
  };
}
