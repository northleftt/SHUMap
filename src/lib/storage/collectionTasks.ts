import { useCallback, useEffect, useRef, useState } from "react";
import {
  claimCollectionTask,
  listCollectionTasks,
  saveCollectionTask as saveCollectionTaskApi,
  submitCollectionTask as submitCollectionTaskApi,
} from "../api/public";
import type { CollectionTaskDto } from "../api/types";
import { collectionDeviceId, useIdentity } from "./identity";
import { useLocalStore } from "./localStore";

const KEY = "shumap.collection-tasks";
const SYNC_KEY = "shumap.collection-last-sync";
const POLL_INTERVAL_MS = 30_000;
const SAVE_DELAY_MS = 500;

export type CollectionStatus = "pending" | "collecting" | "submitted" | "accepted" | "needs_recollection";

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
  /** 该层平面图照片，已上传到隔离区的 media id（最多 2 张）。 */
  photoMediaIds?: string[];
}

export interface CollectionTask {
  buildingId: string;
  status: CollectionStatus;
  assignee: string | null;
  owned: boolean;
  openHours: string;
  phone: string;
  organization: string;
  floors: CollectedFloor[];
  /** 大门照片，已上传到隔离区的 media id（最多 3 张）。 */
  photoMediaIds: string[];
  lockExpiresAt: string | null;
  updatedAt: string | null;
  submittedAt: string | null;
}

export type CollectionTaskMap = Record<string, CollectionTask>;

type DraftPatch = Partial<Pick<CollectionTask, "openHours" | "phone" | "organization" | "floors" | "photoMediaIds">>;

function emptyTask(buildingId: string, assignee: string): CollectionTask {
  return {
    buildingId,
    status: "collecting",
    assignee,
    owned: true,
    openHours: "",
    phone: "",
    organization: "",
    floors: [],
    photoMediaIds: [],
    lockExpiresAt: null,
    updatedAt: new Date().toISOString(),
    submittedAt: null,
  };
}

function payloadOf(task: CollectionTask): Record<string, unknown> {
  return {
    openHours: task.openHours,
    phone: task.phone,
    organization: task.organization,
    floors: task.floors,
    photoMediaIds: task.photoMediaIds,
  };
}

function fromDto(dto: CollectionTaskDto, cached?: CollectionTask): CollectionTask {
  const payload = dto.payload ?? {};
  return {
    buildingId: dto.buildingId,
    status: dto.status,
    assignee: dto.assignee,
    owned: dto.owned,
    openHours: typeof payload.openHours === "string" ? payload.openHours : (cached?.openHours ?? ""),
    phone: typeof payload.phone === "string" ? payload.phone : (cached?.phone ?? ""),
    organization: typeof payload.organization === "string" ? payload.organization : (cached?.organization ?? ""),
    floors: Array.isArray(payload.floors) ? (payload.floors as CollectedFloor[]) : (cached?.floors ?? []),
    photoMediaIds: Array.isArray(payload.photoMediaIds)
      ? (payload.photoMediaIds as string[])
      : (cached?.photoMediaIds ?? []),
    lockExpiresAt: dto.lockExpiresAt,
    updatedAt: dto.updatedAt,
    submittedAt: dto.submittedAt,
  };
}

export function useCollectionTasks() {
  const [tasks, setTasks] = useLocalStore<CollectionTaskMap>(KEY, {});
  const [lastSyncAt, setLastSyncAt] = useLocalStore<string | null>(SYNC_KEY, null);
  const [identity] = useIdentity();
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState("");
  const saveTimers = useRef(new Map<string, number>());
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const deviceId = collectionDeviceId();

  const reload = useCallback(async (signal?: AbortSignal, clearError = true) => {
    setPolling(true);
    try {
      const response = await listCollectionTasks(deviceId, signal);
      setTasks((current) => {
        const next: CollectionTaskMap = {};
        for (const dto of response.items) next[dto.buildingId] = fromDto(dto, current[dto.buildingId]);
        return next;
      });
      setLastSyncAt(new Date().toISOString());
      if (clearError) setError("");
    } catch (err) {
      if (signal?.aborted) return;
      setError(err instanceof Error ? err.message : "采集任务同步失败");
    } finally {
      if (!signal?.aborted) setPolling(false);
    }
  }, [deviceId, setLastSyncAt, setTasks]);

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    const timer = window.setInterval(() => void reload(), POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      for (const saveTimer of saveTimers.current.values()) window.clearTimeout(saveTimer);
    };
  }, [reload]);

  const getTask = (buildingId: string): CollectionTask | null => tasks[buildingId] ?? null;

  const startCollection = async (buildingId: string): Promise<boolean> => {
    try {
      const response = await claimCollectionTask(buildingId, { deviceId, assigneeName: identity.name });
      setTasks((current) => ({
        ...current,
        [buildingId]: fromDto(response.task, current[buildingId] ?? emptyTask(buildingId, identity.name)),
      }));
      setLastSyncAt(new Date().toISOString());
      setError("");
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法锁定该楼宇");
      await reload(undefined, false);
      return false;
    }
  };

  const persistDraft = (buildingId: string) => {
    const current = tasksRef.current[buildingId];
    if (!current?.owned || current.status !== "collecting") return;
    void saveCollectionTaskApi(buildingId, { deviceId, payload: payloadOf(current) })
      .then(({ task }) => {
        setTasks((all) => ({ ...all, [buildingId]: fromDto(task, all[buildingId]) }));
        setLastSyncAt(new Date().toISOString());
        setError("");
      })
      .catch((err) => setError(err instanceof Error ? err.message : "草稿同步失败"));
  };

  const saveDraft = (buildingId: string, patch: DraftPatch) => {
    setTasks((current) => {
      const task = current[buildingId];
      if (!task?.owned || task.status !== "collecting") return current;
      return { ...current, [buildingId]: { ...task, ...patch, updatedAt: new Date().toISOString() } };
    });
    const existing = saveTimers.current.get(buildingId);
    if (existing) window.clearTimeout(existing);
    saveTimers.current.set(buildingId, window.setTimeout(() => persistDraft(buildingId), SAVE_DELAY_MS));
  };

  const submitCollection = async (buildingId: string): Promise<boolean> => {
    const current = tasksRef.current[buildingId];
    if (!current?.owned || current.status !== "collecting") return false;
    const timer = saveTimers.current.get(buildingId);
    if (timer) window.clearTimeout(timer);
    try {
      const response = await submitCollectionTaskApi(buildingId, { deviceId, payload: payloadOf(current) });
      setTasks((all) => ({ ...all, [buildingId]: fromDto(response.task, all[buildingId]) }));
      setLastSyncAt(new Date().toISOString());
      setError("");
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交采集失败");
      return false;
    }
  };

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
    collectedCount: Object.values(tasks).filter((task) => task.status === "submitted" || task.status === "accepted").length,
  };
}
