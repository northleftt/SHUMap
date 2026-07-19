import { useEffect, useState } from "react";
import { useIdentity } from "./identity";
import { useLocalStore } from "./localStore";

const KEY = "shumap.collection-tasks";
const SYNC_KEY = "shumap.collection-last-sync";
const POLL_INTERVAL_MS = 30_000;

/**
 * 志愿者数据采集——后端待写，本轮纯 localStorage 模拟。
 * 类型按未来 API 形状设计（building + assignee + status 状态机 +
 * floors/facilities 草稿），接后端时只需替换本模块实现。
 */
export type CollectionStatus =
  | "pending" // 未采集
  | "collecting" // 采集中（已锁定）
  | "submitted" // 已提交
  | "needs_recollection"; // 需补采

export interface CollectedFacility {
  id: string;
  typeCode: string;
  name: string;
  locationText: string;
}

export interface CollectedFloor {
  id: string;
  levelCode: string;
  note: string;
  facilities: CollectedFacility[];
}

export interface CollectionTask {
  buildingId: string;
  status: CollectionStatus;
  /** 锁定人昵称；他人看到「采集中 · XX」只读 */
  assignee: string | null;
  openHours: string;
  phone: string;
  organization: string;
  floors: CollectedFloor[];
  updatedAt: string | null;
  submittedAt: string | null;
}

export type CollectionTaskMap = Record<string, CollectionTask>;

function emptyTask(buildingId: string, assignee: string): CollectionTask {
  return {
    buildingId,
    status: "collecting",
    assignee,
    openHours: "",
    phone: "",
    organization: "",
    floors: [],
    updatedAt: new Date().toISOString(),
    submittedAt: null,
  };
}

export function useCollectionTasks() {
  const [tasks, setTasks] = useLocalStore<CollectionTaskMap>(KEY, {});
  const [lastSyncAt, setLastSyncAt] = useLocalStore<string | null>(SYNC_KEY, null);
  const [identity] = useIdentity();
  const [polling, setPolling] = useState(false);

  // 模拟 30s 轮询同步（接后端后改为真实拉取）
  useEffect(() => {
    const tick = () => {
      setPolling(true);
      window.setTimeout(() => {
        setLastSyncAt(new Date().toISOString());
        setPolling(false);
      }, 400);
    };
    const timer = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getTask = (buildingId: string): CollectionTask | null => tasks[buildingId] ?? null;

  /** 开始采集 = 锁定楼宇；已被他人（模拟）锁定时返回 false */
  const startCollection = (buildingId: string): boolean => {
    const existing = tasks[buildingId];
    if (existing && existing.status !== "pending" && existing.status !== "needs_recollection" && existing.assignee !== identity.name) {
      return false;
    }
    setTasks((prev) => ({ ...prev, [buildingId]: existing ?? emptyTask(buildingId, identity.name) }));
    return true;
  };

  const saveDraft = (buildingId: string, patch: Partial<Omit<CollectionTask, "buildingId">>) => {
    setTasks((prev) => {
      const current = prev[buildingId];
      if (!current) return prev;
      return { ...prev, [buildingId]: { ...current, ...patch, updatedAt: new Date().toISOString() } };
    });
  };

  const submitCollection = (buildingId: string) => {
    setTasks((prev) => {
      const current = prev[buildingId];
      if (!current) return prev;
      const now = new Date().toISOString();
      return { ...prev, [buildingId]: { ...current, status: "submitted", updatedAt: now, submittedAt: now } };
    });
  };

  return {
    tasks,
    getTask,
    startCollection,
    saveDraft,
    submitCollection,
    lastSyncAt,
    polling,
    collectedCount: Object.values(tasks).filter((task) => task.status === "submitted").length,
  };
}
