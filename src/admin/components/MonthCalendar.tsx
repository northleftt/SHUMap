import { monthGrid } from "../../lib/calendar/dayType";

// 单月日历格子（周一开头）。「日历管理」与「就餐安排」的双月预览共用：
// 每天的着色与点击行为由 renderDay 交给页面决定，这里只管排版。

const WEEK_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

export interface DayCell {
  className?: string;
  onClick?: () => void;
  title?: string;
}

export function MonthCalendar({
  year,
  month,
  renderDay,
}: {
  year: number;
  /** 0-based（0 = 一月）。 */
  month: number;
  renderDay: (date: string) => DayCell;
}) {
  const weeks = monthGrid(year, month);
  return (
    <div className="min-w-0 flex-1">
      <p className="mb-2 text-center text-aux font-semibold text-ink">
        {year} 年 {month + 1} 月
      </p>
      <div className="grid grid-cols-7 gap-1">
        {WEEK_LABELS.map((label) => (
          <span className="grid h-7 place-items-center text-label text-sub" key={label}>{label}</span>
        ))}
        {weeks.flat().map((date, index) => {
          if (date === null) return <span key={`blank-${index}`} />;
          const cell = renderDay(date);
          return (
            <button
              className={`grid h-8 place-items-center rounded-md text-aux ${cell.className ?? "text-ink"} ${
                cell.onClick ? "cursor-pointer" : "cursor-default"
              }`}
              disabled={!cell.onClick}
              key={date}
              onClick={cell.onClick}
              title={cell.title}
              type="button"
            >
              {Number(date.slice(8, 10))}
            </button>
          );
        })}
      </div>
    </div>
  );
}
