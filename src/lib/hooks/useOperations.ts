import { listOperations } from "../api/public";
import type { OperationalEvent } from "../api/types";
import { useAsyncData } from "./useAsyncData";

/** 运营事件（含 targets/updates）。M2 横幅 / M6 / M8 共用。 */
export function useOperations() {
  const { state, reload } = useAsyncData((signal) => listOperations(signal), []);
  const events: OperationalEvent[] = state.status === "ready" && state.data ? state.data.items : [];
  const activeEvents = events.filter(
    (event) => event.operationalStatus === "scheduled" || event.operationalStatus === "active",
  );
  const endedEvents = events.filter(
    (event) => event.operationalStatus !== "scheduled" && event.operationalStatus !== "active",
  );
  return { events, activeEvents, endedEvents, status: state.status, reload };
}
