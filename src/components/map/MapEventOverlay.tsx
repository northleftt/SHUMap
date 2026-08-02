import type { OperationalEvent } from "../../lib/api/types";
import { parseGeoGeometryJson, type GeoGeometry } from "../../lib/geoGeometry";
import type { MapViewWindow } from "./MapCanvas";

/** 叠加图层项：事件 + 其 svg_viewbox 坐标。 */
export interface EventOverlayItem {
  event: OperationalEvent;
  locationId: string;
  campusId: string | null;
  geometry: GeoGeometry;
}

const SEVERITY_COLORS = {
  info: "#1e80c1",
  warning: "#f59e0b",
  critical: "#dc2626",
} as const;

function severityColor(severity: OperationalEvent["severity"]): string {
  return SEVERITY_COLORS[severity];
}

/**
 * 事件位置由 /api/public/operations 随事件 live 下发（crs=svg_viewbox），
 * 审核通过即可上图，不依赖发布新 release。geographic CRS 本轮跳过（无 geo→SVG 变换）。
 */
export function buildEventOverlayItems(events: OperationalEvent[]): EventOverlayItem[] {
  const items: EventOverlayItem[] = [];
  for (const event of events) {
    for (const location of event.locations) {
      const geometry = parseGeoGeometryJson(location.geometryJson, `operation location ${location.id}.geometryJson`);
      if (location.geometryType !== geometry.type) {
        throw new Error(`Data contract violation: operation location ${location.id}.geometryType must match geometryJson.type`);
      }
      items.push({ event, locationId: location.id, campusId: location.campusId ?? null, geometry });
    }
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
          // 手势层 pointer capture 会吞 click；命中检测靠这个 data 属性（MapCanvas.handlePointerUp）
          "data-overlay-event-id": item.event.id,
          style: { pointerEvents: "auto" as const, cursor: "pointer" },
          onClick: (e: React.MouseEvent) => {
            e.stopPropagation();
            onSelect(item.event.id);
          },
        };

        if (item.geometry.type === "Point") {
          const [cx, cy] = item.geometry.coordinates;
          return (
            <g key={item.locationId} {...common}>
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

        if (item.geometry.type === "Polygon" || item.geometry.type === "MultiPolygon") {
          const polygons = item.geometry.type === "Polygon" ? [item.geometry.coordinates] : item.geometry.coordinates;
          const rings = polygons.map((polygon) => polygon[0]);
          const labelRing = rings[0];
          const cx = labelRing.reduce((sum, [x]) => sum + x, 0) / labelRing.length;
          const cy = labelRing.reduce((sum, [, y]) => sum + y, 0) / labelRing.length;
          return (
            <g key={item.locationId} {...common}>
              {rings.map((ring, ringIndex) => (
                <polygon
                  key={ringIndex}
                  points={ring.map(([x, y]) => `${x},${y}`).join(" ")}
                  fill={color}
                  fillOpacity={selected ? 0.28 : 0.15}
                  stroke={color}
                  strokeWidth={unit * 0.09}
                  strokeDasharray={`${unit * 0.3} ${unit * 0.22}`}
                />
              ))}
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
          <g key={item.locationId} {...common}>
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
