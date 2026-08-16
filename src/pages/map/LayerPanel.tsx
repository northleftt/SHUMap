import { Layers } from "lucide-react";
import { Chip } from "../../components/ui/Chip";
import { MARKER_SCALE_OPTIONS, type MarkerScaleKey } from "../../lib/map/markerScale";
import type { FilterKey } from "../../lib/types";

/**
 * 图层浮卡（M8 扩展）：事件叠加开关 + 图钉大小 + 类别高亮。
 * 类别高亮与搜索抽屉的快速筛选共享选中标签——搜索里点 = 过滤列表+高亮，
 * 这里点 = 只高亮，不弹抽屉。
 */
export function LayerPanel({
  eventCount,
  eventStatus,
  eventError,
  onRetryEvents,
  eventsOn,
  onToggleEvents,
  markerScale,
  onSelectMarkerScale,
  activeFilters,
  filters,
  onToggleFilter,
}: {
  eventCount: number;
  eventStatus: "loading" | "ready" | "error";
  eventError: string | null;
  onRetryEvents: () => void;
  eventsOn: boolean;
  onToggleEvents: () => void;
  markerScale: MarkerScaleKey;
  onSelectMarkerScale: (next: MarkerScaleKey) => void;
  activeFilters: FilterKey[];
  filters: Array<{ key: FilterKey; label: string }>;
  onToggleFilter: (key: FilterKey) => void;
}) {
  return (
    <div className="max-h-[min(60vh,420px)] w-[248px] overflow-y-auto rounded-2xl bg-surface p-4 shadow-floating">
      <p className="text-label text-sub">图层</p>
      <button
        type="button"
        aria-pressed={eventsOn}
        className="mt-2 flex w-full items-center gap-2.5 rounded-xl bg-page px-3 py-2.5"
        onClick={onToggleEvents}
      >
        <Layers size={16} className={eventsOn ? "text-primary" : "text-sub"} />
        <span className="flex-1 text-left text-body text-ink">运营事件</span>
        {eventCount > 0 ? (
          <span className="grid h-5 min-w-5 place-items-center rounded-full bg-warning px-1 text-[10px] font-bold text-white">
            {eventCount}
          </span>
        ) : null}
        <span
          className={`flex h-5 w-9 items-center rounded-full px-0.5 transition-colors ${
            eventsOn ? "justify-end bg-primary" : "justify-start bg-line"
          }`}
        >
          <span className="h-4 w-4 rounded-full bg-white shadow-sm" />
        </span>
      </button>
      {eventStatus === "loading" ? (
        <p className="mt-2 text-label text-sub">正在加载运营事件…</p>
      ) : eventStatus === "error" ? (
        <div className="mt-2 rounded-xl bg-error-bg px-3 py-2 text-label text-error">
          <p>运营事件加载失败：{eventError}</p>
          <button type="button" className="mt-1 font-semibold underline" onClick={onRetryEvents}>重新加载</button>
        </div>
      ) : null}

      <p className="mt-3.5 text-label text-sub">图钉大小</p>
      <div className="mt-2 flex gap-1.5" role="radiogroup" aria-label="图钉大小">
        {MARKER_SCALE_OPTIONS.map((option) => (
          <button
            aria-checked={markerScale === option.key}
            className={`h-9 flex-1 rounded-xl text-body transition-colors ${
              markerScale === option.key ? "bg-primary text-white" : "bg-page text-ink active:bg-line"
            }`}
            key={option.key}
            onClick={() => onSelectMarkerScale(option.key)}
            role="radio"
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>

      {filters.length > 0 ? (
        <>
          <p className="mt-3.5 text-label text-sub">高亮类别</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {filters.map((filter) => (
              <Chip key={filter.key} active={activeFilters.includes(filter.key)} onClick={() => onToggleFilter(filter.key)}>
                {filter.label}
              </Chip>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
