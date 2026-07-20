import { useLocalStore } from "./localStore";

const KEY = "shumap.submissions-log";

export type LocalSubmissionStatus = "pending" | "accepted" | "partially_accepted" | "rejected";

/**
 * 我的反馈——本地提交记录。公共端没有「我的提交」查询接口，
 * 状态只能记录提交时刻的 pending；后续后台处理状态无法回流，
 * 文案需保持诚实（展示「已提交」而非「已采纳」）。
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

export function useSubmissionsLog(): {
  submissions: LocalSubmission[];
  addSubmission: (entry: Omit<LocalSubmission, "createdAt" | "status"> & { status?: LocalSubmissionStatus }) => void;
} {
  const [submissions, setSubmissions] = useLocalStore<LocalSubmission[]>(KEY, []);
  return {
    submissions,
    addSubmission: (entry) =>
      setSubmissions((prev) => [
        { ...entry, status: entry.status ?? "pending", createdAt: new Date().toISOString() },
        ...prev,
      ]),
  };
}
