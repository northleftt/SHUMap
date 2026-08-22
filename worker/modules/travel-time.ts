// 校车区间用时采样（scheduled handler 调用，见 worker/index-v2.ts）。
//
// 背景：时刻表只有发车时刻，「几点能到」在页面上是空的。校车按表发车，所以到达
// 时间里唯一的未知量是行驶耗时；腾讯距离矩阵接口的 departure_time 支持传未来出发
// 时刻并按那个时刻的预测路况算耗时，因此不必先攒几周历史才能起步。
//
// 实测约束（都是拿真 key 打出来的，不是从文档推的）：
//
//   1. **只有 matrix 认 departure_time**。路线规划接口（ws/direction/v1/driving）
//      会静默忽略它：传当前 / +1h / +6h / +12h 返回完全相同的 duration，传 `abc`
//      或 `-1` 也照样 status 0。四种 policy（含号称避堵的 REAL_TRAFFIC）返回的
//      duration 与 distance 也完全一致。所以绝不能换到 direction 上，换了之后
//      所有班次会显示同一个到达时间，而且不报错。
//
//   2. **每次调用最多 5 个矩阵元素**。6 个及以上返回 status 120，文案是「每秒
//      请求量已达到上限」——但这是误导：间隔 20s 重测两次仍然失败，而 5 元素
//      立刻就通。是元素数上限伪装成了限流错误。见 MATRIX_MAX_ELEMENTS。
//
//   3. **另有突发 QPS 上限**。紧凑循环会撞 120，间隔 1.2s 连发 6 次全通。
//      所以调用之间要留间隔（CALL_SPACING_MS）。
//
//   4. **departure_time 只接受未来 7 天内**，超出返回 status 348。所以不能一次
//      性预算一整个学期，采样必须是滚动刷新的 cron。见 MAX_LEAD_DAYS。
//
//   5. **matrix 与 direction 不是同一个引擎**，短线差得明显（宝山→延长 matrix
//      21.4min vs direction 26.0min，+21%；长线只差 1~7%）。matrix 系统性偏
//      乐观。所以样本带 provider 列，换接口要新增枚举值而不是混在一起取中位数。
//
//   6. **星期分辨率很弱**：08:00 出发周一 22.3min vs 周六 22.1min。别指望它替
//      我们区分工作日与假日；日型区分要靠 service_calendars 自己。
//
// 时段信号是真的：宝山→延长明天各时段出发，连测两轮，03:00 是 19.7/19.7min、
// 08:00 是 24.2/23.5min。跨时段极差 4.5min，轮间噪声 0.5min，信号比噪声大一个
// 量级——所以按发车时刻分别采样是有意义的，不能一条线只存一个平均耗时。
//
// 这一步只写库，不改任何面向用户的显示：先让数字攒起来、能核对，再决定怎么展示。

import type { Env } from "../types/cloudflare";
import { all } from "../lib/db";
import { isoNow, makeId } from "../lib/values";

/** 样本的 provider 标识，与 0023 迁移的 CHECK 枚举一致。 */
export const PROVIDER = "tencent_matrix";

/** 单次 matrix 调用的矩阵元素上限（实测 5 通 6 挂，见文件头第 2 条）。 */
export const MATRIX_MAX_ELEMENTS = 5;

/** 同一区间多久重采一次。预测是时段模型而不是当日实况，一周一次够了。 */
export const REFRESH_INTERVAL_DAYS = 7;

/**
 * 单次 cron 最多打多少次外部调用。乘上 CALL_SPACING_MS 就是这个 handler 的
 * 大致墙上时间（60 × 1.5s ≈ 90s），远低于 cron 触发的执行上限。
 *
 * 这个数要和 REFRESH_INTERVAL_DAYS 一起算，不能随手定：0024 校区对校区改版后
 * 线路变成多站链，实测生产拓扑有 **188** 个待采区间（14 条 pattern × 各自发车
 * 时刻 × 相邻区间），按 (起点, 出发时刻) 合并后需要 **116** 次调用才能排空一轮。
 * cap=20 时要 6 天才排空，紧贴 7 天的刷新周期——中间任何一天 cron 失败或新增
 * 班次，队列就永远追不上，最旧的那批样本会一直过期。cap=60 时 2 天排空，留足
 * 余量。改线路数量或刷新周期时重算这个数。
 */
export const MAX_CALLS_PER_RUN = 60;

/** 样本保留期。中位数只读最近若干条，久远样本留着是为了后面画用时曲线。 */
export const SAMPLE_RETENTION_DAYS = 180;

/** 取中位数时最多回看多少条样本（够平掉单次抖动，又不会被半年前的路况拖住）。 */
export const MEDIAN_SAMPLE_WINDOW = 8;

/** 单次清理最多删多少行，保证 cron 在限额内跑完；积压多时下一轮继续。 */
const MAX_PURGE_PER_RUN = 500;

/** 问 provider 的出发时刻至少要比现在晚这么久，确保它落在「未来」一侧。 */
const MIN_LEAD_MINUTES = 15;

/** 最多问未来第几天。provider 硬限制是 7 天（超出 status 348），留一天余量。 */
const MAX_LEAD_DAYS = 6;

/** 调用间隔，避开突发 QPS 限流（实测 1.2s 可过，这里留一点余量）。 */
const CALL_SPACING_MS = 1500;

const MATRIX_ENDPOINT = "https://apis.map.qq.com/ws/distance/v1/matrix";

/** Asia/Shanghai 固定 UTC+8（无夏令时），所以壁钟换算可以纯算术做。 */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

const WEEKDAY_COLUMNS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 一条样本的身份：走哪一段、几点走。 */
export interface SegmentKey {
  patternId: string;
  fromStopSequence: number;
  toStopSequence: number;
  /** 该区间起点站的排班发车时刻（HH:MM）。 */
  departureTime: string;
}

export interface Segment extends SegmentKey {
  fromStopId: string;
  toStopId: string;
  /** 该区间实际运营的星期（0=周日），来自 service_calendars 的并集。 */
  serviceDays: number[];
}

export interface GeoPoint {
  longitude: number;
  latitude: number;
}

/** 一次 matrix 调用：一个起点、一个出发时刻、最多 MATRIX_MAX_ELEMENTS 个终点。 */
export interface SampleCall {
  fromStopId: string;
  departureTime: string;
  /** 实际问 provider 的那个未来时刻（ISO）。 */
  departureAt: string;
  unixSeconds: number;
  destinations: Array<{ toStopId: string; segments: SegmentKey[] }>;
}

export interface MatrixElement {
  durationSeconds: number;
  distanceMeters: number | null;
}

// ---------------------------------------------------------------------------
// 纯函数（可测部分）
// ---------------------------------------------------------------------------

export function segmentKeyOf(segment: SegmentKey): string {
  return [segment.patternId, segment.fromStopSequence, segment.toStopSequence, segment.departureTime].join("|");
}

/**
 * 把「HH:MM 的排班发车」解析成一个具体的未来时刻。
 *
 * 只挑该区间真的运营的星期（serviceDays），并跳过太近的时刻——provider 要求
 * departure_time 落在未来，贴着当前时间问容易被判成过去。返回 null 表示未来
 * MAX_LEAD_DAYS 天内没有合适的班（例如只在周末跑而窗口内的周末已经过了）。
 */
export function nextServiceInstant(
  departureTime: string,
  serviceDays: number[],
  now: Date,
  options: { minLeadMinutes?: number; maxLeadDays?: number } = {},
): { departureAt: string; unixSeconds: number } | null {
  const parsed = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(departureTime);
  if (!parsed || serviceDays.length === 0) return null;
  const hours = Number(parsed[1]);
  const minutes = Number(parsed[2]);
  const minLeadMs = (options.minLeadMinutes ?? MIN_LEAD_MINUTES) * 60 * 1000;
  const maxLeadDays = options.maxLeadDays ?? MAX_LEAD_DAYS;
  // 平移 +8h 后用 UTC getter 读出来的就是上海本地的年月日与星期。
  const shanghai = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  for (let offset = 0; offset <= maxLeadDays; offset += 1) {
    const day = new Date(Date.UTC(shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate() + offset));
    if (!serviceDays.includes(day.getUTCDay())) continue;
    const instant = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hours, minutes) - SHANGHAI_OFFSET_MS;
    if (instant - now.getTime() < minLeadMs) continue;
    return { departureAt: new Date(instant).toISOString(), unixSeconds: Math.floor(instant / 1000) };
  }
  return null;
}

/**
 * 排出本轮要打的调用。
 *
 * 三件事：挑出过期未采的区间、按 (起点, 出发时刻) 合并成矩阵调用（省配额）、
 * 按「最久没采」优先排序并封顶。合并是有意义的：同一个起点同一个发车时刻可能
 * 有多条线路（例如宝山 17:00 同时发往延长和嘉定），一次调用就能一起问到。
 */
export function planSampleCalls(
  segments: Segment[],
  lastSampledAt: Map<string, string>,
  now: Date,
  options: { maxCalls?: number; refreshIntervalDays?: number; maxElements?: number; maxLeadDays?: number } = {},
): SampleCall[] {
  const maxCalls = options.maxCalls ?? MAX_CALLS_PER_RUN;
  const maxElements = options.maxElements ?? MATRIX_MAX_ELEMENTS;
  const refreshIntervalDays = options.refreshIntervalDays ?? REFRESH_INTERVAL_DAYS;
  const cutoff = new Date(now.getTime() - refreshIntervalDays * 24 * 60 * 60 * 1000).toISOString();

  // 空串排在所有 ISO 时间戳之前，所以「从没采过」自然优先。
  const staleness = (segment: Segment) => lastSampledAt.get(segmentKeyOf(segment)) ?? "";
  const stale = segments
    .filter((segment) => staleness(segment) < cutoff)
    .sort((left, right) => {
      const byStaleness = staleness(left).localeCompare(staleness(right));
      return byStaleness !== 0 ? byStaleness : segmentKeyOf(left).localeCompare(segmentKeyOf(right));
    });

  interface Group {
    fromStopId: string;
    departureTime: string;
    departureAt: string;
    unixSeconds: number;
    staleness: string;
    destinations: Map<string, SegmentKey[]>;
  }
  const groups = new Map<string, Group>();
  for (const segment of stale) {
    const instant = nextServiceInstant(segment.departureTime, segment.serviceDays, now, {
      maxLeadDays: options.maxLeadDays,
    });
    if (!instant) continue;
    // 同一起点 + 同一绝对时刻即可合并；不同 HH:MM 不会映射到同一时刻，所以
    // 组内的 departureTime 必然一致。
    const groupKey = `${segment.fromStopId}|${instant.unixSeconds}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        fromStopId: segment.fromStopId,
        departureTime: segment.departureTime,
        departureAt: instant.departureAt,
        unixSeconds: instant.unixSeconds,
        staleness: staleness(segment),
        destinations: new Map(),
      };
      groups.set(groupKey, group);
    }
    // 两条 pattern 可能共用同一对站点：终点去重，一次结果归给所有匹配的区间。
    const existing = group.destinations.get(segment.toStopId);
    if (existing) existing.push(segment);
    else group.destinations.set(segment.toStopId, [segment]);
  }

  const calls: SampleCall[] = [];
  for (const group of [...groups.values()].sort((left, right) => left.staleness.localeCompare(right.staleness))) {
    const destinations = [...group.destinations.entries()].map(([toStopId, segmentKeys]) => ({
      toStopId,
      segments: segmentKeys.map(({ patternId, fromStopSequence, toStopSequence, departureTime }) => ({
        patternId, fromStopSequence, toStopSequence, departureTime,
      })),
    }));
    for (let index = 0; index < destinations.length; index += maxElements) {
      calls.push({
        fromStopId: group.fromStopId,
        departureTime: group.departureTime,
        departureAt: group.departureAt,
        unixSeconds: group.unixSeconds,
        destinations: destinations.slice(index, index + maxElements),
      });
    }
  }
  return calls.slice(0, maxCalls);
}

/**
 * 解析 matrix 响应。status 非 0 直接抛（调用方记日志跳过这一组）；单个元素
 * 缺失或耗时非正只把那一格记成 null，不连坐同批的其他终点。
 */
export function parseMatrixElements(payload: unknown, expected: number): Array<MatrixElement | null> {
  if (typeof payload !== "object" || payload === null) throw new Error("matrix response is not an object");
  const body = payload as { status?: unknown; message?: unknown; result?: unknown };
  if (body.status !== 0) {
    throw new Error(`matrix status ${String(body.status)}: ${String(body.message ?? "")}`);
  }
  const result = body.result as { rows?: unknown } | undefined;
  const rows = Array.isArray(result?.rows) ? result.rows : null;
  if (!rows || rows.length === 0) throw new Error("matrix response has no rows");
  const elements = (rows[0] as { elements?: unknown })?.elements;
  if (!Array.isArray(elements)) throw new Error("matrix row has no elements");
  return Array.from({ length: expected }, (_unused, index) => {
    const element = elements[index] as { duration?: unknown; distance?: unknown } | undefined;
    const duration = typeof element?.duration === "number" ? element.duration : NaN;
    if (!Number.isFinite(duration) || duration <= 0 || duration >= 86400) return null;
    const distance = typeof element?.distance === "number" && Number.isFinite(element.distance) && element.distance >= 0
      ? Math.round(element.distance)
      : null;
    return { durationSeconds: Math.round(duration), distanceMeters: distance };
  });
}

/**
 * 样本中位数。用中位数而不是平均值：偶发的一次堵车或一次 provider 抖动不该把
 * 页面上的数字整体拉走。偶数条取中间两条的平均。
 */
export function medianDurationSeconds(durations: number[]): number | null {
  const sorted = durations.filter((value) => Number.isFinite(value) && value > 0).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/**
 * 沿停靠链累加各相邻区间的中位耗时，推出每一站的预计到达时刻。
 *
 * 为什么是累加而不是「首站直接问到末站」：采样只存相邻区间（loadSegments），
 * 多站线路上任意前缀的用时就是各段之和。这样 N 站只需 N-1 段样本，而不是
 * N(N-1)/2 个组合；代价是中间不含停站上下客时间（provider 只算行驶）。
 *
 * 缺一段就断链：后面所有站返回 null 而不是跳过那一段接着加。少一段的和会系统性
 * 偏小，宁可显示「暂无」也不要显示一个偏早的到达时间——用户按偏早的时间到站，
 * 车其实还没来，比没有信息更糟。
 *
 * @param stopSequences 该 pattern 的停靠序号，升序（首站在前）
 * @param medians 相邻区间 `from|to` → 中位耗时（秒）
 * @param departureTime 首站排班发车时刻（HH:MM）
 */
export function estimateStopArrivals(
  stopSequences: number[],
  medians: Map<string, number>,
  departureTime: string,
): Map<number, { time: string; dayOffset: number; durationSeconds: number }> {
  const arrivals = new Map<number, { time: string; dayOffset: number; durationSeconds: number }>();
  let cumulative = 0;
  for (let index = 1; index < stopSequences.length; index += 1) {
    const median = medians.get(`${stopSequences[index - 1]}|${stopSequences[index]}`);
    // 断链：这一段没样本，它之后的站都推不出来。
    if (median === undefined) break;
    cumulative += median;
    const arrival = addSecondsToTimeOfDay(departureTime, cumulative);
    if (!arrival) break;
    arrivals.set(stopSequences[index], { ...arrival, durationSeconds: cumulative });
  }
  return arrivals;
}

/**
 * 每条相邻区间的中位耗时，按 (pattern, 区间, 发车时刻) 取最近
 * MEDIAN_SAMPLE_WINDOW 条样本。key 是 `patternId|from|to|departureTime`。
 *
 * 只读一次、在内存里分组：campus-lines 一次要给多条线路多个班次算到达时间，
 * 每段一条 SQL 会把一次公开请求放大成上百次查询。
 */
export async function loadSegmentMedians(
  env: Env,
  patternIds: string[],
): Promise<Map<string, number>> {
  if (patternIds.length === 0) return new Map();
  const rows = await all<{
    patternId: string; fromStopSequence: number; toStopSequence: number;
    departureTime: string; durationSeconds: number;
  }>(
    env.DB,
    `select pattern_id as patternId, from_stop_sequence as fromStopSequence,
            to_stop_sequence as toStopSequence, departure_time as departureTime,
            duration_seconds as durationSeconds
       from transit_travel_time_samples
      where provider=? and pattern_id in (${patternIds.map(() => "?").join(",")})
      order by pattern_id, from_stop_sequence, to_stop_sequence, departure_time, sampled_at desc`,
    [PROVIDER, ...patternIds],
  );
  // order by 已把每组的最新样本排在前面，取前 MEDIAN_SAMPLE_WINDOW 条即可。
  const grouped = new Map<string, number[]>();
  for (const row of rows) {
    const key = `${row.patternId}|${row.fromStopSequence}|${row.toStopSequence}|${row.departureTime}`;
    const list = grouped.get(key) ?? [];
    if (list.length < MEDIAN_SAMPLE_WINDOW) list.push(row.durationSeconds);
    grouped.set(key, list);
  }
  const medians = new Map<string, number>();
  for (const [key, durations] of grouped) {
    const median = medianDurationSeconds(durations);
    if (median !== null) medians.set(key, median);
  }
  return medians;
}

/**
 * 从 {@link loadSegmentMedians} 的全量表里取出某条 pattern、某个发车时刻的相邻区间
 * 中位数，key 收窄成 `from|to` 供 {@link estimateStopArrivals} 直接用。
 *
 * 发车时刻按 `HH:MM` 比较：样本表的 CHECK 是 `like '__:__'`，而 transit_stop_times
 * 里可能存着 `HH:MM:SS`，两边都先截断到 5 位再比。
 */
export function scopeSegmentMedians(
  medians: Map<string, number>,
  patternId: string,
  departureTime: string,
): Map<string, number> {
  const scoped = new Map<string, number>();
  const prefix = `${patternId}|`;
  const suffix = `|${departureTime.slice(0, 5)}`;
  for (const [key, value] of medians) {
    if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
    scoped.set(key.slice(prefix.length, key.length - suffix.length), value);
  }
  return scoped;
}

/**
 * 发车时刻 + 耗时 → 到达时刻（HH:MM）。跨零点回绕，并给出跨天标记，免得
 * 22:00 发车的末班车显示成「00:15 到」而看不出是次日。
 */
export function addSecondsToTimeOfDay(
  departureTime: string,
  durationSeconds: number,
): { time: string; dayOffset: number } | null {
  const parsed = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(departureTime);
  if (!parsed || !Number.isFinite(durationSeconds) || durationSeconds < 0) return null;
  const total = Number(parsed[1]) * 60 + Number(parsed[2]) + Math.round(durationSeconds / 60);
  const dayOffset = Math.floor(total / (24 * 60));
  const minuteOfDay = total - dayOffset * 24 * 60;
  const hours = String(Math.floor(minuteOfDay / 60)).padStart(2, "0");
  const minutes = String(minuteOfDay % 60).padStart(2, "0");
  return { time: `${hours}:${minutes}`, dayOffset };
}

// ---------------------------------------------------------------------------
// 数据读取
// ---------------------------------------------------------------------------

/**
 * 待采样的区间清单。
 *
 * 只取**相邻**停靠对：任意两站的用时是相邻区间的累加（见 estimateStopArrivals），
 * 不必再单独采一遍长区间。序号可能不连续，所以「下一站」用相关子查询取大于当前
 * 序号的最小值，而不是 +1。
 *
 * **不能按 pickup/dropoff 类型筛选区间端点**。0024 校区对校区改版之后线路是多站
 * 链：`pattern_jiading-to-baoshan` 是嘉定北门 → 宝山 5 个下车点，只有首站
 * pickup='regular'，中间站全是 pickup='none' + dropoff='regular'。早先那版 SQL
 * 要求区间起点 pickup<>'none'，于是只采到 0→1 一段，后面 1→2…4→5 四段永远没有
 * 样本 —— 6 个站里 4 个推不出到达时间。这里改成对全部相邻停靠对取区间。
 *
 * **发车时刻取该班次首站的那一个**（`stop_sequence` 最小且有 departure_time 的
 * 行）。线上只有 seq=0 录了时刻（实测 157 个班次里 seq=1 只有 2 条有值，seq>=2
 * 全空），中间站的通过时刻本身就是要推算的东西，不可能从库里读。用首站发车时刻
 * 作为整条链的查询基准，代价是中间段问 provider 的时刻偏早（最多偏一趟车的全程
 * 时长，约 40 分钟）；而实测跨时段极差只有 4.5 分钟／全天，这个精度下可以接受。
 *
 * 同一个 (pattern, 区间, 发车时刻) 可能来自多个 trip（差别只在服务日历），
 * 这里按 key 合并并对星期取并集。
 */
export async function loadSegments(env: Env, today: string): Promise<Segment[]> {
  const rows = await all<{
    patternId: string;
    fromStopSequence: number;
    toStopSequence: number;
    fromStopId: string;
    toStopId: string;
    departureTime: string;
    sunday: number; monday: number; tuesday: number; wednesday: number;
    thursday: number; friday: number; saturday: number;
  }>(
    env.DB,
    `select p.id as patternId,
            ps1.stop_sequence as fromStopSequence, ps2.stop_sequence as toStopSequence,
            ps1.stop_id as fromStopId, ps2.stop_id as toStopId,
            st.departure_time as departureTime,
            c.sunday, c.monday, c.tuesday, c.wednesday, c.thursday, c.friday, c.saturday
       from transit_patterns p
       join transit_routes r on r.id=p.route_id and r.status='active'
       join transit_pattern_stops ps1 on ps1.pattern_id=p.id
       join transit_pattern_stops ps2 on ps2.pattern_id=p.id
            and ps2.stop_sequence=(select min(x.stop_sequence) from transit_pattern_stops x
                                    where x.pattern_id=p.id and x.stop_sequence>ps1.stop_sequence)
       join transit_trips t on t.pattern_id=p.id and t.status='active'
       join transit_stop_times st on st.trip_id=t.id
            and st.stop_sequence=(select min(y.stop_sequence) from transit_stop_times y
                                   where y.trip_id=t.id and y.departure_time is not null)
       join service_calendars c on c.id=t.service_calendar_id
      where st.departure_time is not null and c.valid_to>=?`,
    [today],
  );

  const merged = new Map<string, Segment>();
  for (const row of rows) {
    const departureTime = row.departureTime.slice(0, 5);
    const key = segmentKeyOf({ ...row, departureTime });
    const days = WEEKDAY_COLUMNS.flatMap((column, index) => (Number(row[column]) === 1 ? [index] : []));
    const existing = merged.get(key);
    if (existing) {
      for (const day of days) if (!existing.serviceDays.includes(day)) existing.serviceDays.push(day);
      continue;
    }
    merged.set(key, {
      patternId: row.patternId,
      fromStopSequence: row.fromStopSequence,
      toStopSequence: row.toStopSequence,
      departureTime,
      fromStopId: row.fromStopId,
      toStopId: row.toStopId,
      serviceDays: days,
    });
  }
  for (const segment of merged.values()) segment.serviceDays.sort();
  return [...merged.values()];
}

/**
 * 站点的 GCJ-02 经纬度。取站点自己的 navigation_target，没有就借它绑定的 place 的。
 *
 * **不能要求 is_primary=1**（照抄客户端 navigationPointForStop 会踩这个坑）：
 * idx_entity_locations_one_primary（0001，0015 重建）限制每个实体只有一个
 * primary 绑定，而站点的那个名额被 boarding_point（地图图钉）占着，所以
 * navigation_target 必然是 is_primary=0。线上 release manifest 实测印证：4 个
 * 站点里带 navigation_target 的两条 isPrimary 都是 0 —— 加了这个条件采样会
 * 永远采到 0 条，而且不报错。
 *
 * 身份唯一性由 idx_entity_locations_one_active_navigation_target 保证
 * （entity_type+entity_id+role 在 valid_to is null 时唯一），不依赖 is_primary。
 * 客户端那边要 isPrimary=1 是因为它读的是 release manifest 的展示投影，
 * 语义不同；这里读的是库里的规范存储。
 *
 * 刻意不做地理编码兜底：实测「上海大学陈台公寓」返回的点离宝山校区中心只有
 * 600m（可信度 3），换个写法又跳到十几公里外，而站点名在数据里还有「陈太/陈台」
 * 的不一致。宁可这条线没有样本，也不要一条静默错误的耗时。
 */
export async function loadStopPoints(env: Env): Promise<Map<string, GeoPoint>> {
  const rows = await all<{ entityType: string; entityId: string; geometryJson: string | null }>(
    env.DB,
    `select el.entity_type as entityType, el.entity_id as entityId, la.geometry_json as geometryJson
       from entity_locations el join location_anchors la on la.id=el.anchor_id
      where el.valid_to is null and el.role='navigation_target'
        and (la.valid_to is null or la.valid_to>?)
        and la.geometry_type='Point' and la.crs='GCJ02' and la.geometry_json is not null
        and el.entity_type in ('transit_stop','place')`,
    [isoNow()],
  );
  const byEntity = new Map<string, GeoPoint>();
  for (const row of rows) {
    const point = parsePoint(row.geometryJson);
    if (point) byEntity.set(`${row.entityType}:${row.entityId}`, point);
  }
  const stops = await all<{ id: string; placeId: string | null }>(
    env.DB,
    "select id, place_id as placeId from transit_stops where status='active'",
  );
  const resolved = new Map<string, GeoPoint>();
  for (const stop of stops) {
    const point = byEntity.get(`transit_stop:${stop.id}`)
      ?? (stop.placeId ? byEntity.get(`place:${stop.placeId}`) : undefined);
    if (point) resolved.set(stop.id, point);
  }
  return resolved;
}

function parsePoint(geometryJson: string | null): GeoPoint | null {
  if (!geometryJson) return null;
  try {
    const geometry = JSON.parse(geometryJson) as { type?: unknown; coordinates?: unknown };
    if (geometry.type !== "Point" || !Array.isArray(geometry.coordinates) || geometry.coordinates.length !== 2) return null;
    const [longitude, latitude] = geometry.coordinates as unknown[];
    if (typeof longitude !== "number" || typeof latitude !== "number") return null;
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
    if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) return null;
    return { longitude, latitude };
  } catch {
    return null;
  }
}

/** 每个区间最近一次采样时间，用来判断谁过期了。 */
async function loadLastSampledAt(env: Env): Promise<Map<string, string>> {
  const rows = await all<{
    patternId: string; fromStopSequence: number; toStopSequence: number; departureTime: string; lastSampledAt: string;
  }>(
    env.DB,
    `select pattern_id as patternId, from_stop_sequence as fromStopSequence, to_stop_sequence as toStopSequence,
            departure_time as departureTime, max(sampled_at) as lastSampledAt
       from transit_travel_time_samples
      where provider=?
      group by pattern_id, from_stop_sequence, to_stop_sequence, departure_time`,
    [PROVIDER],
  );
  return new Map(rows.map((row) => [segmentKeyOf(row), row.lastSampledAt]));
}

// ---------------------------------------------------------------------------
// Provider 调用
// ---------------------------------------------------------------------------

export interface MatrixQuery {
  origin: GeoPoint;
  destinations: GeoPoint[];
  unixSeconds: number;
}

export type MatrixFetcher = (query: MatrixQuery) => Promise<Array<MatrixElement | null>>;

/** 腾讯坐标参数是 `纬度,经度`，与 GeoJSON 的 [lng, lat] 相反。 */
function coordParam(point: GeoPoint): string {
  return `${point.latitude},${point.longitude}`;
}

export function matrixRequestUrl(query: MatrixQuery, key: string): string {
  const url = new URL(MATRIX_ENDPOINT);
  url.searchParams.set("mode", "driving");
  url.searchParams.set("from", coordParam(query.origin));
  url.searchParams.set("to", query.destinations.map(coordParam).join(";"));
  url.searchParams.set("departure_time", String(query.unixSeconds));
  url.searchParams.set("key", key);
  return url.toString();
}

function tencentMatrixFetcher(key: string): MatrixFetcher {
  return async (query) => {
    const response = await fetch(matrixRequestUrl(query, key));
    if (!response.ok) throw new Error(`matrix http ${response.status}`);
    return parseMatrixElements(await response.json(), query.destinations.length);
  };
}

// ---------------------------------------------------------------------------
// cron 入口
// ---------------------------------------------------------------------------

export interface SampleRunSummary {
  planned: number;
  called: number;
  inserted: number;
  skippedNoCoordinates: number;
  failedCalls: number;
  purged: number;
}

/**
 * 采样一轮。跟 purgeQuarantineMedia 一样吞掉一切错误只打日志：cron 抛异常算
 * 这次运行失败，但没有人工盯着告警，安静地少采一轮比让整个 scheduled 挂掉好。
 */
export async function sampleTravelTimes(
  env: Env,
  deps: { now?: Date; fetcher?: MatrixFetcher; sleep?: (ms: number) => Promise<void> } = {},
): Promise<SampleRunSummary> {
  const summary: SampleRunSummary = {
    planned: 0, called: 0, inserted: 0, skippedNoCoordinates: 0, failedCalls: 0, purged: 0,
  };
  try {
    const now = deps.now ?? new Date();
    const key = env.TENCENT_MAP_KEY;
    const fetcher = deps.fetcher ?? (key ? tencentMatrixFetcher(key) : null);
    if (!fetcher) {
      console.log("travel-time sampling skipped: TENCENT_MAP_KEY is not configured");
      return summary;
    }
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

    const today = now.toISOString().slice(0, 10);
    const [segments, points, lastSampledAt] = await Promise.all([
      loadSegments(env, today),
      loadStopPoints(env),
      loadLastSampledAt(env),
    ]);

    // 缺坐标的区间在排程前就剔掉，否则它们会一直占着「最久没采」的队首。
    const usable = segments.filter((segment) => {
      const ok = points.has(segment.fromStopId) && points.has(segment.toStopId);
      if (!ok) summary.skippedNoCoordinates += 1;
      return ok;
    });

    const calls = planSampleCalls(usable, lastSampledAt, now);
    summary.planned = calls.length;

    const inserts = [];
    for (const [index, call] of calls.entries()) {
      if (index > 0) await sleep(CALL_SPACING_MS);
      const origin = points.get(call.fromStopId);
      const destinationPoints = call.destinations.map((destination) => points.get(destination.toStopId));
      if (!origin || destinationPoints.some((point) => !point)) continue;
      let elements: Array<MatrixElement | null>;
      try {
        elements = await fetcher({
          origin,
          destinations: destinationPoints as GeoPoint[],
          unixSeconds: call.unixSeconds,
        });
        summary.called += 1;
      } catch (error) {
        summary.failedCalls += 1;
        console.error(`travel-time matrix call failed (${call.fromStopId} @ ${call.departureAt})`, error);
        continue;
      }
      const sampledAt = isoNow();
      for (const [position, destination] of call.destinations.entries()) {
        const element = elements[position];
        if (!element) continue;
        for (const segment of destination.segments) {
          inserts.push(
            env.DB.prepare(
              `insert into transit_travel_time_samples(
                 id, pattern_id, from_stop_sequence, to_stop_sequence, departure_time, departure_at,
                 duration_seconds, distance_meters, provider, sampled_at
               ) values(?,?,?,?,?,?,?,?,?,?)`,
            ).bind(
              makeId("tts"), segment.patternId, segment.fromStopSequence, segment.toStopSequence,
              segment.departureTime, call.departureAt, element.durationSeconds, element.distanceMeters,
              PROVIDER, sampledAt,
            ),
          );
        }
      }
    }
    if (inserts.length > 0) {
      await env.DB.batch(inserts);
      summary.inserted = inserts.length;
    }

    summary.purged = await purgeExpiredSamples(env, now);
    console.log(
      `travel-time sampling: ${summary.called}/${summary.planned} calls ok, ${summary.inserted} samples inserted, `
        + `${summary.failedCalls} calls failed, ${summary.skippedNoCoordinates} segments lack coordinates, `
        + `${summary.purged} old samples purged`,
    );
  } catch (error) {
    console.error("travel-time sampling failed", error);
  }
  return summary;
}

async function purgeExpiredSamples(env: Env, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - SAMPLE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows = await all<{ id: string }>(
    env.DB,
    "select id from transit_travel_time_samples where sampled_at < ? limit ?",
    [cutoff, MAX_PURGE_PER_RUN],
  );
  if (rows.length === 0) return 0;
  await env.DB.batch(
    rows.map((row) => env.DB.prepare("delete from transit_travel_time_samples where id=?").bind(row.id)),
  );
  return rows.length;
}
