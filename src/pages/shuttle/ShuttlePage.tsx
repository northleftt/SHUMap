import { ArrowDownUp, ChevronDown, MapPin, Navigation, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { EmptyState, LoadingState } from "../../components/ui/EmptyState";
import { SectionHeader } from "../../components/ui/SectionHeader";
import { SheetModal } from "../../components/ui/SheetModal";
import type { TransitStop } from "../../lib/api/types";
import { useAsyncData } from "../../lib/hooks/useAsyncData";
import { useBreakpoint } from "../../lib/hooks/useBreakpoint";
import { useNow } from "../../lib/hooks/useNow";
import { MapAppSheet, type MapTarget } from "../../lib/nav";
import { useRelease } from "../../lib/release/ReleaseContext";
import type { LoadedRelease } from "../../lib/release/mapData";
import {
  BUCKET_LABELS,
  buildTripPreview,
  fetchSchedules,
  fetchTripStops,
  formatDate,
  getCurrentDateBucket,
  getDaysInMonth,
  getRemainingBuses,
  getSafeDate,
  isSameDay,
  mergeSchedulesByTime,
  parseTime,
  type ScheduleItem,
  type ScheduleStatus,
} from "../../lib/transit/schedule";

const BOOKING_SITE_URL = "http://vcard.shu.edu.cn/shu-wechat-client/schoolbus/passenger/jumpToOrder";

type ScheduleState =
  | { status: "loading" }
  | { status: "ready"; schedules: ScheduleItem[] }
  | { status: "error"; message: string };

/** 倒计时文案：「5分钟后」/「1小时内」等，departure 已过返回 null。 */
function countdownLabel(departureTime: string, now: Date): string | null {
  const departureMinutes = parseTime(departureTime);
  const nowMinutes = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const delta = Math.ceil(departureMinutes - nowMinutes);
  if (delta <= 0) return null;
  if (delta < 60) return `${delta}分钟后`;
  // 超过 1 小时只报小时数，避免 hero 卡文案过长换行
  return `${Math.floor(delta / 60)}小时后`;
}

function StatusChip({ status }: { status: ScheduleStatus }) {
  const reservation = <span className="font-medium text-primary">预</span>;
  const nonReservation = <span className="font-medium text-slate-500">非</span>;
  if (status === "mixed") {
    return (
      <span className="inline-flex items-center gap-1 text-label">
        {reservation}
        {nonReservation}
      </span>
    );
  }
  return <span className="text-label">{status === "reservation" ? reservation : nonReservation}</span>;
}

function CampusPicker({
  value,
  onChange,
  stops,
  align = "left",
}: {
  value: TransitStop | null;
  onChange: (stop: TransitStop) => void;
  stops: TransitStop[];
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        className={`flex items-baseline gap-1.5 ${align === "right" ? "flex-row-reverse" : ""}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-body font-semibold text-ink">{value?.name ?? "选择"}</span>
        <ChevronDown size={13} className="self-center text-sub" />
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            className={`absolute top-full z-40 mt-2 max-h-56 w-36 overflow-auto rounded-xl border border-line bg-surface py-1 shadow-floating ${
              align === "right" ? "right-0" : "left-0"
            }`}
          >
            {stops.map((stop) => (
              <button
                key={stop.id}
                type="button"
                className={`block w-full px-3.5 py-2.5 text-left text-body ${
                  stop.id === value?.id ? "font-medium text-primary" : "text-ink active:bg-page"
                }`}
                onClick={() => {
                  onChange(stop);
                  setOpen(false);
                }}
              >
                {stop.name}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function DatePicker({
  date,
  onChange,
}: {
  date: Date;
  onChange: (date: Date) => void;
}) {
  const [open, setOpen] = useState(false);
  const info = formatDate(date);
  const today = isSameDay(date, new Date());
  const dayMax = getDaysInMonth(date.getFullYear(), date.getMonth());
  const selectClass =
    "appearance-none rounded-lg bg-page py-1.5 pl-2.5 pr-7 text-body font-medium text-ink outline-none";

  return (
    <div className="relative">
      <button type="button" className="text-right" onClick={() => setOpen((v) => !v)}>
        <div className="text-label text-sub">{today ? "今天" : BUCKET_LABELS[getCurrentDateBucket(date)]}</div>
        <div className="mt-0.5 text-aux font-medium text-ink">
          {info.month}/{info.day} {info.weekday.replace("周", " ")}
        </div>
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-40 mt-2 w-52 rounded-xl border border-line bg-surface p-3 shadow-floating">
            <div className="flex items-center gap-2">
              <div className="relative">
                <select
                  className={selectClass}
                  value={info.month}
                  onChange={(event) => onChange(getSafeDate(date, "month", Number(event.target.value)))}
                >
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((month) => (
                    <option key={month} value={month}>
                      {month}
                    </option>
                  ))}
                </select>
                <ChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-sub" />
              </div>
              <span className="text-body text-ink">月</span>
              <div className="relative">
                <select
                  className={selectClass}
                  value={info.day}
                  onChange={(event) => onChange(getSafeDate(date, "day", Number(event.target.value)))}
                >
                  {Array.from({ length: dayMax }, (_, i) => i + 1).map((day) => (
                    <option key={day} value={day}>
                      {day}
                    </option>
                  ))}
                </select>
                <ChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-sub" />
              </div>
              <span className="text-body text-ink">日</span>
            </div>
            {!today ? (
              <button
                type="button"
                className="mt-2.5 flex w-full items-center justify-center gap-1 rounded-full bg-primary py-2 text-aux font-medium text-white active:bg-primary-pressed"
                onClick={() => {
                  onChange(new Date());
                  setOpen(false);
                }}
              >
                <Undo2 size={13} />
                回到今日
              </button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * 时间线上每站右侧的轻量导航入口：一个文字链接，点了弹「用哪个地图打开」。
 * 站点名本身就是校区名，所以调起的是校区级坐标标记点。
 */
function StopNavLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="-mr-1 flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-label font-medium text-primary active:bg-primary-container"
      onClick={onClick}
    >
      <Navigation size={11} />
      导航
    </button>
  );
}

/** M7 预览内容（移动端 SheetModal / 桌面端常驻侧卡共用）。 */
function TripPreviewContent({
  schedule,
  fromStop,
  toStop,
  release,
  onClose,
}: {
  schedule: ScheduleItem;
  fromStop: TransitStop | null;
  toStop: TransitStop | null;
  release: LoadedRelease;
  onClose: () => void;
}) {
  const [navTarget, setNavTarget] = useState<MapTarget | null>(null);
  // 停靠序列与时刻走实时接口，改点即生效。
  const { state: tripStopsState } = useAsyncData(
    (signal) => fetchTripStops(schedule.tripId, signal),
    [schedule.tripId],
  );

  const preview = useMemo(() => {
    if (tripStopsState.status !== "ready") return null;
    const value = buildTripPreview(tripStopsState.data, schedule);
    if (value.stops.length < 2) throw new Error(`班次 ${schedule.tripId} 缺少完整停靠序列`);
    if (value.stops[0].role !== "boarding") throw new Error(`班次 ${schedule.tripId} 缺少上车站`);
    return value;
  }, [schedule, tripStopsState]);

  const boarding = preview?.stops[0] ?? null;
  const alightingStops = preview === null ? null : preview.stops.slice(1);
  const navigationTarget = (stopId: string, stopName: string): MapTarget | null => {
    const releaseStop = release.manifest.transit.stops.find((stop) => stop.id === stopId);
    if (!releaseStop?.place_id) return null;
    const place = release.buildings.find((building) => building.poiKey === releaseStop.place_id);
    if (!place?.navigationUrls) return null;
    return { label: stopName, navigationUrls: place.navigationUrls };
  };
  const boardingNavigationTarget = boarding
    ? navigationTarget(boarding.stopId, boarding.stopName)
    : null;

  return (
    <div className="px-5 pb-6 pt-1">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-card text-ink">{schedule.departureTime} 班车</h2>
          <p className="mt-1 text-aux text-sub">
            {[
              fromStop && toStop ? `${fromStop.name} → ${toStop.name}` : null,
              schedule.isReservation ? "预约车" : "非预约车",
              preview?.durationMinutes !== null && preview?.durationMinutes !== undefined ? `约 ${preview.durationMinutes} 分钟` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <button
          type="button"
          aria-label="关闭"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-page text-sub"
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      {tripStopsState.status === "loading" ? (
        <LoadingState label="正在加载停靠站点…" />
      ) : tripStopsState.status === "error" ? (
        <EmptyState title="停靠站点加载失败" subtitle={tripStopsState.message} />
      ) : boarding && alightingStops ? (
        /* 站点时间线：每行「校区名 · 上/下车」+ 发车时间，右侧轻量导航链接 */
        <div className="mt-4">
          <div className="flex gap-3">
            <div className="flex flex-col items-center">
              <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-primary" />
              <span className="mt-1 w-px flex-1 bg-line" />
            </div>
            <div className="flex min-w-0 flex-1 items-start justify-between gap-2 pb-3">
              <div className="min-w-0">
                <div className="truncate text-body font-medium text-ink">{boarding.stopName} · 上车</div>
                <div className="mt-1 text-label text-sub">
                  {boarding.time ? `${boarding.time} 发车` : "发车时间待定"}
                </div>
              </div>
              {boardingNavigationTarget ? (
                <StopNavLink onClick={() => setNavTarget(boardingNavigationTarget)} />
              ) : null}
            </div>
          </div>

          <div className="flex gap-3">
          <div className="flex flex-col items-center">
            <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-success" />
          </div>
          <div className="min-w-0 flex-1">
            {alightingStops.map((stop, index) => {
              const stopNavigationTarget = navigationTarget(stop.stopId, stop.stopName);
              return (
                <div
                  key={stop.stopId}
                  className={`flex items-start justify-between gap-2 ${index > 0 ? "mt-2" : ""}`}
                >
                  <div className="min-w-0">
                    <div className="truncate text-body font-medium text-ink">
                      {stop.stopName}
                      {stop.role === "alighting" && alightingStops.length > 1 ? ` · 下车点${index + 1}` : " · 下车"}
                    </div>
                    {stop.time ? (
                      <div className="mt-1 text-label text-sub">
                        {stop.time} {stop.timeLabel ?? ""}
                      </div>
                    ) : null}
                  </div>
                  {stopNavigationTarget ? (
                    <StopNavLink onClick={() => setNavTarget(stopNavigationTarget)} />
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
        </div>
      ) : null}

      {schedule.isReservation ? (
        <button
          type="button"
          className="mt-5 w-full rounded-full bg-primary py-3 text-body font-semibold text-white active:bg-primary-pressed"
          onClick={() => window.open(schedule.bookingUrl ?? BOOKING_SITE_URL, "_blank")}
        >
          预约此班次
        </button>
      ) : null}

      <MapAppSheet target={navTarget} onClose={() => setNavTarget(null)} />
    </div>
  );
}

/** M7 班次路线预览（移动端底部弹卡）。 */
function TripPreviewSheet({
  schedule,
  fromStop,
  toStop,
  release,
  onClose,
}: {
  schedule: ScheduleItem | null;
  fromStop: TransitStop | null;
  toStop: TransitStop | null;
  release: LoadedRelease;
  onClose: () => void;
}) {
  // 内容精简后 0.55 会留大片空白：标题 + 两站时间线约 200px，预约车多一个 CTA。
  const height = schedule?.isReservation ? 0.42 : 0.34;
  return (
    <SheetModal open={schedule !== null} onClose={onClose} initialHeight={height}>
      {schedule ? (
        <TripPreviewContent schedule={schedule} fromStop={fromStop} toStop={toStop} release={release} onClose={onClose} />
      ) : null}
    </SheetModal>
  );
}

/** M3 校车时刻表。 */
export function ShuttlePage() {
  const releaseState = useRelease();
  if (releaseState.status === "loading") {
    return <div className="h-full bg-page"><LoadingState label="正在加载校车数据…" /></div>;
  }
  if (releaseState.status !== "ready") {
    return (
      <div className="h-full bg-page px-5 pt-16">
        <EmptyState
          title={releaseState.status === "empty" ? "班次数据尚未发布" : "班次数据加载失败"}
          subtitle={releaseState.status === "empty" ? "当前没有已发布的校车数据\n请稍后再试或联系管理员发布" : "请检查网络后重试"}
        />
      </div>
    );
  }
  return <ReadyShuttlePage release={releaseState.release} />;
}

function ReadyShuttlePage({ release }: { release: LoadedRelease }) {
  const navigate = useNavigate();
  const isDesktop = useBreakpoint() === "desktop";
  const stops = release.manifest.transit.stops;

  const [fromStop, setFromStop] = useState<TransitStop | null>(null);
  const [toStop, setToStop] = useState<TransitStop | null>(null);
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [scheduleState, setScheduleState] = useState<ScheduleState>({ status: "loading" });
  const [previewTrip, setPreviewTrip] = useState<ScheduleItem | null>(null);
  const now = useNow(30_000);
  const nowDate = new Date(now);

  // 当前发布快照的站点顺序定义默认线路。
  const initializedRef = useRef(false);
  useEffect(() => {
    if (initializedRef.current || stops.length === 0) return;
    initializedRef.current = true;
    setFromStop(stops[0]);
    setToStop(stops[1] ?? stops[0]);
  }, [stops]);

  const todayFlag = isSameDay(selectedDate, nowDate);

  useEffect(() => {
    if (!fromStop || !toStop) return;
    if (fromStop.id === toStop.id) {
      setScheduleState({ status: "ready", schedules: [] });
      return;
    }
    const controller = new AbortController();
    setScheduleState({ status: "loading" });
    fetchSchedules(fromStop.id, toStop.id, selectedDate, controller.signal)
      .then((schedules) => setScheduleState({ status: "ready", schedules }))
      .catch((error) => {
        if (controller.signal.aborted) return;
        setScheduleState({ status: "error", message: error instanceof Error ? error.message : "加载失败" });
      });
    return () => controller.abort();
  }, [fromStop, toStop, selectedDate]);

  const scheduleDisplay = useMemo(() => {
    if (scheduleState.status !== "ready") return null;
    const remaining = todayFlag ? getRemainingBuses(scheduleState.schedules, nowDate) : scheduleState.schedules;
    const nextReservation = remaining.find((schedule) => schedule.isReservation) ?? null;
    const nextNonReservation = remaining.find((schedule) => !schedule.isReservation) ?? null;
    const heroTimes = new Set(
      [nextReservation?.departureTime, nextNonReservation?.departureTime].filter(Boolean) as string[],
    );
    const rest = todayFlag ? remaining.filter((schedule) => !heroTimes.has(schedule.departureTime)) : remaining;
    return {
      nextReservation: todayFlag ? nextReservation : null,
      nextNonReservation: todayFlag ? nextNonReservation : null,
      otherBuses: mergeSchedulesByTime(rest),
    };
    // now 每 30s 跳动，驱动倒计时与「已过班次」剔除
  }, [scheduleState, todayFlag, now]);

  const handleSwap = () => {
    setFromStop(toStop);
    setToStop(fromStop);
  };

  const handleTimeClick = (departureTime: string) => {
    if (scheduleState.status !== "ready") return;
    const remaining = todayFlag ? getRemainingBuses(scheduleState.schedules, nowDate) : scheduleState.schedules;
    const trip = remaining.find((schedule) => schedule.departureTime === departureTime);
    if (trip) setPreviewTrip(trip);
  };

  const heroCard = (
    schedule: ScheduleItem | null,
    label: string,
    tone: "reservation" | "nonReservation",
  ) => {
    const countdown = schedule ? countdownLabel(schedule.departureTime, nowDate) : null;
    const palette = tone === "reservation" ? "bg-primary" : "bg-shuttle-free";
    return (
      <button
        type="button"
        disabled={!schedule}
        className={`min-w-0 flex-1 rounded-3xl px-4 py-4 text-left text-white ${palette} ${schedule ? "active:opacity-90" : "opacity-45"}`}
        onClick={() => schedule && setPreviewTrip(schedule)}
      >
        <div className="flex items-baseline justify-between gap-2 whitespace-nowrap text-aux text-white/85">
          <span>{label}</span>
          <span>{countdown ?? "—"}</span>
        </div>
        <div className="mt-1.5 text-[38px] font-semibold leading-none tracking-tight">
          {schedule ? schedule.departureTime : "--:--"}
        </div>
      </button>
    );
  };

  return (
    <div className="flex h-full justify-center gap-6 overflow-hidden bg-page">
      <div className="flex h-full w-full max-w-[780px] flex-col overflow-hidden">
        <header className="flex items-end justify-between px-5 pb-3 pt-6">
          <h1 className="text-title">校车时刻表</h1>
          <button
            type="button"
            className="pb-1 text-aux font-medium text-primary"
            onClick={() => window.open(BOOKING_SITE_URL, "_blank")}
          >
            预约网站 ›
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 pb-6">
        {/* 线路卡 */}
        <div className="rounded-2xl bg-surface px-4 py-3.5 shadow-card">
          <div className="flex items-center">
            <div className="min-w-0 flex-1">
              <div className="text-label text-sub">从</div>
              <div className="mt-0.5">
                <CampusPicker value={fromStop} onChange={setFromStop} stops={stops} />
              </div>
            </div>
            <button
              type="button"
              aria-label="交换起终点"
              className="mx-2 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary-container text-primary active:opacity-80"
              onClick={handleSwap}
            >
              <ArrowDownUp size={15} />
            </button>
            <div className="min-w-0 flex-1">
              <div className="text-label text-sub">到</div>
              <div className="mt-0.5">
                <CampusPicker value={toStop} onChange={setToStop} stops={stops} />
              </div>
            </div>
            <div className="ml-3 shrink-0 border-l border-line pl-3">
              <DatePicker date={selectedDate} onChange={setSelectedDate} />
            </div>
          </div>
        </div>

        {scheduleState.status === "loading" ? (
          <LoadingState label="正在加载班次…" />
        ) : scheduleState.status === "error" ? (
          <EmptyState title="班次数据加载失败" subtitle={scheduleState.message} />
        ) : scheduleState.schedules.length === 0 ? (
          <EmptyState
            title={todayFlag ? "今日无班次" : "当日无班次"}
            subtitle={fromStop?.id === toStop?.id ? "起点和终点相同" : "请尝试更换日期或线路"}
          />
        ) : (
          <>
            {/* 最近一班（仅今天） */}
            {scheduleDisplay && todayFlag && (scheduleDisplay.nextReservation || scheduleDisplay.nextNonReservation) ? (
              <div className="mt-5">
                <SectionHeader title="最近一班" />
                <div className="mt-2.5 flex gap-3">
                  {heroCard(scheduleDisplay.nextReservation, "预约车", "reservation")}
                  {heroCard(scheduleDisplay.nextNonReservation, "非预约车", "nonReservation")}
                </div>
              </div>
            ) : null}

            {/* 时刻网格 */}
            {scheduleDisplay && scheduleDisplay.otherBuses.length > 0 ? (
              <div className="mt-5">
                <SectionHeader title={todayFlag ? "今日其他班次" : "当日班次"} />
                <div className="mt-2.5 rounded-2xl bg-surface px-5 py-2 shadow-card">
                  <div className="grid grid-cols-2">
                    {scheduleDisplay.otherBuses.map((item, index) => (
                      <button
                        key={item.departureTime}
                        type="button"
                        className={`flex items-center gap-2 py-3.5 text-left active:opacity-70 ${
                          index % 2 === 0 ? "" : "pl-4"
                        }`}
                        onClick={() => handleTimeClick(item.departureTime)}
                      >
                        <span className="text-body font-semibold text-ink">{item.departureTime}</span>
                        <StatusChip status={item.status} />
                      </button>
                    ))}
                  </div>
                </div>
                <p className="mt-2 text-label text-sub">
                  <span className="mr-3"><span className="text-primary">预</span> = 预约车</span>
                  <span><span className="text-slate-500">非</span> = 非预约车</span>
                </p>
              </div>
            ) : null}

            {/* 上下车点 */}
            {fromStop && toStop && fromStop.id !== toStop.id ? (
              <div className="mt-5">
                <SectionHeader title="上下车点" />
                <div className="mt-2.5 rounded-2xl bg-surface px-5 py-1.5 shadow-card">
                  {[
                    { label: "上车点", stop: fromStop },
                    { label: "下车点", stop: toStop },
                  ].map(({ label, stop }, index) => {
                    const poiKey = stop.place_id;
                    return (
                      <button
                        key={label}
                        type="button"
                        disabled={!poiKey}
                        className={`flex w-full items-center gap-2.5 py-3 text-left ${
                          index === 0 ? "border-b border-line" : ""
                        } ${poiKey ? "active:opacity-70" : "cursor-default"}`}
                        onClick={() => poiKey && navigate(`/map?poi=${encodeURIComponent(poiKey)}`)}
                      >
                        <span className="w-12 shrink-0 text-label text-sub">{label}</span>
                        <MapPin size={14} className="shrink-0 text-primary" />
                        <span className="text-aux text-slate-600">{stop.name}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </>
        )}
        </div>
      </div>

      {/* D2 桌面端：常驻右侧预览卡（不用底部弹卡） */}
      {isDesktop && previewTrip ? (
        <aside className="w-[400px] shrink-0 overflow-y-auto py-6 pr-5">
          <div className="rounded-3xl bg-surface pt-3 shadow-card">
            <TripPreviewContent
              schedule={previewTrip}
              fromStop={fromStop}
              toStop={toStop}
              release={release}
              onClose={() => setPreviewTrip(null)}
            />
          </div>
        </aside>
      ) : null}

      {!isDesktop ? (
        <TripPreviewSheet
          schedule={previewTrip}
          fromStop={fromStop}
          toStop={toStop}
          release={release}
          onClose={() => setPreviewTrip(null)}
        />
      ) : null}
    </div>
  );
}
