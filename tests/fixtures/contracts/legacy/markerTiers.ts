/**
 * 楼外图钉尺寸控制（纯逻辑，无 React 依赖——release 装配与 node 单测都会引用，
 * 不能把 hook 带进来）。
 *
 * 图钉尺寸原先写死在 MapPoiOverlay 里，调一次要改代码。这里把「基准单位 + 系数」
 * 收成唯一来源：基准取当前视窗较短轴的 1/52，横屏与窄屏因此保持相近的屏幕像素
 * 大小；管理端给单个 POI/站点定的系数只是乘在基准上，不影响命中检测与坐标。
 *
 * 系数是 [MARKER_SCALE_MIN, MARKER_SCALE_MAX] 内的连续值（0027 起）；早先三档
 * 枚举（small/standard/large）的存量值仍按 LEGACY_MARKER_SCALES 读出对应系数。
 */
export const MARKER_UNIT_DIVISOR = 52;

export const MARKER_SCALE_MIN = 0.5;
export const MARKER_SCALE_MAX = 2;
export const MARKER_SCALE_STEP = 0.05;
export const MARKER_SCALE_DEFAULT = 1;

/** 0027 之前的三档枚举存量值 → 连续系数。 */
const LEGACY_MARKER_SCALES: Record<string, number> = { small: 0.72, standard: 1, large: 1.35 };

export type MarkerScaleKey = "small" | "standard" | "large";

/** 用户侧（LayerPanel）快捷档位仍保留三档；管理端 per-POI 控制已改连续系数。 */
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

/** 系数落库/进 manifest 前规整：夹紧到范围内并保留两位小数，避免浮点长尾。 */
export function clampMarkerScale(value: number): number {
  const clamped = Math.min(MARKER_SCALE_MAX, Math.max(MARKER_SCALE_MIN, value));
  return Math.round(clamped * 100) / 100;
}

/**
 * 任意来源的图钉系数 → 范围内数值：接受数值、数值字符串与三档枚举存量值；
 * 缺省 / 非法值一律回落 1（标准），不让脏数据把图钉画飞。
 */
export function markerScaleValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return clampMarkerScale(value);
  if (typeof value === "string") {
    const legacy = LEGACY_MARKER_SCALES[value];
    if (legacy !== undefined) return legacy;
    // Number("") / Number("  ") = 0，空串必须先挡掉，否则脏值会变成 0.5。
    const trimmed = value.trim();
    const parsed = trimmed === "" ? NaN : Number(trimmed);
    if (Number.isFinite(parsed)) return clampMarkerScale(parsed);
  }
  return MARKER_SCALE_DEFAULT;
}

/** 叠加层的尺寸基准单位：较短视轴的 1/52，再乘系数。 */
export function markerUnit(view: { width: number; height: number }, scale = 1): number {
  return (Math.min(view.width, view.height) / MARKER_UNIT_DIVISOR) * scale;
}

/**
 * 管理端在 content.marker.size 里给单个 POI 定的系数。
 * 缺省 / 非法值一律回落 1（标准），不让脏数据把图钉画飞。
 */
export function markerScaleFromContent(content: Record<string, unknown> | null | undefined): number {
  const marker = content?.marker;
  if (!marker || typeof marker !== "object") return MARKER_SCALE_DEFAULT;
  return markerScaleValue((marker as Record<string, unknown>).size);
}
