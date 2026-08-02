import { listOperations } from "../api/public";
import { useAsyncData } from "./useAsyncData";

/** 运营事件（含 targets/updates）。M2 横幅 / M6 / M8 共用。 */
export function useOperations() {
  const { state, reload } = useAsyncData((signal) => listOperations(signal), []);
  if (state.status === "loading") return { status: "loading", reload } as const;
  if (state.status === "error") return { status: "error", message: state.message, reload } as const;
  const activeEvents = state.data.items.filter(
    (event) => event.operationalStatus === "scheduled" || event.operationalStatus === "active",
  );
  const endedEvents = state.data.items.filter(
    (event) => event.operationalStatus !== "scheduled" && event.operationalStatus !== "active",
  );
  return { status: "ready", events: state.data.items, activeEvents, endedEvents, reload } as const;
}
