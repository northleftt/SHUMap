// 客户端日型推导：管理端「日历管理」「就餐安排」两个页面的日历预览共用。
//
// 口径与 worker/lib/daytype.ts 的校历部分一致（临时规则日历不在这里推导，
// 预览只画校历能决定的部分）：
//   1. 调休工作日列表（workday_override）→ weekday
//   2. 法定节假日列表（holiday）→ holiday
//   3. 假期区间（winter_break / summer_break）
//   4. 周六日 → weekend
//   5. 其余 → weekday

export type CampusDayType = "weekday" | "weekend" | "holiday" | "winter_break" | "summer_break";

export interface DayTypeTerm {
  dayType: string;
  validFrom: string;
  validTo: string;
}

export interface DayTypeDate {
  serviceDate: string;
  kind: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 上海时区的星期（与 worker 的 shanghaiWeekday 同口径，不受浏览器 TZ 影响）。非法日期返回 null。 */
export function shanghaiWeekday(date: string): string | null {
  if (!DATE_RE.test(date)) return null;
  return new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", weekday: "long" })
    .format(new Date(`${date}T12:00:00+08:00`))
    .toLowerCase();
}

/** 某天是否周末（周六 / 周日，上海时区）。非法日期返回 false。 */
export function isWeekend(date: string): boolean {
  const weekday = shanghaiWeekday(date);
  return weekday === "saturday" || weekday === "sunday";
}

/**
 * 推导某天的校园日型。terms 跨学年混合传入即可（服务端判定也不分学年）；
 * 只有 dayType 为 winter_break / summer_break 的区间参与，term 区间不影响结果。
 */
export function deriveDayType(
  date: string,
  terms: readonly DayTypeTerm[],
  dates: readonly DayTypeDate[],
): CampusDayType {
  for (const kind of ["workday_override", "holiday"] as const) {
    if (dates.some((special) => special.serviceDate === date && special.kind === kind)) {
      return kind === "workday_override" ? "weekday" : "holiday";
    }
  }
  for (const term of terms) {
    if (term.dayType !== "winter_break" && term.dayType !== "summer_break") continue;
    if (term.validFrom <= date && date <= term.validTo) return term.dayType;
  }
  if (isWeekend(date)) return "weekend";
  return "weekday";
}

/** 「2025-2026」→「2026-2027」。解析不了（不是「数字-数字」结构）时返回空串，交给用户填。 */
export function nextAcademicYearName(name: string): string {
  const match = /^(\d{2,4})\s*[-–—]\s*(\d{2,4})$/.exec(name.trim());
  if (!match) return "";
  return `${Number(match[1]) + 1}-${Number(match[2]) + 1}`;
}

/** 月份网格：每周一开头，返回 6×7 的日期串（YYYY-MM-DD），不属于当月的格子为 null。 */
export function monthGrid(year: number, month: number): Array<string | null>[] {
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (first.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const weeks: Array<string | null>[] = [];
  let day = 1 - offset;
  while (day <= daysInMonth) {
    const week: Array<string | null> = [];
    for (let i = 0; i < 7; i += 1) {
      if (day < 1 || day > daysInMonth) {
        week.push(null);
      } else {
        const mm = String(month + 1).padStart(2, "0");
        const dd = String(day).padStart(2, "0");
        week.push(`${year}-${mm}-${dd}`);
      }
      day += 1;
    }
    weeks.push(week);
  }
  return weeks;
}
