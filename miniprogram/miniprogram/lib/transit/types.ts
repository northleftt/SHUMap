// 与 v2 Worker 公开契约对应的类型（只保留校车页面用到的部分）。
// 来源：src/lib/api/types.ts，字段语义以 worker/modules/public.ts、transit.ts 为准。

export interface TransitStop {
  id: string;
  place_id: string | null;
  campus_id: string | null;
  code: string | null;
  name: string;
  status: "active";
  created_at: string;
  updated_at: string;
  /** 客户端从 release locations 解析出的 GCJ-02 导航锚点。 */
  navigationPoint?: { longitude: number; latitude: number; displayName: string } | null;
  /**
   * 站点在地图上的 POI 键（`transit_stop:<id>`），没上图时为 null。
   * 由 mapPoiKeyForStop 按发布层同一条规则判定，不要用 place_id 现算。
   */
  mapPoiKey?: string | null;
}

/** release manifest 里校车相关的最小子集：快照只冻结站点，班次走实时接口。 */
export interface ReleaseNavigationLocation {
  entityType: "place" | "facility" | "merchant_outlet" | "transit_stop";
  entityId: string;
  role: string;
  isPrimary: 0 | 1;
  geometry_type: string;
  geometry_json: string | null;
  crs: string | null;
  location_hint: string | null;
}

export interface ReleaseTransitManifest {
  campuses: Array<{ id: string; name: string }>;
  transit: { stops: TransitStop[] };
  locations?: ReleaseNavigationLocation[];
}

// ---------------------------------------------------------------------------
// GET /api/public/transit/campus-lines — 校区对校区模型（0024 改版）
// ---------------------------------------------------------------------------

/** 端点 id：校区直接用 campus_id；无校区的乘车点用 `stop:<stopId>` 伪端点。 */
export interface TransitEndpointInfo {
  id: string;
  name: string;
}

export interface CampusLineStop {
  stopId: string;
  stopName: string;
  stopSequence: number;
  pickupType: string;
  dropoffType: string;
}

export interface CampusLinePattern {
  patternId: string;
  name: string;
  stops: CampusLineStop[];
}

export interface CampusJourneyStopTime {
  stopSequence: number;
  arrivalTime: string | null;
  departureTime: string | null;
  /**
   * 估算到达时刻（HH:MM）。来自 worker/modules/travel-time.ts 的区间用时采样，
   * 不是排班时刻——校车按表发车，未知量只有行驶耗时。缺样本或断链时为 null。
   */
  estimatedArrivalTime: string | null;
  /** 估算到达跨天数：末班车 22:00 发车 + 40 分钟是次日，此时为 1。 */
  estimatedArrivalDayOffset: number | null;
}

export interface CampusJourney {
  tripId: string;
  patternId: string;
  publicLabel: string | null;
  /** 首站发车时刻；源数据只有发车列时到达为 null。 */
  departureTime: string | null;
  arrivalTime: string | null;
  /** 末站的估算到达时刻；`arrivalTime` 有真实值时不用它。 */
  estimatedArrivalTime: string | null;
  estimatedArrivalDayOffset: number | null;
  /** 全程估算用时（分钟）。 */
  estimatedDurationMinutes: number | null;
  stopTimes: CampusJourneyStopTime[];
}

export interface CampusLine {
  routeId: string;
  routeName: string;
  /** 预约是线路级属性：required / not_required / optional。 */
  bookingPolicy: string;
  bookingUrl: string | null;
  patterns: CampusLinePattern[];
  journeys: CampusJourney[];
}

/** 日型标签的取值，来自服务日历的 day_type（0025 迁移）。 */
export type PublicDayType = "weekday" | "weekend" | "holiday" | "winter_break" | "summer_break";

export interface CampusLinesResponse {
  date: string;
  timezone: string;
  /**
   * 当日日型，由**管理端的服务日历**决定（worker 的 resolveDayType）。
   * 客户端不要再自己算：曾经算在前端、数据源是 data/academic-calendar 那份手写
   * 草稿，与班次归属所依据的 service_calendars 没有任何连通，会出现「页面说今天是
   * 假日、但假日班次一个都不出」。
   */
  dayType: PublicDayType;
  from: TransitEndpointInfo;
  to: TransitEndpointInfo;
  lines: CampusLine[];
}
