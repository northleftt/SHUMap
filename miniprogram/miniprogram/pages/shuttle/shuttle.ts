// M3 校车时刻表。对标 Web 端 src/pages/shuttle/ShuttlePage.tsx：
// 校区 OD 选择、最近一班倒计时、时刻网格、班次预览（M7）、预约入口。
// 数据双通道：campus-lines 实时接口优先，断网降级到包内快照（lib/transit/schedule.ts）。

import {
  BUCKET_LABELS,
  buildLinePreview,
  fetchCampusLinesWithFallback,
  flattenLineJourneys,
  formatDate,
  getCurrentDateBucket,
  getRemainingJourneys,
  isReservationLine,
  isSameDay,
  linesAlightingStops,
  linesBoardingStops,
  loadTransitEndpoints,
  mergeSchedulesByTime,
  parseTime,
  toDateKey,
  SNAPSHOT_VERSION,
  type FlatLineJourney,
  type ScheduleSource,
  type TransitEndpoint,
} from "../../lib/transit/schedule";
import type { CampusJourney, CampusLine, TransitStop } from "../../lib/transit/types";
import { enableShareMenus, shareQuery, sharePath, shareTitle } from "../../lib/share";

// Web 端是 http://vcard.shu.edu.cn/...，web-view 只接受 https，这里用 https（同路径 200 可达）。
const BOOKING_SITE_URL = "https://vcard.shu.edu.cn/shu-wechat-client/schoolbus/passenger/jumpToOrder";

/** 倒计时文案：「5分钟后」/「1小时后」等，departure 已过返回 null。 */
function countdownLabel(departureTime: string, now: Date): string | null {
  const departureMinutes = parseTime(departureTime);
  const nowMinutes = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const delta = Math.ceil(departureMinutes - nowMinutes);
  if (delta <= 0) return null;
  if (delta < 60) return `${delta}分钟后`;
  // 超过 1 小时只报小时数，避免 hero 卡文案过长换行
  return `${Math.floor(delta / 60)}小时后`;
}

interface HeroCard {
  label: string;
  time: string;
  countdown: string;
  disabled: boolean;
  tone: "reservation" | "nonReservation";
}

interface SpotRowStop {
  stopId: string;
  name: string;
  canMap: boolean;
}

interface SpotRow {
  label: string;
  stops: SpotRowStop[];
  showBorder: boolean;
}

Page({
  data: {
    // 自定义导航（Skyline 要求 navigationStyle: custom）下的状态栏占位
    statusBarHeight: 20,

    // 端点与选择状态
    endpointsReady: false,
    endpointNames: [] as string[],
    fromIndex: 0,
    toIndex: 1,
    dateKey: "",
    dateLabel: "",
    dateSub: "",

    // 班次展示
    loading: true,
    errorMessage: "",
    emptyTitle: "",
    emptySubtitle: "",
    isEmpty: false,
    todayFlag: true,
    nextReservation: null as HeroCard | null,
    nextNonReservation: null as HeroCard | null,
    otherBuses: [] as Array<{ departureTime: string; status: string }>,
    spotRows: [] as SpotRow[],
    offlineTip: "",

    // 班次预览弹层
    previewVisible: false,
    previewTime: "",
    previewMeta: "",
    previewOffline: false,
    previewBoarding: null as { stopId: string; name: string; timeText: string; canNavigate: boolean } | null,
    previewAlighting: [] as Array<{ stopId: string; name: string; roleText: string; timeText: string; canNavigate: boolean }>,
    previewIsReservation: false,
  },

  // 页面内状态（不进 data，避免 setData 开销）
  endpoints: [] as TransitEndpoint[],
  stops: [] as TransitStop[],
  source: "api" as ScheduleSource,
  lines: [] as CampusLine[],
  previewLine: null as CampusLine | null,
  previewJourney: null as CampusJourney | null,
  _timer: 0,
  /** 转发深链带进来的 OD（端点 id），endpoints 到位后由 applyPendingRoute 消费。 */
  pendingRoute: null as { from: string; to: string } | null,

  onLoad(options: Record<string, string | undefined>) {
    enableShareMenus();
    const now = new Date();
    const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : { statusBarHeight: 20 };
    // 转发卡片深链 ?f=&t=：只认端点 id，日期一律回落「今天」——分享出去的卡片
    // 隔天点开时带旧日期会更奇怪（校车关心的是「现在还有没有车」）。
    const from = options?.f ? decodeURIComponent(options.f) : "";
    const to = options?.t ? decodeURIComponent(options.t) : "";
    this.pendingRoute = from && to ? { from, to } : null;
    this.setData({ dateKey: toDateKey(now), statusBarHeight: windowInfo.statusBarHeight ?? 20 });
    this.updateDateLabel(now);
    this.initEndpoints();
    // now 每 30s 跳动，驱动倒计时与「已过班次」剔除（对齐 Web 端 useNow(30s)）
    this._timer = setInterval(() => this.refreshDisplay(), 30_000) as unknown as number;
  },

  /** 自定义 tabBar：回显本 tab 的选中态（app.json tabBar.custom=true）。 */
  onShow() {
    const tabBar = this.getTabBar?.();
    if (tabBar) tabBar.setData({ selected: 1 });
  },

  /** 转发：标题带当前 OD（「宝山 → 延长 校车时刻」），路径带端点 id 还原选择。 */
  onShareAppMessage() {
    return {
      title: shareTitle(this.routeShareSubject(), "校车时刻"),
      path: sharePath("/pages/shuttle/shuttle", this.routeShareParams()),
    };
  },

  /** 分享到朋友圈：本页不依赖 tabBar / web-view，单页模式下可正常看时刻表。 */
  onShareTimeline() {
    return {
      title: shareTitle(this.routeShareSubject(), "校车时刻"),
      query: shareQuery(this.routeShareParams()),
    };
  },

  /** 卡片标题主题：「宝山 → 延长」；端点没就绪时返回空串走 App 名兜底。 */
  routeShareSubject(): string {
    const from = this.getFromEndpoint();
    const to = this.getToEndpoint();
    return from && to ? `${from.name} → ${to.name}` : "";
  },

  routeShareParams(): Record<string, string> {
    const from = this.getFromEndpoint();
    const to = this.getToEndpoint();
    return from && to ? { f: from.id, t: to.id } : {};
  },

  /** 深链 OD 回填：id 匹配不上（站点下线/改名）就沿用默认选择。 */
  applyPendingRoute() {
    const pending = this.pendingRoute;
    this.pendingRoute = null;
    if (!pending) return;
    const fromIndex = this.endpoints.findIndex((endpoint) => endpoint.id === pending.from);
    const toIndex = this.endpoints.findIndex((endpoint) => endpoint.id === pending.to);
    if (fromIndex < 0 || toIndex < 0) return;
    this.setData({ fromIndex, toIndex });
  },

  onUnload() {
    clearInterval(this._timer);
  },

  /** 端点列表：release manifest 优先，失败退化到快照端点。 */
  async initEndpoints() {
    try {
      const { endpoints, stops, source } = await loadTransitEndpoints();
      this.endpoints = endpoints;
      this.stops = stops;
      this.source = source;
      this.setData({
        endpointsReady: true,
        endpointNames: endpoints.map((endpoint) => endpoint.name),
        offlineTip: source === "snapshot" ? this.snapshotTip() : "",
      });
    } catch {
      this.setData({ endpointsReady: true, endpointNames: [], errorMessage: "站点数据加载失败", loading: false });
      return;
    }
    // 转发深链的 OD 要在首次 reloadLines 之前回填，否则会先按默认 OD 请求一次。
    this.applyPendingRoute();
    this.reloadLines();
  },

  snapshotTip(): string {
    return `当前为离线快照数据（${SNAPSHOT_VERSION}），班次以实际为准`;
  },

  // 注意：Page 选项里的 getter 会在 glass-easel 合并时被求值成静态值，
  // 所以这里用普通方法取当前选择。
  getFromEndpoint(): TransitEndpoint | null {
    return this.endpoints[this.data.fromIndex] ?? null;
  },

  getToEndpoint(): TransitEndpoint | null {
    return this.endpoints[this.data.toIndex] ?? null;
  },

  getSelectedDate(): Date {
    const [year, month, day] = this.data.dateKey.split("-").map(Number);
    return new Date(year, month - 1, day);
  },

  async reloadLines() {
    const fromEndpoint = this.getFromEndpoint();
    const toEndpoint = this.getToEndpoint();
    if (!fromEndpoint || !toEndpoint) return;
    this.closePreview();

    // 起终点相同：不请求，直接空态（对齐 Web 端）
    if (fromEndpoint.id === toEndpoint.id) {
      this.lines = [];
      this.setData({
        loading: false,
        errorMessage: "",
        isEmpty: true,
        emptyTitle: this.isToday() ? "今日无班次" : "当日无班次",
        emptySubtitle: "起点和终点相同",
      });
      this.refreshDisplay();
      return;
    }

    this.setData({ loading: true, errorMessage: "", isEmpty: false });
    try {
      const { lines, source } = await fetchCampusLinesWithFallback(fromEndpoint, toEndpoint, this.getSelectedDate());
      this.lines = lines;
      this.source = source;
      this.setData({
        loading: false,
        offlineTip: source === "snapshot" ? this.snapshotTip() : "",
      });
      this.refreshDisplay();
    } catch (error) {
      this.setData({
        loading: false,
        errorMessage: error instanceof Error ? error.message : "加载失败",
        isEmpty: false,
      });
    }
  },

  isToday(): boolean {
    return isSameDay(this.getSelectedDate(), new Date());
  },

  /** 由当前 lines 推导 hero 卡与时刻网格；now 变化时也可单独调用。 */
  refreshDisplay() {
    if (this.data.loading || this.data.errorMessage || this.data.isEmpty) return;
    const todayFlag = this.isToday();
    const now = new Date();
    // 全部线路的班次摊平成一张时刻表（旧版 schedules 语义）
    const all = flattenLineJourneys(this.lines);
    const remaining = todayFlag ? getRemainingJourneys(all, now) : all;

    const nextReservation = (todayFlag && remaining.find((item) => item.isReservation)) || null;
    const nextNonReservation = (todayFlag && remaining.find((item) => !item.isReservation)) || null;
    const heroTimes = new Set(
      [nextReservation?.departureTime, nextNonReservation?.departureTime].filter(Boolean) as string[],
    );
    const rest = todayFlag ? remaining.filter((item) => !heroTimes.has(item.departureTime)) : remaining;

    const hero = (item: FlatLineJourney | null, label: string, tone: HeroCard["tone"]): HeroCard => ({
      label,
      tone,
      time: item ? item.departureTime : "--:--",
      countdown: item ? countdownLabel(item.departureTime, now) ?? "—" : "—",
      disabled: !item,
    });

    // 「上下车点」四行：按预约类别拆，同类多条线路合并去重；无该类线路则该行不出。
    const reservationLines = this.lines.filter(isReservationLine);
    const freeLines = this.lines.filter((line) => !isReservationLine(line));
    const mapStop = (stop: { stopId: string; stopName: string }): SpotRowStop => ({
      stopId: stop.stopId,
      name: stop.stopName,
      canMap: Boolean(this.stopMapTarget(stop.stopId)),
    });
    const spotRows = [
      { label: "上车点-预约车", stops: linesBoardingStops(reservationLines).map(mapStop) },
      { label: "上车点-非预约车", stops: linesBoardingStops(freeLines).map(mapStop) },
      { label: "下车点-预约车", stops: linesAlightingStops(reservationLines).map(mapStop) },
      { label: "下车点-非预约车", stops: linesAlightingStops(freeLines).map(mapStop) },
    ]
      .filter((row) => row.stops.length > 0)
      .map((row, index, rows) => ({ ...row, showBorder: index < rows.length - 1 }));

    const isEmpty = all.length === 0;
    this.setData({
      todayFlag,
      nextReservation: hero(nextReservation, "预约车", "reservation"),
      nextNonReservation: hero(nextNonReservation, "非预约车", "nonReservation"),
      otherBuses: mergeSchedulesByTime(rest),
      spotRows,
      isEmpty,
      emptyTitle: todayFlag ? "今日无班次" : "当日无班次",
      emptySubtitle: "请尝试更换日期或线路",
    });
  },

  // ------------------------------------------------------------------
  // 选择器交互
  // ------------------------------------------------------------------

  onFromChange(event: any) {
    this.setData({ fromIndex: Number(event.detail.value) });
    this.reloadLines();
  },

  onToChange(event: any) {
    this.setData({ toIndex: Number(event.detail.value) });
    this.reloadLines();
  },

  onSwap() {
    this.setData({ fromIndex: this.data.toIndex, toIndex: this.data.fromIndex });
    this.reloadLines();
  },

  onDateChange(event: any) {
    const dateKey = event.detail.value as string;
    const [year, month, day] = dateKey.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    this.setData({ dateKey });
    this.updateDateLabel(date);
    this.reloadLines();
  },

  /** 「今天」或日历分桶名 + 「8/7 四」。 */
  updateDateLabel(date: Date) {
    const info = formatDate(date);
    const today = isSameDay(date, new Date());
    this.setData({
      dateLabel: today ? "今天" : BUCKET_LABELS[getCurrentDateBucket(date)],
      dateSub: `${info.month}/${info.day} ${info.weekday.replace("周", " ")}`,
    });
  },

  // ------------------------------------------------------------------
  // 班次预览（M7；数据随 campus-lines 一次到位，本地构建，不再二次请求）
  // ------------------------------------------------------------------

  /** 当前时刻表（hero / 网格点击共用）：今天只看未发车的班次。 */
  currentJourneys(): FlatLineJourney[] {
    const all = flattenLineJourneys(this.lines);
    return this.isToday() ? getRemainingJourneys(all, new Date()) : all;
  },

  openPreviewByTime(event: any) {
    const departureTime = event.currentTarget.dataset.time as string;
    const item = this.currentJourneys().find((entry) => entry.departureTime === departureTime);
    if (item) this.openPreview(item.line, item.journey);
  },

  openPreviewByHero(event: any) {
    const tone = event.currentTarget.dataset.tone as string;
    const item = this.currentJourneys().find((entry) =>
      tone === "reservation" ? entry.isReservation : !entry.isReservation,
    );
    if (item) this.openPreview(item.line, item.journey);
  },

  openPreview(line: CampusLine, journey: CampusJourney) {
    this.previewLine = line;
    this.previewJourney = journey;
    const fromName = this.getFromEndpoint()?.name ?? "";
    const toName = this.getToEndpoint()?.name ?? "";
    const isReservation = isReservationLine(line);
    // 快照线路没有停靠序列（patterns 为空），预览时间线不可用，降级展示
    const isSnapshot = line.patterns.length === 0;

    const baseMeta = [`${fromName} → ${toName}`, isReservation ? "预约车" : "非预约车"];
    this.setData({
      previewVisible: true,
      previewTime: journey.departureTime ?? "--:--",
      previewMeta: baseMeta.join(" · "),
      previewIsReservation: isReservation,
      previewOffline: isSnapshot,
      previewBoarding: null,
      previewAlighting: [],
    });

    if (isSnapshot) return;

    try {
      const preview = buildLinePreview(line, journey);
      const boarding = preview.stops[0];
      const alightingStops = preview.stops.slice(1);
      this.setData({
        previewMeta: [
          ...baseMeta,
          // 含推算段时写「预计」而不是「约」：后者会被读成排班上的既定时长。
          preview.durationMinutes !== null
            ? `${preview.hasEstimated ? "预计" : "约"} ${preview.durationMinutes} 分钟`
            : null,
        ]
          .filter(Boolean)
          .join(" · "),
        previewBoarding: boarding
          ? {
              stopId: boarding.stopId,
              name: boarding.stopName,
              timeText: boarding.time ? `${boarding.time} 发车` : "发车时间待定",
              canNavigate: this.canNavigateStop(boarding.stopId),
            }
          : null,
        previewAlighting: alightingStops.map((stop, index) => ({
          stopId: stop.stopId,
          name: stop.stopName,
          roleText: stop.role === "alighting" && alightingStops.length > 1 ? `下车点${index + 1}` : "下车",
          // 推算值与排班时刻在措辞上必须分开（同 Web 端 ShuttlePage 的下车行）：
          // 显示成确定时刻会让人按它掐点到站，而车其实还没到。
          timeText: stop.time
            ? (stop.isEstimated
              ? `预计 ${stop.dayOffset > 0 ? "次日 " : ""}${stop.time} 到达`
              : `${stop.time} ${stop.timeLabel ?? ""}`)
            : "",
          canNavigate: this.canNavigateStop(stop.stopId),
        })),
      });
    } catch {
      // 数据异常（如 pattern 缺失）时保留基础信息，不整块报错
    }
  },

  closePreview() {
    this.previewLine = null;
    this.previewJourney = null;
    this.setData({ previewVisible: false });
  },

  /** 弹层内容区吞掉点击，防止穿透到遮罩触发关闭。 */
  noop() {},

  canNavigateStop(stopId: string): boolean {
    return Boolean(this.stops.find((item) => item.id === stopId)?.navigationPoint);
  },

  openStopNavigation(e: any) {
    const stopId = String(e.currentTarget.dataset.stopId ?? "");
    const point = this.stops.find((item) => item.id === stopId)?.navigationPoint;
    if (!point) return;
    wx.openLocation({
      latitude: point.latitude,
      longitude: point.longitude,
      name: point.displayName,
      scale: 18,
    });
  },

  /** 站点 → 地图深链目标：优先站点绑定的 place，否则落到校区。 */
  stopMapTarget(stopId: string): string {
    const stop = this.stops.find((item) => item.id === stopId);
    if (!stop) return "";
    if (stop.place_id) return stop.place_id;
    return stop.campus_id ? `campus:${stop.campus_id}` : "";
  },

  /** 上下车点点击：跳地图打开站点（回跳标记见 map.ts openPendingPoi）。 */
  openStopOnMap(e: any) {
    const stopId = String(e.currentTarget.dataset.stopId ?? "");
    const target = this.stopMapTarget(stopId);
    if (!target) return;
    try {
      wx.setStorageSync("shumap.pending-map-poi", target);
      // 回跳标记：地图页打开站点详情后，关闭详情 switchTab 回校车（map.ts openPendingPoi 读取）。
      wx.setStorageSync("shumap.pending-map-poi-return", "/pages/shuttle/shuttle");
    } catch {
      wx.showToast({ title: "暂时无法打开站点", icon: "none" });
      return;
    }
    this.closePreview();
    wx.switchTab({ url: "/pages/map/map" });
  },

  // ------------------------------------------------------------------
  // 预约乘车：web-view 打开 vcard.shu.edu.cn
  // ------------------------------------------------------------------

  openBookingSite() {
    this.openBooking(BOOKING_SITE_URL);
  },

  /** 班次级预约入口：bookingUrl 读线路，空则用默认预约网站。 */
  bookPreviewTrip() {
    const line = this.previewLine;
    this.openBooking(line?.bookingUrl ?? BOOKING_SITE_URL);
  },

  openBooking(url: string) {
    wx.navigateTo({
      url: `/pages/webview/webview?url=${encodeURIComponent(url)}`,
      fail: () => {
        // web-view 不可用（如个人主体限制）时退化为复制链接
        wx.setClipboardData({ data: url });
      },
    });
  },
});
