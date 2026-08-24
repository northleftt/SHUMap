// 「如何坐车」乘车指南的数据层。对齐 shared/shuttle-guide-contract.ts 的规范化规则
// （tests/shuttle-guide-content.test.mjs 钉住两份行为一致）。
//
// 内容存在 guide_documents 里（slug=shuttle-ride），与返校指南共用一套端点与
// 发布流水线，公共读端是 GET /api/public/guide/shuttle-ride。所以这一份不需要
// 新的迁移、新的表、新的路由 —— 见 shared/shuttle-guide-contract.ts 顶部注释。
//
// 与 lib/guide.ts 的分工：那份是返校指南（hubs × campuses × modes 的矩阵，
// 1200 行视图模型），这份只是一篇图文（一串块），刻意不复用它的任何视图逻辑。

import { apiGet } from "./api";
import { config } from "../config";

/** 文档 slug。公共读端 GET /api/public/guide/shuttle-ride。 */
export const SHUTTLE_GUIDE_SLUG = "shuttle-ride";

export interface HeadingBlock {
  type: "heading";
  text: string;
}

export interface ParagraphBlock {
  type: "paragraph";
  text: string;
}

export interface ListBlock {
  type: "list";
  items: string[];
}

export interface ImageBlock {
  type: "image";
  /** guide_assets 的 asset_key（位图，kind=figure_png）。 */
  asset: string;
  caption: string | null;
}

export type ShuttleGuideBlock = HeadingBlock | ParagraphBlock | ListBlock | ImageBlock;

export interface ShuttleGuideContent {
  schema: 2;
  kind: "article";
  meta: { title: string; subtitle: string };
  blocks: ShuttleGuideBlock[];
  hubs: unknown[];
  cards: unknown[];
}

/** 素材键：与 worker/modules/guide.ts 的 ASSET_KEY_PATTERN 同一条规则。 */
export const ASSET_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 单块规范化。返回 null 表示「这块不要了」：类型不认识，或内容全空。
 *
 * 宽松读取而不是报错：内容是 JSON 存的，手改过的稿子、将来加了新块类型的稿子
 * 都可能带不认识的东西。渲染端宁可少画一块，也不要整页白屏。
 */
export function normalizeBlock(raw: unknown): ShuttleGuideBlock | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  switch (value.type) {
    case "heading": {
      const content = text(value.text);
      return content ? { type: "heading", text: content } : null;
    }
    case "paragraph": {
      const content = text(value.text);
      return content ? { type: "paragraph", text: content } : null;
    }
    case "list": {
      const items = Array.isArray(value.items) ? value.items.map(text).filter(Boolean) : [];
      return items.length > 0 ? { type: "list", items } : null;
    }
    case "image": {
      const asset = text(value.asset);
      if (!ASSET_KEY_PATTERN.test(asset)) return null;
      const caption = text(value.caption);
      return { type: "image", asset, caption: caption || null };
    }
    default:
      return null;
  }
}

export function normalizeBlocks(raw: unknown): ShuttleGuideBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: ShuttleGuideBlock[] = [];
  for (const item of raw) {
    const block = normalizeBlock(item);
    if (block) out.push(block);
  }
  return out;
}

export function normalizeShuttleGuideContent(raw: unknown): ShuttleGuideContent {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const meta = value.meta && typeof value.meta === "object" ? (value.meta as Record<string, unknown>) : {};
  return {
    schema: 2,
    kind: "article",
    meta: { title: text(meta.title), subtitle: text(meta.subtitle) },
    blocks: normalizeBlocks(value.blocks),
    hubs: [],
    cards: [],
  };
}

/**
 * 素材键 → 可给 <image> 的地址。
 *
 * 与 lib/guide.ts 的 guideAssetImage 不同，这里不试 `<key>-png` 派生：
 * 返校指南的图示是 SVG（小程序画不了），编辑器另存一份 `<key>-png` 供小程序用；
 * 乘车指南的图从一开始就以位图入库（kind=figure_png），键本身就能画。
 */
export function shuttleGuideAssetUrl(assetKey: string): string {
  return `${config.apiBaseUrl}/api/public/guide-assets/${encodeURIComponent(assetKey)}`;
}

/* ══════════════ 视图模型 ══════════════ */

/**
 * 一块的渲染视图。WXML 没有 switch，所以把类型判断摊成布尔标志，
 * 模板里 wx:if 直接读 —— 比在模板里写四个 `block.type === '…'` 干净。
 */
export interface ShuttleGuideBlockView {
  /** wx:key 用。内容里没有 id，用序号（列表不会局部重排，序号稳定）。 */
  key: string;
  isHeading: boolean;
  isParagraph: boolean;
  isList: boolean;
  isImage: boolean;
  text: string;
  items: string[];
  src: string;
  caption: string;
}

export function buildBlockViews(content: ShuttleGuideContent): ShuttleGuideBlockView[] {
  return content.blocks.map((block, index) => ({
    key: `b${index}`,
    isHeading: block.type === "heading",
    isParagraph: block.type === "paragraph",
    isList: block.type === "list",
    isImage: block.type === "image",
    text: block.type === "heading" || block.type === "paragraph" ? block.text : "",
    items: block.type === "list" ? block.items : [],
    src: block.type === "image" ? shuttleGuideAssetUrl(block.asset) : "",
    caption: block.type === "image" ? (block.caption ?? "") : "",
  }));
}

/** 页内全部图片地址，供 wx.previewImage 的 urls 用（点一张能左右翻）。 */
export function previewUrls(views: ShuttleGuideBlockView[]): string[] {
  return views.filter((view) => view.isImage && view.src).map((view) => view.src);
}

/* ══════════════ 拉取 ══════════════ */

export interface ShuttleGuidePayload {
  /** 发布记录里的文档标题；页头用它，空则由页面兜底。 */
  title: string;
  /** 版本号。入口按它判断「有没有已发布内容」。 */
  revisionNo: number;
  content: ShuttleGuideContent;
}

/** 响应校验。不合格返回 null —— 宁可当作未发布，也不要渲染半份内容。 */
export function parseShuttleGuidePayload(raw: unknown): ShuttleGuidePayload | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.revisionNo !== "number" || !Number.isFinite(value.revisionNo)) return null;
  return {
    title: text(value.title),
    revisionNo: value.revisionNo,
    content: normalizeShuttleGuideContent(value.content),
  };
}

/**
 * 拉取已发布的乘车指南。
 *
 * 未发布时公共读端返回 404，apiGet 以 statusCode 404 reject —— 那不是错误，
 * 是「没有内容」，调用方据此隐藏入口 / 显示未发布态。
 */
export async function loadShuttleGuide(): Promise<ShuttleGuidePayload> {
  const payload = parseShuttleGuidePayload(
    await apiGet<unknown>(`/api/public/guide/${encodeURIComponent(SHUTTLE_GUIDE_SLUG)}`),
  );
  if (!payload) throw new Error("乘车指南数据格式不正确");
  return payload;
}

/**
 * 入口探测：只回答「有没有可看的内容」。
 *
 * 校车页用它决定要不要显示「如何坐车？」。任何失败（404 未发布、断网、格式不对）
 * 都返回 false —— 入口宁可不出现，也不要点进去看一个空页或报错页。
 * 内容有正文才算可看：发布了一份空文档时入口不该出现。
 */
export async function hasPublishedShuttleGuide(): Promise<boolean> {
  try {
    const payload = await loadShuttleGuide();
    return payload.content.blocks.length > 0;
  } catch {
    return false;
  }
}
