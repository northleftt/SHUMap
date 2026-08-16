// 返校指南页（原生版，Part 5 第一刀：数据层 + 骨架 + route 卡）。
// 数据：GET /api/public/guide/:slug（与地图页横幅同一接口），逻辑全部在
// lib/guide.ts；本页只做状态装配。后续切片：figure/steps 卡渲染（cards 里
// 非 route 项当前只占位跳过）、枢纽级 sceneGuide/remark/视频入口。

import {
  buildCardView,
  buildHubGuideView,
  buildHubVideosView,
  buildSceneGuideView,
  cardCount,
  cardsFor,
  collectGuidePreviewImages,
  hubById,
  loadGuide,
  modesFor,
  normalizeGuideContent,
  parseGuideQuery,
  preprocessRemarkHtml,
  sortedHubs,
  validCampus,
  type FigureCardView,
  type GuideCardView,
  type GuideContent,
  type GuidePayload,
  type HubGuideView,
  type HubVideoEntryView,
  type SceneGuideView,
} from "../../lib/guide";
import type { ApiError } from "../../lib/api";
import {
  collectPreviewableUrls,
  panViewer,
  pinchScale,
  resetViewerTransform,
  toggleViewerScale,
  touchDistance,
  VIEWER_TAP_SLOP_PX,
  viewerNeedsPaper,
  viewerTransformStyle,
  type ViewerPoint,
  type ViewerTransform,
} from "../../lib/image-viewer";

interface HubOption {
  id: string;
  name: string;
  note: string;
  colorStyle: string;
  active: boolean;
}

interface CampusOption {
  id: string;
  label: string;
  countText: string;
  disabled: boolean;
  active: boolean;
}

interface ModeChip {
  mode: string;
  label: string;
  on: boolean;
}

Page({
  data: {
    statusBarHeight: 20,
    /** loading | ready | unpublished | error */
    state: "loading",
    errorMessage: "",
    title: "",
    subtitle: "",
    edition: "",
    footText: "",
    hubOptions: [] as HubOption[],
    campusOptions: [] as CampusOption[],
    showModeBar: false,
    modeChips: [] as ModeChip[],
    cards: [] as GuideCardView[],
    emptyText: "",
    /** 当前枢纽 × 校区的实景指引（sceneGuide）；null = 整块不显示。 */
    sceneGuide: null as SceneGuideView | null,
    /** 枢纽指引图（guideFigures）；null = 有图但都不适用当前方向。 */
    hubGuide: null as HubGuideView | null,
    /** 实况视频入口（guideVideos 按校区过滤后）；渲染在实况指引区块内。 */
    videoEntries: [] as HubVideoEntryView[],
    /** 备注富文本（预处理后的 HTML 字符串，rich-text 渲染）；空串不显示。 */
    remarkHtml: "",
    /** 热点弹层：{ title, body, links }；null = 关闭。 */
    hotspotPop: null as {
      title: string;
      body: string;
      links: Array<{ label: string; href: string; kind: string; cardId: string }>;
    } | null,
    /** scroll-view scroll-into-view 目标（#card: 链接跳转用）。 */
    scrollToCard: "",
    /** 全屏看图：点缩略图打开，再点切换放大/还原，双指捏合。 */
    imageViewer: {
      open: false,
      src: "",
      paper: false,
      style: viewerTransformStyle(resetViewerTransform()),
    },
  },

  /** 规范化后的内容与发布信息（不进 data，避免大对象过 setData）。 */
  content: null as GuideContent | null,
  payload: null as GuidePayload | null,
  hubId: "",
  campusId: "",
  modesOff: {} as Record<string, boolean>,
  pendingQuery: { hub: null as string | null, campus: null as string | null },
  viewerTransform: resetViewerTransform() as ViewerTransform,
  viewerGesture: null as {
    scale: number;
    tx: number;
    ty: number;
    x: number;
    y: number;
    dist: number;
    pinch: boolean;
  } | null,
  viewerMoved: false,

  onLoad(options: Record<string, string | undefined>) {
    const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : { statusBarHeight: 20 };
    this.setData({ statusBarHeight: windowInfo.statusBarHeight ?? 20 });
    this.pendingQuery = parseGuideQuery(options || {});
    this.load();
  },

  goBack() {
    if (this.data.imageViewer.open) {
      this.closeImageViewer();
      return;
    }
    wx.navigateBack();
  },

  async load() {
    this.setData({ state: "loading", errorMessage: "" });
    let payload: GuidePayload;
    try {
      payload = await loadGuide();
    } catch (err) {
      const statusCode = (err as ApiError)?.statusCode;
      if (statusCode === 404) {
        /* 管理端未发布 / 已下线：尊重发布状态（对齐网页版，不兜底种子） */
        this.setData({ state: "unpublished" });
      } else {
        this.setData({ state: "error", errorMessage: "网络异常，请稍后重试" });
      }
      return;
    }
    this.boot(payload);
  },

  boot(payload: GuidePayload) {
    const content = normalizeGuideContent(payload.content);
    const hubs = sortedHubs(content);
    if (!hubs.length) {
      this.setData({ state: "error", errorMessage: "暂无枢纽数据" });
      return;
    }
    this.content = content;
    this.payload = payload;

    /* 深链 ?h=&c=：无效项回落默认（首个枢纽 × 首个有卡校区），同网页版 */
    const { hub, campus } = this.pendingQuery;
    this.hubId = hub && hubs.some((item) => item.id === hub) ? hub : hubs[0].id;
    this.campusId = validCampus(content, this.hubId, campus);
    this.modesOff = {};

    const meta = content.meta || {};
    const footBits: string[] = [];
    if (meta.version) footBits.push(`版本 ${meta.version}`);
    if (meta.revisedAt) footBits.push(`修订于 ${meta.revisedAt}`);
    if (typeof payload.revisionNo === "number") footBits.push(`第 ${payload.revisionNo} 版发布稿`);

    this.setData({
      state: "ready",
      title: payload.title || meta.title || "上海大学",
      subtitle: meta.subtitle || "",
      edition: payload.edition || meta.edition || "",
      footText: footBits.join(" · "),
    });
    this.syncAll();
  },

  /* ── 选择器 ── */

  syncAll() {
    const content = this.content;
    if (!content) return;
    this.setData({
      hubOptions: sortedHubs(content).map((hub) => ({
        id: hub.id,
        name: hub.name,
        note: hub.note || "",
        colorStyle: `background: ${hub.color || "#465060"};`,
        active: hub.id === this.hubId,
      })),
      campusOptions: (content.campuses || []).map((camp) => {
        const count = cardCount(content, this.hubId, camp.id);
        return {
          id: camp.id,
          label: camp.label || camp.id,
          countText: count > 0 ? String(count) : "暂无",
          disabled: count === 0,
          active: camp.id === this.campusId,
        };
      }),
    });
    this.renderCards();
  },

  pickHub(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    const content = this.content;
    if (!content || !id || id === this.hubId) return;
    this.hubId = id;
    if (cardCount(content, id, this.campusId) === 0) {
      this.campusId = validCampus(content, id, null);
    }
    this.modesOff = {};
    if (this.data.imageViewer.open) this.closeImageViewer();
    this.syncAll();
  },

  pickCampus(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    if (!this.content || !id || id === this.campusId) return;
    this.campusId = id;
    this.modesOff = {};
    if (this.data.imageViewer.open) this.closeImageViewer();
    this.syncAll();
  },

  /* ── 出行方式筛选：>1 种方式才显示；全部默认开，可多点切换 ── */

  toggleMode(e: WechatMiniprogram.TouchEvent) {
    const mode = e.currentTarget.dataset.mode as string;
    if (!mode) return;
    if (this.modesOff[mode]) delete this.modesOff[mode];
    else this.modesOff[mode] = true;
    this.renderCards();
  },

  renderCards() {
    const content = this.content;
    if (!content) return;
    const modes = modesFor(content, this.hubId, this.campusId);
    /* 掉出当前组合的方式清掉开关记录，免得状态越积越脏（同网页版） */
    const off: Record<string, boolean> = {};
    modes.forEach((m) => {
      if (this.modesOff[m.mode]) off[m.mode] = true;
    });
    this.modesOff = off;

    const showModeBar = modes.length > 1;
    const filter = showModeBar
      ? new Set(modes.filter((m) => !off[m.mode]).map((m) => m.mode))
      : null;
    const cards = cardsFor(content, this.hubId, this.campusId, filter).map((card) =>
      buildCardView(card, content),
    );

    this.setData({
      showModeBar,
      modeChips: modes.map((m) => ({ mode: m.mode, label: m.label, on: !off[m.mode] })),
      cards,
      emptyText: cards.length === 0 ? "当前筛选下没有卡片，换个出行方式试试。" : "",
      sceneGuide: buildSceneGuideView(hubById(content, this.hubId), this.campusId),
      hubGuide: buildHubGuideView(hubById(content, this.hubId), this.campusId),
      videoEntries: buildHubVideosView(hubById(content, this.hubId), this.campusId),
      remarkHtml: preprocessRemarkHtml(hubById(content, this.hubId)?.remark),
    });
  },

  /* ── figure 图示卡：图片 -png 优先、binderror 回落原键、再失败显示占位 ── */

  onFigureImageError(e: WechatMiniprogram.TouchEvent) {
    const cardId = e.currentTarget.dataset.cardId as string;
    const index = this.data.cards.findIndex((card) => card.id === cardId);
    if (index < 0) return;
    const card = this.data.cards[index] as FigureCardView & { imgFailed?: boolean };
    if (card.kind !== "figure") return;
    if (card.src !== card.fallbackSrc) {
      this.setData({ [`cards[${index}].src`]: card.fallbackSrc });
    } else {
      this.setData({ [`cards[${index}].imgFailed`]: true });
    }
  },

  /** 图片加载成功标记（巡检脚本据此等待，避免截图早于解码完成）。 */
  onFigureImageLoad(e: WechatMiniprogram.TouchEvent) {
    const cardId = e.currentTarget.dataset.cardId as string;
    const index = this.data.cards.findIndex((card) => card.id === cardId);
    if (index < 0) return;
    this.setData({ [`cards[${index}].imgLoaded`]: true });
  },

  /** 实景照片（sceneGuide 小节/步骤配图）同样的 -png → 原键回落。 */
  onSceneImageError(e: WechatMiniprogram.TouchEvent) {
    const ds = e.currentTarget.dataset as { sec: number; step: number; fig: number };
    const sceneGuide = this.data.sceneGuide;
    if (!sceneGuide) return;
    const path =
      ds.step >= 0
        ? `sceneGuide.sections[${ds.sec}].steps[${ds.step}].figures[${ds.fig}]`
        : `sceneGuide.sections[${ds.sec}].figures[${ds.fig}]`;
    const section = sceneGuide.sections[ds.sec];
    if (!section) return;
    const image =
      ds.step >= 0 ? section.steps[ds.step]?.figures[ds.fig] : section.figures[ds.fig];
    if (!image || image.src === image.fallbackSrc) return;
    this.setData({ [`${path}.src`]: image.fallbackSrc });
  },

  /** 枢纽指引图同样的 -png → 原键回落。 */
  onHubGuideImageError(e: WechatMiniprogram.TouchEvent) {
    const fig = e.currentTarget.dataset.fig as number;
    const hubGuide = this.data.hubGuide;
    if (!hubGuide) return;
    const image = hubGuide.figures[fig];
    if (!image || image.src === image.fallbackSrc) return;
    this.setData({ [`hubGuide.figures[${fig}].src`]: image.fallbackSrc });
  },

  /** 视频入口：点「点击查看视频引导」后才挂载 <video>（默认不拉视频流）。 */
  playVideo(e: WechatMiniprogram.TouchEvent) {
    const index = e.currentTarget.dataset.index as number;
    if (this.data.videoEntries[index]?.playing) return;
    this.setData({ [`videoEntries[${index}].playing`]: true });
  },

  /* ── 图片查看器：点开放大、再点还原、双指缩放 ── */

  previewGuideImage(e: WechatMiniprogram.TouchEvent) {
    const requested = String(e.currentTarget.dataset.src || "");
    const urls = collectPreviewableUrls(
      collectGuidePreviewImages({
        cards: this.data.cards,
        hubGuide: this.data.hubGuide,
        sceneGuide: this.data.sceneGuide,
      }),
    );
    const src = urls.includes(requested) ? requested : requested || urls[0] || "";
    if (!src) return;
    this.applyViewerTransform(resetViewerTransform());
    this.viewerGesture = null;
    this.viewerMoved = false;
    this.setData({
      "imageViewer.open": true,
      "imageViewer.src": src,
      "imageViewer.paper": viewerNeedsPaper(src),
    });
  },

  closeImageViewer() {
    this.viewerGesture = null;
    this.viewerMoved = false;
    this.applyViewerTransform(resetViewerTransform());
    this.setData({ "imageViewer.open": false, "imageViewer.src": "", "imageViewer.paper": false });
  },

  applyViewerTransform(transform: ViewerTransform) {
    this.viewerTransform = transform;
    this.setData({ "imageViewer.style": viewerTransformStyle(transform) });
  },

  viewerTouchPoint(touch: WechatMiniprogram.Touch): ViewerPoint {
    return { x: touch.clientX, y: touch.clientY };
  },

  onViewerTouchStart(e: WechatMiniprogram.TouchEvent) {
    const touches = e.touches || [];
    if (!touches.length) return;
    const transform = this.viewerTransform;
    const a = this.viewerTouchPoint(touches[0]);
    const pinch = touches.length >= 2;
    this.viewerMoved = pinch;
    this.viewerGesture = {
      scale: transform.scale,
      tx: transform.tx,
      ty: transform.ty,
      x: a.x,
      y: a.y,
      dist: pinch ? touchDistance(a, this.viewerTouchPoint(touches[1])) : 0,
      pinch,
    };
  },

  onViewerTouchMove(e: WechatMiniprogram.TouchEvent) {
    const gesture = this.viewerGesture;
    const touches = e.touches || [];
    if (!gesture || !touches.length) return;
    if (touches.length >= 2) {
      const dist = touchDistance(this.viewerTouchPoint(touches[0]), this.viewerTouchPoint(touches[1]));
      const startDist = gesture.dist > 0 ? gesture.dist : dist;
      this.viewerMoved = true;
      this.applyViewerTransform({
        scale: pinchScale(gesture.scale, startDist, dist),
        tx: gesture.tx,
        ty: gesture.ty,
      });
      return;
    }
    const point = this.viewerTouchPoint(touches[0]);
    const dx = point.x - gesture.x;
    const dy = point.y - gesture.y;
    if (Math.hypot(dx, dy) > VIEWER_TAP_SLOP_PX) this.viewerMoved = true;
    if (this.viewerTransform.scale > 1.01) {
      this.applyViewerTransform(panViewer({
        scale: this.viewerTransform.scale,
        tx: gesture.tx,
        ty: gesture.ty,
      }, dx, dy));
    }
  },

  onViewerTouchEnd(e: WechatMiniprogram.TouchEvent) {
    const remaining = e.touches || [];
    if (remaining.length >= 1) {
      this.onViewerTouchStart(e);
      return;
    }
    const wasTap = !this.viewerMoved && !this.viewerGesture?.pinch;
    this.viewerGesture = null;
    if (!wasTap) return;
    const next: ViewerTransform = {
      scale: toggleViewerScale(this.viewerTransform.scale),
      tx: 0,
      ty: 0,
    };
    this.applyViewerTransform(next);
  },

  /* ── 热点弹层 ── */

  openHotspot(e: WechatMiniprogram.TouchEvent) {
    const { cardId, hotId } = e.currentTarget.dataset as { cardId: string; hotId: string };
    const card = this.data.cards.find((item) => item.id === cardId) as FigureCardView | undefined;
    const hotspot = card && card.kind === "figure"
      ? card.hotspots.find((item) => item.id === hotId)
      : null;
    if (!hotspot) return;
    this.setData({
      hotspotPop: { title: hotspot.title, body: hotspot.body, links: hotspot.links },
    });
  },

  closeHotspot() {
    this.setData({ hotspotPop: null });
  },

  /** 弹层内容区 catchtap 用，阻断冒泡触发遮罩关闭。 */
  noop() {},

  /** #card: 链接：滚动到对应卡片。 */
  openCardLink(e: WechatMiniprogram.TouchEvent) {
    const cardId = e.currentTarget.dataset.cardId as string;
    if (!cardId) return;
    this.setData({ hotspotPop: null, scrollToCard: `card-${cardId}` });
    setTimeout(() => this.setData({ scrollToCard: "" }), 500);
  },
});
