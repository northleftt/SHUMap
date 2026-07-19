import type { OperationalEvent, ReleaseLocation } from "../../lib/api/types";
import type { MapViewWindow } from "./MapCanvas";

/** 叠加图层项：事件 + 其 svg_viewbox 坐标。 */
export interface EventOverlayItem {
  event: OperationalEvent;
  location: ReleaseLocation;
  geometry: GeoGeometry;
}

type GeoGeometry =
  | { type: "Point"; coordinates: [number, number] }
  | { type: "LineString"; coordinates: [number, number][] }
  | { type: "Polygon"; coordinates: [number, number][][] };

function parseGeometry(raw: string | null): GeoGeometry | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as GeoGeometry;
    if (parsed.type === "Point" || parsed.type === "LineString" || parsed.type === "Polygon") return parsed;
    return null;
  } catch {
    return null;
  }
}

const SEVERITY_COLORS = {
  info: "#1e80c1",
  warning: "#f59e0b",
  critical: "#dc2626",
} as const;

function severityColor(severity: string): string {
  return SEVERITY_COLORS[severity as keyof typeof SEVERITY_COLORS] ?? SEVERITY_COLORS.info;
}

/**
 * Join manifest locations (entityType=operational_event, crs=svg_viewbox) with
 * live events. geographic CRS 本轮跳过（无 geo→SVG 变换）。
 */
export function buildEventOverlayItems(
  locations: ReleaseLocation[],
  events: OperationalEvent[],
): EventOverlayItem[] {
  const eventById = new Map(events.map((event) => [event.id, event]));
  const items: EventOverlayItem[] = [];
  for (const location of locations) {
    if (location.entityType !== "operational_event") continue;
    if (location.crs !== "svg_viewbox") continue;
    const event = eventById.get(location.entityId);
    if (!event) continue;
    const geometry = parseGeometry(location.geometry_json);
    if (!geometry) continue;
    items.push({ event, location, geometry });
  }
  return items;
}

/**
 * M8 地图事件叠加层。与底图同一 viewBox 窗口，几何随 pan/zoom 天然同步。
 * 图形 pointer-events-auto + stopPropagation，空白处落回 canvas 点选。
 */
export function MapEventOverlay({
  viewWindow,
  items,
  selectedEventId,
  onSelect,
}: {
  viewWindow: MapViewWindow | null;
  items: EventOverlayItem[];
  selectedEventId: string | null;
  onSelect: (eventId: string) => void;
}) {
  if (!viewWindow || items.length === 0) return null;

  // 以当前窗口宽度为基准的几何尺寸（约 20px 屏幕直径的标记）
  const unit = viewWindow.width / 40;

  return (
    <svg
      className="absolute inset-0 h-full w-full"
      viewBox={`${viewWindow.x} ${viewWindow.y} ${viewWindow.width} ${viewWindow.height}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ pointerEvents: "none" }}
    >
      {items.map((item) => {
        const color = severityColor(item.event.severity);
        const selected = item.event.id === selectedEventId;
        const common = {
          style: { pointerEvents: "auto" as const, cursor: "pointer" },
          onClick: (e: React.MouseEvent) => {
            e.stopPropagation();
            onSelect(item.event.id);
          },
        };

        if (item.geometry.type === "Point") {
          const [cx, cy] = item.geometry.coordinates;
          return (
            <g key={item.location.id} {...common}>
              {/* 脉冲圈 */}
              <circle cx={cx} cy={cy} r={unit * 0.9} fill={color} opacity={0.25} className="event-pulse" />
              <circle
                cx={cx}
                cy={cy}
                r={unit * 0.55}
                fill={color}
                stroke="#fff"
                strokeWidth={unit * 0.1}
              />
              <text
                x={cx}
                y={cy + unit * 0.22}
                textAnchor="middle"
                fontSize={unit * 0.62}
                fill="#fff"
                fontWeight={700}
              >
                !
              </text>
              {selected ? (
                <circle cx={cx} cy={cy} r={unit * 0.85} fill="none" stroke={color} strokeWidth={unit * 0.08} />
              ) : null}
            </g>
          );
        }

        if (item.geometry.type === "Polygon") {
          const ring = item.geometry.coordinates[0] ?? [];
          const points = ring.map(([x, y]) => `${x},${y}`).join(" ");
          const cx = ring.reduce((sum, [x]) => sum + x, 0) / Math.max(1, ring.length);
          const cy = ring.reduce((sum, [, y]) => sum + y, 0) / Math.max(1, ring.length);
          return (
            <g key={item.location.id} {...common}>
              <polygon
                points={points}
                fill={color}
                fillOpacity={selected ? 0.28 : 0.15}
                stroke={color}
                strokeWidth={unit * 0.09}
                strokeDasharray={`${unit * 0.3} ${unit * 0.22}`}
              />
              <text
                x={cx}
                y={cy}
                textAnchor="middle"
                fontSize={unit * 0.5}
                fill={color}
                fontWeight={600}
                style={{ textShadow: "0 0 4px #fff" }}
              >
                {item.event.title}
              </text>
            </g>
          );
        }

        // LineString：虚线 + 端点圆点
        const line = item.geometry.coordinates;
        const points = line.map(([x, y]) => `${x},${y}`).join(" ");
        const [sx, sy] = line[0] ?? [0, 0];
        const [ex, ey] = line[line.length - 1] ?? [0, 0];
        return (
          <g key={item.location.id} {...common}>
            <polyline
              points={points}
              fill="none"
              stroke={color}
              strokeWidth={selected ? unit * 0.18 : unit * 0.12}
              strokeDasharray={`${unit * 0.35} ${unit * 0.25}`}
              strokeLinecap="round"
            />
            <circle cx={sx} cy={sy} r={unit * 0.22} fill="#fff" stroke={color} strokeWidth={unit * 0.08} />
            <circle cx={ex} cy={ey} r={unit * 0.22} fill={color} />
          </g>
        );
      })}
    </svg>
  );
}
