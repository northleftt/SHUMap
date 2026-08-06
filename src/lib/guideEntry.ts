/*
 * guideEntry.ts — 返校指南入口条的显示判断。
 *
 * 与组件分开放：这两条判断错得起，得能单测，而组件本体是 DOM + fetch，
 * 在 node --test 里跑不动。抽出来后 GuideBanner.tsx 只负责取数与渲染。
 *
 *   1. 「有没有已发布的指南」判断错 → 开学了地图上没有入口，或内容下线了入口还在；
 *   2. 「用户关过哪一版」判断错 → 关不掉（刷新又冒出来），或出了新版再也不提醒。
 */

export const GUIDE_SLUG = "freshman-transit";
export const GUIDE_URL = "/guide/";
export const GUIDE_DISMISS_KEY = "shumap-guide-banner-dismissed";

export interface GuideSummary {
  title: string;
  edition: string | null;
  revisionNo: number;
}

/**
 * 从 GET /api/public/guide/:slug 的响应里解析摘要。
 * 未发布时接口返回 404，调用方会传 null 进来 —— 那不是错误，是「没有入口」。
 * 字段缺失或类型不对同样返回 null：宁可不显示入口，也不要显示一条空白的横幅。
 */
export function parseGuideSummary(payload: unknown): GuideSummary | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  if (typeof value.revisionNo !== "number" || !Number.isFinite(value.revisionNo)) return null;
  if (typeof value.title !== "string" || value.title.trim() === "") return null;
  return {
    title: value.title,
    edition: typeof value.edition === "string" && value.edition !== "" ? value.edition : null,
    revisionNo: value.revisionNo,
  };
}

/**
 * 关闭记录的标记。按发布版本号记而不是记一个布尔值：
 * 出新版时标记不再匹配，入口会重新出现一次 —— 内容更新了值得再提醒一遍，
 * 但同一版关掉后不会反复烦人。
 */
export function dismissStamp(revisionNo: number, slug: string = GUIDE_SLUG): string {
  return `${slug}:${revisionNo}`;
}

/** 是否显示入口。没有已发布内容、或用户关过当前这一版，都不显示。 */
export function shouldShowGuideBanner(guide: GuideSummary | null, dismissed: string): boolean {
  if (!guide) return false;
  return dismissed !== dismissStamp(guide.revisionNo);
}

/** 副标题：有版次就带上，没有就只说去处。 */
export function guideSubtitle(guide: GuideSummary): string {
  return guide.edition ? `${guide.edition} · 查看到校路线` : "查看到校路线";
}
