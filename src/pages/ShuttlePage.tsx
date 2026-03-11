import { useState, useMemo, useEffect } from "react";
import {
  getCampuses,
  formatDate,
  type Campus,
  type ScheduleItem,
  getCurrentDateBucket,
  getRemainingBuses,
  getTodaySchedules,
} from "../utils/shuttle";

const ArrowDownIcon = () => (
  <svg width="12" height="8" viewBox="0 0 12 8" fill="none">
    <path d="M1 1.5L6 6.5L11 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

// 交换图标 - 按照设计稿的循环箭头样式
const ExchangeIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
    <path
      d="M7 16V4M7 4L3 8M7 4l4 4"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M17 8v12m0 0l4-4m-4 4l-4-4"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const LocationIcon = () => (
  <svg width="16" height="20" viewBox="0 0 14 18" fill="none">
    <path d="M7 0.5C3.5 0.5 0.5 3.3 0.5 6.8C0.5 10.3 3.5 13.1 7 17.5C10.5 13.1 13.5 10.3 13.5 6.8C13.5 3.3 10.5 0.5 7 0.5ZM7 9C5.9 9 5 8.1 5 7C5 5.9 5.9 5 7 5C8.1 5 9 5.9 9 7C9 8.1 8.1 9 7 9Z" stroke="currentColor" strokeWidth="1.2" fill="none"/>
  </svg>
);

const LeftArrowIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path
      d="M11 7H3.5"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M6.5 3.5L3 7L6.5 10.5"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

interface TimeSelectorProps {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  label: string;
}

function TimeSelector({ value, onChange, min, max, label }: TimeSelectorProps) {
  return (
    <div className="flex items-center gap-1">
      <div className="relative">
        <select
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="appearance-none bg-[#F1F5F9] text-[#0F172A] text-xl font-medium py-1.5 pl-3 pr-8 rounded-lg border-none outline-none cursor-pointer min-w-[50px]"
        >
          {Array.from({ length: max - min + 1 }, (_, i) => min + i).map((num) => (
            <option key={num} value={num}>
              {num}
            </option>
          ))}
        </select>
        <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-[#6F7C8E]">
          <ArrowDownIcon />
        </div>
      </div>
      <span className="text-lg text-[#0F172A] font-medium">{label}</span>
    </div>
  );
}

interface CampusSelectorProps {
  value: Campus | "";
  onChange: (value: Campus) => void;
  placeholder: string;
  exclude?: Campus;
}

function CampusSelector({ value, onChange, placeholder, exclude }: CampusSelectorProps) {
  const campuses = getCampuses().filter((c) => c !== exclude);
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`w-full flex items-center justify-between px-4 py-3 bg-white rounded-[21px] border transition-colors ${
          isOpen ? "border-[#1E80C1]" : "border-transparent"
        }`}
      >
        <span className={value ? "text-[#0F172A] text-lg" : "text-[#6F7C8E] text-lg"}>
          {value || placeholder}
        </span>
        <ArrowDownIcon />
      </button>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-30"
            onClick={() => setIsOpen(false)}
          />
          <div className="absolute top-full left-0 right-0 mt-2 bg-white rounded-[16px] shadow-lg border border-[#CBD5E1]/30 py-2 z-40 max-h-48 overflow-auto">
            {campuses.map((campus) => (
              <button
                key={campus}
                onClick={() => {
                  onChange(campus);
                  setIsOpen(false);
                }}
                className={`w-full text-left px-4 py-3 text-base transition-colors ${
                  value === campus
                    ? "text-[#1E80C1] bg-[#D7E8F3]/30"
                    : "text-[#6F7C8E] hover:bg-[#F1F5F9]"
                }`}
              >
                {campus}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

type ScheduleStatus = "reservation" | "nonReservation" | "mixed";

interface DisplayScheduleItem {
  departureTime: string;
  status: ScheduleStatus;
}

interface RecentBusItem {
  departureTime: string;
  status: Exclude<ScheduleStatus, "mixed">;
  label: string;
}

function mergeSchedulesByTime(schedules: ScheduleItem[]): DisplayScheduleItem[] {
  const merged = new Map<string, { hasReservation: boolean; hasNonReservation: boolean }>();

  schedules.forEach((schedule) => {
    const current = merged.get(schedule.departureTime) ?? {
      hasReservation: false,
      hasNonReservation: false,
    };

    if (schedule.isReservation) {
      current.hasReservation = true;
    } else {
      current.hasNonReservation = true;
    }

    merged.set(schedule.departureTime, current);
  });

  return Array.from(merged.entries()).map(([departureTime, availability]) => ({
    departureTime,
    status:
      availability.hasReservation && availability.hasNonReservation
        ? "mixed"
        : availability.hasReservation
          ? "reservation"
          : "nonReservation",
  }));
}

function getScheduleStatusTextClass(status: Exclude<ScheduleStatus, "mixed">): string {
  return status === "reservation" ? "text-[var(--color-primary)]" : "text-[var(--color-text-muted)]";
}

function ScheduleStatusInline({
  status,
  size = "text-xs",
}: {
  status: ScheduleStatus;
  size?: string;
}) {
  if (status === "mixed") {
    return (
      <span className={`inline-flex items-center gap-1 whitespace-nowrap font-medium ${size}`}>
        <span className={getScheduleStatusTextClass("reservation")}>预</span>
        <span className={getScheduleStatusTextClass("nonReservation")}>非</span>
      </span>
    );
  }

  return (
    <span className={`whitespace-nowrap font-medium ${size} ${getScheduleStatusTextClass(status)}`}>
      {status === "reservation" ? "预" : "非"}
    </span>
  );
}

// 时刻表网格项 - 支持左中右对齐
function ScheduleTimeItem({
  time,
  status,
  align = "center"
}: {
  time: string;
  status: ScheduleStatus;
  align?: "left" | "center" | "right";
}) {
  const alignClass = {
    left: "justify-start",
    center: "justify-center",
    right: "justify-end",
  };

  return (
    <div className={`flex items-center gap-1.5 py-2 ${alignClass[align]}`}>
      <span className="text-base font-medium text-[#0F172A]">{time}</span>
      <ScheduleStatusInline status={status} />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center">
      <p className="text-[#6F7C8E] text-base">今日无班次</p>
      <p className="text-[#CBD5E1] text-sm mt-1">请尝试更换日期或线路</p>
    </div>
  );
}

// 判断是否是今天
function isToday(date: Date): boolean {
  const today = new Date();
  return (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  );
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getSafeDate(baseDate: Date, type: "month" | "day", value: number): Date {
  const year = baseDate.getFullYear();
  const month = type === "month" ? value - 1 : baseDate.getMonth();
  const dayLimit = getDaysInMonth(year, month);
  const day = type === "day" ? Math.min(value, dayLimit) : Math.min(baseDate.getDate(), dayLimit);

  return new Date(year, month, day);
}

export function ShuttlePage() {
  const [from, setFrom] = useState<Campus>("宝山校区");
  const [to, setTo] = useState<Campus>("嘉定校区");
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [currentTime, setCurrentTime] = useState(new Date());

  // 每分钟更新当前时间
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 60000);
    return () => clearInterval(timer);
  }, []);

  const dateInfo = useMemo(() => formatDate(selectedDate), [selectedDate]);
  const dateBucket = useMemo(() => getCurrentDateBucket(selectedDate), [selectedDate]);
  const todayFlag = useMemo(() => isToday(selectedDate), [selectedDate]);
  const dayMax = useMemo(
    () => getDaysInMonth(selectedDate.getFullYear(), selectedDate.getMonth()),
    [selectedDate],
  );

  // 计算显示的班次
  const { visibleSchedules, recentBuses } = useMemo(() => {
    const allSchedules = getTodaySchedules(from, to, selectedDate);
    const remainingSchedules = todayFlag ? getRemainingBuses(allSchedules, currentTime) : allSchedules;
    const visibleSchedules = mergeSchedulesByTime(remainingSchedules);

    if (!todayFlag) {
      return { visibleSchedules, recentBuses: [] as RecentBusItem[] };
    }

    const nextReservationBus = remainingSchedules.find((schedule) => schedule.isReservation);
    const nextNonReservationBus = remainingSchedules.find((schedule) => !schedule.isReservation);
    const recentBuses: RecentBusItem[] = [];

    if (nextReservationBus) {
      recentBuses.push({
        departureTime: nextReservationBus.departureTime,
        status: "reservation",
        label: "最近预约车",
      });
    }

    if (nextNonReservationBus) {
      recentBuses.push({
        departureTime: nextNonReservationBus.departureTime,
        status: "nonReservation",
        label: "最近非预约车",
      });
    }

    return {
      visibleSchedules,
      recentBuses,
    };
  }, [from, to, selectedDate, currentTime, todayFlag]);

  // 其他时刻（排除最近一班）
  const otherBuses = useMemo(() => {
    if (!todayFlag || recentBuses.length === 0) return visibleSchedules;

    const recentDepartureTimes = new Set(recentBuses.map((schedule) => schedule.departureTime));
    return visibleSchedules.filter((schedule) => !recentDepartureTimes.has(schedule.departureTime));
  }, [todayFlag, visibleSchedules, recentBuses]);

  const handleExchange = () => {
    setFrom(to);
    setTo(from);
  };

  const handleBackToToday = () => {
    const today = new Date();
    setSelectedDate(today);
    setCurrentTime(today);
  };

  const handleDateChange = (type: "month" | "day", value: number) => {
    setSelectedDate((currentSelectedDate) => getSafeDate(currentSelectedDate, type, value));
  };

  const bucketLabels: Record<string, string> = {
    weekday: "工作日",
    weekend: "周末",
    holiday: "假日",
    winterBreak: "寒假",
    summerBreak: "暑假",
  };

  // 将时刻分组显示（每行3个）
  const groupedBuses = useMemo(() => {
    const groups: DisplayScheduleItem[][] = [];
    for (let i = 0; i < otherBuses.length; i += 3) {
      groups.push(otherBuses.slice(i, i + 3));
    }
    return groups;
  }, [otherBuses]);

  return (
    <div className="h-full w-full bg-[#FFFBF2] flex flex-col overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-8 pt-12 pb-4">
        <h1 className="text-[28px] font-medium text-[#0F172A]">校车时刻表</h1>
        <button
          onClick={() => window.open("http://vcard.shu.edu.cn/shu-wechat-client/schoolbus/passenger/jumpToOrder", "_blank")}
          className="text-[15px] font-medium text-[#6F7C8E] hover:text-[#1E80C1] transition-colors flex items-center gap-1"
        >
          预约网站
          <span className="text-lg">›</span>
        </button>
      </header>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto px-8 pb-24">
        {/* Date Selector Row with Back to Today Button */}
        <div className="mb-4 flex items-center gap-1.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <TimeSelector
              value={dateInfo.month}
              onChange={(v) => handleDateChange("month", v)}
              min={1}
              max={12}
              label="月"
            />
            <TimeSelector
              value={dateInfo.day}
              onChange={(v) => handleDateChange("day", v)}
              min={1}
              max={dayMax}
              label="日"
            />
            <span className="ml-1 min-w-[2.2em] text-lg font-medium text-[#0F172A]">
              {dateInfo.weekday}
            </span>
          </div>
          {!todayFlag && (
            <button
              onClick={handleBackToToday}
              className="ml-3 inline-flex h-8 shrink-0 items-center gap-0.5 rounded-full bg-[var(--color-primary)] px-2.5 text-[13px] font-medium text-white transition-colors hover:bg-[var(--color-primary-dark)]"
              title="返回今日"
              aria-label="返回今日"
            >
              <LeftArrowIcon />
              <span>今日</span>
            </button>
          )}
        </div>

        {/* Date Bucket Label */}
        <div className="mb-3 text-xs text-[#6F7C8E]">
          当前：{bucketLabels[dateBucket]}
          {!todayFlag && <span className="ml-2 text-[var(--color-warning)]">（非今日，显示全部时刻）</span>}
        </div>

        {/* Route Selector Card */}
        <div className="bg-[#F1F5F9] rounded-[24px] p-4 mb-4">
          <div className="space-y-3">
            <CampusSelector
              value={from}
              onChange={setFrom}
              placeholder="出发地"
              exclude={to}
            />
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <CampusSelector
                  value={to}
                  onChange={setTo}
                  placeholder="目的地"
                  exclude={from}
                />
              </div>
              {/* 交换按钮 - 按照设计稿样式 */}
              <button
                onClick={handleExchange}
                className="w-10 h-10 flex items-center justify-center text-[#0F172A] hover:text-[#1E80C1] transition-colors"
                title="交换出发地和目的地"
              >
                <ExchangeIcon />
              </button>
            </div>
          </div>
        </div>

        {/* Next Bus Section - 仅当天显示 */}
        {todayFlag && recentBuses.length > 0 && (
          <div className="mb-5">
            <h2 className="text-xl font-semibold text-[#0F172A] mb-3">最近一班</h2>
            <div className="rounded-[20px] bg-white px-5 py-5">
              <div className={`grid gap-6 ${recentBuses.length === 2 ? "grid-cols-2" : "grid-cols-1"}`}>
                {recentBuses.map((bus) => (
                  <div
                    key={`${bus.status}-${bus.departureTime}`}
                    className={
                      recentBuses.length === 1
                        ? "justify-self-start"
                        : bus.status === "reservation"
                          ? "justify-self-start"
                          : "justify-self-center"
                    }
                  >
                    <p className="mb-2 text-sm font-medium text-[var(--color-primary)]">{bus.label}</p>
                    <span className="text-2xl font-semibold text-[#0F172A]">{bus.departureTime}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Other Buses Section */}
        {visibleSchedules.length > 0 && (
          <div className="mb-5">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-xl font-semibold text-[#0F172A]">
                {todayFlag ? "当日本线其他时刻" : "当日所有时刻"}
              </h2>
            </div>
            <p className="text-[13px] text-[#6F7C8E] mb-3">
              <span className="inline-flex items-center gap-1 mr-3">
                <span className="h-2 w-2 rounded-full bg-[var(--color-primary)]" />
                预=预约车
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-[#6F7C8E]" />
                非=非预约车
              </span>
            </p>

            {/* 时刻表网格 - 散格式布局：左对齐、居中、右对齐 */}
            <div className="bg-white rounded-[20px] px-6 py-4">
              {groupedBuses.length > 0 ? (
                <div className="space-y-1">
                  {groupedBuses.map((group, rowIndex) => (
                    <div key={rowIndex} className="grid grid-cols-3 gap-x-8">
                      {group[0] && (
                        <ScheduleTimeItem
                          time={group[0].departureTime}
                          status={group[0].status}
                          align="left"
                        />
                      )}
                      {group[1] && (
                        <ScheduleTimeItem
                          time={group[1].departureTime}
                          status={group[1].status}
                          align="left"
                        />
                      )}
                      {group[2] && (
                        <ScheduleTimeItem
                          time={group[2].departureTime}
                          status={group[2].status}
                          align="left"
                        />
                      )}
                    </div>
                  ))}
                </div>
              ) : todayFlag && recentBuses.length > 0 ? (
                <p className="text-[#6F7C8E] text-center py-4">无其他时刻</p>
              ) : null}
            </div>
          </div>
        )}

        {/* Bottom Actions */}
        <div className="flex items-center justify-between pt-4">
          <button
            onClick={() => {
              alert("乘车点导航功能即将上线");
            }}
            className="flex items-center gap-2 px-4 py-2.5 bg-[#F1F5F9] rounded-[19px] text-[14px] font-medium text-[#0F172A] hover:bg-[#E2E8F0] transition-colors"
          >
            <LocationIcon />
            乘车点导航
          </button>
          <button
            onClick={() => window.open("/docs/shuttle-schedule.pdf", "_blank")}
            className="flex items-center gap-1 text-[14px] font-medium text-[var(--color-text-muted)] transition-colors hover:text-[#0F172A]"
          >
            查看全部时刻表
            <span className="text-lg">›</span>
          </button>
        </div>
      </div>
    </div>
  );
}
