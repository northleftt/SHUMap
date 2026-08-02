import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError } from "../api/client";
import { loadRelease, type LoadedRelease } from "./mapData";

export type ReleaseStatus = "loading" | "ready" | "empty" | "error";

type ReleaseState =
  | { status: "loading"; release: null }
  | { status: "ready"; release: LoadedRelease }
  | { status: "empty"; release: null }
  | { status: "error"; release: null };

type ReleaseContextValue = ReleaseState & {
  reload: () => void;
};

const ReleaseContext = createContext<ReleaseContextValue>({ status: "loading", release: null, reload: () => {} });

/**
 * 全局唯一 release 加载点（/api/public/releases/current）。
 * 修复旧版 MapPage / ShuttlePage 各自重复拉取 manifest 的问题。
 */
export function ReleaseProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ReleaseState>({ status: "loading", release: null });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading", release: null });
    loadRelease(controller.signal)
      .then((release) => setState({ status: "ready", release }))
      .catch((error) => {
        if (controller.signal.aborted) return;
        const empty = error instanceof ApiError && error.isReleaseUnavailable;
        setState({ status: empty ? "empty" : "error", release: null });
      });
    return () => controller.abort();
  }, [nonce]);

  const value = useMemo<ReleaseContextValue>(() => ({ ...state, reload }), [state, reload]);
  return <ReleaseContext.Provider value={value}>{children}</ReleaseContext.Provider>;
}

export function useRelease(): ReleaseContextValue {
  return useContext(ReleaseContext);
}
