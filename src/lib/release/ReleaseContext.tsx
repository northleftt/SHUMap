import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError } from "../api/client";
import { loadRelease, type LoadedRelease } from "./mapData";

export type ReleaseStatus = "loading" | "ready" | "empty" | "error";

interface ReleaseContextValue {
  status: ReleaseStatus;
  release: LoadedRelease | null;
  reload: () => void;
}

const ReleaseContext = createContext<ReleaseContextValue>({ status: "loading", release: null, reload: () => {} });

/**
 * 全局唯一 release 加载点（/api/public/releases/current）。
 * 修复旧版 MapPage / ShuttlePage 各自重复拉取 manifest 的问题。
 */
export function ReleaseProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ status: ReleaseStatus; release: LoadedRelease | null }>({ status: "loading", release: null });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setState((prev) => ({ status: "loading", release: prev.release }));
    loadRelease(controller.signal)
      .then((release) => setState({ status: "ready", release }))
      .catch((error) => {
        if (controller.signal.aborted) return;
        const empty = error instanceof ApiError && error.isReleaseUnavailable;
        setState({ status: empty ? "empty" : "error", release: null });
      });
    return () => controller.abort();
  }, [nonce]);

  const value = useMemo(() => ({ status: state.status, release: state.release, reload }), [state, reload]);
  return <ReleaseContext.Provider value={value}>{children}</ReleaseContext.Provider>;
}

export function useRelease(): ReleaseContextValue {
  return useContext(ReleaseContext);
}
