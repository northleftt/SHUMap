import { ArrowDownUp, ChevronDown, MapPin, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { EmptyState, LoadingState } from "../../components/ui/EmptyState";
import { SectionHeader } from "../../components/ui/SectionHeader";
import { SheetModal } from "../../components/ui/SheetModal";
import type { TransitStop } from "../../lib/api/types";
import { useBreakpoint } from "../../lib/hooks/useBreakpoint";
import { useNow } from "../../lib/hooks/useNow";
import { useRelease } from "../../lib/release/ReleaseContext";
import {
  BUCKET_LABELS,
  buildTripPreview,
  fetchSchedules,
  formatDate,
  getCurrentDateBucket,
  getDaysInMonth,
  getRemainingBuses,
  getSafeDate,
  isSameDay,
  mergeSchedulesByTime,
  parseTime,
  stopToPoiKey,
  type ScheduleItem,
  type ScheduleStatus,
} from "../../lib/transit/schedule";

const BOOKING_SITE_URL = "http://vcard.shu.edu.cn/shu-wechat-client/schoolbus/passenger/jumpToOrder";

type ScheduleState =
  | { status: "loading" }
  | { status: "ready"; schedules: ScheduleItem[] }
  | { status: "error"; message: string };

const EMPTY_SCHEDULES: ScheduleItem[] = [];

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

/** M7 预览内容（移动端 SheetModal / 桌面端常驻侧卡共用）。 */
function TripPreviewContent({
  schedule,
  fromStop,
  toStop,
  onClose,
}: {
  schedule: ScheduleItem;
  fromStop: TransitStop | null;
  toStop: TransitStop | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { release } = useRelease();

  const preview = useMemo(
    () => (release ? buildTripPreview(release.manifest, schedule) : null),
    [schedule, release],
  );

  const goPoi = (stop: TransitStop | null) => {
    if (!release) return;
    const poiKey = stopToPoiKey(stop ?? undefined, release.buildings);
    if (poiKey) {
      onClose();
      navigate(`/map?poi=${encodeURIComponent(poiKey)}`);
    }
  };

  const boarding = preview?.stops.find((stop) => stop.role === "boarding");
  const alightingStops = preview?.stops.filter((stop) => stop.role !== "boarding") ?? [];

  return (
    <div className="px-5 pb-8 pt-1">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-card">{schedule.departureTime} 班车</h2>
          <p className="mt-1 text-aux text-sub">
            {fromStop?.name} → {toStop?.name}
            {"  "}
            {schedule.isReservation ? "预约车" : "非预约车"}
          </p>
        </div>
        <button
          type="button"
          aria-label="关闭"
          className="grid h-8 w-8 place-items-center rounded-full bg-page text-sub"
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      <div className="mt-5 flex gap-4">
        {/* 时间线 */}
        <div className="min-w-0 flex-1">
          {boarding ? (
            <div className="flex gap-3">
              <div className="flex flex-col items-center">
                <span className="mt-1.5 h-2.5 w-2.5 rounded-full bg-primary" />
                <span className="w-px flex-1 bg-slate-300" />
              </div>
              <div className="pb-1">
                <div className="text-body font-medium text-ink">{boarding.stopName} · 上车</div>
                <div className="mt-0.5 text-label text-sub">
                  {boarding.time ? `${boarding.time} 发车` : "时间未发布"}
                </div>
                {preview && preview.durationMinutes !== null ? (
                  <div className="mt-2 text-label text-sub">约 {preview.durationMinutes} 分钟</div>
                ) : null}
              </div>
            </div>
          ) : null}
          <div className="flex gap-3">
            <div className="flex flex-col items-center">
              <span className="mt-1.5 h-2.5 w-2.5 rounded-full bg-success" />
            </div>
            <div className="min-w-0">
              {alightingStops.map((stop, index) => (
                <div key={stop.stopId} className={index > 0 ? "mt-2.5" : ""}>
                  <div className="text-body font-medium text-ink">
                    {stop.stopName}
                    {stop.role === "alighting" && alightingStops.length > 1 ? ` · 下车点${index + 1}` : " · 下车"}
                  </div>
                  {stop.time ? (
                    <div className="mt-0.5 text-label text-sub">
                      {stop.time} {stop.timeLabel ?? ""}
                    </div>
                  ) : null}
                </div>
              ))}
              {alightingStops.length === 0 ? (
                <div className="text-body text-sub">下车点信息未发布</div>
              ) : null}
            </div>
          </div>
        </div>

        {/* 右侧操作 */}
        <div className="flex w-[104px] shrink-0 flex-col gap-2.5">
          <button
            type="button"
            className="flex items-center justify-center gap-1 rounded-full bg-primary py-2.5 text-aux font-medium text-white active:bg-primary-pressed disabled:opacity-40"
            disabled={!fromStop}
            onClick={() => goPoi(fromStop)}
          >
            <MapPin size={13} />
            查看上车点
          </button>
          <button
            type="button"
            className="flex items-center justify-center gap-1 rounded-full bg-primary py-2.5 text-aux font-medium text-white active:bg-primary-pressed disabled:opacity-40"
            disabled={!toStop}
            onClick={() => goPoi(toStop)}
          >
            <MapPin size={13} />
            查看下车点
          </button>
        </div>
      </div>

      {schedule.isReservation ? (
        <button
          type="button"
          className="mt-6 w-full rounded-full bg-primary py-3 text-body font-semibold text-white active:bg-primary-pressed"
          onClick={() => window.open(schedule.bookingUrl ?? BOOKING_SITE_URL, "_blank")}
        >
          预约此班次
        </button>
      ) : null}
    </div>
  );
}

/** M7 班次路线预览（移动端底部弹卡）。 */
function TripPreviewSheet({
  schedule,
  fromStop,
  toStop,
  onClose,
}: {
  schedule: ScheduleItem | null;
  fromStop: TransitStop | null;
  toStop: TransitStop | null;
  onClose: () => void;
}) {
  return (
    <SheetModal open={schedule !== null} onClose={onClose} initialHeight={0.55}>
      {schedule ? (
        <TripPreviewContent schedule={schedule} fromStop={fromStop} toStop={toStop} onClose={onClose} />
      ) : null}
    </SheetModal>
  );
}

/** M3 校车时刻表。 */
export function ShuttlePage() {
  const navigate = useNavigate();
  const { status: releaseStatus, release } = useRelease();
  const isDesktop = useBreakpoint() === "desktop";
  const stops = useMemo(() => release?.manifest.transit.stops ?? [], [release]);

  const [fromStop, setFromStop] = useState<TransitStop | null>(null);
  const [toStop, setToStop] = useState<TransitStop | null>(null);
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [scheduleState, setScheduleState] = useState<ScheduleState>({ status: "loading" });
  const [previewTrip, setPreviewTrip] = useState<ScheduleItem | null>(null);
  const now = useNow(30_000);
  const nowDate = new Date(now);

  // release 就绪后初始化默认线路（保持旧默认：宝山 → 嘉定）
  const initializedRef = useRef(false);
  useEffect(() => {
    if (initializedRef.current || stops.length === 0) return;
    initializedRef.current = true;
    const byName = (name: string) => stops.find((stop) => stop.name.includes(name));
    setFromStop(byName("宝山") ?? stops[0]);
    setToStop(byName("嘉定") ?? stops[1] ?? stops[0]);
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

  const daySchedules = scheduleState.status === "ready" ? scheduleState.schedules : EMPTY_SCHEDULES;

  const { nextReservation, nextNonReservation, otherBuses } = useMemo(() => {
    const remaining = todayFlag ? getRemainingBuses(daySchedules, nowDate) : daySchedules;
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
  }, [daySchedules, todayFlag, now]);

  const handleSwap = () => {
    setFromStop(toStop);
    setToStop(fromStop);
  };

  const handleTimeClick = (departureTime: string) => {
    const remaining = todayFlag ? getRemainingBuses(daySchedules, nowDate) : daySchedules;
    const trip = remaining.find((schedule) => schedule.departureTime === departureTime);
    if (trip) setPreviewTrip(trip);
  };

  if (releaseStatus === "loading") {
    return <div className="h-full bg-page"><LoadingState label="正在加载校车数据…" /></div>;
  }
  if (releaseStatus === "empty" || releaseStatus === "error") {
    return (
      <div className="h-full bg-page px-5 pt-16">
        <EmptyState
          title={releaseStatus === "empty" ? "班次数据尚未发布" : "班次数据加载失败"}
          subtitle={releaseStatus === "empty" ? "当前没有已发布的校车数据\n请稍后再试或联系管理员发布" : "请检查网络后重试"}
        />
      </div>
    );
  }

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
        ) : daySchedules.length === 0 ? (
          <EmptyState
            title={todayFlag ? "今日无班次" : "当日无班次"}
            subtitle={fromStop?.id === toStop?.id ? "起点和终点相同" : "请尝试更换日期或线路"}
          />
        ) : (
          <>
            {/* 最近一班（仅今天） */}
            {todayFlag && (nextReservation || nextNonReservation) ? (
              <div className="mt-5">
                <SectionHeader title="最近一班" />
                <div className="mt-2.5 flex gap-3">
                  {heroCard(nextReservation, "预约车", "reservation")}
                  {heroCard(nextNonReservation, "非预约车", "nonReservation")}
                </div>
              </div>
            ) : null}

            {/* 时刻网格 */}
            {otherBuses.length > 0 ? (
              <div className="mt-5">
                <SectionHeader title={todayFlag ? "今日其他班次" : "当日班次"} />
                <div className="mt-2.5 rounded-2xl bg-surface px-5 py-2 shadow-card">
                  <div className="grid grid-cols-2">
                    {otherBuses.map((item, index) => (
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
                <SectionHeader
                  title="上下车点说明"
                  action={<span className="text-label">点位可跳地图 ›</span>}
                />
                <div className="mt-2.5 rounded-2xl bg-surface px-5 py-1.5 shadow-card">
                  {[
                    { label: "上车点", stop: fromStop },
                    { label: "下车点", stop: toStop },
                  ].map(({ label, stop }, index) => {
                    const poiKey = release ? stopToPoiKey(stop, release.buildings) : null;
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
          onClose={() => setPreviewTrip(null)}
        />
      ) : null}
    </div>
  );
}
