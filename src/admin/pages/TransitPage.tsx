import { ArrowDown, ArrowUp, Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
  MarkerScaleField,
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
import { ShuttleGuidePanel } from "../components/ShuttleGuidePanel";
import type { LocationRole } from "../../../shared/revision-contract";

// ---------------------------------------------------------------------------
// A8 校车管理
//
// 前四个分区共用一次 GET /api/admin/transit：
//   · 班次时刻 —— 选一条线路，编辑它的站点顺序与每日班次
//   · 站点     —— 站点的增删改，含地点绑定与候车点 / 导航坐标
//   · 线路     —— 线路（校区对 + 乘车方式）的增删改
//   · 服务日历 —— 运行日、日期范围与例外日期
//
// 线路的真实模型是「校区对 + 是否预约」，与去程 / 回程无关：属于哪个校区对由
// 站点序列首末站所属校区决定，名称自动派生为「起点校区 → 终点校区」（预约线加
// 「（预约）」后缀），不由用户填写。数据库里 transit_routes → transit_patterns
// 是 1:1，pattern 只是实现细节，界面上不出现「方向」概念。
// ---------------------------------------------------------------------------

// 「乘坐指南」与前四个分区不是一类东西：前四个都在写 transit_* 表（一次
// GET /api/admin/transit 拿全），它写的是 guide_documents（slug=shuttle-ride），
// 走草稿→送审→发布的独立流水线。放在同一个 tab 组里是因为运营视角上它就是
// 「校车这件事」的一部分——编辑的人不该为了写一段乘车说明去翻另一个侧栏入口。
type Tab = "schedule" | "stops" | "lines" | "calendars" | "guide";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "schedule", label: "班次时刻" },
  { key: "stops", label: "站点" },
  { key: "lines", label: "线路" },
  { key: "calendars", label: "服务日历" },
  { key: "guide", label: "乘坐指南" },
];

const WEEK_LABELS = ["一", "二", "三", "四", "五", "六", "日"];
const WEEK_KEYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;


/** 站点自身的锚点：候车点，外加可选的导航终点。上 / 下车安排归线路（pattern 的 pickup/dropoff），不归站点。 */
const STOP_LOCATION_ROLES: readonly LocationRole[] = ["boarding_point", "navigation_target"];

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
  transit_stop_in_use: "还有线路或班次停靠这个站点。先把它从线路的站点顺序里移除，再停用或删除。",
  transit_route_in_use: "这条线路已配置站点序列，不能直接删除。如不再开行，请改为「暂停运行」。",
  transit_pattern_in_use: "这条线路下面还有班次。先删掉班次，再删除线路的站点序列。",
  transit_pattern_duplicate: "这条线路已经有同名同走向的站点序列了。",
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

/** 班次编辑表的一行：tripId 为 null 表示本轮新增的班次。 */
interface TripDraft {
  key: string;
  tripId: string | null;
  times: string[];
}

function sameTimes(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((time, index) => time.trim() === b[index].trim());
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

  // reload 会把 useAsyncData 重置回 loading；若此时直接渲染 LoadingState，整个
  // ReadyTransitPage 会被卸载重挂，线路 / 日历选择和草稿全部回到默认。这里留住
  // 最近一次成功数据，刷新期间继续渲染旧数据，直到新数据到达。
  const [lastTransit, setLastTransit] = useState<TransitResponse | null>(null);
  useEffect(() => {
    if (transit.state.status === "ready") setLastTransit(transit.state.data);
  }, [transit.state]);

  if (transit.state.status === "error" && lastTransit === null) return <ErrorBanner message={transit.state.message} />;
  if (meta.state.status === "error") return <ErrorBanner message={meta.state.message} />;
  if (lastTransit === null || meta.state.status !== "ready") return <LoadingState label="加载校车数据…" />;
  return <ReadyTransitPage data={lastTransit} meta={meta.state.data} reload={transit.reload} />;
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

  const campusName = useMemo(() => {
    const map = new Map(meta.spaces.campuses.map((campus) => [campus.id, campus.name]));
    return (id: string) => map.get(id) ?? id;
  }, [meta.spaces.campuses]);

  /** 站点的线路端点名：campus_id 指向校区名；无校区站点（如陈太公寓）自己就是端点。 */
  const stopEndpointName = useMemo(() => {
    const stopById = new Map(data.stops.map((stop) => [stop.id, stop]));
    return (stopId: string) => {
      const stop = stopById.get(stopId);
      if (!stop) throw new Error(`校车数据引用了不存在的站点 ${stopId}`);
      return stop.campusId ? campusName(stop.campusId) : stop.name;
    };
  }, [data.stops, campusName]);

  /** 线路名自动派生：「首站端点 → 末站端点」，预约线加「（预约）」。站点不足两个返回 null。 */
  const deriveRouteName = useMemo(() => {
    return (stopIds: string[], bookingPolicy: TransitBookingPolicy): string | null => {
      if (stopIds.length < 2) return null;
      const base = `${stopEndpointName(stopIds[0])} → ${stopEndpointName(stopIds[stopIds.length - 1])}`;
      return bookingPolicy === "required" ? `${base}（预约）` : base;
    };
  }, [stopEndpointName]);

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
        <SchedulePanel busy={busy} data={data} deriveRouteName={deriveRouteName} mutate={mutate} stopName={stopName} />
      ) : null}
      {tab === "stops" ? <StopsPanel busy={busy} data={data} meta={meta} mutate={mutate} /> : null}
      {tab === "lines" ? (
        <LinesPanel busy={busy} data={data} deriveRouteName={deriveRouteName} meta={meta} mutate={mutate} />
      ) : null}
      {tab === "calendars" ? <CalendarsPanel busy={busy} data={data} meta={meta} mutate={mutate} /> : null}
      {/* 乘坐指南自带数据加载与错误处理（写的是 guide_documents，不在 GET /api/admin/transit
          里），所以不吃外层的 busy / mutate / data —— 那三个都是校车表的。 */}
      {tab === "guide" ? <ShuttleGuidePanel /> : null}
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
  deriveRouteName,
}: PanelProps & {
  stopName: (id: string) => string;
  deriveRouteName: (stopIds: string[], bookingPolicy: TransitBookingPolicy) => string | null;
}) {
  const [patternId, setPatternId] = useState("");
  const [calendarId, setCalendarId] = useState("");

  const [sequence, setSequence] = useState<StopDraft[]>([]);
  const [addStopId, setAddStopId] = useState("");
  const [sequenceSaved, setSequenceSaved] = useState(false);

  // 班次表按线路 + 日历批量编辑：rows 是整表草稿，deletedIds 是待删除的已落库班次。
  const [rows, setRows] = useState<TripDraft[]>([]);
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const [tripError, setTripError] = useState("");
  const [tripSaved, setTripSaved] = useState(false);
  const [pendingDelete, setPendingDelete] = useState("");

  const { patterns, calendars, stops } = data;
  const selectedPatternId = patterns.some((pattern) => pattern.id === patternId) ? patternId : patterns[0]?.id ?? "";
  const selectedCalendarId = calendars.some((calendar) => calendar.id === calendarId) ? calendarId : calendars[0]?.id ?? "";
  const activeCalendar = calendars.find((calendar) => calendar.id === selectedCalendarId);
  // 预约与否是线路级属性（0024）：班次不再单独选乘车方式，这里只读回显。
  const selectedRoute = data.routes.find((route) => route.id === patterns.find((pattern) => pattern.id === selectedPatternId)?.routeId);

  /** 已落库的站点顺序，用作草稿基线。 */
  const savedSequence = useMemo<StopDraft[]>(
    () =>
      data.patternStops
        .filter((row) => row.patternId === selectedPatternId)
        .sort((a, b) => a.stopSequence - b.stopSequence)
        .map((row) => ({ stopId: row.stopId, pickupType: row.pickupType, dropoffType: row.dropoffType })),
    [data.patternStops, selectedPatternId],
  );

  // 只在切换线路时回到已落库状态，避免草稿串到别的线路；数据刷新不重置站点顺序草稿。
  const lastSequencePatternId = useRef<string | null>(null);
  useEffect(() => {
    if (lastSequencePatternId.current === selectedPatternId) return;
    lastSequencePatternId.current = selectedPatternId;
    setSequence(savedSequence);
    setAddStopId("");
    setSequenceSaved(false);
  }, [savedSequence, selectedPatternId]);

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

  /** 已落库班次的表格基线，按首站发车时间升序。 */
  const savedRows = useMemo<TripDraft[]>(
    () =>
      trips
        .map((trip) => ({ key: trip.id, tripId: trip.id as string | null, times: tripTimes(trip.id) }))
        .sort((a, b) => a.times[0].localeCompare(b.times[0])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trips, savedSequence, timesByTrip],
  );

  const selectionKey = `${selectedPatternId}:${selectedCalendarId}`;
  const lastSelectionKey = useRef<string | null>(null);
  // 保存成功后下一次数据刷新到达时，整表重建为最新的已落库状态。
  const resyncOnRefresh = useRef(false);

  // 切换线路或日历时整表重建；数据刷新时按 tripId 保留能对上的未保存草稿，
  // 对不上的（如刚删的行）丢弃。
  useEffect(() => {
    if (lastSelectionKey.current !== selectionKey) {
      lastSelectionKey.current = selectionKey;
      setRows(savedRows);
      setDeletedIds([]);
      setPendingDelete("");
      setTripError("");
      setTripSaved(false);
      return;
    }
    if (resyncOnRefresh.current) {
      resyncOnRefresh.current = false;
      setRows(savedRows);
      setDeletedIds([]);
      setPendingDelete("");
      return;
    }
    const savedIds = new Set(savedRows.map((row) => row.tripId));
    setRows((current) => current.filter((row) => row.tripId === null || savedIds.has(row.tripId)));
    setDeletedIds((current) => current.filter((id) => savedIds.has(id)));
  }, [selectionKey, savedRows]);

  /** 相对已落库状态是否有改动：待删除、新增非空行、或时刻被改过。 */
  const tripsDirty = deletedIds.length > 0
    || rows.some((row) => {
      if (row.tripId === null) return row.times.some((time) => time.trim() !== "");
      const saved = savedRows.find((item) => item.tripId === row.tripId);
      return !saved || !sameTimes(row.times, saved.times);
    });

  const newRowKey = useRef(0);

  function addTripRow() {
    setRows((current) => [
      ...current,
      { key: `new-${++newRowKey.current}`, tripId: null, times: savedSequence.map(() => "") },
    ]);
    setTripSaved(false);
  }

  function patchTripTime(rowKey: string, index: number, value: string) {
    setRows((current) =>
      current.map((row) =>
        row.key === rowKey
          ? { ...row, times: row.times.map((time, i) => (i === index ? value : time)) }
          : row));
    setTripSaved(false);
  }

  /** 删除暂存：新增行直接移除；已落库班次记入 deletedIds，保存时才真正删除。 */
  function stageDelete(row: TripDraft) {
    const tripId = row.tripId;
    setRows((current) => current.filter((item) => item.key !== row.key));
    if (tripId !== null) setDeletedIds((current) => [...current, tripId]);
    setPendingDelete("");
    setTripSaved(false);
  }

  function discardTripChanges() {
    setRows(savedRows);
    setDeletedIds([]);
    setPendingDelete("");
    setTripError("");
    setTripSaved(false);
  }

  /** 全量校验：所有行首站必填且 HH:MM，其余站可空但非空必须 HH:MM；全空的新增行忽略。 */
  function validateRows(): boolean {
    for (const [index, row] of rows.entries()) {
      const trimmed = row.times.map((time) => time.trim());
      if (row.tripId === null && trimmed.every((time) => time === "")) continue;
      const label = `第 ${index + 1} 班（${trimmed[0] || "未填发车时间"}）`;
      if (!TIME_PATTERN.test(trimmed[0] ?? "")) {
        setTripError(`${label}：请填写发车时间，格式为 07:30`);
        return false;
      }
      const invalid = trimmed.findIndex((time, stopIndex) => stopIndex > 0 && time !== "" && !TIME_PATTERN.test(time));
      if (invalid >= 0) {
        setTripError(`${label}「${stopName(savedSequence[invalid].stopId)}」的时间格式应为 07:30`);
        return false;
      }
    }
    setTripError("");
    return true;
  }

  async function saveTrips() {
    if (!validateRows()) return;
    const ok = await mutate(async () => {
      // 按序执行：先删除，再更新改过的行，最后新增。某行失败时报错带上是第几班。
      for (const tripId of deletedIds) {
        const saved = savedRows.find((row) => row.tripId === tripId);
        try {
          await admin.deleteTransitTrip(tripId);
        } catch (err) {
          throw new Error(`删除 ${saved ? saved.times[0] : tripId} 班次失败：${transitError(err, "请稍后重试")}`);
        }
      }
      for (const [index, row] of rows.entries()) {
        const trimmed = row.times.map((time) => time.trim());
        if (row.tripId === null && trimmed.every((time) => time === "")) continue;
        if (row.tripId !== null) {
          const saved = savedRows.find((item) => item.tripId === row.tripId);
          if (saved && sameTimes(trimmed, saved.times)) continue;
        }
        const stopTimes = trimmed.map((time) => ({ arrivalTime: time || null, departureTime: time || null }));
        const label = `第 ${index + 1} 班（${trimmed[0]}）`;
        try {
          if (row.tripId === null) {
            await admin.createTransitTrip({
              patternId: selectedPatternId,
              serviceCalendarId: selectedCalendarId,
              publicLabel: null,
              bookingUrl: null,
              sourceId: null,
              stopTimes,
            });
          } else {
            await admin.updateTransitTrip(row.tripId, { serviceCalendarId: selectedCalendarId, stopTimes });
          }
        } catch (err) {
          throw new Error(`${label}保存失败：${transitError(err, "请稍后重试")}`);
        }
      }
    }, "保存班次失败，请稍后重试");
    if (ok) {
      resyncOnRefresh.current = true;
      setTripSaved(true);
    }
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
    const ok = await mutate(async () => {
      await admin.replaceTransitPatternStops(selectedPatternId, sequence);
      // 首末站变化会改变线路所属的校区对；线路名是派生值，顺手改回最新派生名。
      const derived = deriveRouteName(
        sequence.map((stop) => stop.stopId),
        selectedRoute?.bookingPolicy ?? "not_required",
      );
      if (selectedRoute && derived !== null && derived !== selectedRoute.name) {
        await admin.updateTransitRoute(selectedRoute.id, { name: derived });
      }
    }, "保存站点顺序失败，请稍后重试");
    if (ok) setSequenceSaved(true);
  }

  if (patterns.length === 0) {
    return (
      <Panel title="班次时刻">
        <InfoNote tone="warning">还没有线路。请先在「线路」里新建一条线路，再回来编辑站点顺序与班次。</InfoNote>
      </Panel>
    );
  }

  const canEditTrips = savedSequence.length >= 2 && activeCalendar !== undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-72">
          <SelectField
            label="线路"
            onChange={setPatternId}
            options={patterns.map((pattern) => ({
              value: pattern.id,
              label: data.routes.find((route) => route.id === pattern.routeId)?.name ?? pattern.name,
            }))}
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

            {sequence.length === 0 ? <EmptyState label="这条线路还没有站点" /> : null}

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

            {sequence.length === 1 ? <InfoNote tone="warning">一条线路至少需要两个站点才能保存</InfoNote> : null}

            <div className="flex items-center gap-2">
              <PrimaryButton disabled={!sequenceDirty || sequence.length < 2 || busy} onClick={() => void saveSequence()}>
                保存站点顺序
              </PrimaryButton>
              {sequenceDirty ? (
                <GhostButton disabled={busy} onClick={() => setSequence(savedSequence)}>还原</GhostButton>
              ) : null}
            </div>
          </div>
        </Panel>

        <div className="space-y-4">
          <Panel
            title={activeCalendar ? `班次时刻 · ${activeCalendar.name}` : "班次时刻"}
            action={
              canEditTrips ? (
                <button className="flex items-center gap-1 text-aux font-medium text-primary" onClick={addTripRow} type="button">
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
            ) : savedSequence.length < 2 ? (
              <div className="p-5">
                <EmptyState label="先保存站点顺序，再添加班次" />
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-left text-body">
                    <thead>
                      <tr className="text-label text-sub">
                        {savedSequence.map((stop, index) => (
                          <th key={stop.stopId} className="whitespace-nowrap px-3 pb-2 pt-1 font-medium first:pl-5">
                            {stopName(stop.stopId)}{index === 0 ? " 发车" : " 到达"}
                          </th>
                        ))}
                        <th className="px-3 pb-2 pt-1 pr-5 font-medium" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {rows.map((row) => (
                        <tr key={row.key} className={row.tripId === null ? "bg-primary-container/40" : undefined}>
                          {savedSequence.map((stop, index) => (
                            <td key={stop.stopId} className="px-3 py-2 first:pl-5">
                              <input
                                aria-label={`${stopName(stop.stopId)}${index === 0 ? "发车" : "到达"}时间`}
                                className="h-9 w-24 rounded-lg border border-line bg-surface px-3 text-body text-ink outline-none focus:border-primary"
                                onChange={(e) => patchTripTime(row.key, index, e.target.value)}
                                placeholder={index === 0 ? "07:30" : "可留空"}
                                value={row.times[index] ?? ""}
                              />
                            </td>
                          ))}
                          <td className="whitespace-nowrap px-3 py-2 pr-5">
                            {row.tripId !== null && pendingDelete === row.key ? (
                              <span className="flex items-center gap-2">
                                <button
                                  className="text-aux font-medium text-error disabled:opacity-50"
                                  disabled={busy}
                                  onClick={() => stageDelete(row)}
                                  type="button"
                                >
                                  确认删除
                                </button>
                                <button className="text-aux text-sub" onClick={() => setPendingDelete("")} type="button">取消</button>
                              </span>
                            ) : (
                              <button
                                aria-label="删除班次"
                                className="grid h-7 w-7 place-items-center rounded-md text-error hover:bg-error-bg"
                                onClick={() => (row.tripId === null ? stageDelete(row) : setPendingDelete(row.key))}
                                type="button"
                              >
                                <X size={15} />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {rows.length === 0 ? (
                  <div className="p-5">
                    <EmptyState label="该日历下暂无班次，点右上角「添加班次」排班" />
                  </div>
                ) : null}
                <div className="space-y-3 px-5 pb-4 pt-2">
                  <InfoNote>乘车方式由线路决定：当前线路为「{selectedRoute ? POLICY_META[selectedRoute.bookingPolicy].label : "—"}」，要改请到「线路」页调整。</InfoNote>
                  <div className="flex items-center gap-2">
                    <PrimaryButton disabled={!tripsDirty || busy} onClick={() => void saveTrips()}>
                      <Check size={15} /> 保存班次
                    </PrimaryButton>
                    {tripsDirty ? (
                      <GhostButton disabled={busy} onClick={discardTripChanges}>放弃更改</GhostButton>
                    ) : null}
                    {tripSaved && !tripsDirty ? <span className="text-aux text-success">已保存</span> : null}
                    {rows.length > 0 ? <span className="ml-auto text-label text-sub">共 {rows.length} 班</span> : null}
                  </div>
                  <ErrorBanner message={tripError} />
                </div>
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
  markerSize: number;
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
            站点绑定一处地点后，名称、照片、联系方式、地图图钉与导航都默认跟随那条地点（地点在「内容管理」里维护）；
            这里只需要维护停靠状态。实际候车点不在地点那里时，才需要单独标一个候车点；
            哪站上车、哪站下车在「班次时刻」的站点顺序里维护。
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
                    markerSize: form.markerSize,
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
                        markerSize: stop.markerSize ?? 1,
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
                            markerSize: form.markerSize,
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
                      {anchors.length ? "已标候车点" : stop.placeId ? "跟随地点位置" : "未标坐标"}
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
                      title={usage > 0 ? "还有线路停靠这个站点，只能先移除停靠或改为已停用" : "彻底删除"}
                      type="button"
                    >
                      <Trash2 size={13} />删除
                    </button>
                  </div>
                  {confirmDelete === stop.id ? (
                    <div className="mb-3 rounded-lg bg-error-bg px-4 py-3">
                      <p className="text-body font-medium text-error">
                        确认删除站点「{stop.name}」？它的候车点坐标会一并删除，且不可恢复。
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
  // 名称默认跟随绑定地点：用户没手动改过名称时，换绑地点就把名称一起带过去。
  const [nameEdited, setNameEdited] = useState(Boolean(initial?.name));
  const [code, setCode] = useState(initial?.code ?? "");
  const [placeId, setPlaceId] = useState(initial?.placeId ?? "");
  const [campusId, setCampusId] = useState(initial?.campusId ?? "");
  const [status, setStatus] = useState<TransitStopStatus>(initial?.status ?? "active");
  const [markerSize, setMarkerSize] = useState(initial?.markerSize ?? 1);
  const [locations, setLocations] = useState<LocationDraft[]>(initial?.locations ?? []);
  const [formError, setFormError] = useState("");

  // 站点通常就是一处校园地点，绑定后名称 / 照片 / 联系方式 / 图钉 / 导航默认都
  // 复用那条地点；只有实际候车点不在地点那里时才需要单独标点。
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

  function patchPlace(nextPlaceId: string) {
    setPlaceId(nextPlaceId);
    if (nameEdited) return;
    const place = nextPlaceId ? data.places.find((candidate) => candidate.id === nextPlaceId) : null;
    setName(place?.displayName ?? "");
  }

  function submit() {
    if (!name.trim()) { setFormError("请填写站点名称"); return; }
    const kept = locations.filter((row) => !isLocationDraftBlank(row));
    if (kept.length > 2) {
      setFormError("站点最多标一个候车点和一个导航终点；都不标时图钉与导航跟随绑定地点");
      return;
    }
    const roles = kept.map((row) => row.role);
    if (new Set(roles).size !== roles.length) {
      setFormError("候车点与导航终点各只能标一个");
      return;
    }
    // 候车点是主要位置（决定地图图钉）；只有导航终点时才让它顶替主要位置。
    // 管理员不必操心 primary 勾选。
    const hasBoardingPoint = roles.includes("boarding_point");
    const normalized = kept.map((row) => ({
      ...row,
      isPrimary: hasBoardingPoint ? row.role === "boarding_point" : true,
    }));
    try {
      // locationInput 会校验经纬度成对、不与地图图形冲突等，先跑一遍再提交。
      normalized.map(locationInput);
    } catch (err) {
      setFormError(errorMessage(err, "候车点填写有误"));
      return;
    }
    setFormError("");
    void onSave({ name: name.trim(), code: code.trim(), placeId, campusId, status, markerSize, locations: normalized });
  }

  return (
    <div className="space-y-3 rounded-xl bg-page p-4">
      <div className="grid grid-cols-3 gap-3">
        <Field
          label="站点名称"
          onChange={(value) => { setName(value); setNameEdited(true); }}
          placeholder="默认跟随绑定地点"
          value={name}
        />
        <Field label="站点代码（可选）" onChange={setCode} placeholder="如 baoshan-south" value={code} />
        <SelectField
          label="停靠状态"
          onChange={(value) => setStatus(value as TransitStopStatus)}
          options={STOP_STATUS_OPTIONS}
          value={status}
        />
        <SelectField
          label="绑定地点（名称 / 照片 / 联系方式 / 导航来源）"
          onChange={patchPlace}
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
        <MarkerScaleField
          onChange={setMarkerSize}
          value={markerSize}
          />
      </div>

      {boundPlace === null ? (
        <InfoNote tone="warning">
          未绑定地点时，用户端只能看到站点名称与候车点坐标，没有照片、联系方式，也点不出「导航到这里」。
        </InfoNote>
      ) : (
        <InfoNote tone="info">
          这个站点的照片与联系方式跟随地点「{boundPlace.displayName ?? boundPlace.id}」，
          在「内容管理 → 地点」里编辑即可同步；不标候车点时，图钉与导航也直接用那条地点的位置。
          {boundPlace.isBuilding
            ? "该地点作为楼宇维护，需要有建筑轮廓才会出现在地图上。"
            : "这是一处楼外地点，需要在它的编辑页于校区图上标过点位，才会出现在地图上。"}
        </InfoNote>
      )}

      <LocationEditor
        disabled={busy}
        mapVersions={meta.mapVersions}
        maxRows={2}
        onChange={setLocations}
        roles={STOP_LOCATION_ROLES}
        spaces={meta.spaces}
        title="候车点 / 导航终点（可选，缺省跟随绑定地点）"
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
            <Plus size={14} />标一个候车点
          </GhostButton>
        ) : null}
      </div>
    </div>
  );
}

// ===========================================================================
// 线路（校区对 + 乘车方式；pattern 1:1 是实现细节，界面不出现「方向」）
// ===========================================================================

function LinesPanel({
  data,
  meta,
  busy,
  mutate,
  deriveRouteName,
}: PanelProps & {
  meta: TransitMeta;
  deriveRouteName: (stopIds: string[], bookingPolicy: TransitBookingPolicy) => string | null;
}) {
  const [creatingRoute, setCreatingRoute] = useState(false);
  const [newFromEndpoint, setNewFromEndpoint] = useState("");
  const [newToEndpoint, setNewToEndpoint] = useState("");
  const [newRouteBooking, setNewRouteBooking] = useState<TransitBookingPolicy>("not_required");
  const [newRouteBookingUrl, setNewRouteBookingUrl] = useState("");
  const [createError, setCreateError] = useState("");
  const [notice, setNotice] = useState("");

  const [editingRoute, setEditingRoute] = useState("");
  const [routeOperator, setRouteOperator] = useState("");
  const [routeStatus, setRouteStatus] = useState("active");
  const [routeBooking, setRouteBooking] = useState<TransitBookingPolicy>("not_required");
  const [routeBookingUrl, setRouteBookingUrl] = useState("");
  const [confirmRouteDelete, setConfirmRouteDelete] = useState("");

  const patternsByRoute = useMemo(() => {
    const map = new Map<string, TransitPatternRow[]>();
    for (const pattern of data.patterns) {
      const list = map.get(pattern.routeId) ?? [];
      list.push(pattern);
      map.set(pattern.routeId, list);
    }
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

  const stopById = useMemo(() => new Map(data.stops.map((stop) => [stop.id, stop])), [data.stops]);

  const operatorName = useMemo(() => {
    const map = new Map(meta.ref.organizations.map((org) => [org.id, org.name]));
    return (id: string) => map.get(id) ?? id;
  }, [meta.ref.organizations]);

  /** 可选端点：有 active 站点的校区（按 campuses 顺序）+ 无校区站站点（如陈太公寓）各自成端点。 */
  const endpoints = useMemo(() => {
    const list: Array<{ id: string; name: string }> = [];
    for (const campus of meta.spaces.campuses) {
      if (data.stops.some((stop) => stop.campusId === campus.id && stop.status === "active")) {
        list.push({ id: campus.id, name: campus.name });
      }
    }
    for (const stop of data.stops) {
      if (stop.campusId === null && stop.status === "active") list.push({ id: `stop:${stop.id}`, name: stop.name });
    }
    return list;
  }, [meta.spaces.campuses, data.stops]);

  /** 端点下的 active 站点（按 data.stops 数组序）。 */
  function activeStopsOfEndpoint(endpointId: string): TransitStopRow[] {
    if (endpointId.startsWith("stop:")) {
      const stop = stopById.get(endpointId.slice("stop:".length));
      return stop && stop.status === "active" ? [stop] : [];
    }
    return data.stops.filter((stop) => stop.campusId === endpointId && stop.status === "active");
  }

  /** 站点的端点 key：campus_id，或无校区站点的 `stop:<stopId>`。 */
  function endpointKeyOfStop(stopId: string): string {
    const stop = stopById.get(stopId);
    if (!stop) throw new Error(`校车数据引用了不存在的站点 ${stopId}`);
    return stop.campusId ?? `stop:${stop.id}`;
  }

  /** 线路的站点序列（取第一个有 ≥2 站的 pattern；1:1 模型下就是它）。 */
  function routeStopIds(route: TransitRouteRow): string[] {
    for (const pattern of patternsByRoute.get(route.id) ?? []) {
      const stopIds = stopsByPattern.get(pattern.id) ?? [];
      if (stopIds.length >= 2) return stopIds;
    }
    return [];
  }

  /** 线路的校区对 key（首末站所属端点）；旧数据没有有效 pattern 时返回 null。 */
  function routePairKey(route: TransitRouteRow): string | null {
    const stopIds = routeStopIds(route);
    if (stopIds.length < 2) return null;
    return `${endpointKeyOfStop(stopIds[0])}>${endpointKeyOfStop(stopIds[stopIds.length - 1])}`;
  }

  async function createLine() {
    setCreateError("");
    setNotice("");
    if (!newFromEndpoint || !newToEndpoint) { setCreateError("请选择起点和终点"); return; }
    if (newFromEndpoint === newToEndpoint) { setCreateError("起点和终点不能相同"); return; }
    const fromStops = activeStopsOfEndpoint(newFromEndpoint);
    const toStops = activeStopsOfEndpoint(newToEndpoint);
    if (fromStops.length === 0 || toStops.length === 0) {
      setCreateError("该校区还没有乘车点，请先在「站点」页添加");
      return;
    }
    // 重复校验：同校区对 + 同乘车方式的线路只允许一条（按现有线路首末站判定校区对）
    const pairKey = `${newFromEndpoint}>${newToEndpoint}`;
    if (data.routes.some((route) => route.bookingPolicy === newRouteBooking && routePairKey(route) === pairKey)) {
      setCreateError("该校区对已有相同乘车方式的线路");
      return;
    }

    // 名称自动派生：「起点端点 → 终点端点」，预约线加「（预约）」；代码不填。
    const name = deriveRouteName([fromStops[0].id, toStops[toStops.length - 1].id], newRouteBooking);
    if (name === null) { setCreateError("端点站点数据不完整，请刷新后重试"); return; }
    const ok = await mutate(async () => {
      const created = await admin.createTransitRoute({
        name,
        code: null,
        operatorId: null,
        bookingPolicy: newRouteBooking,
        bookingUrl: newRouteBookingUrl.trim() || null,
      });
      // 初始站点序列：起点端点的第一个 active 站点 → 终点端点的最后一个 active 站点
      await admin.createTransitPattern({
        routeId: created.id,
        directionId: 0,
        name,
        stops: [
          { stopId: fromStops[0].id, pickupType: "regular", dropoffType: "none" },
          { stopId: toStops[toStops.length - 1].id, pickupType: "none", dropoffType: "regular" },
        ],
      });
    }, "新建线路失败");
    if (ok) {
      setCreatingRoute(false);
      setNewFromEndpoint("");
      setNewToEndpoint("");
      setNewRouteBooking("not_required");
      setNewRouteBookingUrl("");
      setNotice(`线路「${name}」已创建。请到「班次时刻」页调整站点顺序和班次。`);
    }
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
            线路 = 校区对 + 乘车方式：名称按「起点 → 终点」自动派生（预约线带「（预约）」后缀），不用手填。
            站点顺序与班次在「班次时刻」里维护。
          </InfoNote>

          {notice ? <InfoNote tone="info">{notice}</InfoNote> : null}

          {creatingRoute ? (
            <div className="space-y-3 rounded-xl bg-page p-4">
              <div className="grid grid-cols-[170px_170px_130px_1fr_auto] items-end gap-3">
                <SelectField
                  label="起点"
                  onChange={setNewFromEndpoint}
                  options={endpoints.map((endpoint) => ({ value: endpoint.id, label: endpoint.name }))}
                  placeholder="选择校区或站点"
                  value={newFromEndpoint}
                />
                <SelectField
                  label="终点"
                  onChange={setNewToEndpoint}
                  options={endpoints.map((endpoint) => ({ value: endpoint.id, label: endpoint.name }))}
                  placeholder="选择校区或站点"
                  value={newToEndpoint}
                />
                <SelectField
                  label="乘车方式"
                  onChange={(value) => setNewRouteBooking(value as TransitBookingPolicy)}
                  options={POLICY_OPTIONS}
                  value={newRouteBooking}
                />
                <Field label="预约链接（可选）" onChange={setNewRouteBookingUrl} placeholder="留空用默认预约网站" value={newRouteBookingUrl} />
                <div className="flex gap-2">
                  <PrimaryButton disabled={busy} onClick={() => void createLine()}>
                    保存
                  </PrimaryButton>
                  <GhostButton onClick={() => { setCreatingRoute(false); setCreateError(""); }}>取消</GhostButton>
                </div>
              </div>
              <ErrorBanner message={createError} />
            </div>
          ) : null}

          {data.routes.length === 0 ? <EmptyState label="暂无校车线路" /> : null}

          <div className="space-y-3">
            {data.routes.map((route) => {
              const stopIds = routeStopIds(route);
              const hasPattern = (patternsByRoute.get(route.id) ?? []).length > 0;
              const statusMeta = ROUTE_STATUS_META[route.status] ?? { label: route.status, tone: "neutral" as const };
              return (
                <div className="rounded-xl border border-line" key={route.id}>
                  {editingRoute === route.id ? (
                    <div className="grid grid-cols-[170px_130px_130px_1fr_auto] items-end gap-3 p-4">
                      <SelectField
                        label="运营单位"
                        onChange={setRouteOperator}
                        options={meta.ref.organizations.map((org) => ({ value: org.id, label: org.name }))}
                        placeholder="不指定"
                        value={routeOperator}
                      />
                      <SelectField label="运行状态" onChange={setRouteStatus} options={ROUTE_STATUS_OPTIONS} value={routeStatus} />
                      <SelectField
                        label="乘车方式"
                        onChange={(value) => setRouteBooking(value as TransitBookingPolicy)}
                        options={POLICY_OPTIONS}
                        value={routeBooking}
                      />
                      <Field label="预约链接（可选）" onChange={setRouteBookingUrl} placeholder="留空用默认预约网站" value={routeBookingUrl} />
                      <div className="flex gap-2">
                        <PrimaryButton
                          disabled={busy}
                          onClick={() => void (async () => {
                            // 乘车方式变了名称也要跟上：名称始终是派生值（站点序列没动，只重拼后缀）
                            const derived = deriveRouteName(stopIds, routeBooking);
                            const ok = await mutate(
                              () => admin.updateTransitRoute(route.id, {
                                ...(derived !== null ? { name: derived } : {}),
                                operatorId: routeOperator || null,
                                status: routeStatus as admin.TransitRouteStatus,
                                bookingPolicy: routeBooking,
                                bookingUrl: routeBookingUrl.trim() || null,
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
                      <span className="w-40 shrink-0 truncate text-aux text-sub">
                        {route.operatorId ? operatorName(route.operatorId) : "未指定运营单位"}
                      </span>
                      <span className="w-20 shrink-0 text-aux text-sub">{hasPattern ? `${stopIds.length} 站` : "—"}</span>
                      <Pill tone={POLICY_META[route.bookingPolicy].tone}>{POLICY_META[route.bookingPolicy].label}</Pill>
                      <Pill tone={statusMeta.tone}>{statusMeta.label}</Pill>
                      <button
                        aria-label={`编辑线路 ${route.name}`}
                        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 text-aux font-medium text-ink disabled:opacity-40"
                        disabled={busy}
                        onClick={() => {
                          setEditingRoute(route.id);
                          setRouteOperator(route.operatorId ?? "");
                          setRouteStatus(route.status);
                          setRouteBooking(route.bookingPolicy);
                          setRouteBookingUrl(route.bookingUrl ?? "");
                          setConfirmRouteDelete("");
                        }}
                        type="button"
                      >
                        <Pencil size={13} />编辑
                      </button>
                      <button
                        aria-label={`删除线路 ${route.name}`}
                        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-error/40 px-3 text-aux font-medium text-error disabled:opacity-40"
                        disabled={busy || hasPattern}
                        onClick={() => setConfirmRouteDelete(route.id)}
                        title={hasPattern ? "这条线路已配置站点与班次，不能直接删除；如不再开行请改为「暂停运行」" : "彻底删除"}
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
  // 新建默认 'weekday'：最常见的日历就是工作日班表。不默认 'other' 是因为
  // 'other' 不参与客户端日型标签，静默选它会让「今天是什么日子」这行字消失。
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
    void onSave({
      name: name.trim(),
      validFrom,
      validTo,
      weekdays,
      exceptions: filled,
      sourceId,
    });
  }

  return (
    <div className="space-y-3 rounded-xl bg-page p-4">
      <div className="grid grid-cols-3 gap-3">
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
