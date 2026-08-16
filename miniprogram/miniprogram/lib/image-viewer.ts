// 指南图片查看器：缩放/平移纯函数。
// 页面手势走 JS 触摸事件（Skyline 上 worklet:ongesture 不触发，见 AGENTS 坑 #8），
// 这里只算状态，不碰 wx / DOM。

export const VIEWER_MIN_SCALE = 1;
export const VIEWER_MAX_SCALE = 5;
export const VIEWER_TOGGLE_SCALE = 2.5;
export const VIEWER_TAP_SLOP_PX = 8;

export interface ViewerTransform {
  scale: number;
  tx: number;
  ty: number;
}

export interface ViewerPoint {
  x: number;
  y: number;
}

export function clampViewerScale(scale: number): number {
  if (!Number.isFinite(scale)) return VIEWER_MIN_SCALE;
  return Math.min(VIEWER_MAX_SCALE, Math.max(VIEWER_MIN_SCALE, scale));
}

export function resetViewerTransform(): ViewerTransform {
  return { scale: VIEWER_MIN_SCALE, tx: 0, ty: 0 };
}

/** 单击切换：大于 1 收回到原大，否则放到 VIEWER_TOGGLE_SCALE。 */
export function toggleViewerScale(scale: number): number {
  return scale > 1.05 ? VIEWER_MIN_SCALE : VIEWER_TOGGLE_SCALE;
}

export function touchDistance(a: ViewerPoint, b: ViewerPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function pinchScale(startScale: number, startDist: number, currentDist: number): number {
  if (!(startDist > 0) || !(currentDist > 0)) return clampViewerScale(startScale);
  return clampViewerScale(startScale * (currentDist / startDist));
}

/** 仅放大后允许平移；收回 1x 时清偏移，避免缩回去还偏在一边。 */
export function panViewer(transform: ViewerTransform, dx: number, dy: number): ViewerTransform {
  if (transform.scale <= 1.01) return { ...transform, tx: 0, ty: 0 };
  return { ...transform, tx: transform.tx + dx, ty: transform.ty + dy };
}

export function viewerTransformStyle(transform: ViewerTransform): string {
  return `transform: translate(${transform.tx}px, ${transform.ty}px) scale(${transform.scale});`;
}

/**
 * 简图（SVG 或它的透明 PNG 副本）在深色遮罩上会「镂空」。
 * 实景 JPEG/站内 jpg 本身不透明，不必垫白底。
 */
export function viewerNeedsPaper(src: string): boolean {
  const url = String(src || "");
  if (/\.(jpe?g|webp)(\?|#|$)/i.test(url)) return false;
  if (/\.svg(\?|#|$)/i.test(url)) return true;
  if (/\/guide-assets\//i.test(url)) return true;
  return false;
}

/** 当前正在显示的 http(s) 图，去重保序。data: / 空串不进预览。 */
export function collectPreviewableUrls(
  items: Array<{ src?: string; fallbackSrc?: string } | null | undefined>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const url = (item && (item.src || item.fallbackSrc)) || "";
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}
