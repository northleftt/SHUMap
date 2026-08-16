import { useLocalStore } from "../storage/localStore";

/**
 * 楼外图钉尺寸控制。
 *
 * 图钉尺寸原先写死在 MapPoiOverlay 里，调一次要改代码。这里把「基准单位 + 档位」
 * 收成唯一来源：基准取当前视窗较短轴的 1/52，横屏与窄屏因此保持相近的屏幕像素
 * 大小；用户档位只是乘在基准上的系数，不影响命中检测与坐标。
 */
export const MARKER_UNIT_DIVISOR = 52;

export type MarkerScaleKey = "small" | "standard" | "large";

export const MARKER_SCALE_OPTIONS: ReadonlyArray<{
  key: MarkerScaleKey;
  label: string;
  value: number;
}> = [
  { key: "small", label: "小", value: 0.72 },
  { key: "standard", label: "标准", value: 1 },
  { key: "large", label: "大", value: 1.35 },
];

export const DEFAULT_MARKER_SCALE: MarkerScaleKey = "standard";

const STORE_KEY = "shumap.map-marker-scale";

/** 未知档位（存量脏值、手改 localStorage）一律回落标准档，不让地图画出畸形图钉。 */
export function markerScaleValue(key: string): number {
  return MARKER_SCALE_OPTIONS.find((option) => option.key === key)?.value
    ?? MARKER_SCALE_OPTIONS.find((option) => option.key === DEFAULT_MARKER_SCALE)!.value;
}

/** 叠加层的尺寸基准单位：较短视轴的 1/52，再乘用户档位系数。 */
export function markerUnit(view: { width: number; height: number }, scale = 1): number {
  return (Math.min(view.width, view.height) / MARKER_UNIT_DIVISOR) * scale;
}

/** 图钉大小档位（localStorage 持久化，跨页面/多处消费者同步）。 */
export function useMarkerScale(): [MarkerScaleKey, (next: MarkerScaleKey) => void] {
  const [stored, setStored] = useLocalStore<MarkerScaleKey>(STORE_KEY, DEFAULT_MARKER_SCALE);
  const key = MARKER_SCALE_OPTIONS.some((option) => option.key === stored)
    ? stored
    : DEFAULT_MARKER_SCALE;
  return [key, setStored];
}
