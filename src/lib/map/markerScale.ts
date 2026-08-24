import { useLocalStore } from "../storage/localStore";
import {
  DEFAULT_MARKER_SCALE,
  MARKER_SCALE_OPTIONS,
  type MarkerScaleKey,
} from "./markerTiers";

// 纯逻辑（基准、系数、content 解析）在 ./markerTiers——release 装配与 node 单测
// 都会引用它，那里不能带 React。本文件只留用户档位的持久化 hook 并原样转发导出。
export {
  clampMarkerScale,
  DEFAULT_MARKER_SCALE,
  MARKER_SCALE_DEFAULT,
  MARKER_SCALE_MAX,
  MARKER_SCALE_MIN,
  MARKER_SCALE_OPTIONS,
  MARKER_SCALE_STEP,
  MARKER_UNIT_DIVISOR,
  markerScaleFromContent,
  markerScaleValue,
  markerUnit,
  type MarkerScaleKey,
} from "./markerTiers";

const STORE_KEY = "shumap.map-marker-scale";

/** 用户侧图钉大小档位（localStorage 持久化，跨页面/多处消费者同步）。 */
export function useMarkerScale(): [MarkerScaleKey, (next: MarkerScaleKey) => void] {
  const [stored, setStored] = useLocalStore<MarkerScaleKey>(STORE_KEY, DEFAULT_MARKER_SCALE);
  const key = MARKER_SCALE_OPTIONS.some((option) => option.key === stored)
    ? stored
    : DEFAULT_MARKER_SCALE;
  return [key, setStored];
}
