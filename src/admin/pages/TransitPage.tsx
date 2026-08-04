import { ArrowDown, ArrowUp, Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import * as admin from "../../lib/api/admin";
import { ApiError } from "../../lib/api/client";
import type {
  ReferenceDataResponse,
  ServiceCalendarRow,
  SpacesResponse,
  TransitBookingPolicy,
  TransitDropoffType,
  TransitPatternRow,
  TransitPickupType,
  TransitResponse,
  TransitRouteRow,
  TransitStopRow,
  TransitStopStatus,
} from "../adminTypes";
import {
  Chip,
  EmptyState,
  ErrorBanner,
  Field,
  GhostButton,
  InfoNote,
  LoadingState,
  Panel,
  Pill,
  PrimaryButton,
  SelectField,
  errorMessage,
  fmtDay,
  useAsyncData,
} from "../components/primitives";
import {
  LocationEditor,
  emptyLocation,
  isLocationDraftBlank,
  locationDraftFromApi,
  locationInput,
  type LocationDraft,
} from "../components/LocationEditor";
import type { LocationRole } from "../../../shared/revision-contract";

// ---------------------------------------------------------------------------
// A8 校车管理
//
// 四个分区共用一次 GET /api/admin/transit：
//   · 班次时刻 —— 选一条线路方向，编辑它的停靠顺序与每日班次
//   · 站点     —— 站点的增删改，含地点绑定与上/下车点坐标
//   · 线路     —— 线路及其方向（去程 / 回程）的增删改
//   · 服务日历 —— 运行日、日期范围与例外日期
//
// 「线路」与「方向」在数据库里是 transit_routes → transit_patterns 两层，但对运营
// 同学而言一条线路就是一个走向。所以这里不再让人分两步选：选择器直接列出「线路 ·
// 去程」这样的条目，方向名称由线路名与去/回程自动生成，不用再手填一次。
// ---------------------------------------------------------------------------

type Tab = "schedule" | "stops" | "lines" | "calendars";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "schedule", label: "班次时刻" },
  { key: "stops", label: "站点" },
  { key: "lines", label: "线路" },
  { key: "calendars", label: "服务日历" },
];

const WEEK_LABELS = ["一", "二", "三", "四", "五", "六", "日"];
const WEEK_KEYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

/** 站点自身的锚点只描述在哪上车、在哪下车。 */
const STOP_LOCATION_ROLES: readonly LocationRole[] = ["boarding_point", "alighting_point"];

const DIRECTION_LABELS: Record<number, string> = { 0: "去程", 1: "回程" };

const DIRECTION_OPTIONS = [
  { value: "0", label: "去程" },
  { value: "1", label: "回程" },
];

const POLICY_META: Record<TransitBookingPolicy, { label: string; tone: "info" | "neutral" }> = {
  required: { label: "需预约", tone: "info" },
  optional: { label: "可预约", tone: "info" },
  not_required: { label: "非预约", tone: "neutral" },
};

const POLICY_OPTIONS = [
  { value: "not_required", label: "非预约" },
  { value: "required", label: "需预约" },
  { value: "optional", label: "可预约" },
];

const PICKUP_OPTIONS = [
  { value: "regular", label: "可上车" },
  { value: "reservation_only", label: "仅预约班次可上车" },
  { value: "none", label: "不可上车" },
];

const DROPOFF_OPTIONS = [
  { value: "regular", label: "可下车" },
  { value: "none", label: "不可下车" },
];

const STOP_STATUS_META: Record<TransitStopStatus, { label: string; tone: "ok" | "warning" | "neutral" }> = {
  active: { label: "停靠中", tone: "ok" },
  temporarily_closed: { label: "暂停停靠", tone: "warning" },
  retired: { label: "已停用", tone: "neutral" },
};

const STOP_STATUS_OPTIONS = [
  { value: "active", label: "停靠中" },
  { value: "temporarily_closed", label: "暂停停靠" },
  { value: "retired", label: "已停用" },
];

const ROUTE_STATUS_META: Record<string, { label: string; tone: "ok" | "warning" | "neutral" }> = {
  active: { label: "运行中", tone: "ok" },
  suspended: { label: "暂停运行", tone: "warning" },
  retired: { label: "已停用", tone: "neutral" },
};

const ROUTE_STATUS_OPTIONS = [
  { value: "active", label: "运行中" },
  { value: "suspended", label: "暂停运行" },
  { value: "retired", label: "已停用" },
];

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 后端的 409 都带专用 code，这里翻成运营同学能照着做的说明。 */
const ERROR_TEXT: Record<string, string> = {
  transit_code_taken: "这个代码已经被另一条记录占用了，换一个或留空。",
  transit_stop_in_use: "还有线路方向或班次时刻停靠这个站点。先把它从这些方向里移除，再停用或删除。",
  transit_route_in_use: "这条线路下面还有方向。先删掉方向，或者把线路改成「暂停运行」。",
  transit_pattern_in_use: "这个方向下面还有班次。先删掉班次，再删除方向。",
  transit_pattern_duplicate: "这条线路已经有同名同走向的方向了。",
  service_calendar_in_use: "还有班次挂在这个日历上。先把它们改到别的日历或删掉。",
  calendar_range_excludes_exceptions: "有例外日期落在新的日期范围之外。请连同例外日期一起调整。",
  validation_error: "填写的内容不完整或不正确，请检查后重试。",
  forbidden: "当前账号没有维护校车数据的权限。",
  unauthorized: "登录状态已失效，请重新登录。",
  not_found: "这条记录不存在，可能已被其他人改动，刷新后再试。",
};

function transitError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return ERROR_TEXT[err.code] ?? err.message ?? fallback;
  return errorMessage(err, fallback);
}

interface StopDraft {
  stopId: string;
  pickupType: TransitPickupType;
  dropoffType: TransitDropoffType;
}

function sameSequence(a: StopDraft[], b: StopDraft[]): boolean {
  return (
    a.length === b.length
    && a.every((stop, index) =>
      stop.stopId === b[index].stopId
      && stop.pickupType === b[index].pickupType
      && stop.dropoffType === b[index].dropoffType)
  );
}

function today(): string {
  return new Date().toLocaleDateString("en-CA");
}

// ---------------------------------------------------------------------------

interface TransitMeta {
  spaces: SpacesResponse;
  ref: ReferenceDataResponse;
  mapVersions: admin.MapVersionRow[];
}

export function TransitPage() {
  const transit = useAsyncData<TransitResponse>((signal) => admin.listAdminTransit<TransitResponse>(signal), []);
  const meta = useAsyncData<TransitMeta>(async (signal) => {
    const [spaces, ref, maps] = await Promise.all([
      admin.listSpaces<SpacesResponse>(signal),
      admin.listReferenceData<ReferenceDataResponse>(signal),
      admin.listMapVersions(signal),
    ]);
    return { spaces, ref, mapVersions: maps.items };
  }, []);

  if (transit.state.status === "loading" || meta.state.status === "loading") return <LoadingState label="加载校车数据…" />;
  if (transit.state.status === "error") return <ErrorBanner message={transit.state.message} />;
  if (meta.state.status === "error") return <ErrorBanner message={meta.state.message} />;
  return <ReadyTransitPage data={transit.state.data} meta={meta.state.data} reload={transit.reload} />;
}

function ReadyTransitPage({ data, meta, reload }: { data: TransitResponse; meta: TransitMeta; reload: () => void }) {
  const [tab, setTab] = useState<Tab>("schedule");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  /** 所有写操作走这里：出错留在原地并给出可执行的说明，成功才刷新。 */
  async function mutate(action: () => Promise<unknown>, fallback: string): Promise<boolean> {
    setBusy(true);
    setError("");
    try {
      await action();
      reload();
      return true;
    } catch (err) {
      setError(transitError(err, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const stopName = useMemo(() => {
    const map = new Map(data.stops.map((stop) => [stop.id, stop.name]));
    return (id: string) => {
      const name = map.get(id);
      if (name === undefined) throw new Error(`校车数据引用了不存在的站点 ${id}`);
      return name;
    };
  }, [data.stops]);

  const routeById = useMemo(() => new Map(data.routes.map((route) => [route.id, route])), [data.routes]);

  /** 「线路 · 去程」这样的一行标签；方向另有名称时补在后面。 */
  const lineLabel = useMemo(() => {
    return (pattern: TransitPatternRow) => {
      const route = routeById.get(pattern.routeId);
      if (!route) throw new Error(`方向 ${pattern.id} 引用了不存在的线路`);
      const direction = DIRECTION_LABELS[pattern.directionId] ?? `方向 ${pattern.directionId}`;
      const base = `${route.name} · ${direction}`;
      return pattern.name.trim() && pattern.name.trim() !== route.name.trim() ? `${base}（${pattern.name.trim()}）` : base;
    };
  }, [routeById]);

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

      {tab === "schedule" ? (
        <SchedulePanel busy={busy} data={data} lineLabel={lineLabel} mutate={mutate} stopName={stopName} />
      ) : null}
      {tab === "stops" ? <StopsPanel busy={busy} data={data} meta={meta} mutate={mutate} /> : null}
      {tab === "lines" ? <LinesPanel busy={busy} data={data} meta={meta} mutate={mutate} stopName={stopName} /> : null}
      {tab === "calendars" ? <CalendarsPanel busy={busy} data={data} meta={meta} mutate={mutate} /> : null}
    </div>
  );
}

// ===========================================================================
// 班次时刻
// ===========================================================================

interface PanelProps {
  data: TransitResponse;
  busy: boolean;
  mutate: (action: () => Promise<unknown>, fallback: string) => Promise<boolean>;
}

function SchedulePanel({
  data,
  busy,
  mutate,
  stopName,
  lineLabel,
}: PanelProps & {
  stopName: (id: string) => string;
  lineLabel: (pattern: TransitPatternRow) => string;
}) {
  const [patternId, setPatternId] = useState("");
  const [calendarId, setCalendarId] = useState("");

  const [sequence, setSequence] = useState<StopDraft[]>([]);
  const [addStopId, setAddStopId] = useState("");
  const [sequenceSaved, setSequenceSaved] = useState(false);

  const [editing, setEditing] = useState<"new" | string | null>(null);
  const [times, setTimes] = useState<string[]>([]);
  const [policy, setPolicy] = useState<TransitBookingPolicy>("not_required");
  const [formCalendarId, setFormCalendarId] = useState("");
  const [tripError, setTripError] = useState("");
  const [pendingDelete, setPendingDelete] = useState("");

  const { patterns, calendars, stops } = data;
  const selectedPatternId = patterns.some((pattern) => pattern.id === patternId) ? patternId : patterns[0]?.id ?? "";
  const selectedCalendarId = calendars.some((calendar) => calendar.id === calendarId) ? calendarId : calendars[0]?.id ?? "";
  const activeCalendar = calendars.find((calendar) => calendar.id === selectedCalendarId);

  /** 已落库的站点顺序，用作草稿基线。 */
  const savedSequence = useMemo<StopDraft[]>(
    () =>
      data.patternStops
        .filter((row) => row.patternId === selectedPatternId)
        .sort((a, b) => a.stopSequence - b.stopSequence)
        .map((row) => ({ stopId: row.stopId, pickupType: row.pickupType, dropoffType: row.dropoffType })),
    [data.patternStops, selectedPatternId],
  );

  // 切换走向或数据刷新后回到已落库状态，避免草稿串到别的走向。
  useEffect(() => {
    setSequence(savedSequence);
    setAddStopId("");
    setSequenceSaved(false);
    setEditing(null);
    setPendingDelete("");
  }, [savedSequence]);

  const trips = useMemo(
    () => data.trips.filter((trip) => trip.patternId === selectedPatternId && trip.serviceCalendarId === selectedCalendarId),
    [data.trips, selectedPatternId, selectedCalendarId],
  );

  const timesByTrip = useMemo(() => {
    const map = new Map<string, Array<{ stopSequence: number; arrivalTime: string | null; departureTime: string | null }>>();
    for (const row of data.stopTimes) {
      let list = map.get(row.tripId);
      if (list === undefined) {
        list = [];
        map.set(row.tripId, list);
      }
      list.push(row);
    }
    for (const list of map.values()) list.sort((a, b) => a.stopSequence - b.stopSequence);
    return map;
  }, [data.stopTimes]);

  function rowsForTrip(tripId: string) {
    const rows = timesByTrip.get(tripId);
    if (rows === undefined) throw new Error(`班次 ${tripId} 缺少站点时刻`);
    return rows;
  }

  function tripTimes(tripId: string): string[] {
    const rows = rowsForTrip(tripId);
    return savedSequence.map((_, index) => (rows[index]?.departureTime ?? rows[index]?.arrivalTime ?? "").slice(0, 5));
  }

  // 停用的站点不再作为新增选项，但已经排进顺序里的照常显示。
  const availableStops = stops.filter((stop) => stop.status !== "retired" && !sequence.some((item) => item.stopId === stop.id));
  const sequenceDirty = !sameSequence(sequence, savedSequence);

  function moveStop(index: number, delta: number) {
    setSequence((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    setSequenceSaved(false);
  }

  function patchStop(index: number, patch: Partial<StopDraft>) {
    setSequence((current) => current.map((stop, i) => (i === index ? { ...stop, ...patch } : stop)));
    setSequenceSaved(false);
  }

  async function saveSequence() {
    setSequenceSaved(false);
    const ok = await mutate(() => admin.replaceTransitPatternStops(selectedPatternId, sequence), "保存站点顺序失败，请稍后重试");
    if (ok) setSequenceSaved(true);
  }

  function startAddTrip() {
    setEditing("new");
    setTimes(savedSequence.map(() => ""));
    setPolicy("not_required");
    setFormCalendarId(selectedCalendarId);
    setTripError("");
  }

  function startEditTrip(tripId: string, bookingPolicy: TransitBookingPolicy, tripCalendarId: string) {
    setEditing(tripId);
    setTimes(tripTimes(tripId));
    setPolicy(bookingPolicy);
    setFormCalendarId(tripCalendarId);
    setTripError("");
  }

  async function saveTrip() {
    const trimmed = times.map((time) => time.trim());
    if (!TIME_PATTERN.test(trimmed[0])) {
      setTripError("请填写发车时间，格式为 07:30");
      return;
    }
    const invalid = trimmed.findIndex((time, index) => index > 0 && time !== "" && !TIME_PATTERN.test(time));
    if (invalid >= 0) {
      setTripError(`「${stopName(savedSequence[invalid].stopId)}」的时间格式应为 07:30`);
      return;
    }
    const serviceCalendarId = formCalendarId || selectedCalendarId;
    if (!serviceCalendarId) {
      setTripError("请选择服务日历");
      return;
    }
    setTripError("");
    const stopTimes = trimmed.map((time) => ({ arrivalTime: time || null, departureTime: time || null }));
    const ok = await mutate(
      () =>
        editing === "new"
          ? admin.createTransitTrip({
            patternId: selectedPatternId,
            serviceCalendarId,
            publicLabel: null,
            bookingPolicy: policy,
            bookingUrl: null,
            sourceId: null,
            stopTimes,
          })
          : admin.updateTransitTrip(String(editing), { serviceCalendarId, bookingPolicy: policy, stopTimes }),
      editing === "new" ? "添加班次失败，请稍后重试" : "保存班次失败，请稍后重试",
    );
    if (ok) setEditing(null);
  }

  if (patterns.length === 0) {
    return (
      <Panel title="班次时刻">
        <InfoNote tone="warning">还没有线路。请先在「线路」里新建一条线路，再回来编辑停靠顺序与班次。</InfoNote>
      </Panel>
    );
  }

  const tripEditor = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        {savedSequence.map((stop, index) => (
          <label key={stop.stopId} className="block">
            <span className="mb-1 block text-label text-sub">
              {stopName(stop.stopId)}
              {index === 0 ? " 发车" : " 到达"}
            </span>
            <input
              aria-label={`${stopName(stop.stopId)}${index === 0 ? "发车" : "到达"}时间`}
              className="h-9 w-24 rounded-lg border border-line bg-surface px-3 text-body text-ink outline-none focus:border-primary"
              onChange={(e) => setTimes((current) => current.map((time, i) => (i === index ? e.target.value : time)))}
              placeholder={index === 0 ? "07:30" : "可留空"}
              value={times[index]}
            />
          </label>
        ))}
        <div className="w-32">
          <SelectField label="乘车方式" onChange={(value) => setPolicy(value as TransitBookingPolicy)} options={POLICY_OPTIONS} value={policy} />
        </div>
        <div className="w-32">
          <SelectField
            label="服务日历"
            onChange={setFormCalendarId}
            options={calendars.map((calendar) => ({ value: calendar.id, label: calendar.name }))}
            value={formCalendarId}
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <PrimaryButton disabled={busy} onClick={() => void saveTrip()}>
          <Check size={15} /> {editing === "new" ? "添加" : "保存"}
        </PrimaryButton>
        <GhostButton disabled={busy} onClick={() => setEditing(null)}>取消</GhostButton>
      </div>
      <ErrorBanner message={tripError} />
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-72">
          <SelectField
            label="线路方向"
            onChange={setPatternId}
            options={patterns.map((pattern) => ({ value: pattern.id, label: lineLabel(pattern) }))}
            value={selectedPatternId}
          />
        </div>
        <div className="w-48">
          <SelectField
            label="服务日历"
            onChange={setCalendarId}
            options={calendars.map((calendar) => ({ value: calendar.id, label: calendar.name }))}
            placeholder={calendars.length ? undefined : "还没有服务日历"}
            value={selectedCalendarId}
          />
        </div>
      </div>

      <div className="grid grid-cols-[420px_1fr] items-start gap-4">
        <Panel
          title="站点顺序"
          action={
            sequenceDirty ? (
              <span className="text-aux text-warning">有未保存的改动</span>
            ) : sequenceSaved ? (
              <span className="text-aux text-success">已保存</span>
            ) : null
          }
          padded={false}
        >
          <div className="space-y-2.5 p-5">
            {sequence.map((stop, index) => (
              <div key={stop.stopId} className="rounded-lg bg-page px-3.5 py-3">
                <div className="flex items-center gap-3">
                  <span
                    className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-aux font-semibold ${
                      index === 0 ? "bg-primary text-white" : "bg-chip text-sub"
                    }`}
                  >
                    {index + 1}
                  </span>
                  <p className="min-w-0 flex-1 truncate text-body font-semibold text-ink">{stopName(stop.stopId)}</p>
                  <button
                    aria-label="上移"
                    className="grid h-7 w-7 place-items-center rounded-md text-sub hover:bg-chip disabled:opacity-30"
                    disabled={index === 0}
                    onClick={() => moveStop(index, -1)}
                    type="button"
                  >
                    <ArrowUp size={15} />
                  </button>
                  <button
                    aria-label="下移"
                    className="grid h-7 w-7 place-items-center rounded-md text-sub hover:bg-chip disabled:opacity-30"
                    disabled={index === sequence.length - 1}
                    onClick={() => moveStop(index, 1)}
                    type="button"
                  >
                    <ArrowDown size={15} />
                  </button>
                  <button
                    aria-label={`移除站点 ${stopName(stop.stopId)}`}
                    className="grid h-7 w-7 place-items-center rounded-md text-error hover:bg-error-bg"
                    onClick={() => {
                      setSequence((current) => current.filter((_, i) => i !== index));
                      setSequenceSaved(false);
                    }}
                    type="button"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                <div className="mt-2 flex gap-2">
                  <select
                    aria-label={`${stopName(stop.stopId)} 上车规则`}
                    className="h-8 flex-1 rounded-md border border-line bg-surface px-2 text-aux text-ink"
                    onChange={(e) => patchStop(index, { pickupType: e.target.value as TransitPickupType })}
                    value={stop.pickupType}
                  >
                    {PICKUP_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <select
                    aria-label={`${stopName(stop.stopId)} 下车规则`}
                    className="h-8 flex-1 rounded-md border border-line bg-surface px-2 text-aux text-ink"
                    onChange={(e) => patchStop(index, { dropoffType: e.target.value as TransitDropoffType })}
                    value={stop.dropoffType}
                  >
                    {DROPOFF_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            ))}

            {sequence.length === 0 ? <EmptyState label="该方向还没有站点" /> : null}

            <div className="flex items-end gap-2 pt-1">
              <div className="flex-1">
                <SelectField
                  label="添加站点"
                  onChange={setAddStopId}
                  options={availableStops.map((stop) => ({ value: stop.id, label: stop.name }))}
                  placeholder={availableStops.length ? "选择站点" : "已加入全部站点"}
                  value={addStopId}
                />
              </div>
              <GhostButton
                disabled={!addStopId}
                onClick={() => {
                  setSequence((current) => [...current, { stopId: addStopId, pickupType: "regular", dropoffType: "regular" }]);
                  setAddStopId("");
                  setSequenceSaved(false);
                }}
              >
                <Plus size={15} /> 添加
              </GhostButton>
            </div>

            {sequence.length === 1 ? <InfoNote tone="warning">一个方向至少需要两个站点才能保存</InfoNote> : null}

            <div className="flex items-center gap-2">
              <PrimaryButton disabled={!sequenceDirty || sequence.length < 2 || busy} onClick={() => void saveSequence()}>
                保存站点顺序
              </PrimaryButton>
              {sequenceDirty ? (
                <GhostButton disabled={busy} onClick={() => setSequence(savedSequence)}>还原</GhostButton>
              ) : null}
            </div>

            <InfoNote tone="warning">「仅预约班次可上车」的站点，非预约班次不会停靠</InfoNote>
          </div>
        </Panel>

        <div className="space-y-4">
          <Panel
            title={activeCalendar ? `班次时刻 · ${activeCalendar.name}` : "班次时刻"}
            action={
              editing === null && savedSequence.length >= 2 && activeCalendar ? (
                <button className="flex items-center gap-1 text-aux font-medium text-primary" onClick={startAddTrip} type="button">
                  <Plus size={14} /> 添加班次
                </button>
              ) : null
            }
            padded={false}
          >
            {calendars.length === 0 ? (
              <div className="p-5">
                <InfoNote tone="warning">还没有服务日历。请先在「服务日历」里建一个，再添加班次。</InfoNote>
              </div>
            ) : (
              <>
                <table className="w-full border-collapse text-left text-body">
                  <thead>
                    <tr className="text-label text-sub">
                      {["发车", "到达", "乘车方式", ""].map((header, index) => (
                        <th key={index} className="px-5 pb-2 pt-1 font-medium">{header}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {trips.map((trip) => {
                      const rows = rowsForTrip(trip.id);
                      const first = rows[0];
                      const last = rows[rows.length - 1];
                      const policyMeta = POLICY_META[trip.bookingPolicy];
                      if (editing === trip.id) {
                        return (
                          <tr key={trip.id} className="bg-primary-container/40">
                            <td className="px-5 py-3" colSpan={4}>{tripEditor}</td>
                          </tr>
                        );
                      }
                      return (
                        <tr key={trip.id}>
                          <td className="px-5 py-3 font-semibold">{first?.departureTime?.slice(0, 5) ?? "—"}</td>
                          <td className="px-5 py-3">
                            {(rows.length > 1 ? (last?.arrivalTime ?? last?.departureTime) : null)?.slice(0, 5) ?? "—"}
                          </td>
                          <td className="px-5 py-3"><Pill tone={policyMeta.tone}>{policyMeta.label}</Pill></td>
                          <td className="px-5 py-3">
                            {pendingDelete === trip.id ? (
                              <span className="flex items-center gap-2">
                                <button
                                  className="text-aux font-medium text-error disabled:opacity-50"
                                  disabled={busy}
                                  onClick={() => void mutate(async () => {
                                    await admin.deleteTransitTrip(trip.id);
                                    setPendingDelete("");
                                  }, "删除班次失败，请稍后重试")}
                                  type="button"
                                >
                                  确认删除
                                </button>
                                <button className="text-aux text-sub" onClick={() => setPendingDelete("")} type="button">取消</button>
                              </span>
                            ) : (
                              <span className="flex items-center gap-1">
                                <button
                                  aria-label="编辑班次"
                                  className="grid h-7 w-7 place-items-center rounded-md text-sub hover:bg-chip"
                                  onClick={() => startEditTrip(trip.id, trip.bookingPolicy, trip.serviceCalendarId)}
                                  type="button"
                                >
                                  <Pencil size={14} />
                                </button>
                                <button
                                  aria-label="删除班次"
                                  className="grid h-7 w-7 place-items-center rounded-md text-error hover:bg-error-bg"
                                  onClick={() => setPendingDelete(trip.id)}
                                  type="button"
                                >
                                  <X size={15} />
                                </button>
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {editing === "new" ? (
                      <tr className="bg-primary-container/40">
                        <td className="px-5 py-3" colSpan={4}>{tripEditor}</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
                {trips.length === 0 && editing !== "new" ? (
                  <div className="p-5">
                    <EmptyState label={savedSequence.length >= 2 ? "该日历下暂无班次" : "先保存站点顺序，再添加班次"} />
                  </div>
                ) : null}
                {trips.length > 0 ? (
                  <div className="px-5 pb-4 pt-1"><p className="text-label text-sub">共 {trips.length} 班</p></div>
                ) : null}
              </>
            )}
          </Panel>

          {activeCalendar ? (
            <Panel title={`${activeCalendar.name}的运行日`} padded={false}>
              <div className="flex flex-wrap items-center gap-2.5 p-5">
                {WEEK_LABELS.map((label, index) => (
                  <span
                    key={label}
                    className={`grid h-9 w-9 place-items-center rounded-full text-body font-medium ${
                      activeCalendar[WEEK_KEYS[index]] ? "bg-primary text-white" : "bg-page text-sub"
                    }`}
                  >
                    {label}
                  </span>
                ))}
                <span className="ml-auto text-aux text-sub">
                  {fmtDay(activeCalendar.validFrom)} 至 {fmtDay(activeCalendar.validTo)}
                </span>
              </div>
            </Panel>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// 站点
// ===========================================================================

interface StopFormState {
  name: string;
  code: string;
  placeId: string;
  campusId: string;
  status: TransitStopStatus;
  locations: LocationDraft[];
}

function StopsPanel({
  data,
  meta,
  busy,
  mutate,
}: PanelProps & { meta: TransitMeta }) {
  // "new" = 新建，其余为正在编辑的站点 id。
  const [editing, setEditing] = useState<"new" | string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState("");

  const locationsByStop = useMemo(() => {
    const map = new Map<string, LocationDraft[]>();
    for (const [index, row] of data.stopLocations.entries()) {
      const list = map.get(row.entityId) ?? [];
      list.push(locationDraftFromApi(row, index));
      map.set(row.entityId, list);
    }
    return map;
  }, [data.stopLocations]);

  const usageByStop = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of data.patternStops) map.set(row.stopId, (map.get(row.stopId) ?? 0) + 1);
    return map;
  }, [data.patternStops]);

  const placeName = useMemo(() => {
    const map = new Map(data.places.map((place) => [place.id, place.displayName ?? place.id]));
    return (id: string) => map.get(id) ?? id;
  }, [data.places]);

  const campusName = useMemo(() => {
    const map = new Map(meta.spaces.campuses.map((campus) => [campus.id, campus.name]));
    return (id: string) => map.get(id) ?? id;
  }, [meta.spaces.campuses]);

  return (
    <div className="space-y-4">
      <Panel
        title={`校车站点${data.stops.length ? `（${data.stops.length}）` : ""}`}
        action={
          editing === null ? (
            <PrimaryButton className="h-8" onClick={() => setEditing("new")}>
              <Plus size={15} />新建站点
            </PrimaryButton>
          ) : null
        }
      >
        <div className="space-y-4">
          <InfoNote>
            站点的照片、联系方式、开放时间等信息来自它绑定的地点，在「内容管理」里维护；这里维护站点本身的名称、
            停靠状态，以及上车 / 下车点的具体坐标。
          </InfoNote>

          {editing === "new" ? (
            <StopEditor
              busy={busy}
              data={data}
              meta={meta}
              onCancel={() => setEditing(null)}
              onSave={async (form) => {
                const ok = await mutate(
                  () => admin.createTransitStop({
                    name: form.name,
                    code: form.code || null,
                    placeId: form.placeId || null,
                    campusId: form.campusId || null,
                    locations: form.locations.filter((row) => !isLocationDraftBlank(row)).map(locationInput),
                  }),
                  "新建站点失败",
                );
                if (ok) setEditing(null);
              }}
            />
          ) : null}

          {data.stops.length === 0 && editing !== "new" ? <EmptyState label="暂无校车站点" /> : null}

          <div className="divide-y divide-line">
            {data.stops.map((stop) => {
              if (editing === stop.id) {
                return (
                  <div className="py-3" key={stop.id}>
                    <StopEditor
                      busy={busy}
                      data={data}
                      initial={{
                        name: stop.name,
                        code: stop.code ?? "",
                        placeId: stop.placeId ?? "",
                        campusId: stop.campusId ?? "",
                        status: stop.status,
                        locations: locationsByStop.get(stop.id) ?? [],
                      }}
                      meta={meta}
                      onCancel={() => setEditing(null)}
                      onSave={async (form) => {
                        const ok = await mutate(
                          () => admin.updateTransitStop(stop.id, {
                            name: form.name,
                            code: form.code || null,
                            placeId: form.placeId || null,
                            campusId: form.campusId || null,
                            status: form.status,
                            locations: form.locations.filter((row) => !isLocationDraftBlank(row)).map(locationInput),
                          }),
                          "保存站点失败",
                        );
                        if (ok) setEditing(null);
                      }}
                    />
                  </div>
                );
              }
              const usage = usageByStop.get(stop.id) ?? 0;
              const anchors = locationsByStop.get(stop.id) ?? [];
              const statusMeta = STOP_STATUS_META[stop.status];
              return (
                <div key={stop.id}>
                  <div className="flex items-center gap-3 py-3">
                    <span className="min-w-0 flex-1 truncate font-medium text-ink">{stop.name}</span>
                    <span className="w-24 shrink-0 truncate text-aux text-sub">{stop.code ?? "—"}</span>
                    <span className="w-44 shrink-0 truncate text-aux text-sub">
                      {stop.placeId ? `地点：${placeName(stop.placeId)}` : "未绑定地点"}
                    </span>
                    <span className="w-24 shrink-0 truncate text-aux text-sub">
                      {stop.campusId ? campusName(stop.campusId) : "—"}
                    </span>
                    <span className="w-28 shrink-0 text-aux text-sub">
                      {anchors.length ? `${anchors.length} 个上下车点` : "未标坐标"}
                    </span>
                    <span className="w-20 shrink-0 text-aux text-sub">{usage ? `${usage} 处停靠` : "未被停靠"}</span>
                    <Pill tone={statusMeta.tone}>{statusMeta.label}</Pill>
                    <button
                      aria-label={`编辑 ${stop.name}`}
                      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 text-aux font-medium text-ink disabled:opacity-40"
                      disabled={busy}
                      onClick={() => { setEditing(stop.id); setConfirmDelete(""); }}
                      type="button"
                    >
                      <Pencil size={13} />编辑
                    </button>
                    <button
                      aria-label={`删除 ${stop.name}`}
                      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-error/40 px-3 text-aux font-medium text-error disabled:opacity-40"
                      disabled={busy || usage > 0}
                      onClick={() => setConfirmDelete(stop.id)}
                      title={usage > 0 ? "还有线路方向停靠这个站点，只能先移除停靠或改为已停用" : "彻底删除"}
                      type="button"
                    >
                      <Trash2 size={13} />删除
                    </button>
                  </div>
                  {confirmDelete === stop.id ? (
                    <div className="mb-3 rounded-lg bg-error-bg px-4 py-3">
                      <p className="text-body font-medium text-error">
                        确认删除站点「{stop.name}」？它的上下车点坐标会一并删除，且不可恢复。
                      </p>
                      <div className="mt-2.5 flex gap-2">
                        <button
                          className="h-8 rounded-lg bg-error px-3 text-aux font-semibold text-white disabled:opacity-40"
                          disabled={busy}
                          onClick={() => void mutate(async () => {
                            await admin.deleteTransitStop(stop.id);
                            setConfirmDelete("");
                          }, "删除站点失败")}
                          type="button"
                        >
                          {busy ? "删除中…" : "确认删除"}
                        </button>
                        <button
                          className="h-8 rounded-lg border border-line bg-surface px-3 text-aux font-medium text-ink"
                          disabled={busy}
                          onClick={() => setConfirmDelete("")}
                          type="button"
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </Panel>
    </div>
  );
}

function StopEditor({
  data,
  meta,
  initial,
  busy,
  onSave,
  onCancel,
}: {
  data: TransitResponse;
  meta: TransitMeta;
  initial?: StopFormState;
  busy: boolean;
  onSave: (form: StopFormState) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [code, setCode] = useState(initial?.code ?? "");
  const [placeId, setPlaceId] = useState(initial?.placeId ?? "");
  const [campusId, setCampusId] = useState(initial?.campusId ?? "");
  const [status, setStatus] = useState<TransitStopStatus>(initial?.status ?? "active");
  const [locations, setLocations] = useState<LocationDraft[]>(initial?.locations ?? []);
  const [formError, setFormError] = useState("");

  // 站点通常就是一处校园地点，绑定后照片 / 联系方式 / 导航直接复用那条地点。
  //
  // 楼宇与楼外地点都能带：楼宇按建筑轮廓上图，楼外地点按自己的校区图点位上图
  // （buildMapPointPois），校车详情页顺着 release.pois 取导航链接，两种都在里面。
  // 前提是那条地点得有位置——楼宇要有建筑轮廓，楼外地点要在校区图上标过点。
  const placeOptions = data.places.map((place) => ({
    value: place.id,
    label: place.isBuilding
      ? (place.displayName ?? place.id)
      : `${place.displayName ?? place.id}（楼外地点）`,
  }));
  const boundPlace = placeId ? data.places.find((place) => place.id === placeId) ?? null : null;

  function submit() {
    if (!name.trim()) { setFormError("请填写站点名称"); return; }
    const kept = locations.filter((row) => !isLocationDraftBlank(row));
    if (kept.length > 0 && kept.filter((row) => row.isPrimary).length !== 1) {
      setFormError("上下车点里需要且只能有一个主要位置");
      return;
    }
    try {
      // locationInput 会校验经纬度成对、不与地图图形冲突等，先跑一遍再提交。
      kept.map(locationInput);
    } catch (err) {
      setFormError(errorMessage(err, "上下车点填写有误"));
      return;
    }
    setFormError("");
    void onSave({ name: name.trim(), code: code.trim(), placeId, campusId, status, locations: kept });
  }

  return (
    <div className="space-y-3 rounded-xl bg-page p-4">
      <div className="grid grid-cols-3 gap-3">
        <Field label="站点名称" onChange={setName} placeholder="如 宝山校区南大门" value={name} />
        <Field label="站点代码（可选）" onChange={setCode} placeholder="如 baoshan-south" value={code} />
        <SelectField
          label="停靠状态"
          onChange={(value) => setStatus(value as TransitStopStatus)}
          options={STOP_STATUS_OPTIONS}
          value={status}
        />
        <SelectField
          label="绑定地点（照片 / 联系方式 / 导航来源）"
          onChange={setPlaceId}
          options={placeOptions}
          placeholder="不绑定"
          value={placeId}
        />
        <SelectField
          label="所属校区"
          onChange={setCampusId}
          options={meta.spaces.campuses.map((campus) => ({ value: campus.id, label: campus.name }))}
          placeholder="不指定"
          value={campusId}
        />
      </div>

      {boundPlace === null ? (
        <InfoNote tone="warning">
          未绑定地点时，用户端只能看到站点名称与坐标，没有照片、联系方式，也点不出「导航到这里」。
        </InfoNote>
      ) : (
        <InfoNote tone="info">
          这个站点的照片与联系方式跟随地点「{boundPlace.displayName ?? boundPlace.id}」，
          在「内容管理 → 地点」里编辑即可同步。
          {boundPlace.isBuilding
            ? "该地点作为楼宇维护，需要有建筑轮廓才会出现在地图上。"
            : "这是一处楼外地点，需要在它的编辑页于校区图上标过点位，才会出现在地图上。"}
        </InfoNote>
      )}

      <LocationEditor
        disabled={busy}
        mapVersions={meta.mapVersions}
        onChange={setLocations}
        roles={STOP_LOCATION_ROLES}
        spaces={meta.spaces}
        title="上车 / 下车点"
        value={locations}
      />

      <ErrorBanner message={formError} />

      <div className="flex gap-2">
        <PrimaryButton disabled={busy} onClick={submit}>{busy ? "处理中…" : "保存"}</PrimaryButton>
        <GhostButton disabled={busy} onClick={onCancel}>取消</GhostButton>
        {locations.length === 0 ? (
          <GhostButton
            disabled={busy}
            onClick={() => setLocations([{ ...emptyLocation("boarding_point"), isPrimary: true }])}
          >
            <Plus size={14} />标一个上车点
          </GhostButton>
        ) : null}
      </div>
    </div>
  );
}

// ===========================================================================
// 线路（含方向）
// ===========================================================================

function LinesPanel({
  data,
  meta,
  busy,
  mutate,
  stopName,
}: PanelProps & { meta: TransitMeta; stopName: (id: string) => string }) {
  const [creatingRoute, setCreatingRoute] = useState(false);
  const [newRouteName, setNewRouteName] = useState("");
  const [newRouteCode, setNewRouteCode] = useState("");
  const [newRouteOperator, setNewRouteOperator] = useState("");

  const [editingRoute, setEditingRoute] = useState("");
  const [routeName, setRouteName] = useState("");
  const [routeCode, setRouteCode] = useState("");
  const [routeOperator, setRouteOperator] = useState("");
  const [routeStatus, setRouteStatus] = useState("active");
  const [confirmRouteDelete, setConfirmRouteDelete] = useState("");

  // 新方向：属于哪条线路、去程还是回程、按顺序有哪些站
  const [addingDirectionFor, setAddingDirectionFor] = useState("");
  const [directionId, setDirectionId] = useState("0");
  const [directionStops, setDirectionStops] = useState<StopDraft[]>([]);
  const [directionStopId, setDirectionStopId] = useState("");

  const [editingPattern, setEditingPattern] = useState("");
  const [patternName, setPatternName] = useState("");
  const [patternDirection, setPatternDirection] = useState("0");
  const [confirmPatternDelete, setConfirmPatternDelete] = useState("");

  const patternsByRoute = useMemo(() => {
    const map = new Map<string, TransitPatternRow[]>();
    for (const pattern of data.patterns) {
      const list = map.get(pattern.routeId) ?? [];
      list.push(pattern);
      map.set(pattern.routeId, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.directionId - b.directionId);
    return map;
  }, [data.patterns]);

  const stopsByPattern = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const row of [...data.patternStops].sort((a, b) => a.stopSequence - b.stopSequence)) {
      const list = map.get(row.patternId) ?? [];
      list.push(row.stopId);
      map.set(row.patternId, list);
    }
    return map;
  }, [data.patternStops]);

  const tripCountByPattern = useMemo(() => {
    const map = new Map<string, number>();
    for (const trip of data.trips) map.set(trip.patternId, (map.get(trip.patternId) ?? 0) + 1);
    return map;
  }, [data.trips]);

  const operatorName = useMemo(() => {
    const map = new Map(meta.ref.organizations.map((org) => [org.id, org.name]));
    return (id: string) => map.get(id) ?? id;
  }, [meta.ref.organizations]);

  const selectableStops = data.stops.filter((stop) => stop.status !== "retired");

  function startAddDirection(route: TransitRouteRow) {
    const existing = patternsByRoute.get(route.id) ?? [];
    // 已经有去程时默认补回程，反之默认去程。
    const hasOutbound = existing.some((pattern) => pattern.directionId === 0);
    setAddingDirectionFor(route.id);
    setDirectionId(hasOutbound ? "1" : "0");
    // 补反向时用已有方向的倒序作为起点，省掉重新点一遍站点。
    const mirror = existing.find((pattern) => pattern.directionId === (hasOutbound ? 0 : 1));
    const mirrorStops = mirror ? [...(stopsByPattern.get(mirror.id) ?? [])].reverse() : [];
    setDirectionStops(mirrorStops.map((stopId) => ({ stopId, pickupType: "regular", dropoffType: "regular" })));
    setDirectionStopId("");
    setEditingPattern("");
    setEditingRoute("");
  }

  return (
    <div className="space-y-4">
      <Panel
        title={`校车线路${data.routes.length ? `（${data.routes.length}）` : ""}`}
        action={
          <PrimaryButton className="h-8" onClick={() => setCreatingRoute((value) => !value)}>
            <Plus size={15} />新建线路
          </PrimaryButton>
        }
      >
        <div className="space-y-4">
          <InfoNote>
            一条线路包含去程与回程两个方向，班次时刻挂在方向上。方向的名称由线路名和去 / 回程自动生成，不用另起一个。
          </InfoNote>

          {creatingRoute ? (
            <div className="grid grid-cols-[1fr_180px_200px_auto] items-end gap-3 rounded-xl bg-page p-4">
              <Field label="线路名称" onChange={setNewRouteName} placeholder="如 宝山 ↔ 延长" value={newRouteName} />
              <Field label="代码（可选）" onChange={setNewRouteCode} placeholder="如 bs-yc" value={newRouteCode} />
              <SelectField
                label="运营单位（可选）"
                onChange={setNewRouteOperator}
                options={meta.ref.organizations.map((org) => ({ value: org.id, label: org.name }))}
                placeholder="不指定"
                value={newRouteOperator}
              />
              <div className="flex gap-2">
                <PrimaryButton
                  disabled={busy || !newRouteName.trim()}
                  onClick={() => void (async () => {
                    const ok = await mutate(
                      () => admin.createTransitRoute({
                        name: newRouteName.trim(),
                        code: newRouteCode.trim() || null,
                        operatorId: newRouteOperator || null,
                      }),
                      "新建线路失败",
                    );
                    if (ok) { setCreatingRoute(false); setNewRouteName(""); setNewRouteCode(""); setNewRouteOperator(""); }
                  })()}
                >
                  保存
                </PrimaryButton>
                <GhostButton onClick={() => setCreatingRoute(false)}>取消</GhostButton>
              </div>
            </div>
          ) : null}

          {data.routes.length === 0 ? <EmptyState label="暂无校车线路" /> : null}

          <div className="space-y-3">
            {data.routes.map((route) => {
              const patterns = patternsByRoute.get(route.id) ?? [];
              const statusMeta = ROUTE_STATUS_META[route.status] ?? { label: route.status, tone: "neutral" as const };
              return (
                <div className="rounded-xl border border-line" key={route.id}>
                  {editingRoute === route.id ? (
                    <div className="grid grid-cols-[1fr_160px_180px_160px_auto] items-end gap-3 p-4">
                      <Field label="线路名称" onChange={setRouteName} value={routeName} />
                      <Field label="代码" onChange={setRouteCode} value={routeCode} />
                      <SelectField
                        label="运营单位"
                        onChange={setRouteOperator}
                        options={meta.ref.organizations.map((org) => ({ value: org.id, label: org.name }))}
                        placeholder="不指定"
                        value={routeOperator}
                      />
                      <SelectField label="运行状态" onChange={setRouteStatus} options={ROUTE_STATUS_OPTIONS} value={routeStatus} />
                      <div className="flex gap-2">
                        <PrimaryButton
                          disabled={busy || !routeName.trim()}
                          onClick={() => void (async () => {
                            const ok = await mutate(
                              () => admin.updateTransitRoute(route.id, {
                                name: routeName.trim(),
                                code: routeCode.trim() || null,
                                operatorId: routeOperator || null,
                                status: routeStatus as admin.TransitRouteStatus,
                              }),
                              "保存线路失败",
                            );
                            if (ok) setEditingRoute("");
                          })()}
                        >
                          <Check size={14} />保存
                        </PrimaryButton>
                        <GhostButton onClick={() => setEditingRoute("")}>取消</GhostButton>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 px-4 py-3">
                      <span className="min-w-0 flex-1 truncate text-body font-semibold text-ink">{route.name}</span>
                      <span className="w-24 shrink-0 truncate text-aux text-sub">{route.code ?? "—"}</span>
                      <span className="w-40 shrink-0 truncate text-aux text-sub">
                        {route.operatorId ? operatorName(route.operatorId) : "未指定运营单位"}
                      </span>
                      <span className="w-20 shrink-0 text-aux text-sub">{patterns.length} 个方向</span>
                      <Pill tone={statusMeta.tone}>{statusMeta.label}</Pill>
                      <GhostButton
                        className="h-8"
                        disabled={busy || patterns.length >= 2}
                        onClick={() => startAddDirection(route)}
                        title={patterns.length >= 2 ? "去程与回程都已存在" : "补一个方向"}
                      >
                        <Plus size={13} />方向
                      </GhostButton>
                      <button
                        aria-label={`编辑线路 ${route.name}`}
                        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 text-aux font-medium text-ink disabled:opacity-40"
                        disabled={busy}
                        onClick={() => {
                          setEditingRoute(route.id);
                          setRouteName(route.name);
                          setRouteCode(route.code ?? "");
                          setRouteOperator(route.operatorId ?? "");
                          setRouteStatus(route.status);
                          setConfirmRouteDelete("");
                          setAddingDirectionFor("");
                        }}
                        type="button"
                      >
                        <Pencil size={13} />编辑
                      </button>
                      <button
                        aria-label={`删除线路 ${route.name}`}
                        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-error/40 px-3 text-aux font-medium text-error disabled:opacity-40"
                        disabled={busy || patterns.length > 0}
                        onClick={() => setConfirmRouteDelete(route.id)}
                        title={patterns.length > 0 ? "先删除这条线路下的方向，或改为「暂停运行」" : "彻底删除"}
                        type="button"
                      >
                        <Trash2 size={13} />删除
                      </button>
                    </div>
                  )}

                  {confirmRouteDelete === route.id ? (
                    <div className="mx-4 mb-3 rounded-lg bg-error-bg px-4 py-3">
                      <p className="text-body font-medium text-error">确认删除线路「{route.name}」？删除后不可恢复。</p>
                      <div className="mt-2.5 flex gap-2">
                        <button
                          className="h-8 rounded-lg bg-error px-3 text-aux font-semibold text-white disabled:opacity-40"
                          disabled={busy}
                          onClick={() => void mutate(async () => {
                            await admin.deleteTransitRoute(route.id);
                            setConfirmRouteDelete("");
                          }, "删除线路失败")}
                          type="button"
                        >
                          {busy ? "删除中…" : "确认删除"}
                        </button>
                        <button
                          className="h-8 rounded-lg border border-line bg-surface px-3 text-aux font-medium text-ink"
                          onClick={() => setConfirmRouteDelete("")}
                          type="button"
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {/* 方向列表 */}
                  <div className="border-t border-line px-4 py-2">
                    {patterns.length === 0 && addingDirectionFor !== route.id ? (
                      <p className="py-2 text-aux text-sub">还没有方向。点上面的「+ 方向」，按顺序选好站点即可。</p>
                    ) : null}
                    <div className="divide-y divide-line">
                      {patterns.map((pattern) => {
                        const stopIds = stopsByPattern.get(pattern.id) ?? [];
                        const tripCount = tripCountByPattern.get(pattern.id) ?? 0;
                        if (editingPattern === pattern.id) {
                          return (
                            <div className="grid grid-cols-[1fr_160px_auto] items-end gap-3 py-3" key={pattern.id}>
                              <Field label="方向名称" onChange={setPatternName} value={patternName} />
                              <SelectField label="走向" onChange={setPatternDirection} options={DIRECTION_OPTIONS} value={patternDirection} />
                              <div className="flex gap-2">
                                <PrimaryButton
                                  disabled={busy || !patternName.trim()}
                                  onClick={() => void (async () => {
                                    const ok = await mutate(
                                      () => admin.updateTransitPattern(pattern.id, {
                                        name: patternName.trim(),
                                        directionId: patternDirection === "0" ? 0 : 1,
                                      }),
                                      "保存方向失败",
                                    );
                                    if (ok) setEditingPattern("");
                                  })()}
                                >
                                  <Check size={14} />保存
                                </PrimaryButton>
                                <GhostButton onClick={() => setEditingPattern("")}>取消</GhostButton>
                              </div>
                            </div>
                          );
                        }
                        return (
                          <div key={pattern.id}>
                            <div className="flex items-center gap-3 py-2.5">
                              <Pill tone="info">{DIRECTION_LABELS[pattern.directionId] ?? `方向 ${pattern.directionId}`}</Pill>
                              <span className="min-w-0 flex-1 truncate text-aux text-sub">
                                {stopIds.length ? stopIds.map(stopName).join(" → ") : "还没有站点顺序"}
                              </span>
                              <span className="w-20 shrink-0 text-aux text-sub">{tripCount} 班</span>
                              <button
                                aria-label="重命名方向"
                                className="grid h-7 w-7 place-items-center rounded-md text-sub hover:bg-chip"
                                onClick={() => {
                                  setEditingPattern(pattern.id);
                                  setPatternName(pattern.name);
                                  setPatternDirection(String(pattern.directionId));
                                  setConfirmPatternDelete("");
                                }}
                                type="button"
                              >
                                <Pencil size={14} />
                              </button>
                              <button
                                aria-label="删除方向"
                                className="grid h-7 w-7 place-items-center rounded-md text-error hover:bg-error-bg disabled:opacity-30"
                                disabled={busy || tripCount > 0}
                                onClick={() => setConfirmPatternDelete(pattern.id)}
                                title={tripCount > 0 ? "先在「班次时刻」里删掉这个方向的班次" : "删除方向"}
                                type="button"
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                            {confirmPatternDelete === pattern.id ? (
                              <div className="mb-2.5 rounded-lg bg-error-bg px-4 py-3">
                                <p className="text-body font-medium text-error">
                                  确认删除这个方向？它的站点顺序会一并删除。
                                </p>
                                <div className="mt-2.5 flex gap-2">
                                  <button
                                    className="h-8 rounded-lg bg-error px-3 text-aux font-semibold text-white disabled:opacity-40"
                                    disabled={busy}
                                    onClick={() => void mutate(async () => {
                                      await admin.deleteTransitPattern(pattern.id);
                                      setConfirmPatternDelete("");
                                    }, "删除方向失败")}
                                    type="button"
                                  >
                                    {busy ? "删除中…" : "确认删除"}
                                  </button>
                                  <button
                                    className="h-8 rounded-lg border border-line bg-surface px-3 text-aux font-medium text-ink"
                                    onClick={() => setConfirmPatternDelete("")}
                                    type="button"
                                  >
                                    取消
                                  </button>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>

                    {addingDirectionFor === route.id ? (
                      <div className="my-3 space-y-3 rounded-lg bg-page p-3">
                        <div className="grid grid-cols-[160px_1fr] items-end gap-3">
                          <SelectField label="走向" onChange={setDirectionId} options={DIRECTION_OPTIONS} value={directionId} />
                          <p className="text-aux text-sub">
                            方向名称会记为「{route.name} · {DIRECTION_LABELS[directionId === "0" ? 0 : 1]}」
                          </p>
                        </div>
                        {directionStops.map((stop, index) => (
                          <div className="rounded-lg border border-line bg-surface p-3" key={stop.stopId}>
                            <div className="flex items-center gap-2">
                              <span className="grid h-6 w-6 place-items-center rounded-full bg-chip text-aux font-semibold text-sub">
                                {index + 1}
                              </span>
                              <span className="flex-1 text-body font-semibold text-ink">{stopName(stop.stopId)}</span>
                              <GhostButton
                                className="h-8"
                                disabled={index === 0}
                                onClick={() => setDirectionStops((current) => {
                                  const next = [...current];
                                  [next[index - 1], next[index]] = [next[index], next[index - 1]];
                                  return next;
                                })}
                              >
                                <ArrowUp size={14} />
                              </GhostButton>
                              <GhostButton
                                className="h-8"
                                disabled={index === directionStops.length - 1}
                                onClick={() => setDirectionStops((current) => {
                                  const next = [...current];
                                  [next[index], next[index + 1]] = [next[index + 1], next[index]];
                                  return next;
                                })}
                              >
                                <ArrowDown size={14} />
                              </GhostButton>
                              <GhostButton
                                className="h-8"
                                danger
                                onClick={() => setDirectionStops((current) => current.filter((_, i) => i !== index))}
                              >
                                <Trash2 size={14} />
                              </GhostButton>
                            </div>
                            <div className="mt-2 grid grid-cols-2 gap-2">
                              <SelectField
                                label="上车规则"
                                onChange={(pickupType) => setDirectionStops((current) =>
                                  current.map((row, i) => i === index ? { ...row, pickupType: pickupType as TransitPickupType } : row))}
                                options={PICKUP_OPTIONS}
                                value={stop.pickupType}
                              />
                              <SelectField
                                label="下车规则"
                                onChange={(dropoffType) => setDirectionStops((current) =>
                                  current.map((row, i) => i === index ? { ...row, dropoffType: dropoffType as TransitDropoffType } : row))}
                                options={DROPOFF_OPTIONS}
                                value={stop.dropoffType}
                              />
                            </div>
                          </div>
                        ))}
                        <div className="flex items-end gap-2">
                          <div className="flex-1">
                            <SelectField
                              label="添加站点"
                              onChange={setDirectionStopId}
                              options={selectableStops
                                .filter((stop) => !directionStops.some((item) => item.stopId === stop.id))
                                .map((stop) => ({ value: stop.id, label: stop.name }))}
                              placeholder="选择站点"
                              value={directionStopId}
                            />
                          </div>
                          <GhostButton
                            disabled={!directionStopId}
                            onClick={() => {
                              setDirectionStops((current) => [...current, { stopId: directionStopId, pickupType: "regular", dropoffType: "regular" }]);
                              setDirectionStopId("");
                            }}
                          >
                            <Plus size={14} />添加
                          </GhostButton>
                        </div>
                        {directionStops.length < 2 ? <InfoNote tone="warning">一个方向至少需要两个站点</InfoNote> : null}
                        <div className="flex gap-2">
                          <PrimaryButton
                            disabled={busy || directionStops.length < 2}
                            onClick={() => void (async () => {
                              const direction = directionId === "0" ? 0 : 1;
                              const ok = await mutate(
                                () => admin.createTransitPattern({
                                  routeId: route.id,
                                  directionId: direction,
                                  name: `${route.name} · ${DIRECTION_LABELS[direction]}`,
                                  stops: directionStops,
                                }),
                                "新建方向失败",
                              );
                              if (ok) { setAddingDirectionFor(""); setDirectionStops([]); setDirectionStopId(""); }
                            })()}
                          >
                            保存方向
                          </PrimaryButton>
                          <GhostButton onClick={() => setAddingDirectionFor("")}>取消</GhostButton>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </Panel>
    </div>
  );
}

// ===========================================================================
// 服务日历
// ===========================================================================

interface CalendarFormState {
  name: string;
  validFrom: string;
  validTo: string;
  weekdays: boolean[];
  exceptions: Array<{ date: string; type: "added" | "removed"; label: string }>;
  sourceId: string;
}

function CalendarsPanel({
  data,
  meta,
  busy,
  mutate,
}: PanelProps & { meta: TransitMeta }) {
  const [editing, setEditing] = useState<"new" | string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState("");

  const exceptionsByCalendar = useMemo(() => {
    const map = new Map<string, CalendarFormState["exceptions"]>();
    for (const row of data.exceptions) {
      const list = map.get(row.calendarId) ?? [];
      list.push({ date: row.serviceDate, type: row.exceptionType, label: row.label ?? "" });
      map.set(row.calendarId, list);
    }
    return map;
  }, [data.exceptions]);

  const tripCountByCalendar = useMemo(() => {
    const map = new Map<string, number>();
    for (const trip of data.trips) map.set(trip.serviceCalendarId, (map.get(trip.serviceCalendarId) ?? 0) + 1);
    return map;
  }, [data.trips]);

  function formOf(calendar: ServiceCalendarRow): CalendarFormState {
    return {
      name: calendar.name,
      validFrom: calendar.validFrom,
      validTo: calendar.validTo,
      weekdays: WEEK_KEYS.map((key) => calendar[key] === 1),
      exceptions: exceptionsByCalendar.get(calendar.id) ?? [],
      sourceId: calendar.sourceId ?? "",
    };
  }

  return (
    <Panel
      title={`服务日历${data.calendars.length ? `（${data.calendars.length}）` : ""}`}
      action={
        editing === null ? (
          <PrimaryButton className="h-8" onClick={() => setEditing("new")}>
            <Plus size={15} />新建日历
          </PrimaryButton>
        ) : null
      }
    >
      <div className="space-y-4">
        <InfoNote>
          日历决定一批班次在哪些天开行：勾选每周的运行日，再用例外日期处理调休与停运。班次在「班次时刻」里挂到日历上。
        </InfoNote>

        {editing === "new" ? (
          <CalendarEditor
            busy={busy}
            meta={meta}
            onCancel={() => setEditing(null)}
            onSave={async (form) => {
              const ok = await mutate(
                () => admin.createTransitCalendar({
                  name: form.name,
                  validFrom: form.validFrom,
                  validTo: form.validTo,
                  weekdays: Object.fromEntries(WEEK_KEYS.map((key, index) => [key, form.weekdays[index]])) as Record<
                    (typeof WEEK_KEYS)[number], boolean
                  >,
                  exceptions: form.exceptions
                    .filter((item) => item.date)
                    .map((item) => ({ date: item.date, type: item.type, label: item.label.trim() || null })),
                  sourceId: form.sourceId || null,
                }),
                "新建日历失败",
              );
              if (ok) setEditing(null);
            }}
          />
        ) : null}

        {data.calendars.length === 0 && editing !== "new" ? <EmptyState label="暂无服务日历" /> : null}

        <div className="divide-y divide-line">
          {data.calendars.map((calendar) => {
            if (editing === calendar.id) {
              return (
                <div className="py-3" key={calendar.id}>
                  <CalendarEditor
                    busy={busy}
                    initial={formOf(calendar)}
                    meta={meta}
                    onCancel={() => setEditing(null)}
                    onSave={async (form) => {
                      const ok = await mutate(
                        () => admin.updateTransitCalendar(calendar.id, {
                          name: form.name,
                          validFrom: form.validFrom,
                          validTo: form.validTo,
                          weekdays: Object.fromEntries(WEEK_KEYS.map((key, index) => [key, form.weekdays[index]])) as Record<
                            (typeof WEEK_KEYS)[number], boolean
                          >,
                          exceptions: form.exceptions
                            .filter((item) => item.date)
                            .map((item) => ({ date: item.date, type: item.type, label: item.label.trim() || null })),
                          sourceId: form.sourceId || null,
                        }),
                        "保存日历失败",
                      );
                      if (ok) setEditing(null);
                    }}
                  />
                </div>
              );
            }
            const tripCount = tripCountByCalendar.get(calendar.id) ?? 0;
            const exceptions = exceptionsByCalendar.get(calendar.id) ?? [];
            return (
              <div key={calendar.id}>
                <div className="flex items-center gap-3 py-3">
                  <span className="min-w-0 w-56 shrink-0 truncate font-medium text-ink">{calendar.name}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {WEEK_LABELS.map((label, index) => (
                      <span
                        key={label}
                        className={`grid h-6 w-6 place-items-center rounded-full text-label font-medium ${
                          calendar[WEEK_KEYS[index]] ? "bg-primary text-white" : "bg-page text-sub"
                        }`}
                      >
                        {label}
                      </span>
                    ))}
                  </span>
                  <span className="w-40 shrink-0 text-aux text-sub">
                    {fmtDay(calendar.validFrom)} 至 {fmtDay(calendar.validTo)}
                  </span>
                  <span className="w-24 shrink-0 text-aux text-sub">{exceptions.length ? `${exceptions.length} 个例外` : "无例外"}</span>
                  <span className="flex-1" />
                  <span className="w-20 shrink-0 text-aux text-sub">{tripCount} 班</span>
                  <button
                    aria-label={`编辑 ${calendar.name}`}
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 text-aux font-medium text-ink disabled:opacity-40"
                    disabled={busy}
                    onClick={() => { setEditing(calendar.id); setConfirmDelete(""); }}
                    type="button"
                  >
                    <Pencil size={13} />编辑
                  </button>
                  <button
                    aria-label={`删除 ${calendar.name}`}
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-error/40 px-3 text-aux font-medium text-error disabled:opacity-40"
                    disabled={busy || tripCount > 0}
                    onClick={() => setConfirmDelete(calendar.id)}
                    title={tripCount > 0 ? "还有班次挂在这个日历上，先改到别的日历或删掉" : "彻底删除"}
                    type="button"
                  >
                    <Trash2 size={13} />删除
                  </button>
                </div>
                {confirmDelete === calendar.id ? (
                  <div className="mb-3 rounded-lg bg-error-bg px-4 py-3">
                    <p className="text-body font-medium text-error">确认删除日历「{calendar.name}」？例外日期会一并删除。</p>
                    <div className="mt-2.5 flex gap-2">
                      <button
                        className="h-8 rounded-lg bg-error px-3 text-aux font-semibold text-white disabled:opacity-40"
                        disabled={busy}
                        onClick={() => void mutate(async () => {
                          await admin.deleteTransitCalendar(calendar.id);
                          setConfirmDelete("");
                        }, "删除日历失败")}
                        type="button"
                      >
                        {busy ? "删除中…" : "确认删除"}
                      </button>
                      <button
                        className="h-8 rounded-lg border border-line bg-surface px-3 text-aux font-medium text-ink"
                        onClick={() => setConfirmDelete("")}
                        type="button"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </Panel>
  );
}

function CalendarEditor({
  meta,
  initial,
  busy,
  onSave,
  onCancel,
}: {
  meta: TransitMeta;
  initial?: CalendarFormState;
  busy: boolean;
  onSave: (form: CalendarFormState) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [validFrom, setValidFrom] = useState(initial?.validFrom ?? today());
  const [validTo, setValidTo] = useState(initial?.validTo ?? `${new Date().getFullYear()}-12-31`);
  const [weekdays, setWeekdays] = useState(initial?.weekdays ?? [true, true, true, true, true, false, false]);
  const [exceptions, setExceptions] = useState(initial?.exceptions ?? []);
  const [sourceId, setSourceId] = useState(initial?.sourceId ?? "");
  const [formError, setFormError] = useState("");

  function submit() {
    if (!name.trim()) { setFormError("请填写日历名称"); return; }
    if (validFrom > validTo) { setFormError("开始日期不能晚于结束日期"); return; }
    const filled = exceptions.filter((item) => item.date);
    const outside = filled.find((item) => item.date < validFrom || item.date > validTo);
    if (outside) { setFormError(`例外日期 ${outside.date} 不在 ${validFrom} 至 ${validTo} 之间`); return; }
    const dates = new Set<string>();
    for (const item of filled) {
      if (dates.has(item.date)) { setFormError(`例外日期 ${item.date} 重复了`); return; }
      dates.add(item.date);
    }
    setFormError("");
    void onSave({ name: name.trim(), validFrom, validTo, weekdays, exceptions: filled, sourceId });
  }

  return (
    <div className="space-y-3 rounded-xl bg-page p-4">
      <div className="grid grid-cols-4 gap-3">
        <Field label="日历名称" onChange={setName} placeholder="如 2025-2026 工作日" value={name} />
        <Field label="开始日期" onChange={setValidFrom} type="date" value={validFrom} />
        <Field label="结束日期" onChange={setValidTo} type="date" value={validTo} />
        <SelectField
          label="数据来源（可选）"
          onChange={setSourceId}
          options={meta.ref.sources.map((source) => ({ value: source.id, label: source.title }))}
          placeholder="不指定"
          value={sourceId}
        />
      </div>

      <div>
        <p className="mb-1.5 text-label text-sub">每周运行日</p>
        <div className="flex gap-2">
          {WEEK_LABELS.map((day, index) => (
            <button
              aria-label={`星期${day}${weekdays[index] ? "运行" : "不运行"}`}
              aria-pressed={weekdays[index]}
              className={`h-9 w-9 rounded-full text-body ${weekdays[index] ? "bg-primary text-white" : "bg-surface text-sub"}`}
              key={day}
              onClick={() => setWeekdays((rows) => rows.map((value, i) => (i === index ? !value : value)))}
              type="button"
            >
              {day}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-label text-sub">例外日期（调休加开 / 临时停运）</p>
        {exceptions.map((item, index) => (
          <div className="grid grid-cols-[150px_150px_1fr_auto] gap-2" key={`${item.date}:${index}`}>
            <Field
              onChange={(date) => setExceptions((rows) => rows.map((row, i) => (i === index ? { ...row, date } : row)))}
              type="date"
              value={item.date}
            />
            <SelectField
              onChange={(type) => setExceptions((rows) =>
                rows.map((row, i) => (i === index ? { ...row, type: type === "added" ? "added" : "removed" } : row)))}
              options={[{ value: "added", label: "增加服务" }, { value: "removed", label: "暂停服务" }]}
              value={item.type}
            />
            <Field
              onChange={(label) => setExceptions((rows) => rows.map((row, i) => (i === index ? { ...row, label } : row)))}
              placeholder="说明，如 国庆调休"
              value={item.label}
            />
            <GhostButton danger onClick={() => setExceptions((rows) => rows.filter((_, i) => i !== index))}>
              <Trash2 size={14} />
            </GhostButton>
          </div>
        ))}
        <GhostButton onClick={() => setExceptions((rows) => [...rows, { date: "", type: "added", label: "" }])}>
          <Plus size={14} />例外日期
        </GhostButton>
      </div>

      <ErrorBanner message={formError} />

      <div className="flex gap-2">
        <PrimaryButton disabled={busy} onClick={submit}>{busy ? "处理中…" : "保存"}</PrimaryButton>
        <GhostButton disabled={busy} onClick={onCancel}>取消</GhostButton>
      </div>
    </div>
  );
}
