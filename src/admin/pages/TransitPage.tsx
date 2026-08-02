import { ArrowDown, ArrowUp, Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import * as admin from "../../lib/api/admin";
import type {
  ServiceCalendarRow,
  TransitBookingPolicy,
  TransitDropoffType,
  TransitPickupType,
  TransitResponse,
} from "../adminTypes";
import {
  EmptyState,
  ErrorBanner,
  GhostButton,
  InfoNote,
  LoadingState,
  Panel,
  Pill,
  PrimaryButton,
  Field,
  SelectField,
  errorMessage,
  fmtDay,
  useAsyncData,
} from "../components/primitives";

// ---------------------------------------------------------------------------
// A8 校车时刻 · 站点顺序与班次编辑
// 读写都走管理端接口，保存后用户端当天查询立即生效。
// ---------------------------------------------------------------------------

const WEEK_LABELS = ["一", "二", "三", "四", "五", "六", "日"];
const WEEK_KEYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

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

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

interface StopDraft {
  stopId: string;
  pickupType: TransitPickupType;
  dropoffType: TransitDropoffType;
}

function directionLabel(name: string, directionId: number): string {
  const normalized = name.trim();
  if (!normalized) throw new Error(`方向 ${directionId} 缺少名称`);
  return normalized;
}

function calendarLabel(calendar: ServiceCalendarRow): string {
  return calendar.name;
}

function sameSequence(a: StopDraft[], b: StopDraft[]): boolean {
  return (
    a.length === b.length &&
    a.every((stop, index) => stop.stopId === b[index].stopId && stop.pickupType === b[index].pickupType && stop.dropoffType === b[index].dropoffType)
  );
}

export function TransitPage() {
  const { state, reload } = useAsyncData<TransitResponse>((signal) => admin.listAdminTransit<TransitResponse>(signal), []);

  if (state.status === "loading") return <LoadingState label="加载校车数据…" />;
  if (state.status === "error") return <ErrorBanner message={state.message} />;
  return <ReadyTransitPage data={state.data} reload={reload} />;
}

function ReadyTransitPage({ data, reload }: { data: TransitResponse; reload: () => void }) {

  const [routeId, setRouteId] = useState("");
  const [patternId, setPatternId] = useState("");
  const [calendarId, setCalendarId] = useState("");

  const [sequence, setSequence] = useState<StopDraft[]>([]);
  const [addStopId, setAddStopId] = useState("");
  const [sequenceBusy, setSequenceBusy] = useState(false);
  const [sequenceError, setSequenceError] = useState("");
  const [sequenceSaved, setSequenceSaved] = useState(false);

  const [editing, setEditing] = useState<"new" | string | null>(null);
  const [times, setTimes] = useState<string[]>([]);
  const [policy, setPolicy] = useState<TransitBookingPolicy>("not_required");
  const [formCalendarId, setFormCalendarId] = useState("");
  const [tripBusy, setTripBusy] = useState(false);
  const [tripError, setTripError] = useState("");
  const [pendingDelete, setPendingDelete] = useState("");
  const [createKind, setCreateKind] = useState<"stop" | "route" | "pattern" | "calendar" | null>(null);
  const [createName, setCreateName] = useState("");
  const [createCode, setCreateCode] = useState("");
  const [createDirection, setCreateDirection] = useState("0");
  const [createPatternStops, setCreatePatternStops] = useState<StopDraft[]>([]);
  const [createPatternStopId, setCreatePatternStopId] = useState("");
  const [validFrom, setValidFrom] = useState(new Date().toLocaleDateString("en-CA"));
  const [validTo, setValidTo] = useState(`${new Date().getFullYear()}-12-31`);
  const [weekdays, setWeekdays] = useState([true, true, true, true, true, false, false]);
  const [exceptions, setExceptions] = useState<Array<{ date: string; type: "added" | "removed"; label: string }>>([]);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState("");

  const stops = data.stops;
  const routes = data.routes;
  const patterns = data.patterns;
  const calendars = data.calendars;

  const stopName = useMemo(() => {
    const map = new Map(stops.map((stop) => [stop.id, stop.name]));
    return (id: string) => {
      const name = map.get(id);
      if (name === undefined) throw new Error(`校车数据引用了不存在的站点 ${id}`);
      return name;
    };
  }, [stops]);

  const selectedRouteId = routeId || routes[0]?.id || "";
  const routePatterns = useMemo(() => patterns.filter((pattern) => pattern.routeId === selectedRouteId), [patterns, selectedRouteId]);
  const selectedPatternId = routePatterns.some((pattern) => pattern.id === patternId) ? patternId : routePatterns[0]?.id || "";
  const selectedCalendarId = calendars.some((calendar) => calendar.id === calendarId) ? calendarId : calendars[0]?.id || "";
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
    setSequenceError("");
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

  const availableStops = stops.filter((stop) => !sequence.some((item) => item.stopId === stop.id));
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

  function removeStop(index: number) {
    setSequence((current) => current.filter((_, i) => i !== index));
    setSequenceSaved(false);
  }

  function appendStop() {
    if (!addStopId) return;
    setSequence((current) => [...current, { stopId: addStopId, pickupType: "regular", dropoffType: "regular" }]);
    setAddStopId("");
    setSequenceSaved(false);
  }

  function openCreate(kind: "stop" | "route" | "pattern" | "calendar") {
    setCreateKind(kind);
    setCreateError("");
    if (kind === "pattern") {
      setCreatePatternStops([]);
      setCreatePatternStopId("");
    }
  }

  function appendCreatePatternStop() {
    if (!createPatternStopId || createPatternStops.some((stop) => stop.stopId === createPatternStopId)) return;
    setCreatePatternStops((current) => [...current, { stopId: createPatternStopId, pickupType: "regular", dropoffType: "regular" }]);
    setCreatePatternStopId("");
  }

  function patchCreatePatternStop(index: number, patch: Partial<StopDraft>) {
    setCreatePatternStops((current) => current.map((stop, i) => i === index ? { ...stop, ...patch } : stop));
  }

  function moveCreatePatternStop(index: number, delta: number) {
    setCreatePatternStops((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function saveSequence() {
    setSequenceBusy(true);
    setSequenceError("");
    setSequenceSaved(false);
    try {
      await admin.replaceTransitPatternStops(selectedPatternId, sequence);
      setSequenceSaved(true);
      reload();
    } catch (err) {
      setSequenceError(errorMessage(err, "保存站点顺序失败，请稍后重试"));
    } finally {
      setSequenceBusy(false);
    }
  }

  function startAddTrip() {
    if (!activeCalendar) throw new Error("添加班次前必须先创建服务日历");
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
    setTripBusy(true);
    setTripError("");
    try {
      const serviceCalendarId = formCalendarId || selectedCalendarId;
      if (!serviceCalendarId) throw new Error("请选择服务日历");
      const stopTimes = trimmed.map((time) => ({
        arrivalTime: time || null,
        departureTime: time || null,
      }));
      if (editing === "new") {
        await admin.createTransitTrip({
          patternId: selectedPatternId,
          serviceCalendarId,
          publicLabel: null,
          bookingPolicy: policy,
          bookingUrl: null,
          sourceId: null,
          stopTimes,
        });
      } else if (editing) {
        await admin.updateTransitTrip(editing, {
          serviceCalendarId,
          bookingPolicy: policy,
          stopTimes,
        });
      }
      setEditing(null);
      reload();
    } catch (err) {
      setTripError(errorMessage(err, editing === "new" ? "添加班次失败，请稍后重试" : "保存班次失败，请稍后重试"));
    } finally {
      setTripBusy(false);
    }
  }

  async function removeTrip(tripId: string) {
    setTripBusy(true);
    setTripError("");
    try {
      await admin.deleteTransitTrip(tripId);
      setPendingDelete("");
      reload();
    } catch (err) {
      setTripError(errorMessage(err, "删除班次失败，请稍后重试"));
    } finally {
      setTripBusy(false);
    }
  }

  async function createEntity() {
    if (!createKind || !createName.trim()) { setCreateError("请填写名称"); return; }
    setCreateBusy(true); setCreateError("");
    try {
      if (createKind === "stop") {
        await admin.createTransitStop({
          name: createName.trim(),
          code: createCode.trim() || null,
          placeId: null,
          campusId: null,
          locations: [],
        });
      }
      if (createKind === "route") await admin.createTransitRoute({
        name: createName.trim(),
        code: createCode.trim() || null,
        operatorId: null,
      });
      if (createKind === "pattern") {
        if (!selectedRouteId || createPatternStops.length < 2) throw new Error("请按顺序添加至少两个站点");
        await admin.createTransitPattern({
          routeId: selectedRouteId,
          name: createName.trim(),
          directionId: createDirection === "0" ? 0 : 1,
          stops: createPatternStops,
        });
      }
      if (createKind === "calendar") await admin.createTransitCalendar({
        name: createName.trim(), validFrom, validTo,
        weekdays: {
          monday: weekdays[0],
          tuesday: weekdays[1],
          wednesday: weekdays[2],
          thursday: weekdays[3],
          friday: weekdays[4],
          saturday: weekdays[5],
          sunday: weekdays[6],
        },
        exceptions: exceptions.filter((item) => item.date).map((item) => ({ ...item, label: item.label.trim() || null })),
        sourceId: null,
      });
      setCreateKind(null); setCreateName(""); setCreateCode(""); setCreatePatternStops([]); setCreatePatternStopId(""); reload();
    } catch (err) { setCreateError(errorMessage(err, "新建失败")); } finally { setCreateBusy(false); }
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
            options={calendars.map((calendar) => ({ value: calendar.id, label: calendarLabel(calendar) }))}
            value={formCalendarId}
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <PrimaryButton disabled={tripBusy} onClick={saveTrip}>
          <Check size={15} /> {editing === "new" ? "添加" : "保存"}
        </PrimaryButton>
        <GhostButton disabled={tripBusy} onClick={() => setEditing(null)}>
          取消
        </GhostButton>
      </div>
      <ErrorBanner message={tripError} />
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-56">
          <SelectField
            label="线路"
            onChange={(value) => {
              setRouteId(value);
              setPatternId("");
            }}
            options={routes.map((route) => ({ value: route.id, label: route.name }))}
            value={selectedRouteId}
          />
        </div>
        <div className="w-48">
          <SelectField
            label="方向"
            onChange={setPatternId}
            options={routePatterns.map((pattern) => ({ value: pattern.id, label: directionLabel(pattern.name, pattern.directionId) }))}
            value={selectedPatternId}
          />
        </div>
        <div className="w-40">
          <SelectField
            label="服务日历"
            onChange={setCalendarId}
            options={calendars.map((calendar) => ({ value: calendar.id, label: calendarLabel(calendar) }))}
            value={selectedCalendarId}
          />
        </div>
        <div className="ml-auto flex gap-2">
          <GhostButton onClick={() => openCreate("stop")}><Plus size={14} />站点</GhostButton>
          <GhostButton onClick={() => openCreate("route")}><Plus size={14} />线路</GhostButton>
          <GhostButton disabled={!selectedRouteId} onClick={() => openCreate("pattern")}><Plus size={14} />方向</GhostButton>
          <GhostButton onClick={() => openCreate("calendar")}><Plus size={14} />日历</GhostButton>
        </div>
      </div>

      {createKind ? <Panel title={`新建${{ stop: "站点", route: "线路", pattern: "方向", calendar: "服务日历" }[createKind]}`}>
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <Field label="名称" onChange={setCreateName} value={createName} />
            {createKind === "stop" || createKind === "route" ? <Field label="代码" onChange={setCreateCode} value={createCode} /> : null}
            {createKind === "pattern" ? <SelectField label="方向" onChange={setCreateDirection} options={[{ value: "0", label: "去程" }, { value: "1", label: "回程" }]} value={createDirection} /> : null}
            {createKind === "calendar" ? <><Field label="开始日期" onChange={setValidFrom} type="date" value={validFrom} /><Field label="结束日期" onChange={setValidTo} type="date" value={validTo} /></> : null}
          </div>
          {createKind === "pattern" ? <div className="space-y-2">
            {createPatternStops.map((stop, index) => <div className="rounded-lg border border-line p-3" key={stop.stopId}>
              <div className="flex items-center gap-2">
                <span className="grid h-6 w-6 place-items-center rounded-full bg-chip text-aux font-semibold text-sub">{index + 1}</span>
                <span className="flex-1 text-body font-semibold text-ink">{stopName(stop.stopId)}</span>
                <GhostButton disabled={index === 0} onClick={() => moveCreatePatternStop(index, -1)}><ArrowUp size={14} /></GhostButton>
                <GhostButton disabled={index === createPatternStops.length - 1} onClick={() => moveCreatePatternStop(index, 1)}><ArrowDown size={14} /></GhostButton>
                <GhostButton danger onClick={() => setCreatePatternStops((current) => current.filter((_, i) => i !== index))}><Trash2 size={14} /></GhostButton>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <SelectField label="上车规则" onChange={(pickupType) => patchCreatePatternStop(index, { pickupType: pickupType as TransitPickupType })} options={PICKUP_OPTIONS} value={stop.pickupType} />
                <SelectField label="下车规则" onChange={(dropoffType) => patchCreatePatternStop(index, { dropoffType: dropoffType as TransitDropoffType })} options={DROPOFF_OPTIONS} value={stop.dropoffType} />
              </div>
            </div>)}
            <div className="flex items-end gap-2">
              <div className="flex-1"><SelectField label="添加站点" onChange={setCreatePatternStopId} options={stops.filter((stop) => !createPatternStops.some((item) => item.stopId === stop.id)).map((stop) => ({ value: stop.id, label: stop.name }))} placeholder="选择站点" value={createPatternStopId} /></div>
              <GhostButton disabled={!createPatternStopId} onClick={appendCreatePatternStop}><Plus size={14} />添加</GhostButton>
            </div>
            {createPatternStops.length < 2 ? <InfoNote tone="warning">一个方向至少需要两个站点</InfoNote> : null}
          </div> : null}
          {createKind === "calendar" ? <div className="flex gap-2">{WEEK_LABELS.map((day, index) => <button className={`h-9 w-9 rounded-full text-body ${weekdays[index] ? "bg-primary text-white" : "bg-page text-sub"}`} key={day} onClick={() => setWeekdays((rows) => rows.map((value, i) => i === index ? !value : value))} type="button">{day}</button>)}</div> : null}
          {createKind === "calendar" ? <div className="space-y-2">
            {exceptions.map((item, index) => <div className="grid grid-cols-[150px_150px_1fr_auto] gap-2" key={index}>
              <Field onChange={(date) => setExceptions((rows) => rows.map((row, i) => i === index ? { ...row, date } : row))} type="date" value={item.date} />
              <SelectField onChange={(type) => setExceptions((rows) => rows.map((row, i) => i === index ? { ...row, type: type as "added" | "removed" } : row))} options={[{ value: "added", label: "增加服务" }, { value: "removed", label: "暂停服务" }]} value={item.type} />
              <Field onChange={(label) => setExceptions((rows) => rows.map((row, i) => i === index ? { ...row, label } : row))} placeholder="说明" value={item.label} />
              <GhostButton danger onClick={() => setExceptions((rows) => rows.filter((_, i) => i !== index))}><Trash2 size={14} /></GhostButton>
            </div>)}
            <GhostButton onClick={() => setExceptions((rows) => [...rows, { date: "", type: "added", label: "" }])}><Plus size={14} />例外日期</GhostButton>
          </div> : null}
          <ErrorBanner message={createError} />
          <div className="flex gap-2"><PrimaryButton disabled={createBusy || (createKind === "pattern" && createPatternStops.length < 2)} onClick={createEntity}>保存</PrimaryButton><GhostButton onClick={() => setCreateKind(null)}>取消</GhostButton></div>
        </div>
      </Panel> : null}

      {routes.length === 0 ? <EmptyState label="暂无校车线路" /> : null}

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
                    aria-label={`删除站点 ${stopName(stop.stopId)}`}
                    className="grid h-7 w-7 place-items-center rounded-md text-error hover:bg-error-bg"
                    onClick={() => removeStop(index)}
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
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label={`${stopName(stop.stopId)} 下车规则`}
                    className="h-8 flex-1 rounded-md border border-line bg-surface px-2 text-aux text-ink"
                    onChange={(e) => patchStop(index, { dropoffType: e.target.value as TransitDropoffType })}
                    value={stop.dropoffType}
                  >
                    {DROPOFF_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
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
              <GhostButton disabled={!addStopId} onClick={appendStop}>
                <Plus size={15} /> 添加
              </GhostButton>
            </div>

            {sequence.length === 1 ? <InfoNote tone="warning">一个方向至少需要两个站点才能保存</InfoNote> : null}

            <div className="flex items-center gap-2">
              <PrimaryButton disabled={!sequenceDirty || sequence.length < 2 || sequenceBusy} onClick={saveSequence}>
                保存站点顺序
              </PrimaryButton>
              {sequenceDirty ? (
                <GhostButton disabled={sequenceBusy} onClick={() => setSequence(savedSequence)}>
                  还原
                </GhostButton>
              ) : null}
            </div>
            <ErrorBanner message={sequenceError} />

            <InfoNote tone="warning">「仅预约班次可上车」的站点，非预约班次不会停靠</InfoNote>
          </div>
        </Panel>

        <div className="space-y-4">
          <Panel
            title={activeCalendar ? `班次时刻 · ${calendarLabel(activeCalendar)}` : "班次时刻"}
            action={
              editing === null && savedSequence.length >= 2 && activeCalendar ? (
                <button className="flex items-center gap-1 text-aux font-medium text-primary" onClick={startAddTrip} type="button">
                  <Plus size={14} /> 添加班次
                </button>
              ) : null
            }
            padded={false}
          >
            <table className="w-full border-collapse text-left text-body">
              <thead>
                <tr className="text-label text-sub">
                  {["发车", "到达", "乘车方式", ""].map((header, index) => (
                    <th key={index} className="px-5 pb-2 pt-1 font-medium">
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {trips.map((trip) => {
                  const rows = rowsForTrip(trip.id);
                  const first = rows[0];
                  const last = rows[rows.length - 1];
                  const meta = POLICY_META[trip.bookingPolicy];
                  if (editing === trip.id) {
                    return (
                      <tr key={trip.id} className="bg-primary-container/40">
                        <td className="px-5 py-3" colSpan={4}>
                          {tripEditor}
                        </td>
                      </tr>
                    );
                  }
                  return (
                    <tr key={trip.id}>
                      <td className="px-5 py-3 font-semibold">{first?.departureTime?.slice(0, 5) ?? "—"}</td>
                      <td className="px-5 py-3">{(rows.length > 1 ? (last?.arrivalTime ?? last?.departureTime) : null)?.slice(0, 5) ?? "—"}</td>
                      <td className="px-5 py-3">
                        <Pill tone={meta.tone}>{meta.label}</Pill>
                      </td>
                      <td className="px-5 py-3">
                        {pendingDelete === trip.id ? (
                          <span className="flex items-center gap-2">
                            <button
                              className="text-aux font-medium text-error disabled:opacity-50"
                              disabled={tripBusy}
                              onClick={() => removeTrip(trip.id)}
                              type="button"
                            >
                              确认删除
                            </button>
                            <button className="text-aux text-sub" onClick={() => setPendingDelete("")} type="button">
                              取消
                            </button>
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
                    <td className="px-5 py-3" colSpan={4}>
                      {tripEditor}
                    </td>
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
              <div className="px-5 pb-4 pt-1">
                <p className="text-label text-sub">共 {trips.length} 班</p>
              </div>
            ) : null}
          </Panel>

          {activeCalendar ? (
            <Panel title={`${calendarLabel(activeCalendar)}的运行日`} padded={false}>
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
