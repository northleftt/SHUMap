import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import * as admin from "../lib/api/admin";
import { subscribeAdminDataChanged } from "../lib/api/client";
import { useAuth } from "./AuthContext";

// ---------------------------------------------------------------------------
// 「有改动待发版」的共享状态。
//
// 「地图数据只来自 release」这条约定有个代价：后台改完东西，用户端要等下一次发版
// 才会变。此前后台没有任何地方提示这件事，于是改完看不到效果时，无从判断是自己填
// 错了还是只差一次发版。
//
// 侧栏小黄点与发布中心的清单读同一份数据，所以放在 context 里而不是各自请求：两处
// 说法不一致会比没有提示更糟。
//
// 没有 publish:release 权限的账号不请求（那个端点要这个权限，请求了也只会拿到 403）。
// ---------------------------------------------------------------------------

interface PendingReleaseValue {
  /** 尚未取到结果时为 null；取失败也是 null（提示可以缺，不该弹错误打断别的工作）。 */
  pending: admin.PendingReleaseChanges | null;
  reload(): void;
}

const PendingReleaseContext = createContext<PendingReleaseValue | null>(null);

export function PendingReleaseProvider({ children }: { children: ReactNode }) {
  const { hasPermission } = useAuth();
  const canPublish = hasPermission("publish:release");
  const [pending, setPending] = useState<admin.PendingReleaseChanges | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => subscribeAdminDataChanged(reload), [reload]);

  useEffect(() => {
    if (!canPublish) {
      setPending(null);
      return;
    }
    const controller = new AbortController();
    admin.pendingReleaseChanges(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setPending(value);
      })
      .catch(() => {
        // 这只是个提示。取不到就不显示，不要在别的页面上弹错误。
        if (!controller.signal.aborted) setPending(null);
      });
    return () => controller.abort();
  }, [canPublish, nonce]);

  const value = useMemo(() => ({ pending, reload }), [pending, reload]);
  return <PendingReleaseContext.Provider value={value}>{children}</PendingReleaseContext.Provider>;
}

export function usePendingRelease(): PendingReleaseValue {
  const ctx = useContext(PendingReleaseContext);
  if (!ctx) throw new Error("usePendingRelease must be used within PendingReleaseProvider");
  return ctx;
}
