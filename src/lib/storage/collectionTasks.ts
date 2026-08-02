import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  claimCollectionTask,
  listCollectionTasks,
  saveCollectionTask as saveCollectionTaskApi,
  submitCollectionTask as submitCollectionTaskApi,
} from "../api/public";
import type { CollectionTaskDto, CollectionTaskStatus, OwnedCollectionTaskDto } from "../api/types";
import type { CollectionPayload } from "../../../shared/submission-contract";
export type { CollectedFacility, CollectedFloor } from "../../../shared/submission-contract";
import { collectionDeviceId } from "./identity";
import { useLocalStore } from "./localStore";

const KEY = "shumap.collection-tasks";
const SYNC_KEY = "shumap.collection-last-sync";
/** 本机改过但还没写回服务器的楼宇：buildingId -> 最后一次本地编辑时间。 */
const PENDING_KEY = "shumap.collection-pending";
const POLL_INTERVAL_MS = 30_000;
const SAVE_DELAY_MS = 500;

export type CollectionStatus = "pending" | CollectionTaskStatus;

export interface CollectionTask extends CollectionPayload {
  buildingId: string;
  status: CollectionTaskStatus;
  assignee: string | null;
  owned: boolean;
  lockExpiresAt: string | null;
  updatedAt: string | null;
  submittedAt: string | null;
  /** 本机有尚未同步到服务器的改动，网络恢复后会自动重试。 */
  pendingSync: boolean;
}

export type CollectionTaskMap = Record<string, CollectionTask>;
type PendingMap = Record<string, string>;

type DraftPatch = Partial<Pick<CollectionTask, "openHours" | "phone" | "organization" | "floors" | "photoMediaIds">>;

export interface CollectionStats {
  total: number;
  pending: number;
  collecting: number;
  submitted: number;
  accepted: number;
  needsRecollection: number;
}

function emptyPayload(): CollectionPayload {
  return {
    openHours: "",
    phone: "",
    organization: "",
    floors: [],
    photoMediaIds: [],
  };
}

function payloadOf(task: CollectionTask): CollectionPayload {
  return {
    openHours: task.openHours,
    phone: task.phone,
    organization: task.organization,
    floors: task.floors,
    photoMediaIds: task.photoMediaIds,
  };
}

/**
 * 服务端行 -> 本机任务。
 *
 * 状态、领取人、锁与时间戳始终以服务器为准（跨设备协作只有一个真相）。
 * 未持有任务时服务端不返回草稿正文，本机也不保留上一轮领取留下的内容。
 */
function fromDto(dto: CollectionTaskDto): CollectionTask {
  const payload = dto.owned ? dto.payload : emptyPayload();
  return {
    buildingId: dto.buildingId,
    status: dto.status,
    assignee: dto.assignee,
    owned: dto.owned,
    ...payload,
    lockExpiresAt: dto.lockExpiresAt,
    updatedAt: dto.updatedAt,
    submittedAt: dto.submittedAt,
    pendingSync: false,
  };
}

function fromOwnedDtoWithDraft(dto: OwnedCollectionTaskDto, draft: CollectionTask): CollectionTask {
  return {
    ...fromDto(dto),
    ...payloadOf(draft),
    pendingSync: true,
  };
}

/**
 * 本机草稿是否比服务器版本新：只有仍在采集、锁在本机手上，
 * 且本地最后一次编辑晚于服务器记录的更新时间，才保留本地正文。
 */
function localDraftWins(dto: CollectionTaskDto, pendingAt: string | undefined): boolean {
  if (!pendingAt) return false;
  if (!dto.owned || dto.status !== "collecting") return false;
  return pendingAt > dto.updatedAt;
}

/**
 * 采集锁是否已过期。锁过期的楼宇回到待采集池子，任何志愿者都能接手。
 * 只有仍在采集中的任务才谈得上锁。
 */
export function isLockExpired(task: CollectionTask | undefined | null, now: number): boolean {
  if (!task || task.status !== "collecting") return false;
  const expiresAt = task.lockExpiresAt;
  return expiresAt !== null && new Date(expiresAt).getTime() <= now;
}

/** 汇总统计：楼宇清单来自发布清单，没有对应任务行的算「待采集」。 */
export function collectionStats(buildingIds: string[], tasks: CollectionTaskMap, now: number): CollectionStats {
  const stats: CollectionStats = {
    total: buildingIds.length,
    pending: 0,
    collecting: 0,
    submitted: 0,
    accepted: 0,
    needsRecollection: 0,
  };
  for (const buildingId of buildingIds) {
    const task = tasks[buildingId];
    if (!task) {
      stats.pending += 1;
      continue;
    }
    switch (task.status) {
      case "collecting":
        // 锁过期的楼实际上又回到了待采集池子里。
        if (isLockExpired(task, now)) stats.pending += 1;
        else stats.collecting += 1;
        break;
      case "submitted":
        stats.submitted += 1;
        break;
      case "accepted":
        stats.accepted += 1;
        break;
      case "needs_recollection":
        stats.needsRecollection += 1;
        break;
    }
  }
  return stats;
}

export function useCollectionTasks() {
  const [tasks, setTasks] = useLocalStore<CollectionTaskMap>(KEY, {});
  const [lastSyncAt, setLastSyncAt] = useLocalStore<string | null>(SYNC_KEY, null);
  const [pending, setPending] = useLocalStore<PendingMap>(PENDING_KEY, {});
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState("");
  const saveTimers = useRef(new Map<string, number>());
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const deviceId = collectionDeviceId();

  const markPending = useCallback((buildingId: string, at: string | null) => {
    setPending((current) => {
      if (at === null) {
        if (!(buildingId in current)) return current;
        const next = { ...current };
        delete next[buildingId];
        return next;
      }
      return { ...current, [buildingId]: at };
    });
  }, [setPending]);

  /** 把本机草稿写回服务器。失败时留在待同步队列里，正文不丢。 */
  const persistDraft = useCallback(async (buildingId: string): Promise<boolean> => {
    const current = tasksRef.current[buildingId];
    if (!current?.owned || current.status !== "collecting") return false;
    const attemptAt = current.updatedAt ?? new Date().toISOString();
    try {
      const { task } = await saveCollectionTaskApi(buildingId, { deviceId, payload: payloadOf(current) });
      // 服务器已收下这一版；期间若又有新编辑（updatedAt 变了）则继续保持待同步。
      const latest = tasksRef.current[buildingId];
      const changedMeanwhile = Boolean(latest?.updatedAt && latest.updatedAt > attemptAt);
      setTasks((all) => {
        if (!changedMeanwhile) return { ...all, [buildingId]: fromDto(task) };
        const draft = all[buildingId];
        if (!draft) throw new Error(`Collection draft ${buildingId} is missing`);
        return { ...all, [buildingId]: fromOwnedDtoWithDraft(task, draft) };
      });
      if (!changedMeanwhile) markPending(buildingId, null);
      setLastSyncAt(new Date().toISOString());
      setError("");
      return true;
    } catch (err) {
      markPending(buildingId, attemptAt);
      setTasks((all) => {
        const task = all[buildingId];
        return task ? { ...all, [buildingId]: { ...task, pendingSync: true } } : all;
      });
      setError(err instanceof Error ? err.message : "草稿已保存在本机，待网络恢复后自动同步");
      return false;
    }
  }, [deviceId, markPending, setLastSyncAt, setTasks]);

  const reload = useCallback(async (signal?: AbortSignal, clearError = true) => {
    setPolling(true);
    try {
      const response = await listCollectionTasks(deviceId, signal);
      const pendingNow = pendingRef.current;
      const stale: string[] = [];
      setTasks((current) => {
        const next: CollectionTaskMap = {};
        for (const dto of response.items) {
          const keepLocal = localDraftWins(dto, pendingNow[dto.buildingId]);
          if (keepLocal) {
            const draft = current[dto.buildingId];
            if (!draft || !dto.owned) throw new Error(`Collection draft ${dto.buildingId} violates ownership`);
            next[dto.buildingId] = fromOwnedDtoWithDraft(dto, draft);
          } else {
            next[dto.buildingId] = fromDto(dto);
          }
          if (pendingNow[dto.buildingId] && !keepLocal) stale.push(dto.buildingId);
        }
        return next;
      });
      // 服务器版本已经不比本地旧了，待同步标记可以撤掉。
      for (const buildingId of stale) markPending(buildingId, null);
      setLastSyncAt(new Date().toISOString());
      if (clearError) setError("");
      // 顺带把还欠着的草稿补交上去。
      for (const buildingId of Object.keys(pendingNow)) {
        if (!stale.includes(buildingId)) void persistDraft(buildingId);
      }
    } catch (err) {
      if (signal?.aborted) return;
      setError(err instanceof Error ? err.message : "采集进展同步失败");
    } finally {
      if (!signal?.aborted) setPolling(false);
    }
  }, [deviceId, markPending, persistDraft, setLastSyncAt, setTasks]);

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    const timer = window.setInterval(() => void reload(), POLL_INTERVAL_MS);
    const timers = saveTimers.current;
    const onOnline = () => void reload();
    window.addEventListener("online", onOnline);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("online", onOnline);
      for (const saveTimer of timers.values()) window.clearTimeout(saveTimer);
    };
  }, [reload]);

  const getTask = (buildingId: string): CollectionTask | null => tasks[buildingId] ?? null;

  const startCollection = async (buildingId: string): Promise<boolean> => {
    try {
      const response = await claimCollectionTask(buildingId, { deviceId });
      setTasks((current) => ({
        ...current,
        [buildingId]: fromDto(response.task),
      }));
      setLastSyncAt(new Date().toISOString());
      setError("");
      return true;
    } catch (err) {
      // 领取必须联网：锁只有服务器能发，否则两个人会同时改同一栋楼。
      setError(err instanceof Error ? err.message : "无法领取该楼宇，请检查网络后重试");
      await reload(undefined, false);
      return false;
    }
  };

  const saveDraft = (buildingId: string, patch: DraftPatch) => {
    const editedAt = new Date().toISOString();
    setTasks((current) => {
      const task = current[buildingId];
      if (!task?.owned || task.status !== "collecting") return current;
      return { ...current, [buildingId]: { ...task, ...patch, updatedAt: editedAt, pendingSync: true } };
    });
    markPending(buildingId, editedAt);
    const existing = saveTimers.current.get(buildingId);
    if (existing) window.clearTimeout(existing);
    saveTimers.current.set(buildingId, window.setTimeout(() => void persistDraft(buildingId), SAVE_DELAY_MS));
  };

  const submitCollection = async (buildingId: string): Promise<boolean> => {
    const current = tasksRef.current[buildingId];
    if (!current?.owned || current.status !== "collecting") return false;
    const timer = saveTimers.current.get(buildingId);
    if (timer) window.clearTimeout(timer);
    try {
      const response = await submitCollectionTaskApi(buildingId, { deviceId, payload: payloadOf(current) });
      setTasks((all) => ({ ...all, [buildingId]: fromDto(response.task) }));
      markPending(buildingId, null);
      setLastSyncAt(new Date().toISOString());
      setError("");
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交采集失败");
      return false;
    }
  };

  const pendingCount = useMemo(() => Object.keys(pending).length, [pending]);

  return {
    tasks,
    getTask,
    startCollection,
    saveDraft,
    submitCollection,
    reload,
    lastSyncAt,
    polling,
    error,
    /** 还有多少栋楼的草稿欠着没传上去。 */
    pendingCount,
    collectedCount: Object.values(tasks).filter((task) => task.status === "submitted" || task.status === "accepted").length,
  };
}
