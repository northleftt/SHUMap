// 返校指南数据层：拉取 + 规范化 + 查询/视图模型纯函数。
// fetch（loadGuide）与纯函数分离，纯函数可在 node 里直接单测。
// 逻辑对齐网页版 public/guide/index.html（sortedHubs/validCampus/modesFor）与
// assets/guide-render.js（normalizeData/renderRouteCard/renderFigureCard/renderStepsBody）。
//
// 视图模型覆盖：route 卡（buildCardView）、figure 图示卡（buildCardView figure 分支）、
// 枢纽级 sceneGuide 实景指引（buildSceneGuideView）、枢纽指引图（buildHubGuideView）、
// 实况视频入口（buildHubVideosView）、备注富文本预处理（preprocessRemarkHtml）。

import { apiGet } from "./api";
import { config } from "../config";
import { GUIDE_SLUG } from "./guide-entry";

/* ══════════════ 类型 ══════════════ */

export interface GuideHub {
  id: string;
  name: string;
  note?: string | null;
  color?: string;
  order?: number;
  remark?: string;
  guideFigure?: string | null;
  guideFigures?: Array<{ src: string; campuses?: string[]; caption?: string }>;
  guideVideo?: { url: string; note?: string } | null;
  guideVideos?: Array<{ url: string; note?: string; poster?: string; campuses?: string[] }>;
  sceneGuide?: {
    intro?: string;
    sections?: GuideSceneSection[];
    pending?: { label?: string; detail?: string } | null;
  } | null;
}

export interface GuideCampus {
  id: string;
  label: string;
  short?: string;
}

/** 图标注册表项：svg 小程序用不了；uri/png 是位图 data URI（png 为编辑器派生，可能缺省）。 */
export interface GuideIcon {
  id: string;
  name?: string;
  group?: string;
  note?: string;
  svg?: string;
  uri?: string;
  png?: string;
  ratio?: number;
}

/** 实景指引小节（steps 卡与 hub.sceneGuide 共用）。 */
export interface GuideSceneSection {
  title?: string;
  accent?: string;
  campuses?: string[];
  bare?: boolean;
  figures?: Array<{ src: string; caption?: string }>;
  steps?: Array<{
    text?: string;
    note?: string;
    figure?: string | string[];
  }>;
}

export interface GuideRouteLegLine {
  kind?: string;
  no?: string;
  color?: string;
  suffix?: string;
  toward?: string;
  note?: string;
  notes?: string[];
  icon?: string;
}

export interface GuideRouteLeg {
  type: "stop" | "ride" | "walk";
  name?: string;
  exit?: string;
  note?: string;
  marker?: "dot" | "hollow" | "transfer";
  rails?: string[];
  mergeTo?: string[];
  lines?: GuideRouteLegLine[];
  meters?: number;
  terminal?: boolean;
}

export interface GuideScheduleEntry {
  label?: string;
  times?: string;
}

export interface GuideRouteCard {
  id: string;
  kind: "route";
  hub: string;
  campus: string;
  origin?: { name?: string; note?: string | null };
  toward?: string;
  mode?: string;
  modeLabel?: string;
  durationMin?: number | null;
  fareYuan?: number | null;
  flags?: string[];
  legs?: GuideRouteLeg[];
  note?: string;
  schedule?: GuideScheduleEntry[];
}

/** figure/steps 等其他 kind 的卡片：本切片不渲染，只保留 hub/campus/kind。 */
export interface GuideOtherCard {
  id: string;
  kind: string;
  hub: string;
  campus: string;
  [key: string]: unknown;
}

export type GuideCard = GuideRouteCard | GuideOtherCard;

export interface GuideContent {
  schema?: number;
  meta?: {
    title?: string;
    subtitle?: string;
    edition?: string;
    version?: string;
    revisedAt?: string;
    revisionNote?: string;
  };
  lineColors?: Record<string, string>;
  campuses?: GuideCampus[];
  hubs?: GuideHub[];
  icons?: GuideIcon[];
  cards?: GuideCard[];
}

export interface GuidePayload {
  slug?: string;
  title?: string;
  edition?: string;
  revisionNo?: number;
  publishedAt?: string;
  content: GuideContent;
}

/* ══════════════ 拉取与校验 ══════════════ */

/** 校验 GET /api/public/guide/:slug 的响应；不合格返回 null（调用方按错误态处理）。 */
export function parseGuidePayload(raw: unknown): GuidePayload | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const content = value.content as GuideContent | undefined;
  if (!content || typeof content !== "object" || !Array.isArray(content.cards)) return null;
  return {
    slug: typeof value.slug === "string" ? value.slug : undefined,
    title: typeof value.title === "string" ? value.title : undefined,
    edition: typeof value.edition === "string" ? value.edition : undefined,
    revisionNo: typeof value.revisionNo === "number" ? value.revisionNo : undefined,
    publishedAt: typeof value.publishedAt === "string" ? value.publishedAt : undefined,
    content,
  };
}

/** 拉取发布稿并校验。404 由 apiGet 以 statusCode 404 reject，页面按「未发布」处理。 */
export async function loadGuide(slug: string = GUIDE_SLUG): Promise<GuidePayload> {
  const payload = parseGuidePayload(
    await apiGet<unknown>(`/api/public/guide/${encodeURIComponent(slug)}`),
  );
  if (!payload) throw new Error("指南数据格式不正确");
  return payload;
}

/* ══════════════ 规范化（对齐网页版 normalizeData 的 liftSceneGuides） ══════════════
 * steps 卡摘进 hub.sceneGuide；没有 steps 卡时原样返回输入。
 * v1（cover/groups）升级逻辑不搬：线上发布稿已是 schema 2，旧修订不会公开发布。 */
export function normalizeGuideContent(raw: GuideContent): GuideContent {
  const cards = raw.cards || [];
  if (!cards.some((c) => c.kind === "steps")) return raw;

  const hubs = (raw.hubs || []).map((hub) => {
    const out: GuideHub = { ...hub };
    out.sceneGuide = out.sceneGuide
      ? (JSON.parse(JSON.stringify(out.sceneGuide)) as GuideHub["sceneGuide"])
      : null;
    return out;
  });

  const keptCards: GuideCard[] = [];
  for (const card of cards) {
    if (card.kind !== "steps") {
      keptCards.push(card);
      continue;
    }
    const hub = hubs.find((item) => item.id === card.hub);
    if (!hub) {
      keptCards.push(card); // 找不到枢纽就不丢数据
      continue;
    }
    if (!hub.sceneGuide) hub.sceneGuide = {};
    const intro = (card as GuideOtherCard).intro;
    if (typeof intro === "string" && intro) {
      hub.sceneGuide.intro = hub.sceneGuide.intro ? `${hub.sceneGuide.intro}\n${intro}` : intro;
    }
    const sections = (card as GuideOtherCard).sections;
    hub.sceneGuide.sections = (hub.sceneGuide.sections || []).concat(
      Array.isArray(sections) ? sections : [],
    );
    const pending = (card as GuideOtherCard).pending;
    if (pending) hub.sceneGuide.pending = pending as { label?: string; detail?: string } | null;
  }

  const campuses = (raw.campuses || []).filter(
    (camp) => camp.id !== "scene" || keptCards.some((c) => c.campus === "scene"),
  );

  return { ...raw, schema: 2, hubs, campuses, cards: keptCards };
}

/* ══════════════ 查询纯函数（对齐网页版 index.html） ══════════════ */

export function sortedHubs(content: GuideContent): GuideHub[] {
  return (content.hubs || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
}

export function hubById(content: GuideContent, id: string): GuideHub | null {
  return (content.hubs || []).find((hub) => hub.id === id) || null;
}

export function campusById(content: GuideContent, id: string): GuideCampus | null {
  return (content.campuses || []).find((camp) => camp.id === id) || null;
}

export function cardCount(content: GuideContent, hubId: string, campusId: string): number {
  return (content.cards || []).filter((c) => c.hub === hubId && c.campus === campusId).length;
}

/** 校区 id 必须在数据里且当前枢纽下有卡，否则回落到第一个有卡校区。 */
export function validCampus(content: GuideContent, hubId: string, campusId: string | null): string {
  if (campusId && campusById(content, campusId) && cardCount(content, hubId, campusId) > 0) {
    return campusId;
  }
  const list = content.campuses || [];
  for (const camp of list) {
    if (cardCount(content, hubId, camp.id) > 0) return camp.id;
  }
  return list.length ? list[0].id : "";
}

export const GUIDE_MODE_LABEL: Record<string, string> = {
  metro: "地铁",
  bus: "公交",
  maglev: "磁浮",
  airport: "市域线",
  rail: "铁路",
  mixed: "联程",
  other: "其他",
};

export interface GuideModeOption {
  mode: string;
  label: string;
}

/** 当前组合的路线卡里真实出现的出行方式（按卡片顺序去重）。 */
export function modesFor(content: GuideContent, hubId: string, campusId: string): GuideModeOption[] {
  const seen = new Set<string>();
  const out: GuideModeOption[] = [];
  for (const card of content.cards || []) {
    if (card.hub !== hubId || card.campus !== campusId || card.kind !== "route") continue;
    const mode = (card as GuideRouteCard).mode;
    if (!mode || seen.has(mode)) continue;
    seen.add(mode);
    out.push({
      mode,
      label: (card as GuideRouteCard).modeLabel || GUIDE_MODE_LABEL[mode] || mode,
    });
  }
  return out;
}

/**
 * 当前组合的卡片（保持数据序）。modeFilter 提供时只筛路线卡的出行方式，
 * 其他 kind（figure 等）不受筛选影响——与网页版 renderPairView 一致。
 */
export function cardsFor(
  content: GuideContent,
  hubId: string,
  campusId: string,
  modeFilter?: ReadonlySet<string> | null,
): GuideCard[] {
  return (content.cards || []).filter((card) => {
    if (card.hub !== hubId || card.campus !== campusId) return false;
    if (modeFilter && card.kind === "route" && !modeFilter.has((card as GuideRouteCard).mode || "")) {
      return false;
    }
    return true;
  });
}

/** 线路色号 → 颜色值；空值回 neutral，未知 key 原样透传（数据里可直接写 #rrggbb）。 */
export function lineColor(key: string | null | undefined, content: GuideContent): string {
  const map = content.lineColors || {};
  if (!key) return map.neutral || "#8f98a3";
  return map[key] || key;
}

/* ══════════════ 图标注册表（对齐网页版 iconById/lineIcon） ══════════════
 * 只用 content.icons（用户上传，随发布稿下发）；网页版还有出厂种子
 * GUIDE_ICON_SEED，小程序拿不到——icons 缺失/为空时线路一律按无图标处理。
 * svg 内联标记小程序渲染不了，src 只取 png（编辑器派生）或 uri（位图 data URI）。 */

export function iconById(content: GuideContent, id: string | null | undefined): GuideIcon | null {
  if (!id) return null;
  return (content.icons || []).find((ic) => ic && ic.id === id) || null;
}

export interface GuideLineIcon {
  src: string;
  ratio: number;
  name: string;
}

/** 交通方式图标：ln.icon 指定优先，缺省按 kind 映射（metro→metro-sh、rail→rail-sh、bus→无）。 */
const KIND_ICON: Record<string, string | null> = { metro: "metro-sh", rail: "rail-sh", bus: null };

export function lineIcon(content: GuideContent, ln: GuideRouteLegLine): GuideLineIcon | null {
  const id = ln.icon || (ln.kind ? KIND_ICON[ln.kind] : null) || null;
  const ic = iconById(content, id);
  if (!ic) return null;
  const src = ic.png || ic.uri;
  if (!src) return null;
  return { src, ratio: ic.ratio || 1, name: ic.name || "" };
}

/* ══════════════ 指南素材图（figure 卡 / 实景照片共用） ══════════════
 * assetKey → <base>/api/public/guide-assets/<key>。SVG 小程序 <image> 加载不了，
 * 约定 PNG 副本键为 <key>-png（主仓库生成）：src 先用 -png，binderror 回落原键，
 * 再失败由页面显示占位。http(s)/data: 引用原样透传（无 -png 派生），
 * "/" 开头的站内路径拼 config.apiBaseUrl（与 apiGet 直连通道同一 base）。 */

export interface GuideAssetImage {
  src: string;
  fallbackSrc: string;
}

export function guideAssetImage(ref: string): GuideAssetImage {
  if (/^(https?:|data:)/i.test(ref)) return { src: ref, fallbackSrc: ref };
  if (ref.startsWith("/")) {
    const url = `${config.apiBaseUrl}${ref}`;
    return { src: url, fallbackSrc: url };
  }
  const base = `${config.apiBaseUrl}/api/public/guide-assets/${encodeURIComponent(ref)}`;
  return { src: `${base}-png`, fallbackSrc: base };
}

/**
 * 当前页可点开大图的素材：figure 卡 + 枢纽简图 + 实景配图。
 * 用页面上正在显示的 src（含 -png 回落后的值），裂图占位不进列表。
 */
export function collectGuidePreviewImages(input: {
  cards?: GuideCardView[];
  hubGuide?: HubGuideView | null;
  sceneGuide?: SceneGuideView | null;
}): GuideAssetImage[] {
  const items: GuideAssetImage[] = [];
  for (const card of input.cards || []) {
    if (card.kind !== "figure") continue;
    const fig = card as FigureCardView & { imgFailed?: boolean };
    if (fig.imgFailed || !fig.src) continue;
    items.push({ src: fig.src, fallbackSrc: fig.fallbackSrc });
  }
  for (const fig of input.hubGuide?.figures || []) items.push(fig);
  for (const section of input.sceneGuide?.sections || []) {
    items.push(...section.figures);
    for (const step of section.steps) items.push(...step.figures);
  }
  return items;
}

/* ══════════════ 深链 ══════════════
 * 页面 query：?h=<hubId>&c=<campusId>（对齐网页版 #h=&c=）。无效项由调用方回落。 */
export function parseGuideQuery(query: Record<string, string | undefined>): {
  hub: string | null;
  campus: string | null;
} {
  return {
    hub: query.h || null,
    campus: query.c || null,
  };
}

/* ══════════════ 路线卡视图模型（WXML 只负责铺，样式值全部在这里算好） ══════════════ */

/* 时间轴轨道几何：与网页版 RAIL 一致（第一条轨道 x=14，多条并行每条右移 7px）。 */
const RAIL_X0 = 14;
const RAIL_GAP = 7;

export interface RailBarView {
  /** 内联样式：left + background。 */
  style: string;
}

export interface RideLineIconView {
  src: string;
  /** 宽度（rpx）：高度固定 LINE_ICON_H rpx，宽按图标 ratio 推算。 */
  width: number;
}

export interface RideLineView {
  isBus: boolean;
  /** 非公交：线路号徽标底色（inline style）；公交走 .busline 类不用底色。 */
  noStyle: string;
  no: string;
  suffix: string;
  toward: string;
  note: string;
  extraNotes: string[];
  /** 交通方式图标（位图）；无图标（icons 缺失或只有 svg）为 null。 */
  icon: RideLineIconView | null;
}

/** 时间线线路图标高度（rpx，≈15px）。 */
export const LINE_ICON_H = 30;

export interface RouteLegView {
  type: string;
  terminal: boolean;
  /** 上半段轨道（stop 用，颜色接上一段）。 */
  topRails: RailBarView[];
  /** 下半段轨道（stop 用，颜色接本段）。 */
  bottomRails: RailBarView[];
  /** 整段轨道（ride/walk 用）。 */
  fullRails: RailBarView[];
  /** 站点圆点类名：dot / dot dot-hollow / cx（换乘）；ride/walk 为空串。 */
  dotClass: string;
  dotLeft: number;
  /** stop 正文。 */
  stopName: string;
  stopExit: string;
  stopNote: string;
  /** walk 正文（如「步行45米」）。 */
  walkText: string;
  /** ride 正文：线路行。 */
  rideLines: RideLineView[];
}

export interface ScheduleRowView {
  label: string;
  times: string[];
}

export interface RouteCardView {
  kind: "route";
  id: string;
  originName: string;
  originNote: string;
  toward: string;
  modeBadgeText: string;
  /** mode-badge + mode-<kind>，WXSS 里按类上色（WXSS 不支持按 data 属性选色）。 */
  modeBadgeClass: string;
  durationText: string;
  fareText: string;
  flags: string[];
  legs: RouteLegView[];
  note: string;
  schedule: ScheduleRowView[];
}

/** figure 卡数据结构（图示 + 热区）。 */
export interface GuideFigureCard {
  id: string;
  kind: "figure";
  hub: string;
  campus: string;
  figure?: string;
  title?: string;
  caption?: string;
  hotspots?: Array<{
    id: string;
    x: number;
    y: number;
    w?: number;
    h?: number;
    title?: string;
    body?: string;
    links?: Array<{ label?: string; href?: string }>;
  }>;
}

/** 非 route/figure 卡的占位视图。 */
export interface OtherCardView {
  kind: string;
  id: string;
}

export type GuideCardView = RouteCardView | FigureCardView | OtherCardView;

/* ══════════════ figure 图示卡视图模型 ══════════════
 * 热区坐标对齐网页版：x/y 已是百分比直接写 left/top；w/h 是在「卡片正文宽
 * 728px」（HOT_REF）下量的 px，渲染时换算百分比随图等比缩放。 */

const HOT_REF = 728;

export type FigureLinkKind = "card" | "external" | "shumap" | "wechat" | "other";

export interface FigureHotspotLinkView {
  label: string;
  href: string;
  kind: FigureLinkKind;
  /** kind === "card" 时的目标卡片 id。 */
  cardId: string;
}

export interface FigureHotspotView {
  id: string;
  title: string;
  body: string;
  /** 内联样式：left/top/width/height（百分比）。 */
  style: string;
  links: FigureHotspotLinkView[];
}

export interface FigureCardView {
  kind: "figure";
  id: string;
  title: string;
  caption: string;
  /** 图片 src（-png 派生优先）；binderror 时页面换 fallbackSrc，再失败显示占位。 */
  src: string;
  fallbackSrc: string;
  hotspots: FigureHotspotView[];
}

function figureLinkView(link: { label?: string; href?: string }): FigureHotspotLinkView {
  const href = link.href || "";
  let kind: FigureLinkKind = "other";
  let cardId = "";
  if (href.startsWith("#card:")) {
    kind = "card";
    cardId = href.slice("#card:".length);
  } else if (href.startsWith("#shumap:")) kind = "shumap";
  else if (href.startsWith("#wechat:")) kind = "wechat";
  else if (/^https?:/i.test(href)) kind = "external";
  return { label: link.label || "", href, kind, cardId };
}

function buildFigureCardView(card: GuideFigureCard): FigureCardView {
  const image = guideAssetImage(card.figure || "");
  return {
    kind: "figure",
    id: card.id,
    title: card.title || "图示",
    caption: card.caption || "",
    src: image.src,
    fallbackSrc: image.fallbackSrc,
    hotspots: (card.hotspots || []).map((hs) => ({
      id: hs.id,
      title: hs.title || "",
      body: hs.body || "",
      style:
        `left: ${hs.x}%; top: ${hs.y}%;` +
        `width: ${(((hs.w || 44) / HOT_REF) * 100).toFixed(3)}%;` +
        `height: ${(((hs.h || 44) / HOT_REF) * 100).toFixed(3)}%;`,
      links: (hs.links || []).map(figureLinkView),
    })),
  };
}

/* ══════════════ 枢纽级 sceneGuide（实景指引）视图模型 ══════════════
 * 对齐网页版 renderStepsBody + renderHubVideo 的场景部分：
 * intro + 小节（按校区过滤）+ pending；某一步有图时整个小节切双列网格。 */

/** 校区适用性：不声明 campuses（或空数组）= 通用。 */
export function appliesToCampus(item: { campuses?: string[] }, campusId: string): boolean {
  const cs = item && item.campuses;
  return !cs || !cs.length || cs.indexOf(campusId) !== -1;
}

export interface SceneFigureView extends GuideAssetImage {
  caption: string;
}

export interface SceneStepView {
  text: string;
  note: string;
  figures: GuideAssetImage[];
}

export interface SceneSectionView {
  title: string;
  /** 小节色点（inline background 用原始色值）；空串 = 不渲染色点。 */
  accent: string;
  /** 显示步骤序号：bare 且无图时不显示（对齐网页版 ol/div 切换）。 */
  numbered: boolean;
  /** 有步骤配图 → 双列网格（对齐原稿实景指引版式）。 */
  grid: boolean;
  figures: SceneFigureView[];
  steps: SceneStepView[];
}

export interface SceneGuideView {
  intro: string;
  sections: SceneSectionView[];
  pending: { label: string; detail: string } | null;
  /** 枢纽什么实景内容都没有时的占位文案；有内容（或内容不适用当前方向）为空串。 */
  placeholder: string;
}

/**
 * 当前枢纽 × 校区的实景指引视图。
 * 返回 null = 有内容但都不适用这个方向（整块不显示，对齐 renderHubVideo）。
 */
export function buildSceneGuideView(
  hub: GuideHub | null | undefined,
  campusId: string,
): SceneGuideView | null {
  const sg = hub && hub.sceneGuide;
  const hasAnyScene = !!(sg && ((sg.sections && sg.sections.length) || sg.intro || sg.pending));
  const sections = (sg?.sections || []).filter((sec) => appliesToCampus(sec, campusId));
  const hasScene = !!(sg && (sections.length || sg.intro || sg.pending));
  if (!hasScene) {
    if (hasAnyScene) return null;
    return { intro: "", sections: [], pending: null, placeholder: "实况指引待补充" };
  }
  return {
    intro: sg!.intro || "",
    sections: sections.map((sec) => {
      const steps: SceneStepView[] = (sec.steps || []).map((st) => ({
        text: st.text || "",
        note: st.note || "",
        figures: st.figure
          ? (Array.isArray(st.figure) ? st.figure : [st.figure]).map(guideAssetImage)
          : [],
      }));
      const grid = steps.some((st) => st.figures.length > 0);
      return {
        title: sec.title || "",
        accent: sec.accent || "",
        numbered: !sec.bare || grid,
        grid,
        figures: (sec.figures || []).map((f) => ({
          ...guideAssetImage(f.src),
          caption: f.caption || "",
        })),
        steps,
      };
    }),
    pending:
      sg!.pending && sg!.pending.label
        ? { label: sg!.pending.label || "", detail: sg!.pending.detail || "" }
        : null,
    placeholder: "",
  };
}

/* ══════════════ 枢纽指引图（guideFigures）视图模型 ══════════════
 * 对齐网页版 renderHubGuide + hubFigures：数组优先，旧单图字段 guideFigure
 * 在数组缺失/全空时兜底；按 campuses 过滤后一张都不适用 → null（整块不显示）；
 * 枢纽一张图都没有 → 占位（对齐网页版「枢纽指引图待上传」）。 */

export function hubFigures(
  hub: GuideHub | null | undefined,
): Array<{ src: string; campuses?: string[]; caption?: string }> {
  if (!hub) return [];
  if (Array.isArray(hub.guideFigures)) {
    const ok = hub.guideFigures.filter((f) => f && f.src);
    if (ok.length) return ok;
  }
  if (hub.guideFigure) return [{ src: hub.guideFigure }];
  return [];
}

export interface HubGuideFigureView extends GuideAssetImage {
  caption: string;
}

export interface HubGuideView {
  figures: HubGuideFigureView[];
  /** 枢纽一张图都没有时的占位文案；有图为空串。 */
  placeholder: string;
}

export function buildHubGuideView(
  hub: GuideHub | null | undefined,
  campusId: string,
): HubGuideView | null {
  const all = hubFigures(hub);
  if (!all.length) return { figures: [], placeholder: "枢纽指引图待上传" };
  const shown = all.filter((f) => appliesToCampus(f, campusId));
  if (!shown.length) return null;
  return {
    figures: shown.map((f) => ({ ...guideAssetImage(f.src), caption: f.caption || "" })),
    placeholder: "",
  };
}

/* ══════════════ 实况视频（guideVideos）视图模型 ══════════════
 * 对齐网页版 hubVideos + renderHubVideo 的视频部分：数组优先，旧单条字段
 * guideVideo 兜底；campuses 过滤后没有可播条目 → 空数组（页面不出入口）。 */

export function hubVideos(
  hub: GuideHub | null | undefined,
): Array<{ url: string; note?: string; poster?: string; campuses?: string[] }> {
  if (!hub) return [];
  if (Array.isArray(hub.guideVideos)) {
    const ok = hub.guideVideos.filter((v) => v && v.url);
    if (ok.length) return ok;
  }
  if (hub.guideVideo && hub.guideVideo.url) return [hub.guideVideo];
  return [];
}

export interface HubVideoEntryView {
  url: string;
  note: string;
  poster: string;
  /** 点入口后置 true，页面据此渲染 <video>（默认不加载视频流）。 */
  playing: boolean;
}

export function buildHubVideosView(
  hub: GuideHub | null | undefined,
  campusId: string,
): HubVideoEntryView[] {
  return hubVideos(hub)
    .filter((v) => appliesToCampus(v, campusId))
    .map((v) => ({ url: v.url, note: v.note || "", poster: v.poster || "", playing: false }));
}

/* ══════════════ 备注（remark 富文本）预处理 ══════════════
 * hub.remark 是上游已白名单消毒的 HTML；这里做小程序 rich-text 适配：
 * ① img src 的站内相对路径（/api/public/guide-assets/…）拼 config.apiBaseUrl
 *    （与 apiGet 直连通道同一 base）；
 * ② <a> 在 rich-text 里不可点——剥壳保留文字。
 * 空串/全空白返回 ""（页面不显示整块）。 */

export function preprocessRemarkHtml(html: string | null | undefined): string {
  let out = String(html || "");
  if (!out.trim()) return "";
  out = out.replace(
    /(<img\b[^>]*?\bsrc=)(["'])(\/api\/public\/guide-assets\/[^"']*)\2/gi,
    `$1$2${config.apiBaseUrl}$3$2`,
  );
  out = out.replace(/<\/?a\b[^>]*>/gi, "");
  return out.trim();
}

function railBars(rails: string[], content: GuideContent): RailBarView[] {
  return rails.map((key, i) => ({
    style: `left: ${RAIL_X0 + i * RAIL_GAP}px; background: ${lineColor(key, content)};`,
  }));
}

function railsBelow(leg: GuideRouteLeg | null | undefined): string[] {
  return (leg && (leg.mergeTo || leg.rails)) || [];
}

function buildLegViews(card: GuideRouteCard, content: GuideContent): RouteLegView[] {
  const legs = card.legs || [];
  return legs.map((leg, i) => {
    const prev = i > 0 ? legs[i - 1] : null;
    const isJoint = leg.type !== "stop";
    const top = prev ? railsBelow(prev) : [];
    const bottom = railsBelow(leg);

    let dotClass = "";
    let dotLeft = RAIL_X0;
    if (!isJoint) {
      const span = top.length >= bottom.length ? top : bottom;
      if (span.length > 1) {
        dotLeft = (RAIL_X0 + RAIL_X0 + (span.length - 1) * RAIL_GAP) / 2;
      }
      dotClass = leg.marker === "transfer" ? "cx" : leg.marker === "hollow" ? "dot dot-hollow" : "dot";
    }

    const rideLines: RideLineView[] = (leg.lines || []).map((ln) => {
      const icon = lineIcon(content, ln);
      return {
        isBus: ln.kind === "bus",
        noStyle: ln.kind === "bus" ? "" : `background: ${lineColor(ln.color || null, content)};`,
        no: ln.no || "",
        suffix: ln.suffix || "",
        toward: ln.toward || "",
        note: ln.note || "",
        extraNotes: ln.notes || [],
        icon: icon ? { src: icon.src, width: Math.round(LINE_ICON_H * icon.ratio) } : null,
      };
    });

    return {
      type: leg.type,
      terminal: !!leg.terminal,
      topRails: isJoint ? [] : railBars(top, content),
      bottomRails: isJoint ? [] : railBars(bottom, content),
      fullRails: isJoint ? railBars(bottom, content) : [],
      dotClass,
      dotLeft,
      stopName: leg.type === "stop" ? leg.name || "" : "",
      stopExit: leg.type === "stop" ? leg.exit || "" : "",
      stopNote: leg.type === "stop" ? leg.note || "" : "",
      walkText: leg.type === "walk" ? `步行${leg.meters ?? 0}米` : "",
      rideLines,
    };
  });
}

const MODE_BADGE_CLASS: Record<string, string> = {
  metro: "mode-metro",
  bus: "mode-bus",
  rail: "mode-rail",
  maglev: "mode-maglev",
  airport: "mode-airport",
  mixed: "mode-mixed",
  other: "mode-other",
};

/** 卡片 → 视图模型；route/figure 完整构建，其他 kind 返回占位（页面跳过渲染）。 */
export function buildCardView(card: GuideCard, content: GuideContent): GuideCardView {
  if (card.kind === "figure") return buildFigureCardView(card as GuideFigureCard);
  if (card.kind !== "route") return { kind: card.kind, id: card.id };
  const route = card as GuideRouteCard;
  const mode = route.mode || "other";
  return {
    kind: "route",
    id: route.id,
    originName: route.origin?.name || "",
    originNote: route.origin?.note || "",
    toward: route.toward || "",
    modeBadgeText: route.modeLabel || GUIDE_MODE_LABEL[mode] || mode,
    modeBadgeClass: `mode-badge ${MODE_BADGE_CLASS[mode] || "mode-other"}`,
    durationText:
      route.durationMin !== null && route.durationMin !== undefined
        ? `约 ${route.durationMin} 分钟`
        : "",
    fareText:
      route.fareYuan !== null && route.fareYuan !== undefined ? `${route.fareYuan} 元` : "",
    flags: route.flags || [],
    legs: buildLegViews(route, content),
    note: (route.note || "").trim(),
    schedule: (route.schedule || []).map((entry) => ({
      label: entry.label || "",
      times: String(entry.times || "").split("\n").filter((line) => line !== ""),
    })),
  };
}
