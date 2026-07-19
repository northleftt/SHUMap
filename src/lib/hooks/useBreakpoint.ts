import { useSyncExternalStore } from "react";

export type Breakpoint = "mobile" | "tablet" | "desktop";

const TABLET_QUERY = "(min-width: 768px)";
const DESKTOP_QUERY = "(min-width: 1024px)";

function subscribe(callback: () => void): () => void {
  const queries = [window.matchMedia(TABLET_QUERY), window.matchMedia(DESKTOP_QUERY)];
  queries.forEach((query) => query.addEventListener("change", callback));
  return () => queries.forEach((query) => query.removeEventListener("change", callback));
}

function getBreakpoint(): Breakpoint {
  if (window.matchMedia(DESKTOP_QUERY).matches) return "desktop";
  if (window.matchMedia(TABLET_QUERY).matches) return "tablet";
  return "mobile";
}

/** 设计断点：<768 手机（底部 Tab）/ ≥768 平板（左侧栏）/ ≥1024 PC（三栏）。 */
export function useBreakpoint(): Breakpoint {
  return useSyncExternalStore(subscribe, getBreakpoint);
}
