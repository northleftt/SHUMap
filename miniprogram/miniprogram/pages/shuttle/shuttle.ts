// M3 校车时刻表。对标 Web 端 src/pages/shuttle/ShuttlePage.tsx：
// 线路/站点/日期选择、最近一班倒计时、时刻网格、班次预览（M7）、预约入口。
// 数据双通道：实时接口优先，断网降级到包内快照（lib/transit/schedule.ts）。

import {
  BUCKET_LABELS,
  buildTripPreview,
  fetchSchedulesWithFallback,
  fetchTripStops,
  formatDate,
  getCurrentDateBucket,
  getRemainingBuses,
  isSameDay,
  loadTransitStops,
  mergeSchedulesByTime,
  parseTime,
  toDateKey,
  SNAPSHOT_VERSION,
  type ScheduleItem,
  type ScheduleSource,
} from "../../lib/transit/schedule";
import type { TransitStop } from "../../lib/transit/types";

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

Page({
  data: {
    // 自定义导航（Skyline 要求 navigationStyle: custom）下的状态栏占位
    statusBarHeight: 20,

    // 站点与选择状态
    stopsReady: false,
    stopNames: [] as string[],
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
    fromStopName: "",
    toStopName: "",
    fromStopCanMap: false,
    toStopCanMap: false,
    offlineTip: "",

    // 班次预览弹层
    previewVisible: false,
    previewTime: "",
    previewMeta: "",
    previewLoading: false,
    previewError: "",
    previewOffline: false,
    previewBoarding: null as { stopId: string; name: string; timeText: string; canNavigate: boolean } | null,
    previewAlighting: [] as Array<{ stopId: string; name: string; roleText: string; timeText: string; canNavigate: boolean }>,
    previewIsReservation: false,
  },

  // 页面内状态（不进 data，避免 setData 开销）
  stops: [] as TransitStop[],
  source: "api" as ScheduleSource,
  schedules: [] as ScheduleItem[],
  previewTrip: null as ScheduleItem | null,
  _timer: 0,

  onLoad() {
    const now = new Date();
    const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : { statusBarHeight: 20 };
    this.setData({ dateKey: toDateKey(now), statusBarHeight: windowInfo.statusBarHeight ?? 20 });
    this.updateDateLabel(now);
    this.initStops();
    // now 每 30s 跳动，驱动倒计时与「已过班次」剔除（对齐 Web 端 useNow(30s)）
    this._timer = setInterval(() => this.refreshDisplay(), 30_000) as unknown as number;
  },

  /** 自定义 tabBar：回显本 tab 的选中态（app.json tabBar.custom=true）。 */
  onShow() {
    const tabBar = this.getTabBar?.();
    if (tabBar) tabBar.setData({ selected: 1 });
  },

  onUnload() {
    clearInterval(this._timer);
  },

  /** 站点列表：release manifest 优先，失败退化到快照校区名。 */
  async initStops() {
    try {
      const { stops, source } = await loadTransitStops();
      this.stops = stops;
      this.source = source;
      this.setData({
        stopsReady: true,
        stopNames: stops.map((stop) => stop.name),
        offlineTip: source === "snapshot" ? this.snapshotTip() : "",
      });
    } catch {
      this.setData({ stopsReady: true, stopNames: [], errorMessage: "站点数据加载失败", loading: false });
      return;
    }
    this.reloadSchedules();
  },

  snapshotTip(): string {
    return `当前为离线快照数据（${SNAPSHOT_VERSION}），班次以实际为准`;
  },

  // 注意：Page 选项里的 getter 会在 glass-easel 合并时被求值成静态值，
  // 所以这里用普通方法取当前选择。
  getFromStop(): TransitStop | null {
    return this.stops[this.data.fromIndex] ?? null;
  },

  getToStop(): TransitStop | null {
    return this.stops[this.data.toIndex] ?? null;
  },

  getSelectedDate(): Date {
    const [year, month, day] = this.data.dateKey.split("-").map(Number);
    return new Date(year, month - 1, day);
  },

  async reloadSchedules() {
    const fromStop = this.getFromStop();
    const toStop = this.getToStop();
    if (!fromStop || !toStop) return;
    this.closePreview();

    // 起终点相同：不请求，直接空态（对齐 Web 端）
    if (fromStop.id === toStop.id) {
      this.schedules = [];
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
      const { schedules, source } = await fetchSchedulesWithFallback(fromStop, toStop, this.getSelectedDate());
      this.schedules = schedules;
      this.source = source;
      this.setData({
        loading: false,
        fromStopName: fromStop.name,
        toStopName: toStop.name,
        fromStopCanMap: Boolean(this.stopMapTarget(fromStop)),
        toStopCanMap: Boolean(this.stopMapTarget(toStop)),
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

  /** 由当前 schedules 推导 hero 卡与时刻网格；now 变化时也可单独调用。 */
  refreshDisplay() {
    if (this.data.loading || this.data.errorMessage || this.data.isEmpty) return;
    const todayFlag = this.isToday();
    const now = new Date();
    const remaining = todayFlag ? getRemainingBuses(this.schedules, now) : this.schedules;

    const nextReservation = (todayFlag && remaining.find((s) => s.isReservation)) || null;
    const nextNonReservation = (todayFlag && remaining.find((s) => !s.isReservation)) || null;
    const heroTimes = new Set(
      [nextReservation?.departureTime, nextNonReservation?.departureTime].filter(Boolean) as string[],
    );
    const rest = todayFlag ? remaining.filter((s) => !heroTimes.has(s.departureTime)) : remaining;

    const hero = (schedule: ScheduleItem | null, label: string, tone: HeroCard["tone"]): HeroCard => ({
      label,
      tone,
      time: schedule ? schedule.departureTime : "--:--",
      countdown: schedule ? countdownLabel(schedule.departureTime, now) ?? "—" : "—",
      disabled: !schedule,
    });

    const isEmpty = this.schedules.length === 0;
    this.setData({
      todayFlag,
      nextReservation: hero(nextReservation, "预约车", "reservation"),
      nextNonReservation: hero(nextNonReservation, "非预约车", "nonReservation"),
      otherBuses: mergeSchedulesByTime(rest),
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
    this.reloadSchedules();
  },

  onToChange(event: any) {
    this.setData({ toIndex: Number(event.detail.value) });
    this.reloadSchedules();
  },

  onSwap() {
    this.setData({ fromIndex: this.data.toIndex, toIndex: this.data.fromIndex });
    this.reloadSchedules();
  },

  onDateChange(event: any) {
    const dateKey = event.detail.value as string;
    const [year, month, day] = dateKey.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    this.setData({ dateKey });
    this.updateDateLabel(date);
    this.reloadSchedules();
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
  // 班次预览（M7）
  // ------------------------------------------------------------------

  openPreviewByTime(event: any) {
    const departureTime = event.currentTarget.dataset.time as string;
    const now = new Date();
    const remaining = this.isToday() ? getRemainingBuses(this.schedules, now) : this.schedules;
    const trip = remaining.find((s) => s.departureTime === departureTime);
    if (trip) this.openPreview(trip);
  },

  openPreviewByHero(event: any) {
    const tone = event.currentTarget.dataset.tone as string;
    const now = new Date();
    const remaining = this.isToday() ? getRemainingBuses(this.schedules, now) : this.schedules;
    const trip = remaining.find((s) => (tone === "reservation" ? s.isReservation : !s.isReservation));
    if (trip) this.openPreview(trip);
  },

  async openPreview(schedule: ScheduleItem) {
    this.previewTrip = schedule;
    const isSnapshot = schedule.tripId.startsWith("snapshot:");
    const fromName = this.getFromStop()?.name ?? "";
    const toName = this.getToStop()?.name ?? "";
    this.setData({
      previewVisible: true,
      previewTime: schedule.departureTime,
      previewMeta: [
        `${fromName} → ${toName}`,
        schedule.isReservation ? "预约车" : "非预约车",
      ].join(" · "),
      previewIsReservation: schedule.isReservation,
      previewOffline: isSnapshot,
      previewLoading: !isSnapshot,
      previewError: "",
      previewBoarding: null,
      previewAlighting: [],
    });

    // 快照班次没有 tripId，停靠时间线不可用，直接降级展示
    if (isSnapshot) return;

    try {
      const tripStops = await fetchTripStops(schedule.tripId);
      if (this.previewTrip !== schedule) return; // 预览已切换或关闭
      const preview = buildTripPreview(tripStops, schedule);
      const boarding = preview.stops[0];
      const alightingStops = preview.stops.slice(1);
      this.setData({
        previewLoading: false,
        previewMeta: [
          `${fromName} → ${toName}`,
          schedule.isReservation ? "预约车" : "非预约车",
          preview.durationMinutes !== null ? `约 ${preview.durationMinutes} 分钟` : null,
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
          timeText: stop.time ? `${stop.time} ${stop.timeLabel ?? ""}` : "",
          canNavigate: this.canNavigateStop(stop.stopId),
        })),
      });
    } catch (error) {
      if (this.previewTrip !== schedule) return;
      this.setData({
        previewLoading: false,
        previewError: error instanceof Error ? error.message : "停靠站点加载失败",
      });
    }
  },

  closePreview() {
    this.previewTrip = null;
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

  stopMapTarget(stop: TransitStop): string {
    if (stop.place_id) return stop.place_id;
    return stop.campus_id ? `campus:${stop.campus_id}` : "";
  },

  openStopOnMap(e: any) {
    const stopId = String(e.currentTarget.dataset.stopId ?? "");
    const stop = this.stops.find((item) => item.id === stopId);
    if (!stop) return;
    const target = this.stopMapTarget(stop);
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

  openSelectedStopOnMap(e: any) {
    const role = String(e.currentTarget.dataset.role ?? "");
    const stop = role === "from" ? this.getFromStop() : this.getToStop();
    if (!stop || !this.stopMapTarget(stop)) return;
    this.openStopOnMap({ currentTarget: { dataset: { stopId: stop.id } } });
  },

  // ------------------------------------------------------------------
  // 预约乘车：web-view 打开 vcard.shu.edu.cn
  // ------------------------------------------------------------------

  openBookingSite() {
    this.openBooking(BOOKING_SITE_URL);
  },

  bookPreviewTrip() {
    const trip = this.previewTrip;
    this.openBooking(trip?.bookingUrl ?? BOOKING_SITE_URL);
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
