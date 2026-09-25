import { Check, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import * as admin from "../../lib/api/admin";
import type { DiningDayType, DiningMeal, DiningScheduleRow, ListResponse } from "../../lib/api/admin";
import { ApiError } from "../../lib/api/client";
import { deriveDayType, type CampusDayType } from "../../lib/calendar/dayType";
import type { PlaceDetailResponse, PlaceListItem, SpacesResponse } from "../adminTypes";
import {
  Chip,
  EmptyState,
  ErrorBanner,
  Field,
  GhostButton,
  LoadingState,
  Panel,
  PrimaryButton,
  errorMessage,
  useAsyncData,
} from "../components/primitives";
import { MonthCalendar } from "../components/MonthCalendar";

// ---------------------------------------------------------------------------
// A16 + A17 就餐安排
//
// 「开放安排」：某段日期、某些日型下哪些食堂楼层开放（勾 = 开放），即时生效。
// 「供餐时段」：全局三餐时段表，整表替换保存。
// 日型判定与校历同口径（src/lib/calendar/dayType.ts），右卡日历用校历推导
// 周末 / 假日，标出「该录还没录安排」的日子。
// ---------------------------------------------------------------------------

type Tab = "schedules" | "periods";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "schedules", label: "开放安排" },
  { key: "periods", label: "供餐时段" },
];

// 适用日型不含「工作日」：工作日默认全开是常态，worker 也拒录 weekday（DINING_DAY_TYPES）。
// 台风天这类例外应录进校历当特殊日，再由 holiday 类安排承接。
const DAY_TYPE_OPTIONS: Array<{ value: DiningDayType; label: string }> = [
  { value: "weekend", label: "周末" },
  { value: "holiday", label: "假日" },
  { value: "winter_break", label: "寒假" },
  { value: "summer_break", label: "暑假" },
];

const MEAL_ORDER: DiningMeal[] = ["breakfast", "lunner", "latenight"];
const MEAL_LABELS: Record<DiningMeal, string> = {
  breakfast: "早餐",
  lunner: "午晚餐",
  latenight: "夜宵",
};

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const ERROR_TEXT: Record<string, string> = {
  validation_error: "填写的内容不完整或不正确：日期必填且开始不能晚于结束，时间格式为 07:30 且开始早于结束。",
  forbidden: "当前账号没有维护就餐安排的权限。",
  unauthorized: "登录状态已失效，请重新登录。",
  not_found: "这条记录不存在，可能已被其他人改动，刷新后再试。",
};

function diningError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return ERROR_TEXT[err.code] ?? err.message ?? fallback;
  return errorMessage(err, fallback);
}

/** 食堂勾选树用的数据：食堂（kindId === 'canteen' 的地点）+ 它的楼层，按校区分组。 */
interface CanteenEntry {
  id: string;
  name: string;
  campusId: string | null;
  floors: Array<{ id: string; displayName: string; levelOrder: number }>;
}

interface DiningMeta {
  campuses: Array<{ id: string; name: string }>;
  canteens: CanteenEntry[];
}

export function DiningPage() {
  const dining = useAsyncData((signal) => admin.listDiningAdmin(signal), []);
  const calendar = useAsyncData((signal) => admin.listAcademicYears(signal), []);

  // reload 会把 useAsyncData 重置回 loading；若此时直接渲染 LoadingState，整个
  // 编辑面板会被卸载重挂，表单草稿全部丢失。留住最近一次成功数据（TransitPage 同款处理）。
  // 三个数据源都要留：保存任何一项都会广播 admin 数据变更，calendar/meta 也会同时回 loading。
  const [lastDining, setLastDining] = useState<admin.DiningAdminResponse | null>(null);
  useEffect(() => {
    if (dining.state.status === "ready") setLastDining(dining.state.data);
  }, [dining.state]);
  const [lastCalendar, setLastCalendar] = useState<ListResponse<admin.AcademicYearRow> | null>(null);
  useEffect(() => {
    if (calendar.state.status === "ready") setLastCalendar(calendar.state.data);
  }, [calendar.state]);

  const meta = useAsyncData<DiningMeta>(async (signal) => {
    const [places, spaces] = await Promise.all([
      admin.listAdminPlaces<PlaceListItem>(signal),
      admin.listSpaces<SpacesResponse>(signal),
    ]);
    const canteenRows = places.items.filter(
      (place) => place.kindId === "canteen" && place.lifecycleStatus !== "retired",
    );
    const details = await Promise.all(canteenRows.map((place) => admin.getAdminPlace<PlaceDetailResponse>(place.id, signal)));
    return {
      campuses: spaces.campuses.map((campus) => ({ id: campus.id, name: campus.name })),
      canteens: canteenRows.map((place, index) => ({
        id: place.id,
        name: place.displayName ?? place.id,
        campusId: place.campusId,
        floors: [...(details[index]?.floors ?? [])]
          .sort((a, b) => a.levelOrder - b.levelOrder)
          .map((floor) => ({ id: floor.id, displayName: floor.displayName, levelOrder: floor.levelOrder })),
      })),
    };
  }, []);
  const [lastMeta, setLastMeta] = useState<DiningMeta | null>(null);
  useEffect(() => {
    if (meta.state.status === "ready") setLastMeta(meta.state.data);
  }, [meta.state]);

  const [tab, setTab] = useState<Tab>("schedules");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function mutate(action: () => Promise<unknown>, fallback: string): Promise<boolean> {
    setBusy(true);
    setError("");
    try {
      await action();
      dining.reload();
      return true;
    } catch (reason) {
      setError(diningError(reason, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (dining.state.status === "error" && lastDining === null) return <ErrorBanner message={dining.state.message} />;
  if (calendar.state.status === "error" && lastCalendar === null) return <ErrorBanner message={calendar.state.message} />;
  if (meta.state.status === "error" && lastMeta === null) return <ErrorBanner message={meta.state.message} />;
  if (lastDining === null || lastCalendar === null || lastMeta === null) {
    return <LoadingState label="加载就餐安排…" />;
  }

  const terms = lastCalendar.items.flatMap((year) => year.terms);
  const dates = lastCalendar.items.flatMap((year) => year.dates);
  const dayTypeOf = (date: string): CampusDayType => deriveDayType(date, terms, dates);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((item) => (
          <Chip active={tab === item.key} key={item.key} onClick={() => { setTab(item.key); setError(""); }}>
            {item.label}
          </Chip>
        ))}
      </div>

      <ErrorBanner message={error} />

      {tab === "schedules" ? (
        <SchedulesPanel
          busy={busy}
          dayTypeOf={dayTypeOf}
          meta={lastMeta}
          mutate={mutate}
          schedules={lastDining.schedules}
        />
      ) : (
        <PeriodsPanel busy={busy} mutate={mutate} periods={lastDining.mealPeriods} />
      )}
    </div>
  );
}

// ===========================================================================
// A16 开放安排
// ===========================================================================

interface PanelProps {
  busy: boolean;
  mutate: (action: () => Promise<unknown>, fallback: string) => Promise<boolean>;
}

/** 区间覆盖到的全部日型（按 DAY_TYPE_OPTIONS 顺序去重），用于两次点击选区间后的默认值。 */
function dayTypesInRange(from: string, to: string, dayTypeOf: (date: string) => CampusDayType): DiningDayType[] {
  const found = new Set<string>();
  const cursor = new Date(`${from}T12:00:00+08:00`);
  const end = new Date(`${to}T12:00:00+08:00`);
  while (cursor <= end) {
    found.add(dayTypeOf(cursor.toISOString().slice(0, 10)));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return DAY_TYPE_OPTIONS.map((option) => option.value).filter((value) => found.has(value));
}

/** 某天命中的安排：日期落在区间内且当天日型在适用日型里；多条命中取最近更新的（与公开读端一致，updated_at 相同按 id 决胜）。 */
function arrangementFor(
  schedules: DiningScheduleRow[],
  date: string,
  dayType: CampusDayType,
): DiningScheduleRow | null {
  const hits = schedules.filter(
    (schedule) => schedule.validFrom <= date && date <= schedule.validTo && schedule.dayTypes.includes(dayType),
  );
  if (hits.length === 0) return null;
  return [...hits].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))[0] ?? null;
}

function SchedulesPanel({
  schedules,
  meta,
  dayTypeOf,
  busy,
  mutate,
}: PanelProps & {
  schedules: DiningScheduleRow[];
  meta: DiningMeta;
  dayTypeOf: (date: string) => CampusDayType;
}) {
  // editingId 为 null = 新建；点右侧日历的日期把当天命中的安排载进来编辑。
  const [editingId, setEditingId] = useState<string | null>(null);
  const [validFrom, setValidFrom] = useState("");
  const [validTo, setValidTo] = useState("");
  const [dayTypes, setDayTypes] = useState<DiningDayType[]>([]);
  const [floors, setFloors] = useState<Record<string, { noBreakfast: boolean }>>({});
  const [rangeAnchor, setRangeAnchor] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [formError, setFormError] = useState("");

  const campusName = useMemo(() => {
    const map = new Map(meta.campuses.map((campus) => [campus.id, campus.name]));
    return (id: string | null) => (id === null ? "未分校区" : (map.get(id) ?? id));
  }, [meta.campuses]);

  const campusGroups = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, CanteenEntry[]>();
    for (const canteen of meta.canteens) {
      const key = canteen.campusId ?? "";
      if (!map.has(key)) {
        map.set(key, []);
        order.push(key);
      }
      map.get(key)!.push(canteen);
    }
    return order.map((key) => ({ campusId: key, canteens: map.get(key)! }));
  }, [meta.canteens]);

  const now = new Date();
  const months = [
    { year: now.getFullYear(), month: now.getMonth() },
    (() => { const d = new Date(now.getFullYear(), now.getMonth() + 1, 1); return { year: d.getFullYear(), month: d.getMonth() }; })(),
  ];

  /**
   * 日历点击：已有安排的日期载入编辑；否则两次点击选区间——第一下锚定（预填单日），
   * 第二下闭合（起止取两端，适用日型取区间覆盖到的全部日型）。再点锚点本身 = 单日。
   */
  function handleDayClick(date: string) {
    setConfirmDelete(false);
    setNotice("");
    setFormError("");
    const hit = arrangementFor(schedules, date, dayTypeOf(date));
    if (hit) {
      setRangeAnchor(null);
      setEditingId(hit.id);
      setValidFrom(hit.validFrom);
      setValidTo(hit.validTo);
      setDayTypes(hit.dayTypes);
      setFloors(Object.fromEntries(hit.floors.map((floor) => [floor.floorId, { noBreakfast: floor.noBreakfast }])));
      return;
    }
    setEditingId(null);
    setFloors({});
    if (rangeAnchor === null || rangeAnchor === date) {
      setRangeAnchor(rangeAnchor === date ? null : date);
      setValidFrom(date);
      setValidTo(date);
      setDayTypes([dayTypeOf(date)]);
    } else {
      const [from, to] = rangeAnchor < date ? [rangeAnchor, date] : [date, rangeAnchor];
      setRangeAnchor(null);
      setValidFrom(from);
      setValidTo(to);
      setDayTypes(dayTypesInRange(from, to, dayTypeOf));
    }
  }

  function resetForm() {
    setEditingId(null);
    setValidFrom("");
    setValidTo("");
    setDayTypes([]);
    setFloors({});
    setRangeAnchor(null);
    setConfirmDelete(false);
    setFormError("");
  }

  function toggleFloor(floorId: string) {
    setFloors((current) => {
      const next = { ...current };
      if (next[floorId]) delete next[floorId];
      else next[floorId] = { noBreakfast: false };
      return next;
    });
    setNotice("");
  }

  function toggleCanteen(canteen: CanteenEntry) {
    setFloors((current) => {
      const next = { ...current };
      const allChecked = canteen.floors.length > 0 && canteen.floors.every((floor) => next[floor.id]);
      for (const floor of canteen.floors) {
        if (allChecked) delete next[floor.id];
        else if (!next[floor.id]) next[floor.id] = { noBreakfast: false };
      }
      return next;
    });
    setNotice("");
  }

  function toggleDayType(value: DiningDayType) {
    setDayTypes((current) => (current.includes(value) ? current.filter((item) => item !== value) : [...current, value]));
    setNotice("");
  }

  function validate(): string {
    if (!validFrom || !validTo) return "请填写开始与结束日期";
    if (validFrom > validTo) return "开始日期不能晚于结束日期";
    if (dayTypes.length === 0) return "请至少选择一种适用日型";
    return "";
  }

  async function save() {
    const problem = validate();
    if (problem) {
      setFormError(problem);
      return;
    }
    setFormError("");
    const body = {
      validFrom,
      validTo,
      dayTypes,
      floors: Object.entries(floors).map(([floorId, value]) => ({ floorId, noBreakfast: value.noBreakfast })),
    };
    const ok = await mutate(
      () => (editingId === null ? admin.createDiningSchedule(body) : admin.updateDiningSchedule(editingId, body)),
      "保存安排失败，请稍后重试",
    );
    if (ok) setNotice("已保存");
  }

  async function remove() {
    if (editingId === null) return;
    const id = editingId;
    const ok = await mutate(() => admin.deleteDiningSchedule(id), "删除安排失败，请稍后重试");
    if (ok) resetForm();
  }

  const openCount = Object.keys(floors).length;

  function calendarCell(date: string) {
    const dayType = dayTypeOf(date);
    const hit = arrangementFor(schedules, date, dayType);
    const inRange = validFrom !== "" && validTo !== "" && date >= validFrom && date <= validTo;
    let className = "text-ink";
    if (date === rangeAnchor) className = "bg-primary text-white font-semibold";
    else if (inRange) className = "bg-primary-container text-primary font-semibold";
    else if (hit) className = "bg-primary-container text-primary";
    else if (dayType !== "weekday") className = "bg-chip text-sub";
    return {
      className,
      onClick: () => handleDayClick(date),
      title: hit ? "已有安排，点击载入编辑" : dayType !== "weekday" ? "周末 / 假日未录入就餐安排" : undefined,
    };
  }

  return (
    <div className="grid grid-cols-[1fr_460px] items-start gap-4">
      <Panel
        title={editingId === null ? "新建开放安排" : "编辑开放安排"}
        action={
          editingId !== null ? (
            confirmDelete ? (
              <span className="flex items-center gap-2">
                <button
                  className="text-aux font-medium text-error disabled:opacity-50"
                  disabled={busy}
                  onClick={() => void remove()}
                  type="button"
                >
                  {busy ? "删除中…" : "确认删除"}
                </button>
                <button className="text-aux text-sub" onClick={() => setConfirmDelete(false)} type="button">取消</button>
              </span>
            ) : (
              <button className="text-aux font-medium text-error" onClick={() => setConfirmDelete(true)} type="button">
                删除
              </button>
            )
          ) : null
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="开始日期" onChange={(value) => { setValidFrom(value); setNotice(""); }} type="date" value={validFrom} />
            <Field label="结束日期" onChange={(value) => { setValidTo(value); setNotice(""); }} type="date" value={validTo} />
          </div>

          <div>
            <span className="mb-1.5 block text-label text-sub">适用日型</span>
            <div className="flex flex-wrap gap-2">
              {DAY_TYPE_OPTIONS.map((option) => (
                <Chip active={dayTypes.includes(option.value)} key={option.value} onClick={() => toggleDayType(option.value)}>
                  {option.label}
                </Chip>
              ))}
            </div>
          </div>

          <div>
            <span className="mb-1.5 block text-label text-sub">开放楼层勾选（勾 = 开放，未勾 = 休息）</span>
            {campusGroups.length === 0 ? (
              <EmptyState label="暂无食堂地点" />
            ) : (
              <div className="space-y-3">
                {campusGroups.map((group) => (
                  <div key={group.campusId || "none"}>
                    <p className="mb-1 text-aux font-semibold text-sub">{campusName(group.campusId || null)}</p>
                    <div className="space-y-2">
                      {group.canteens.map((canteen) => {
                        const checkedCount = canteen.floors.filter((floor) => floors[floor.id]).length;
                        const allChecked = canteen.floors.length > 0 && checkedCount === canteen.floors.length;
                        return (
                          <div className="rounded-lg bg-page p-3" key={canteen.id}>
                            <label className="flex cursor-pointer items-center gap-2">
                              <input
                                checked={allChecked}
                                className="accent-primary"
                                onChange={() => toggleCanteen(canteen)}
                                type="checkbox"
                              />
                              <span className="text-body font-semibold text-ink">{canteen.name}</span>
                              <span className="text-label text-sub">
                                {canteen.floors.length === 0 ? "暂无楼层" : `${checkedCount}/${canteen.floors.length} 层开放`}
                              </span>
                            </label>
                            {canteen.floors.length > 0 ? (
                              <div className="mt-2 space-y-1.5 pl-6">
                                {canteen.floors.map((floor) => {
                                  const entry = floors[floor.id];
                                  return (
                                    <div className="flex items-center gap-3" key={floor.id}>
                                      <label className="flex flex-1 cursor-pointer items-center gap-2">
                                        <input
                                          checked={entry !== undefined}
                                          className="accent-primary"
                                          onChange={() => toggleFloor(floor.id)}
                                          type="checkbox"
                                        />
                                        <span className="text-aux text-ink">{floor.displayName}</span>
                                      </label>
                                      {entry !== undefined ? (
                                        <label className="flex cursor-pointer items-center gap-1.5 text-label text-sub">
                                          <input
                                            checked={entry.noBreakfast}
                                            className="accent-primary"
                                            onChange={() => {
                                              setFloors((current) => ({
                                                ...current,
                                                [floor.id]: { noBreakfast: !entry.noBreakfast },
                                              }));
                                              setNotice("");
                                            }}
                                            type="checkbox"
                                          />
                                          无早餐供应
                                        </label>
                                      ) : null}
                                    </div>
                                  );
                                })}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <PrimaryButton disabled={busy} onClick={() => void save()}>
              <Check size={15} /> 保存安排
            </PrimaryButton>
            {editingId !== null || validFrom || dayTypes.length > 0 || openCount > 0 ? (
              <GhostButton disabled={busy} onClick={resetForm}>清空重填</GhostButton>
            ) : null}
            {notice ? <span className="text-aux text-success">{notice}</span> : null}
            {openCount > 0 ? <span className="ml-auto text-label text-sub">已勾 {openCount} 层</span> : null}
          </div>
          <ErrorBanner message={formError} />
        </div>
      </Panel>

      <Panel title="安排总览">
        <div className="space-y-4">
          <div className="flex gap-4">
            {months.map((item) => (
              <MonthCalendar
                key={`${item.year}-${item.month}`}
                month={item.month}
                renderDay={calendarCell}
                year={item.year}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-label text-sub">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-3 w-3 rounded bg-chip" />
              周末 / 假日未录入就餐安排
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-3 w-3 rounded bg-primary-container" />
              已有安排
            </span>
          </div>
        </div>
      </Panel>
    </div>
  );
}

// ===========================================================================
// A17 供餐时段
// ===========================================================================

interface PeriodRow {
  key: string;
  meal: DiningMeal;
  startTime: string;
  endTime: string;
}

let periodKey = 0;
function nextPeriodKey(): string {
  periodKey += 1;
  return `period-${periodKey}`;
}

function PeriodsPanel({
  periods,
  busy,
  mutate,
}: PanelProps & { periods: admin.DiningMealPeriodRow[] }) {
  const [rows, setRows] = useState<PeriodRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState("");
  const [formError, setFormError] = useState("");

  // 整表替换的草稿基线：未改动时跟随最新数据，改过以后不被后台刷新冲掉。
  useEffect(() => {
    if (dirty) return;
    setRows(periods.map((period) => ({
      key: nextPeriodKey(),
      meal: period.meal,
      startTime: period.startTime,
      endTime: period.endTime,
    })));
  }, [periods, dirty]);

  function patchRow(key: string, patch: Partial<PeriodRow>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
    setDirty(true);
    setNotice("");
  }

  async function save() {
    for (const row of rows) {
      if (!TIME_PATTERN.test(row.startTime) || !TIME_PATTERN.test(row.endTime)) {
        setFormError(`「${MEAL_LABELS[row.meal]}」有时段格式不对，应为 07:30`);
        return;
      }
      if (row.startTime >= row.endTime) {
        setFormError(`「${MEAL_LABELS[row.meal]}」${row.startTime}–${row.endTime}：开始时间要早于结束时间`);
        return;
      }
    }
    setFormError("");
    // 整表替换：数组顺序即展示顺序，按餐别固定顺序展开。
    const ordered = MEAL_ORDER.flatMap((meal) => rows.filter((row) => row.meal === meal));
    const ok = await mutate(
      () => admin.replaceMealPeriods(ordered.map((row, index) => ({
        meal: row.meal,
        startTime: row.startTime,
        endTime: row.endTime,
        sortOrder: (index + 1) * 10,
      }))),
      "保存时段表失败，请稍后重试",
    );
    if (ok) {
      setDirty(false);
      setNotice("已保存");
    }
  }

  return (
    <Panel title="供餐时段">
      <div className="space-y-5">
        {MEAL_ORDER.map((meal) => {
          const group = rows.filter((row) => row.meal === meal);
          return (
            <div key={meal}>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-body font-semibold text-ink">{MEAL_LABELS[meal]}</p>
                <button
                  className="flex items-center gap-1 text-aux font-medium text-primary"
                  onClick={() => {
                    setRows((current) => [...current, { key: nextPeriodKey(), meal, startTime: "", endTime: "" }]);
                    setDirty(true);
                    setNotice("");
                  }}
                  type="button"
                >
                  <Plus size={14} /> 添加时段
                </button>
              </div>
              {group.length === 0 ? (
                <EmptyState label={`暂无${MEAL_LABELS[meal]}时段`} />
              ) : (
                <div className="space-y-2">
                  {group.map((row) => (
                    <div className="flex items-center gap-2" key={row.key}>
                      <input
                        aria-label={`${MEAL_LABELS[meal]}开始时间`}
                        className="h-9 w-32 rounded-lg border border-line bg-surface px-3 text-body text-ink outline-none focus:border-primary"
                        onChange={(event) => patchRow(row.key, { startTime: event.target.value })}
                        type="time"
                        value={row.startTime}
                      />
                      <span className="text-sub">–</span>
                      <input
                        aria-label={`${MEAL_LABELS[meal]}结束时间`}
                        className="h-9 w-32 rounded-lg border border-line bg-surface px-3 text-body text-ink outline-none focus:border-primary"
                        onChange={(event) => patchRow(row.key, { endTime: event.target.value })}
                        type="time"
                        value={row.endTime}
                      />
                      <button
                        aria-label="删除时段"
                        className="grid h-8 w-8 place-items-center rounded-md text-error hover:bg-error-bg"
                        onClick={() => {
                          setRows((current) => current.filter((item) => item.key !== row.key));
                          setDirty(true);
                          setNotice("");
                        }}
                        type="button"
                      >
                        <X size={15} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        <ErrorBanner message={formError} />
        <div className="flex items-center gap-2">
          <PrimaryButton disabled={busy || !dirty} onClick={() => void save()}>
            <Check size={15} /> 保存时段表
          </PrimaryButton>
          {notice ? <span className="text-aux text-success">{notice}</span> : null}
        </div>
      </div>
    </Panel>
  );
}
