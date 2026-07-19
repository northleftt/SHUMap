import { Check, GripVertical, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import * as admin from "../../lib/api/admin";
import { getCurrentRelease } from "../../lib/api/public";
import type { ReleaseManifest } from "../../lib/api/types";
import {
  Chip,
  EmptyState,
  ErrorBanner,
  InfoNote,
  LoadingState,
  Panel,
  Pill,
  SelectField,
  errorMessage,
  fmtDay,
  useAsyncData,
} from "../components/primitives";

// ---------------------------------------------------------------------------
// A8 校车时刻 · 线路编辑（读取发布产物 manifest 的走向/班次，
// 添加班次走 createTrip 管理端接口）
// ---------------------------------------------------------------------------

interface PatternRow { id: string; route_id: string; direction_id: number; name: string | null }
interface PatternStopRow { pattern_id: string; stop_id: string; stop_sequence: number; pickup_type: string; dropoff_type: string }
interface StopRow { id: string; name: string }
interface RouteRow { id: string; name: string }
interface CalendarRow { id: string; name: string; monday: number; tuesday: number; wednesday: number; thursday: number; friday: number; saturday: number; sunday: number; valid_from: string; valid_to: string }
interface TripRow { id: string; pattern_id: string; service_calendar_id: string; booking_policy: string; booking_url: string | null }
interface StopTimeRow { trip_id: string; stop_sequence: number; arrival_time: string | null; departure_time: string | null }

const WEEK_LABELS = ["一", "二", "三", "四", "五", "六", "日"];
const WEEK_KEYS: Array<keyof CalendarRow> = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

const POLICY_META: Record<string, { label: string; tone: "info" | "warning" | "neutral" }> = {
  required: { label: "预约", tone: "info" },
  optional: { label: "非预约", tone: "neutral" },
  not_required: { label: "非预约", tone: "neutral" },
};

const PICKUP_LABELS: Record<string, string> = { regular: "常规", reservation_only: "仅预约", none: "不可" };

export function TransitPage() {
  const { state, reload } = useAsyncData<ReleaseManifest>((signal) => getCurrentRelease(signal), []);

  const [routeId, setRouteId] = useState("");
  const [patternId, setPatternId] = useState("");
  const [calendarId, setCalendarId] = useState("");
  const [adding, setAdding] = useState(false);
  const [newTimes, setNewTimes] = useState<string[]>([]);
  const [newPolicy, setNewPolicy] = useState("not_required");
  const [newCalendarId, setNewCalendarId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const manifest = state.status === "ready" ? state.data! : null;
  const transit = manifest?.transit;
  const stops = (transit?.stops ?? []) as StopRow[];
  const routes = (transit?.routes ?? []) as RouteRow[];
  const patterns = (transit?.patterns ?? []) as PatternRow[];
  const patternStops = (transit?.patternStops ?? []) as PatternStopRow[];
  const calendars = ((transit?.calendars ?? []) as CalendarRow[]);
  const trips = (transit?.trips ?? []) as TripRow[];
  const stopTimes = (transit?.stopTimes ?? []) as StopTimeRow[];

  const stopName = useMemo(() => {
    const map = new Map(stops.map((s) => [s.id, s.name]));
    return (id: string) => map.get(id) ?? id;
  }, [stops]);

  const selectedRouteId = routeId || routes[0]?.id || "";
  const routePatterns = patterns.filter((p) => p.route_id === selectedRouteId);
  const selectedPatternId = patternId || routePatterns[0]?.id || "";
  const selectedCalendarId = calendarId || calendars[0]?.id || "";
  const stopsOfPattern = patternStops
    .filter((ps) => ps.pattern_id === selectedPatternId)
    .sort((a, b) => a.stop_sequence - b.stop_sequence);
  const tripsOfPattern = trips.filter((t) => t.pattern_id === selectedPatternId);
  const calendarOf = (id: string) => calendars.find((c) => c.id === id);
  const activeCalendar = calendarOf(selectedCalendarId);

  function tripTimes(tripId: string): { departure: string; arrival: string } {
    const rows = stopTimes.filter((st) => st.trip_id === tripId).sort((a, b) => a.stop_sequence - b.stop_sequence);
    const first = rows[0];
    const last = rows[rows.length - 1];
    return {
      departure: first?.departure_time?.slice(0, 5) ?? "—",
      arrival: last?.arrival_time?.slice(0, 5) ?? "—",
    };
  }

  async function addTrip() {
    setBusy(true);
    setError("");
    try {
      await admin.createTransitTrip({
        patternId: selectedPatternId,
        serviceCalendarId: newCalendarId || selectedCalendarId,
        bookingPolicy: newPolicy,
        stopTimes: stopsOfPattern.map((ps, i) => ({
          stopSequence: ps.stop_sequence,
          arrivalTime: newTimes[i] ? `${newTimes[i]}:00` : null,
          departureTime: newTimes[i] ? `${newTimes[i]}:00` : null,
        })),
      });
      setAdding(false);
      setNewTimes([]);
      reload();
    } catch (err) {
      setError(errorMessage(err, "添加班次失败（发布后随下个版本上线）"));
    } finally {
      setBusy(false);
    }
  }

  if (state.status === "loading") return <LoadingState label="加载校车数据…" />;
  if (state.status === "error") return <ErrorBanner message="校车数据来自当前发布版本；加载失败或尚未发布。" />;

  return (
    <div className="space-y-4">
      {/* 顶部选择器 */}
      <div className="flex items-end gap-3">
        <div className="w-56">
          <SelectField
            label="线路"
            onChange={(v) => { setRouteId(v); setPatternId(""); }}
            options={routes.map((r) => ({ value: r.id, label: r.name }))}
            value={selectedRouteId}
          />
        </div>
        <div className="w-44">
          <SelectField
            label="方向"
            onChange={setPatternId}
            options={routePatterns.map((p) => ({ value: p.id, label: p.name ?? (p.direction_id === 0 ? "去程" : "回程") }))}
            value={selectedPatternId}
          />
        </div>
        <div className="w-56">
          <SelectField
            label="服务日历"
            onChange={setCalendarId}
            options={calendars.map((c) => ({ value: c.id, label: c.name }))}
            value={selectedCalendarId}
          />
        </div>
        <span className="pb-2.5 font-mono text-aux text-sub">{selectedPatternId}</span>
      </div>

      <div className="grid grid-cols-[380px_1fr] items-start gap-4">
        {/* 站点序列 */}
        <Panel title="站点序列" padded={false}>
          <div className="space-y-2.5 p-5">
            {stopsOfPattern.map((ps) => (
              <div key={ps.stop_sequence} className="flex items-center gap-3 rounded-lg bg-page px-3.5 py-3">
                <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-aux font-semibold ${ps.stop_sequence === 1 ? "bg-primary text-white" : "text-sub"}`}>
                  {ps.stop_sequence - 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-body font-semibold text-ink">{stopName(ps.stop_id)}</p>
                  <div className="mt-1 flex gap-1.5">
                    <Pill tone={ps.pickup_type === "none" ? "neutral" : "info"}>上车 {PICKUP_LABELS[ps.pickup_type] ?? ps.pickup_type}</Pill>
                    <Pill tone={ps.dropoff_type === "none" ? "neutral" : "info"}>下车 {PICKUP_LABELS[ps.dropoff_type] ?? ps.dropoff_type}</Pill>
                  </div>
                </div>
                <GripVertical size={15} className="text-sub" />
              </div>
            ))}
            {stopsOfPattern.length === 0 ? <EmptyState label="该走向暂无站点序列" /> : null}
            <p className="text-label leading-relaxed text-sub">
              上车/下车对应 pickup_type / dropoff_type（regular / reservation_only / none）
            </p>
            <InfoNote tone="warning">「仅预约」站点只有预约班次停靠，非预约班次将跳过该站</InfoNote>
          </div>
        </Panel>

        {/* 班次时刻 */}
        <div className="space-y-4">
          <Panel
            title="班次时刻"
            action={
              <button className="flex items-center gap-1 text-aux font-medium text-primary" onClick={() => { setAdding((v) => !v); setNewTimes(stopsOfPattern.map(() => "")); setNewCalendarId(selectedCalendarId); }} type="button">
                <Plus size={14} /> 添加班次
              </button>
            }
            padded={false}
          >
            <table className="w-full border-collapse text-left text-body">
              <thead>
                <tr className="text-label text-sub">
                  {["发车", "到达", "预约策略", "服务日历"].map((h) => (
                    <th key={h} className="px-5 pb-2 pt-1 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {tripsOfPattern.map((trip) => {
                  const times = tripTimes(trip.id);
                  const policy = POLICY_META[trip.booking_policy] ?? POLICY_META.not_required;
                  return (
                    <tr key={trip.id}>
                      <td className="px-5 py-3 font-semibold">{times.departure}</td>
                      <td className="px-5 py-3">{times.arrival}</td>
                      <td className="px-5 py-3"><Pill tone={policy.tone}>{policy.label}</Pill></td>
                      <td className="px-5 py-3 text-sub">{calendarOf(trip.service_calendar_id)?.name ?? "—"}</td>
                    </tr>
                  );
                })}
                {adding ? (
                  <tr className="bg-primary-container/50">
                    <td colSpan={4} className="px-5 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        {stopsOfPattern.map((ps, i) => (
                          <label key={ps.stop_sequence} className="flex items-center gap-1 text-aux text-sub">
                            {stopName(ps.stop_id)}
                            <input
                              className="h-8 w-20 rounded-md border border-primary bg-surface px-2 text-body outline-none"
                              onChange={(e) => setNewTimes((cur) => cur.map((t, j) => (j === i ? e.target.value : t)))}
                              placeholder="HH:MM"
                              value={newTimes[i] ?? ""}
                            />
                          </label>
                        ))}
                        <select className="h-8 rounded-md border border-line bg-surface px-2 text-body" onChange={(e) => setNewPolicy(e.target.value)} value={newPolicy}>
                          <option value="not_required">非预约</option>
                          <option value="required">必须预约</option>
                          <option value="optional">可预约</option>
                        </select>
                        <select className="h-8 rounded-md border border-line bg-surface px-2 text-body" onChange={(e) => setNewCalendarId(e.target.value)} value={newCalendarId}>
                          {calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                        <button className="grid h-8 w-8 place-items-center rounded-full bg-primary text-white disabled:opacity-50" disabled={busy} onClick={addTrip} type="button">
                          <Check size={15} />
                        </button>
                        <button className="grid h-8 w-8 place-items-center rounded-full bg-surface text-sub" onClick={() => setAdding(false)} type="button">
                          <X size={15} />
                        </button>
                      </div>
                      <ErrorBanner message={error} />
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
            {tripsOfPattern.length === 0 && !adding ? <div className="p-5"><EmptyState label="该走向暂无班次" /></div> : null}
            <div className="px-5 pb-4">
              <p className="text-label text-sub">班次 = transit_trips（booking_policy: required / optional / not_required）；到离站时间存入 stop_times，随下次发布生效</p>
            </div>
          </Panel>

          {/* 服务日历 */}
          {activeCalendar ? (
            <Panel title={`服务日历：${activeCalendar.name}`} padded={false}>
              <div className="flex items-center gap-2.5 p-5">
                {WEEK_LABELS.map((label, i) => (
                  <span
                    key={label}
                    className={`grid h-9 w-9 place-items-center rounded-full text-body font-medium ${
                      activeCalendar[WEEK_KEYS[i]] ? "bg-primary text-white" : "bg-page text-sub"
                    }`}
                  >
                    {label}
                  </span>
                ))}
                <span className="ml-auto font-mono text-aux text-sub">
                  {fmtDay(activeCalendar.valid_from)} → {fmtDay(activeCalendar.valid_to)}
                </span>
              </div>
            </Panel>
          ) : null}
        </div>
      </div>
    </div>
  );
}
