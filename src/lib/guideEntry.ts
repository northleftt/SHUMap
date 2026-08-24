/*
 * guideEntry.ts — 返校指南入口条的显示判断与文案。
 *
 * 与组件分开放：这几条判断错得起，得能单测，而组件本体是 DOM + fetch，
 * 在 node --test 里跑不动。抽出来后 GuideBanner.tsx 只负责取数与渲染。
 *
 *   1. 「有没有已发布的指南」判断错 → 开学了地图上没有入口，或内容下线了入口还在；
 *   2. 「用户关过哪一版」判断错 → 关不掉（刷新又冒出来），或出了新版再也不提醒；
 *   3. 文案取错 → 横幅上写着与指南无关的字（下面这段的由来）。
 *
 * 横幅文案是**内容里的一个字段**（content.meta.banner），由管理端指南编辑器维护。
 * 以前没有这个字段，横幅只好借文档标题与版次拼：文档标题是「上海大学」（原稿封面
 * 上的单位名），于是地图上挂出一条写着「上海大学 / 2026 版 · 查看到校路线」的横幅
 * —— 主标题没有信息量，副标题又把版次混进了动作提示。现在标题、副标题、图标都能
 * 在后台各自填，没填时按下面的 fallback 兜底。
 */

export const GUIDE_SLUG = "freshman-transit";
export const GUIDE_URL = "/guide/";
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
  /**
   * 横幅图标的素材键（guide_assets 的 asset_key），后台没传图标时为 null。
   * 这里只给键，URL 由各端自己拼——网页端同源相对路径，小程序端要带 API base。
   */
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
  // 老版本服务端不带顶层 banner，横幅字段还在整份内容里（content.meta.banner）。
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
 * 版次里的「· 电子版」这类后缀不进标题（拼出来是「2026 版 · 电子版入校指南」）。
 * 连版次都没有就只写「入校指南」——不再退回文档标题，那正是「上海大学」的来源。
 */
export function fallbackBannerTitle(edition: string | null): string {
  const head = edition ? trimmedString(edition.split("·")[0]) : null;
  return head ? `${head}入校指南` : "入校指南";
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
  // title 仍是必填的契约字段（文档标题）：它缺失说明这个响应不是一份已发布的指南。
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

/** 素材键 → 公共读地址（网页端同源，直接用相对路径）。 */
export function guideAssetUrl(assetKey: string): string {
  return `/api/public/guide-assets/${encodeURIComponent(assetKey)}`;
}
