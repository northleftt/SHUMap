export const SUBMISSIONS_LOG_KEY = "shumap.submissions-log";

export interface LocalSubmission {
  id: string;
  targetType: string;
  targetId?: string;
  targetName?: string;
  title: string;
  status: "pending";
  createdAt: string;
}

function valid(item: unknown): item is LocalSubmission {
  if (!item || typeof item !== "object") return false;
  const value = item as Record<string, unknown>;
  return typeof value.id === "string"
    && typeof value.targetType === "string"
    && typeof value.title === "string"
    && typeof value.createdAt === "string";
}

export function readSubmissions(): LocalSubmission[] {
  try {
    const raw = wx.getStorageSync(SUBMISSIONS_LOG_KEY);
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(value) ? value.filter(valid) : [];
  } catch {
    return [];
  }
}

export function addSubmission(entry: Omit<LocalSubmission, "status" | "createdAt">): LocalSubmission[] {
  const next: LocalSubmission[] = [
    { ...entry, status: "pending", createdAt: new Date().toISOString() },
    ...readSubmissions().filter((item) => item.id !== entry.id),
  ];
  try {
    wx.setStorageSync(SUBMISSIONS_LOG_KEY, JSON.stringify(next));
  } catch {
    // 本地日志写入失败不改变服务端已成功提交的结果。
  }
  return next;
}
