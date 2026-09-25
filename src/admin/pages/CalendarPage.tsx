import { Check, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import * as admin from "../../lib/api/admin";
import type { AcademicTermDayType, AcademicYearRow } from "../../lib/api/admin";
import { ApiError } from "../../lib/api/client";
import {
  deriveDayType,
  nextAcademicYearName,
  type CampusDayType,
} from "../../lib/calendar/dayType";
import {
  EmptyState,
  ErrorBanner,
  Field,
  GhostButton,
  LoadingState,
  Panel,
  PrimaryButton,
  SelectField,
  errorMessage,
  useAsyncData,
} from "../components/primitives";
import { MonthCalendar } from "../components/MonthCalendar";

// ---------------------------------------------------------------------------
// A18 校历管理
//
// 校历是校园级日型的唯一数据源（0035）：假期区间决定寒暑假，dates 列表决定
// 法定节假日与调休工作日。右卡的双月预览用与 worker/lib/daytype.ts 同口径的
// 客户端推导（src/lib/calendar/dayType.ts），改完保存前就能看见日型变化。
// ---------------------------------------------------------------------------

const ERROR_TEXT: Record<string, string> = {
  academic_year_current: "这个学年覆盖了今天，删除后今天的日型判定会落空。请先建好学年的衔接，或改删别的学年。",
  academic_year_exists: "已经存在同名学年，换个名字再试。",
  validation_error: "填写的内容不完整或不正确：区间名称与起止日期必填，开始日期不能晚于结束日期。",
  forbidden: "当前账号没有维护校历的权限。",
  unauthorized: "登录状态已失效，请重新登录。",
  not_found: "这个学年不存在，可能已被其他人改动，刷新后再试。",
};

function calendarError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return ERROR_TEXT[err.code] ?? err.message ?? fallback;
  return errorMessage(err, fallback);
}

const TERM_DAY_TYPE_OPTIONS: Array<{ value: AcademicTermDayType; label: string }> = [
  { value: "term", label: "学期" },
  { value: "winter_break", label: "寒假" },
  { value: "summer_break", label: "暑假" },
];

/** 预览着色：周末蓝、假日橙、寒暑假绿、调休工作日灰、普通工作日不着色。 */
const DAY_TYPE_STYLE: Record<CampusDayType, string> = {
  weekend: "bg-[#E8F1F8] text-[#1E80C1]",
  holiday: "bg-[#FEF3E2] text-[#F59E0B]",
  winter_break: "bg-[#E7F6EC] text-[#16A34A]",
  summer_break: "bg-[#E7F6EC] text-[#16A34A]",
  weekday: "text-ink",
};

const OVERRIDE_STYLE = "bg-chip text-sub";

interface TermDraft {
  key: string;
  name: string;
  validFrom: string;
  validTo: string;
  dayType: AcademicTermDayType;
}

interface YearDraft {
  name: string;
  terms: TermDraft[];
  holidays: string[];
  workdays: string[];
}

let draftKey = 0;
function nextKey(): string {
  draftKey += 1;
  return `term-${draftKey}`;
}

function draftFromYear(year: AcademicYearRow): YearDraft {
  return {
    name: year.name,
    terms: [...year.terms]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((term) => ({
        key: nextKey(),
        name: term.name,
        validFrom: term.validFrom,
        validTo: term.validTo,
        dayType: term.dayType,
      })),
    holidays: year.dates.filter((date) => date.kind === "holiday").map((date) => date.serviceDate),
    workdays: year.dates.filter((date) => date.kind === "workday_override").map((date) => date.serviceDate),
  };
}

/** 新增学年：名字预填下一学年，区间以最近一学年为模板照抄；逐日节假日/调休不照抄
 *  ——去年的法定节假日几乎不会适用到新学年，照抄忘了改就是脏数据，留空让管理员逐年录。 */
function draftFromTemplate(latest: AcademicYearRow | undefined): YearDraft {
  if (!latest) return { name: "", terms: [], holidays: [], workdays: [] };
  const draft = draftFromYear(latest);
  draft.name = nextAcademicYearName(latest.name);
  draft.holidays = [];
  draft.workdays = [];
  return draft;
}

export function CalendarPage() {
  const { state, reload } = useAsyncData((signal) => admin.listAcademicYears(signal), []);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  // creating === true 表示「新增学年」模式（draft 从模板来，保存走 POST）。
  // selectedId 为 "" 时回落到最新学年（接口按名称倒序，items[0]）。
  const [selectedId, setSelectedId] = useState("");
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<YearDraft>({ name: "", terms: [], holidays: [], workdays: [] });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [holidayInput, setHolidayInput] = useState("");
  const [workdayInput, setWorkdayInput] = useState("");

  const years = state.status === "ready" ? state.data.items : [];
  const activeId = creating
    ? null
    : selectedId && years.some((year) => year.id === selectedId)
      ? selectedId
      : (years[0]?.id ?? null);

  // 切换学年 / 进出新增模式时重建草稿；数据刷新（保存后 reload）也同步回已落库状态。
  const lastSync = useRef<{ id: string | null; stamp: unknown } | null>(null);
  useEffect(() => {
    if (state.status !== "ready") return;
    const stamp = state.data;
    if (lastSync.current !== null && lastSync.current.id === activeId && lastSync.current.stamp === stamp) return;
    lastSync.current = { id: activeId, stamp };
    if (activeId === null) {
      setDraft((current) => (creating || current.name || current.terms.length ? current : draftFromTemplate(state.data.items[0])));
    } else {
      const year = state.data.items.find((item) => item.id === activeId);
      if (year) setDraft(draftFromYear(year));
    }
    setConfirmDelete(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, activeId, creating]);

  // 双月预览：当前月 + 下月。
  const now = new Date();
  const months = [
    { year: now.getFullYear(), month: now.getMonth() },
    { year: new Date(now.getFullYear(), now.getMonth() + 1, 1).getFullYear(), month: new Date(now.getFullYear(), now.getMonth() + 1, 1).getMonth() },
  ];

  // 预览口径：全部学年的已落库数据，把正在编辑的那一学年换成草稿；新增模式则附加草稿。
  const previewTerms = [
    ...years.filter((year) => year.id !== activeId).flatMap((year) => year.terms),
    ...draft.terms.map((term) => ({ dayType: term.dayType, validFrom: term.validFrom, validTo: term.validTo })),
  ];
  const previewDates = [
    ...years.filter((year) => year.id !== activeId).flatMap((year) => year.dates),
    ...draft.holidays.map((serviceDate) => ({ serviceDate, kind: "holiday" })),
    ...draft.workdays.map((serviceDate) => ({ serviceDate, kind: "workday_override" })),
  ];

  function previewCell(date: string) {
    if (previewDates.some((item) => item.serviceDate === date && item.kind === "workday_override")) {
      return { className: OVERRIDE_STYLE, title: "调休工作日" };
    }
    const dayType = deriveDayType(date, previewTerms, previewDates);
    return { className: DAY_TYPE_STYLE[dayType] };
  }

  async function mutate(action: () => Promise<unknown>, fallback: string): Promise<boolean> {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      reload();
      return true;
    } catch (reason) {
      setError(calendarError(reason, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function validate(): boolean {
    if (!draft.name.trim()) {
      setError("请填写学年名称");
      return false;
    }
    for (const [index, term] of draft.terms.entries()) {
      if (!term.name.trim() || !term.validFrom || !term.validTo) {
        setError(`第 ${index + 1} 个区间：名称与起止日期都要填`);
        return false;
      }
      if (term.validFrom > term.validTo) {
        setError(`第 ${index + 1} 个区间「${term.name.trim()}」：开始日期不能晚于结束日期`);
        return false;
      }
    }
    setError("");
    return true;
  }

  async function save() {
    if (!validate()) return;
    const body: admin.AcademicYearWrite = {
      name: draft.name.trim(),
      terms: draft.terms.map((term, index) => ({
        name: term.name.trim(),
        dayType: term.dayType,
        validFrom: term.validFrom,
        validTo: term.validTo,
        sortOrder: (index + 1) * 10,
      })),
      dates: [
        ...draft.holidays.map((serviceDate) => ({ serviceDate, kind: "holiday" as const })),
        ...draft.workdays.map((serviceDate) => ({ serviceDate, kind: "workday_override" as const })),
      ],
    };
    const ok = await mutate(async () => {
      if (activeId === null) {
        const created = await admin.createAcademicYear(body);
        setSelectedId(created.id);
        setCreating(false);
      } else {
        await admin.updateAcademicYear(activeId, body);
      }
    }, "保存校历失败，请稍后重试");
    if (ok) setNotice("已保存");
  }

  async function remove() {
    if (activeId === null) return;
    const ok = await mutate(() => admin.deleteAcademicYear(activeId), "删除学年失败，请稍后重试");
    if (ok) {
      setConfirmDelete(false);
      setSelectedId("");
      setCreating(false);
    }
  }

  function patchTerm(key: string, patch: Partial<TermDraft>) {
    setDraft((current) => ({
      ...current,
      terms: current.terms.map((term) => (term.key === key ? { ...term, ...patch } : term)),
    }));
    setNotice("");
  }

  function addDate(list: "holidays" | "workdays", value: string) {
    if (!value) return;
    setDraft((current) => {
      if (current[list].includes(value)) return current;
      return { ...current, [list]: [...current[list], value].sort() };
    });
    setNotice("");
  }

  function removeDate(list: "holidays" | "workdays", value: string) {
    setDraft((current) => ({ ...current, [list]: current[list].filter((item) => item !== value) }));
    setNotice("");
  }

  if (state.status === "error") return <ErrorBanner message={state.message} />;
  if (state.status !== "ready") return <LoadingState label="加载校历…" />;

  return (
    <div className="space-y-4">
      <ErrorBanner message={error} />

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-64">
          <SelectField
            label="学年"
            onChange={(value) => { setSelectedId(value); setCreating(false); setNotice(""); setError(""); }}
            options={years.map((year) => ({ value: year.id, label: year.name }))}
            value={activeId ?? ""}
            placeholder={creating ? "（新增学年）" : undefined}
          />
        </div>
        <GhostButton
          onClick={() => {
            setCreating(true);
            setSelectedId("");
            setDraft(draftFromTemplate(years[0]));
            setConfirmDelete(false);
            setNotice("");
            setError("");
          }}
        >
          <Plus size={15} /> 新增学年
        </GhostButton>
        {!creating && activeId !== null ? (
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
            <button
              className="text-aux font-medium text-error"
              onClick={() => setConfirmDelete(true)}
              type="button"
            >
              删除
            </button>
          )
        ) : null}
      </div>

      <div className="grid grid-cols-[1fr_460px] items-start gap-4">
        <Panel title="校历规则">
          <div className="space-y-4">
            <Field
              label="学年名称"
              onChange={(value) => { setDraft((current) => ({ ...current, name: value })); setNotice(""); }}
              placeholder="如 2026-2027"
              value={draft.name}
            />

            <div className="space-y-2.5">
              {draft.terms.map((term) => (
                <div className="grid grid-cols-[1fr_150px_150px_130px_32px] items-end gap-2 rounded-lg bg-page p-3" key={term.key}>
                  <Field label="名称" onChange={(value) => patchTerm(term.key, { name: value })} placeholder="如 秋季学期" value={term.name} />
                  <Field label="开始日期" onChange={(value) => patchTerm(term.key, { validFrom: value })} type="date" value={term.validFrom} />
                  <Field label="结束日期" onChange={(value) => patchTerm(term.key, { validTo: value })} type="date" value={term.validTo} />
                  <SelectField
                    label="日型归属"
                    onChange={(value) => patchTerm(term.key, { dayType: value as AcademicTermDayType })}
                    options={TERM_DAY_TYPE_OPTIONS}
                    value={term.dayType}
                  />
                  <button
                    aria-label={`删除区间 ${term.name || "未命名"}`}
                    className="grid h-9 w-8 place-items-center rounded-md text-error hover:bg-error-bg"
                    onClick={() => {
                      setDraft((current) => ({ ...current, terms: current.terms.filter((item) => item.key !== term.key) }));
                      setNotice("");
                    }}
                    type="button"
                  >
                    <X size={15} />
                  </button>
                </div>
              ))}
              {draft.terms.length === 0 ? <EmptyState label="还没有区间" /> : null}
              <GhostButton
                className="h-8"
                onClick={() => {
                  setDraft((current) => ({
                    ...current,
                    terms: [...current.terms, { key: nextKey(), name: "", validFrom: "", validTo: "", dayType: "term" }],
                  }));
                  setNotice("");
                }}
              >
                <Plus size={14} /> 添加区间
              </GhostButton>
            </div>

            <DateChips
              input={holidayInput}
              label="法定节假日"
              onAdd={(value) => { addDate("holidays", value); setHolidayInput(""); }}
              onInput={setHolidayInput}
              onRemove={(value) => removeDate("holidays", value)}
              values={draft.holidays}
            />
            <DateChips
              input={workdayInput}
              label="调休工作日（周末上班）"
              onAdd={(value) => { addDate("workdays", value); setWorkdayInput(""); }}
              onInput={setWorkdayInput}
              onRemove={(value) => removeDate("workdays", value)}
              values={draft.workdays}
            />

            <div className="flex items-center gap-2">
              <PrimaryButton disabled={busy} onClick={() => void save()}>
                <Check size={15} /> 保存校历
              </PrimaryButton>
              {notice ? <span className="text-aux text-success">{notice}</span> : null}
            </div>
          </div>
        </Panel>

        <Panel title="日型预览">
          <div className="space-y-4">
            <div className="flex gap-4">
              {months.map((item) => (
                <MonthCalendar
                  key={`${item.year}-${item.month}`}
                  month={item.month}
                  renderDay={previewCell}
                  year={item.year}
                />
              ))}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-label text-sub">
              <Legend className={DAY_TYPE_STYLE.weekend} label="周末" />
              <Legend className={DAY_TYPE_STYLE.holiday} label="法定节假日" />
              <Legend className={DAY_TYPE_STYLE.winter_break} label="寒暑假" />
              <Legend className={OVERRIDE_STYLE} label="调休工作日" />
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-3 w-3 rounded ${className}`} />
      {label}
    </span>
  );
}

function DateChips({
  label,
  values,
  input,
  onInput,
  onAdd,
  onRemove,
}: {
  label: string;
  values: string[];
  input: string;
  onInput: (value: string) => void;
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
}) {
  return (
    <div>
      <span className="mb-1.5 block text-label text-sub">{label}</span>
      <div className="flex flex-wrap items-center gap-2">
        {values.map((value) => (
          <span
            className="inline-flex h-7 items-center gap-1 rounded-full bg-page px-2.5 text-aux text-ink"
            key={value}
          >
            {value}
            <button
              aria-label={`移除 ${value}`}
              className="grid h-4 w-4 place-items-center rounded-full text-sub hover:text-error"
              onClick={() => onRemove(value)}
              type="button"
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          aria-label={`${label}日期`}
          className="h-8 w-36 rounded-lg border border-line bg-surface px-2 text-aux text-ink outline-none focus:border-primary"
          onChange={(event) => onInput(event.target.value)}
          type="date"
          value={input}
        />
        <GhostButton className="h-8 px-3" disabled={!input} onClick={() => onAdd(input)}>
          <Plus size={13} /> 添加
        </GhostButton>
      </div>
    </div>
  );
}
