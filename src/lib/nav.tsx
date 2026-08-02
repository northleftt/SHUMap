import { useEffect } from "react";
import type { NavigationUrls } from "./types";

export interface MapTarget {
  label: string;
  navigationUrls: NavigationUrls;
}

export type MapProvider = "amap" | "tencent" | "baidu";

const PROVIDER_LABELS: Record<MapProvider, string> = {
  amap: "高德地图",
  tencent: "腾讯地图",
  baidu: "百度地图",
};

export function mapProviderOptions(
  target: MapTarget,
): Array<{ provider: MapProvider; label: string; url: string }> {
  return (["amap", "tencent", "baidu"] as const).map((provider) => ({
    provider,
    label: PROVIDER_LABELS[provider],
    url: target.navigationUrls[provider],
  }));
}

/** 选择地图的底部弹层；所有链接来自 release 中已验证的导航锚点。 */
export function MapAppSheet({
  target,
  onClose,
}: {
  target: MapTarget | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!target) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, onClose]);

  if (!target) return null;
  const options = mapProviderOptions(target);

  return (
    <div className="fixed inset-0 z-[60]">
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} />
      <div className="safe-bottom-padding absolute inset-x-0 bottom-0 rounded-t-4xl bg-surface px-5 pb-2 pt-5 shadow-sheet">
        <div className="text-center">
          <div className="text-emphasis text-ink">用地图打开</div>
          <div className="mt-1 text-aux text-sub">{target.label}</div>
        </div>
        <div className="mt-4 divide-y divide-line">
          {options.map((option) => (
            <a
              key={option.provider}
              className="block py-3.5 text-center text-body font-medium text-primary no-underline active:opacity-60"
              href={option.url}
              onClick={onClose}
              rel="noreferrer noopener"
              target="_blank"
            >
              {option.label}
            </a>
          ))}
        </div>
        <button
          type="button"
          className="mt-2 w-full rounded-full bg-page py-3 text-body font-medium text-ink active:opacity-70"
          onClick={onClose}
        >
          取消
        </button>
      </div>
    </div>
  );
}
