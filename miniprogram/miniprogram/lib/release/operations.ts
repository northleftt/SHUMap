// 运营事件（GET /api/public/operations）的模型与纯逻辑。
// 数据模型是 Web 端 src/lib/api/types.ts:347-401 的可用子集；几何解析走 ../geoGeometry
// （零依赖搬运）。服务端已做 approved + 时间窗过滤，客户端再拆 active/ended，
// 地图只显示 active（scheduled/active）。坐标系一律 svg_viewbox，
// 与校区底图 viewBox 同空间（geographic CRS 本轮不做，同 Web 端 M8）。
// 事件是 live 数据不是冻结 release：页面侧任何一步失败都静默降级为不显示事件。

import { apiGet } from "../api";
import { parseGeoGeometryJson, type GeoGeometry, type GeoPosition } from "../geoGeometry";
import type { MapPoi } from "./types";

export type EventType = "maintenance" | "activity" | "closure" | "notice";
export type EventSeverity = "info" | "warning" | "critical";
export type EventOperationalStatus = "scheduled" | "active" | "resolved" | "cancelled" | "expired";

export interface OperationalEventTarget {
  targetType: string;
  targetId: string;
  impactType: string;
}

export interface OperationalEventUpdate {
  id: string;
  status: string;
  message: string;
  createdAt: string;
}

export interface OperationalEventLocation {
  id: string;
  role: string;
  geometryType: "Point" | "Polygon" | "LineString";
  geometryJson: string;
  crs: "svg_viewbox";
  campusId: string | null;
}

export interface OperationalEvent {
  id: string;
  eventType: EventType;
  severity: EventSeverity;
  /** 地图标注颜色（#rrggbb）；null = 按 severity 默认色。 */
  color: string | null;
  operationalStatus: EventOperationalStatus;
  title: string;
  description: string | null;
  startsAt: string;
  expectedEndsAt: string | null;
  targets: OperationalEventTarget[];
  updates: OperationalEventUpdate[];
  locations: OperationalEventLocation[];
}

/** 叠加图层项：事件 + 其 svg_viewbox 坐标（对齐 Web 端 MapEventOverlay）。 */
export interface EventOverlayItem {
  event: OperationalEvent;
  locationId: string;
  campusId: string | null;
  geometry: GeoGeometry;
}

function contractError(message: string): Error {
  return new Error(`Operations data contract violation: ${message}`);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw contractError(`${field} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw contractError(`${field} must be a string or null`);
  return value;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw contractError(`${field} must be an array`);
  return value;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw contractError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

const EVENT_TYPES: readonly EventType[] = ["maintenance", "activity", "closure", "notice"];
const EVENT_SEVERITIES: readonly EventSeverity[] = ["info", "warning", "critical"];
const EVENT_STATUSES: readonly EventOperationalStatus[] = ["scheduled", "active", "resolved", "cancelled", "expired"];
const GEOMETRY_TYPES = ["Point", "Polygon", "LineString"] as const;

function parseEvent(value: unknown, index: number): OperationalEvent {
  const field = `items[${index}]`;
  const raw = requireObject(value, field);
  const eventType = requireString(raw.eventType, `${field}.eventType`) as EventType;
  if (!EVENT_TYPES.includes(eventType)) throw contractError(`${field}.eventType has unsupported value ${eventType}`);
  const severity = requireString(raw.severity, `${field}.severity`) as EventSeverity;
  if (!EVENT_SEVERITIES.includes(severity)) throw contractError(`${field}.severity has unsupported value ${severity}`);
  const operationalStatus = requireString(raw.operationalStatus, `${field}.operationalStatus`) as EventOperationalStatus;
  if (!EVENT_STATUSES.includes(operationalStatus)) {
    throw contractError(`${field}.operationalStatus has unsupported value ${operationalStatus}`);
  }
  return {
    id: requireString(raw.id, `${field}.id`),
    eventType,
    severity,
    color: optionalString(raw.color, `${field}.color`),
    operationalStatus,
    title: requireString(raw.title, `${field}.title`),
    description: optionalString(raw.description, `${field}.description`),
    startsAt: requireString(raw.startsAt, `${field}.startsAt`),
    expectedEndsAt: optionalString(raw.expectedEndsAt, `${field}.expectedEndsAt`),
    targets: requireArray(raw.targets, `${field}.targets`).map((target, targetIndex) => {
      const targetRaw = requireObject(target, `${field}.targets[${targetIndex}]`);
      return {
        targetType: requireString(targetRaw.targetType, `${field}.targets[${targetIndex}].targetType`),
        targetId: requireString(targetRaw.targetId, `${field}.targets[${targetIndex}].targetId`),
        impactType: typeof targetRaw.impactType === "string" ? targetRaw.impactType : "",
      };
    }),
    updates: requireArray(raw.updates, `${field}.updates`).map((update, updateIndex) => {
      const updateRaw = requireObject(update, `${field}.updates[${updateIndex}]`);
      return {
        id: requireString(updateRaw.id, `${field}.updates[${updateIndex}].id`),
        status: typeof updateRaw.status === "string" ? updateRaw.status : "",
        message: requireString(updateRaw.message, `${field}.updates[${updateIndex}].message`),
        createdAt: requireString(updateRaw.createdAt, `${field}.updates[${updateIndex}].createdAt`),
      };
    }),
    locations: requireArray(raw.locations, `${field}.locations`).map((location, locationIndex) => {
      const locationField = `${field}.locations[${locationIndex}]`;
      const locationRaw = requireObject(location, locationField);
      const geometryType = requireString(locationRaw.geometryType, `${locationField}.geometryType`);
      if (!(GEOMETRY_TYPES as readonly string[]).includes(geometryType)) {
        throw contractError(`${locationField}.geometryType has unsupported value ${geometryType}`);
      }
      if (locationRaw.crs !== "svg_viewbox") throw contractError(`${locationField}.crs must be svg_viewbox`);
      return {
        id: requireString(locationRaw.id, `${locationField}.id`),
        role: typeof locationRaw.role === "string" ? locationRaw.role : "",
        geometryType: geometryType as OperationalEventLocation["geometryType"],
        geometryJson: requireString(locationRaw.geometryJson, `${locationField}.geometryJson`),
        crs: "svg_viewbox" as const,
        campusId: optionalString(locationRaw.campusId, `${locationField}.campusId`),
      };
    }),
  };
}

/** 解析 GET /api/public/operations 响应（严格校验，任何违约由调用方降级）。 */
export function parseOperationsResponse(value: unknown): OperationalEvent[] {
  const raw = requireObject(value, "operations response");
  return requireArray(raw.items, "operations response.items").map((item, index) => parseEvent(item, index));
}

/** GET /api/public/operations — 无鉴权公开接口（与 release 同通道）。 */
export async function fetchOperations(): Promise<OperationalEvent[]> {
  const value = await apiGet<unknown>("/api/public/operations");
  return parseOperationsResponse(value);
}

/** 地图只显示进行中的事件（scheduled/active）；其余视为已结束。 */
export function activeOperations(events: OperationalEvent[]): OperationalEvent[] {
  return events.filter(
    (event) => event.operationalStatus === "scheduled" || event.operationalStatus === "active",
  );
}

/** events × locations 展开 + geometryJson 解析（对齐 Web 端 buildEventOverlayItems）。 */
export function buildEventOverlayItems(events: OperationalEvent[]): EventOverlayItem[] {
  const items: EventOverlayItem[] = [];
  for (const event of events) {
    for (const location of event.locations) {
      const geometry = parseGeoGeometryJson(location.geometryJson, `operation location ${location.id}.geometryJson`);
      if (location.geometryType !== geometry.type) {
        throw contractError(`operation location ${location.id}.geometryType must match geometryJson.type`);
      }
      items.push({ event, locationId: location.id, campusId: location.campusId ?? null, geometry });
    }
  }
  return items;
}

/** 校区过滤：campusId 为空 = 通用，否则匹配当前校区 id。 */
export function overlayItemsForCampus(items: EventOverlayItem[], campusId: string): EventOverlayItem[] {
  return items.filter((item) => !item.campusId || item.campusId === campusId);
}

function centroid(positions: GeoPosition[]): GeoPosition {
  const sum = positions.reduce<[number, number]>(
    (accumulator, [x, y]) => [accumulator[0] + x, accumulator[1] + y],
    [0, 0],
  );
  return [sum[0] / positions.length, sum[1] / positions.length];
}

/** overlay item 的图钉锚点：Point 用原坐标，Polygon/LineString 用顶点质心（KISS）。 */
export function overlayAnchor(geometry: GeoGeometry): GeoPosition {
  if (geometry.type === "Point") return geometry.coordinates;
  if (geometry.type === "LineString") return centroid(geometry.coordinates);
  if (geometry.type === "Polygon") return centroid(geometry.coordinates[0]);
  return centroid(geometry.coordinates[0][0]);
}

/**
 * 出「!」图钉的 overlay item 子集：只有点状「事件位置」出图钉。
 * 影响区域/绕行路径本身已是完整图形（且整块可点，eventRegionHit），
 * 再叠一个质心图钉只是噪音——对齐 Web 端 MapEventOverlay 的渲染口径。
 */
export function eventMarkerItems(items: EventOverlayItem[]): EventOverlayItem[] {
  return items.filter((item) => item.geometry.type === "Point");
}

/** 射线法点在环内（偶奇规则；Polygon 的外环+洞逐环翻转即标准含洞判定）。 */
function pointInRing(point: GeoPosition, ring: GeoPosition[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > point[1] !== yj > point[1]
      && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** 点到线段的最短距离。 */
function distanceToSegment(point: GeoPosition, a: GeoPosition, b: GeoPosition): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared));
  return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy));
}

/**
 * 事件区域命中（对齐 Web 端 MapEventOverlay：整个几何图形可点，不只锚点图钉）。
 * Polygon/MultiPolygon 偶奇规则（含洞）；LineString 到最近线段距离 ≤ tolerance；
 * Point 已由 eventAnchors 锚点命中覆盖，这里不重复。
 */
export function eventRegionHit(
  items: EventOverlayItem[],
  world: GeoPosition,
  tolerance: number,
): string | null {
  for (const item of items) {
    const geometry = item.geometry;
    if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") {
      const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
      for (const rings of polygons) {
        let inside = false;
        for (const ring of rings) {
          if (pointInRing(world, ring)) inside = !inside;
        }
        if (inside) return item.event.id;
      }
    } else if (geometry.type === "LineString") {
      const line = geometry.coordinates;
      for (let index = 0; index + 1 < line.length; index++) {
        if (distanceToSegment(world, line[index], line[index + 1]) <= tolerance) {
          return item.event.id;
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 展示文案（对齐 Web 端 OperationDetailSheet / MapPage 摘要卡）
// ---------------------------------------------------------------------------

export const SEVERITY_COLORS: Record<EventSeverity, string> = {
  info: "#1e80c1",
  warning: "#f59e0b",
  critical: "#dc2626",
};

export function severityColor(severity: EventSeverity): string {
  return SEVERITY_COLORS[severity];
}

/** 事件标注颜色：管理端可自选（#rrggbb），未设置时按 severity 默认色（同 Web 端）。 */
export function eventColor(event: Pick<OperationalEvent, "severity" | "color">): string {
  return event.color ?? severityColor(event.severity);
}

export function eventTypeLabel(eventType: EventType): string {
  if (eventType === "closure") return "关闭";
  if (eventType === "maintenance") return "维修";
  if (eventType === "activity") return "活动";
  return "通知";
}

export function eventStatusLabel(status: EventOperationalStatus): string {
  if (status === "active") return "进行中";
  if (status === "scheduled") return "已排期";
  if (status === "resolved") return "已解决";
  if (status === "cancelled") return "已取消";
  return "已过期";
}

export function severityLabel(severity: EventSeverity): string {
  if (severity === "warning") return "警告";
  if (severity === "critical") return "严重";
  return "通知";
}

function formatDay(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 单日期（进展时间线用）；解析失败返回空串。 */
export function formatEventDay(iso: string): string {
  return formatDay(iso) ?? "";
}

/** 起止时间：有 expectedEndsAt 显示区间，否则「X月X日 起 · 长期」。 */
export function formatEventDateRange(event: OperationalEvent): string {
  const start = formatDay(event.startsAt);
  if (!start) return "时间待定";
  const end = event.expectedEndsAt ? formatDay(event.expectedEndsAt) : null;
  return end ? `${start} - ${end}` : `${start} 起 · 长期`;
}

// ---------------------------------------------------------------------------
// targets 与 POI 的关联（详情 sheet 影响范围 / POI 详情横幅）
// ---------------------------------------------------------------------------

/** 详情 sheet 可解析名称的 target 类型（其余类型本轮不展示）。 */
const NAMED_TARGET_TYPES = ["place", "facility", "merchant_outlet", "transit_stop"] as const;

/**
 * 影响范围列表：place/facility/merchant_outlet/transit_stop target 用 release
 * 装配产物（pois + 楼内 facilities/merchants）解析名称；解析不到给兜底文案。
 */
export function resolveEventTargetNames(
  targets: OperationalEventTarget[],
  pois: MapPoi[],
): Array<{ key: string; name: string }> {
  const rows: Array<{ key: string; name: string }> = [];
  for (const target of targets) {
    if (!(NAMED_TARGET_TYPES as readonly string[]).includes(target.targetType)) continue;
    const key = `${target.targetType}:${target.targetId}`;
    let name = "";
    if (target.targetType === "place") {
      name = pois.find(
        (poi) => (poi.entityType === "building" || poi.entityType === "place") && poi.entityId === target.targetId,
      )?.name ?? "关联地点";
    } else if (target.targetType === "facility") {
      name = pois.find((poi) => poi.entityType === "facility" && poi.entityId === target.targetId)?.name
        ?? pois.flatMap((poi) => poi.facilities).find((facility) => facility.id === target.targetId)?.displayName
        ?? "关联设施";
    } else if (target.targetType === "merchant_outlet") {
      name = pois.find((poi) => poi.entityType === "merchant" && poi.entityId === target.targetId)?.name
        ?? pois.flatMap((poi) => poi.merchants).find((merchant) => merchant.id === target.targetId)?.name
        ?? "关联商户";
    } else {
      name = pois.find((poi) => poi.entityType === "transit_stop" && poi.entityId === target.targetId)?.name
        ?? "关联站点";
    }
    rows.push({ key, name });
  }
  return rows;
}

/**
 * active 事件的 targets 是否命中当前 POI（POI 详情 sheet 顶部横幅用）。
 * 逐条对齐 Web 端 PoiDetailSheet：place 命中楼宇/地点实体；facility 命中独立设施
 * 实体或楼内设施；merchant_outlet / transit_stop 按实体类型 + id 匹配。
 */
export function eventsTargetingPoi(events: OperationalEvent[], poi: MapPoi): OperationalEvent[] {
  const facilityIds = new Set(poi.facilities.map((facility) => facility.id));
  return events.filter((event) =>
    event.targets.some(
      (target) =>
        (target.targetType === "place"
          && (poi.entityType === "building" || poi.entityType === "place")
          && target.targetId === poi.entityId)
        || (target.targetType === "facility"
          && (facilityIds.has(target.targetId) || (poi.entityType === "facility" && target.targetId === poi.entityId)))
        || (target.targetType === "merchant_outlet"
          && poi.entityType === "merchant"
          && target.targetId === poi.entityId)
        || (target.targetType === "transit_stop"
          && poi.entityType === "transit_stop"
          && target.targetId === poi.entityId),
    ),
  );
}
