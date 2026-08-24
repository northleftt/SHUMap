// 返校指南入口条的显示判断与文案。对齐 Web 端 src/lib/guideEntry.ts。
//
// 横幅文案是**内容里的一个字段**（content.meta.banner），由管理端指南编辑器维护。
// 以前没有这个字段，横幅只好借文档标题与版次拼：文档标题是「上海大学」（原稿封面上
// 的单位名），于是地图上挂出一条写着「上海大学 / 2026 版 · 查看到校路线」的横幅。
// 现在标题、副标题、图标都能在后台各自填，没填时按 fallback 兜底。

import { config } from "../config";

export const GUIDE_SLUG = "freshman-transit";
export const GUIDE_DISMISS_KEY = "shumap-guide-banner-dismissed";

/** 后台没填副标题时的兜底：横幅只需要告诉用户「这能点」。 */
export const DEFAULT_BANNER_SUBTITLE = "点击查看";

export interface GuideSummary {
  /** 横幅主标题（banner.title，或由版次派生）。 */
  title: string;
  /** 横幅副标题（banner.subtitle，默认「点击查看」）。 */
  subtitle: string;
  /** 版次原文，如「2026 版 · 电子版」；没有则为 null。 */
  edition: string | null;
  /** 横幅图标的素材键（guide_assets 的 asset_key），后台没传时为 null。 */
  iconAsset: string | null;
  revisionNo: number;
}

function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** content.meta.banner，宽松读取：类型不对就当没配，走 fallback。 */
function readBannerField(payload: Record<string, unknown>, key: string): string | null {
  const banner = payload.banner;
  if (banner && typeof banner === "object") {
    const direct = trimmedString((banner as Record<string, unknown>)[key]);
    if (direct) return direct;
  }
  const content = payload.content;
  if (!content || typeof content !== "object") return null;
  const meta = (content as Record<string, unknown>).meta;
  if (!meta || typeof meta !== "object") return null;
  const nested = (meta as Record<string, unknown>).banner;
  if (!nested || typeof nested !== "object") return null;
  return trimmedString((nested as Record<string, unknown>)[key]);
}

/**
 * 后台没填主标题时的兜底：版次 + 「入校指南」，如「2026 版」→「2026 版入校指南」。
 * 版次里的「· 电子版」这类后缀不进标题。连版次都没有就只写「入校指南」——
 * 不再退回文档标题，那正是「上海大学」的来源。
 */
export function fallbackBannerTitle(edition: string | null): string {
  const head = edition ? trimmedString(edition.split("·")[0]) : null;
  return head ? `${head}入校指南` : "入校指南";
}

export function parseGuideSummary(payload: unknown): GuideSummary | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  if (typeof value.revisionNo !== "number" || !Number.isFinite(value.revisionNo)) return null;
  // title 仍是必填的契约字段（文档标题）：缺失说明这不是一份已发布的指南。
  // 但它不再直接上横幅，横幅标题走 banner.title / 版次派生。
  if (typeof value.title !== "string" || value.title.trim() === "") return null;
  const edition = trimmedString(value.edition);
  return {
    title: readBannerField(value, "title") ?? fallbackBannerTitle(edition),
    subtitle: readBannerField(value, "subtitle") ?? DEFAULT_BANNER_SUBTITLE,
    edition,
    iconAsset: readBannerField(value, "icon"),
    revisionNo: value.revisionNo,
  };
}

export function dismissStamp(revisionNo: number, slug: string = GUIDE_SLUG): string {
  return `${slug}:${revisionNo}`;
}

export function shouldShowGuideBanner(guide: GuideSummary | null, dismissed: string): boolean {
  if (!guide) return false;
  return dismissed !== dismissStamp(guide.revisionNo);
}

/**
 * 素材键 → 可给 <image> 的地址。
 *
 * 与网页端的区别：小程序不能用同源相对路径，必须带 config.apiBaseUrl。
 * 素材是位图（icon_png / figure_png）时能直接画；只有 SVG 的键画不出来，
 * 由页面在 binderror 时隐藏图标（横幅文字照旧）。
 */
export function guideAssetUrl(assetKey: string): string {
  return `${config.apiBaseUrl}/api/public/guide-assets/${encodeURIComponent(assetKey)}`;
}
