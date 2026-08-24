// M3 校车时刻表。对标 Web 端 src/pages/shuttle/ShuttlePage.tsx：
// 校区 OD 选择、最近一班倒计时、时刻网格、班次预览（M7）。
// 数据双通道：campus-lines 实时接口优先，断网降级到包内快照（lib/transit/schedule.ts）。
//
// 预约入口（页头「预约网站 ›」+ 弹层「预约此班次」）已于 2026-08-24 下架。三条独立
// 死因，任一条都足以否掉：① vcard.shu.edu.cn 不是本站域名，配业务域名要把校验文件
// 上传到该域名根目录，我们没有写权限；② 个人主体配不了业务域名，web-view 整体不可用；
// ③ jumpToOrder 依赖公众号网页授权（open.weixin.qq.com/connect/oauth2），小程序
// web-view 不携带该会话，即便前两条解决了也拿不到用户身份。留着入口的结果是点进去看
// 「不支持打开非业务域名」的原生错误页——binderror 未必触发，连复制链接的降级都摸不到。
// 线路级 bookingUrl 仍在 API 与后台里保留（Web 端照旧用），只是小程序不再消费它。
// 要恢复：先确认主体类型 + 拿到域名校验文件上传许可 + 确认授权方式，缺一不可。

import {
  buildLinePreview,
  fetchCampusLinesWithFallback,
  flattenLineJourneys,
  formatDate,
  getRemainingJourneys,
  isReservationLine,
  isSameDay,
  journeysAtTime,
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
import type { CampusLine, TransitStop } from "../../lib/transit/types";
import { hasPublishedShuttleGuide } from "../../lib/shuttle-guide";
import { enableShareMenus, shareQuery, sharePath, shareTitle } from "../../lib/share";

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

/** 预览弹层里的一趟班次（同一发车时刻可能有两趟：非预约 + 预约）。 */
interface PreviewTrip {
  tripId: string;
  /** 「非预约车 · 预计 41 分钟」——时刻与方向在卡片大标题里，这里不重复。 */
  meta: string;
  /** 停靠序列缺失（快照线路）时为 true，只降级时间线，标题与乘车方式照旧。 */
  offline: boolean;
  boarding: { stopId: string; name: string; timeText: string; canNavigate: boolean } | null;
  alighting: Array<{ stopId: string; name: string; roleText: string; timeText: string; canNavigate: boolean }>;
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

    /**
     * 「如何坐车？」入口是否显示。默认 false：探测到有已发布内容才亮，
     * 未发布 / 断网时不出现 —— 点进去看一个空页比没有入口更糟。
     */
    guideEntryVisible: false,

    // 班次预览弹层：一个发车时刻可能装两趟（非预约 + 预约），所以是列表
    previewVisible: false,
    previewTime: "",
    /** 大标题里跟在时刻后面的方向：「嘉定校区 → 宝山校区」。 */
    previewRoute: "",
    previewTrips: [] as PreviewTrip[],
  },

  // 页面内状态（不进 data，避免 setData 开销）
  endpoints: [] as TransitEndpoint[],
  stops: [] as TransitStop[],
  source: "api" as ScheduleSource,
  lines: [] as CampusLine[],
  /**
   * 当日日型标签（「工作日」/「假日」……）。在线时来自服务端的服务日历，
   * 离线时来自本地分桶（见 lib/transit/schedule.ts 顶部注释）。
   * 空串表示还没拉到班次——此时只显示日期，不猜日型。
   */
  dayTypeLabel: "",
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
    this.probeGuide();
    // now 每 30s 跳动，驱动倒计时与「已过班次」剔除（对齐 Web 端 useNow(30s)）
    this._timer = setInterval(() => this.refreshDisplay(), 30_000) as unknown as number;
  },

  /** 自定义 tabBar：回显本 tab 的选中态（app.json tabBar.custom=true）。 */
  onShow() {
    const tabBar = this.getTabBar?.();
    if (tabBar) tabBar.setData({ selected: 1 });
  },

  /**
   * 「如何坐车？」入口的显隐探测。
   *
   * 内容未发布 / 断网时不显示入口 —— 点进去只能看到空页或报错页，不如不出现
   * （hasPublishedShuttleGuide 把这几种情况都归成 false）。班次加载失败也不影响它：
   * 两条数据通道独立，指南发布了就该能看，哪怕今天的班次拉不下来。
   */
  async probeGuide() {
    const available = await hasPublishedShuttleGuide();
    if (available) this.setData({ guideEntryVisible: true });
  },

  /** 打开乘车指南。 */
  openRideGuide() {
    wx.navigateTo({ url: "/pages/shuttle-guide/shuttle-guide" });
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
      const { lines, source, dayTypeLabel } = await fetchCampusLinesWithFallback(
        fromEndpoint,
        toEndpoint,
        this.getSelectedDate(),
      );
      this.lines = lines;
      this.source = source;
      this.dayTypeLabel = dayTypeLabel;
      this.setData({
        loading: false,
        offlineTip: source === "snapshot" ? this.snapshotTip() : "",
      });
      // 日型随班次一起到位，拉完要重刷一次标签（onDateChange 时先显示日期、后补日型）。
      this.updateDateLabel(this.getSelectedDate());
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

  /**
   * 「今天」或日型名 + 「8/7 四」。
   *
   * 日型不在这里算：它由 reloadLines 从 fetchCampusLinesWithFallback 拿到
   * （在线走服务端的服务日历，离线才回落本地分桶）。班次还没拉到时 dayTypeLabel
   * 是空串，此时只显示日期——宁可少一行字，也不要显示一个可能和班次矛盾的日型。
   */
  updateDateLabel(date: Date) {
    const info = formatDate(date);
    const today = isSameDay(date, new Date());
    this.setData({
      dateLabel: today ? "今天" : this.dayTypeLabel,
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
    this.openPreview(departureTime);
  },

  /**
   * hero 卡点击：卡上那个时刻的**全部**班次都装进弹层。
   *
   * 不是「该 tone 的那一趟」——预约与非预约的最近一班可能同时刻（时刻网格里就是
   * 「预 非」那一格），两班都该看得到。
   */
  openPreviewByHero(event: any) {
    const tone = event.currentTarget.dataset.tone as string;
    const item = this.currentJourneys().find((entry) =>
      tone === "reservation" ? entry.isReservation : !entry.isReservation,
    );
    if (item) this.openPreview(item.departureTime);
  },

  /**
   * 打开某个发车时刻的预览：该时刻的全部班次，非预约在前、预约在后。
   *
   * 以前这里只装一趟（find 先命中的那个，摊平顺序里通常是非预约），于是同一时刻的
   * 预约车在界面上没有任何入口 —— 时刻网格明明标着「预 非」两个角标。
   */
  openPreview(departureTime: string) {
    const items = journeysAtTime(this.currentJourneys(), departureTime);
    if (items.length === 0) return;
    const fromName = this.getFromEndpoint()?.name ?? "";
    const toName = this.getToEndpoint()?.name ?? "";

    const trips: PreviewTrip[] = items.map((item, index) => {
      const isReservation = item.isReservation;
      // 快照线路没有停靠序列（patterns 为空），时间线不可用，只降级这一段
      let preview: ReturnType<typeof buildLinePreview> | null = null;
      if (item.line.patterns.length > 0) {
        try {
          preview = buildLinePreview(item.line, item.journey);
        } catch {
          // 数据异常（如 pattern 缺失）时只丢时间线，乘车方式与标题照旧
          preview = null;
        }
      }
      const boarding = preview?.stops[0] ?? null;
      const alightingStops = preview ? preview.stops.slice(1) : [];
      return {
        tripId: item.journey.tripId,
        meta: [
          isReservation ? "预约车" : "非预约车",
          // 含推算段时写「预计」而不是「约」：后者会被读成排班上的既定时长。
          preview && preview.durationMinutes !== null
            ? `${preview.hasEstimated ? "预计" : "约"} ${preview.durationMinutes} 分钟`
            : null,
        ]
          .filter(Boolean)
          .join(" · "),
        offline: preview === null,
        boarding: boarding
          ? {
              stopId: boarding.stopId,
              name: boarding.stopName,
              timeText: boarding.time ? `${boarding.time} 发车` : "发车时间待定",
              canNavigate: this.canNavigateStop(boarding.stopId),
            }
          : null,
        alighting: alightingStops.map((stop, stopIndex) => ({
          stopId: stop.stopId,
          name: stop.stopName,
          roleText: stop.role === "alighting" && alightingStops.length > 1 ? `下车点${stopIndex + 1}` : "下车",
          // 推算值与排班时刻在措辞上必须分开（同 Web 端 ShuttlePage 的下车行）：
          // 显示成确定时刻会让人按它掐点到站，而车其实还没到。
          timeText: stop.time
            ? (stop.isEstimated
              ? `预计 ${stop.dayOffset > 0 ? "次日 " : ""}${stop.time} 到达`
              : `${stop.time} ${stop.timeLabel ?? ""}`)
            : "",
          canNavigate: this.canNavigateStop(stop.stopId),
        })),
        showBorder: index > 0,
      };
    });

    this.setData({
      previewVisible: true,
      previewTime: departureTime,
      previewRoute: fromName && toName ? `${fromName} → ${toName}` : "",
      previewTrips: trips,
    });
  },

  closePreview() {
    this.setData({ previewVisible: false, previewTrips: [] });
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

  /**
   * 站点 → 地图深链目标（POI 键），站点没上图时返回空串。
   *
   * 键由 loadTransitEndpoints 按发布层同一条规则算好挂在 stop.mapPoiKey 上
   * （见 lib/transit/schedule.ts 的 mapPoiKeyForStop）。
   *
   * 这里以前是「有 place_id 就用它，否则 `campus:<id>`」，两条都不对：
   * 站点在地图上的身份是 `transit_stop:<id>` 而不是它绑的地点，而 11 个站点里
   * 只有嘉定北门绑了地点 —— 其余 10 个都落到 `campus:` 分支，那个深链只切校区
   * 不开详情，于是「点上下车点回到地图却没打开 POI」。
   */
  stopMapTarget(stopId: string): string {
    return this.stops.find((item) => item.id === stopId)?.mapPoiKey ?? "";
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
});
