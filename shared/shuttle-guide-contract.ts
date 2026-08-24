/*
 * shuttle-guide-contract.ts — 「如何坐车」乘车指南的内容契约。
 *
 * 为什么复用 guide_documents 而不是新开一张表：这份内容需要的全部能力
 * （草稿 / 送审 / 发布 / 回滚 / 图片素材落 R2 / 公共读端带 ETag）
 * guide 模块已经有了，且它按 slug 区分文档 —— 返校指南是 freshman-transit，
 * 乘车指南是 shuttle-ride，两份互不干扰。所以本次改动**零迁移、零新端点**。
 *
 * 代价是要满足 guide 模块的 assertContentShape：content.cards 与 content.hubs
 * 必须是数组。乘车指南没有枢纽也没有卡片，两个都留空数组即可 —— 见 emptyContent()。
 *
 * 内容形状故意做得比返校指南薄得多：那份是 hubs × campuses × modes 的矩阵，
 * 这份只是一篇图文，所以就是一串块（小标题 / 段落 / 要点 / 图）。
 * 需要加块类型时在 BLOCK_TYPES 与 normalizeBlock 各加一处即可。
 */

/** 文档 slug。公共读端 GET /api/public/guide/shuttle-ride。 */
export const SHUTTLE_GUIDE_SLUG = "shuttle-ride";

/** 新建文档时的默认标题（管理端可改）。 */
export const SHUTTLE_GUIDE_DEFAULT_TITLE = "校车乘坐指南";

export const BLOCK_TYPES = ["heading", "paragraph", "list", "image"] as const;

export type ShuttleGuideBlockType = (typeof BLOCK_TYPES)[number];

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
  /** 图注；没有则为 null。 */
  caption: string | null;
}

export type ShuttleGuideBlock = HeadingBlock | ParagraphBlock | ListBlock | ImageBlock;

export interface ShuttleGuideContent {
  schema: 2;
  kind: "article";
  meta: { title: string; subtitle: string };
  blocks: ShuttleGuideBlock[];
  /** guide 模块的 assertContentShape 要求这两个是数组；乘车指南不用它们。 */
  hubs: unknown[];
  cards: unknown[];
}

/** 素材键：与 worker/modules/guide.ts 的 ASSET_KEY_PATTERN 同一条规则。 */
export const ASSET_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/** 新素材键。带 slug 前缀便于在素材列表里一眼分辨归属，尾部 base36 时间戳保证唯一。 */
export function newAssetKey(): string {
  const stamp = Date.now().toString(36);
  const salt = Math.floor(Math.random() * 36 ** 3).toString(36).padStart(3, "0");
  return `${SHUTTLE_GUIDE_SLUG}-${stamp}${salt}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 单块规范化。返回 null 表示「这块不要了」：类型不认识，或内容全空。
 *
 * 宽松读取而不是报错：内容是 JSON 存的，手改过的稿子、老版本的稿子都可能带
 * 不认识的字段。渲染端宁可少画一块，也不要整页白屏。
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

/** 从 content_json（或公共读端的 content 字段）读出规范化内容。 */
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

/** 空内容。新建文档时用它占位（满足 assertContentShape）。 */
export function emptyContent(): ShuttleGuideContent {
  return { schema: 2, kind: "article", meta: { title: "", subtitle: "" }, blocks: [], hubs: [], cards: [] };
}

/** 内容里引用到的素材键（去重）。管理端据此判断哪些素材还在用。 */
export function referencedAssets(content: ShuttleGuideContent): string[] {
  const keys = new Set<string>();
  for (const block of content.blocks) {
    if (block.type === "image") keys.add(block.asset);
  }
  return [...keys];
}
