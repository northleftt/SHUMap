import { useEffect, useState } from "react";
import { getDiningSchedule, getMerchantStatus } from "../api/public";
import { shanghaiToday, type DiningScheduleResponse, type MerchantLifecycle } from "../dining/schedule";
import { subscribeAdminDataChanged } from "../api/client";

type LiveState<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

/** Keep confirmed values during a same-day refresh; never carry yesterday's arrangement. */
function useDiningLive<T>(load: (date: string, signal: AbortSignal) => Promise<T>, dated: boolean): LiveState<T> {
  const [snapshot, setSnapshot] = useState<{ date: string; state: LiveState<T> }>({ date: shanghaiToday(), state: { status: "loading" } });
  useEffect(() => {
    let active = true;
    let request: AbortController | null = null;
    let requestDate = "";
    const refresh = () => {
      const date = shanghaiToday();
      if (dated) setSnapshot(previous => previous.date === date ? previous : { date, state: { status: "loading" } });
      // A slow request should complete, rather than being cancelled by every tick.
      if (request && (!dated || requestDate === date)) return;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      requestDate = date;
      load(date, controller.signal).then(data => {
        if (active && !controller.signal.aborted && (!dated || date === shanghaiToday())) setSnapshot({ date, state: { status: "ready", data } });
      }).catch(error => {
        if (active && !controller.signal.aborted) setSnapshot({ date, state: { status: "error", message: error instanceof Error ? error.message : "加载失败" } });
      }).finally(() => { if (request === controller) request = null; });
    };
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    const unsubscribe = subscribeAdminDataChanged(refresh);
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { active = false; request?.abort(); window.clearInterval(timer); unsubscribe(); document.removeEventListener("visibilitychange", onVisible); };
  }, [load, dated]);
  return dated && snapshot.date !== shanghaiToday() ? { status: "loading" } : snapshot.state;
}
const loadSchedule = (date: string, signal: AbortSignal) => getDiningSchedule(date, signal);
const loadMerchants = (_date: string, signal: AbortSignal) => getMerchantStatus(signal);
export type DiningScheduleState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; schedule: DiningScheduleResponse };
export function useDiningSchedule(): DiningScheduleState {
  const state = useDiningLive(loadSchedule, true);
  return state.status === "ready" ? { status: "ready", schedule: state.data } : state;
}
export type MerchantStatusState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; statuses: Record<string, MerchantLifecycle> };
export function useMerchantStatus(): MerchantStatusState {
  const state = useDiningLive(loadMerchants, false);
  return state.status === "ready" ? { status: "ready", statuses: state.data.statuses } : state;
}
