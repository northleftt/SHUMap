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
  transit: { stops: TransitStop[] };
  locations?: ReleaseNavigationLocation[];
}

export interface Journey {
  tripId: string;
  routeId: string;
  routeName: string;
  patternId: string;
  bookingPolicy: string;
  bookingUrl: string | null;
  departureTime: string;
  /** null when the source only carries departure times. */
  arrivalTime: string | null;
  fromSequence: number;
  toSequence: number;
}

export interface JourneysResponse {
  date: string;
  timezone: string;
  journeys: Journey[];
}

/** 一个班次的完整停靠序列（pattern 顺序 + 该班次的到发时刻）。 */
export interface TripStop {
  stopId: string;
  stopName: string;
  stopSequence: number;
  pickupType: string;
  dropoffType: string;
  arrivalTime: string | null;
  departureTime: string | null;
}

export interface TripStopsResponse {
  tripId: string;
  patternId: string;
  stops: TripStop[];
}
