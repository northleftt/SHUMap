import { Store } from "lucide-react";
import { facilityIconByKey } from "../../lib/facilityIcons";
import { markerUnit } from "../../lib/map/markerScale";
import type { MapPoi } from "../../lib/types";
import type { MapViewWindow } from "./MapCanvas";

/** Independent outdoor POIs share the campus SVG coordinate space. */
export function MapPoiOverlay({
  viewWindow,
  pois,
  selectedPoiKey,
  onSelect,
  scale = 1,
}: {
  viewWindow: MapViewWindow | null;
  pois: MapPoi[];
  selectedPoiKey: string | null;
  onSelect: (poiKey: string) => void;
  /** 图钉大小档位系数（lib/map/markerScale）；默认标准档。 */
  scale?: number;
}) {
  if (!viewWindow || pois.length === 0) return null;
  // 以较短视轴换算图标尺寸，让横屏与窄屏保持相近的屏幕像素大小。
  const unit = markerUnit(viewWindow, scale);

  return (
    <svg
      aria-label="楼外地点"
      className="absolute inset-0 h-full w-full"
      preserveAspectRatio="xMidYMid meet"
      style={{ pointerEvents: "none" }}
      viewBox={`${viewWindow.x} ${viewWindow.y} ${viewWindow.width} ${viewWindow.height}`}
    >
      {pois.map((poi) => {
        if (!poi.markerPoint) return null;
        const selected = poi.poiKey === selectedPoiKey;
        const Icon = poi.entityType === "merchant" ? Store : facilityIconByKey(poi.markerIconKey);
        // 管理端档位（content.marker.size）乘在公共基准上，只对这一个图钉生效。
        const poiUnit = unit * (poi.markerScale || 1);
        const iconSize = poiUnit * 1.08;
        const { x, y } = poi.markerPoint;
        return (
          <g
            aria-label={poi.name}
            data-overlay-poi-key={poi.poiKey}
            key={poi.poiKey}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(poi.poiKey);
            }}
            role="button"
            style={{ cursor: "pointer", pointerEvents: "auto" }}
          >
            {selected ? (
              <circle cx={x} cy={y} fill="#d7e8f3" opacity={0.82} r={poiUnit * 1.08} />
            ) : null}
            <circle
              cx={x}
              cy={y}
              fill={selected ? "#1e80c1" : "#ffffff"}
              r={poiUnit * 0.78}
              stroke="#1e80c1"
              strokeWidth={poiUnit * (selected ? 0.13 : 0.09)}
            />
            <Icon
              color={selected ? "#ffffff" : "#1e80c1"}
              height={iconSize}
              pointerEvents="none"
              strokeWidth={2.2}
              width={iconSize}
              x={x - iconSize / 2}
              y={y - iconSize / 2}
            />
          </g>
        );
      })}
    </svg>
  );
}
