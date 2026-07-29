import { Layers } from "lucide-react";
import { Chip } from "../../components/ui/Chip";
import { filters } from "../../lib/release/mapData";
import type { FilterKey } from "../../lib/types";

/**
 * 图层浮卡（M8 扩展）：事件叠加开关 + 类别高亮。
 * 类别高亮与搜索抽屉的快速筛选共享 activeFilter——搜索里点 = 过滤列表+高亮，
 * 这里点 = 只高亮，不弹抽屉。
 */
export function LayerPanel({
  eventCount,
  eventsOn,
  onToggleEvents,
  activeFilter,
  onToggleFilter,
}: {
  eventCount: number;
  eventsOn: boolean;
  onToggleEvents: () => void;
  activeFilter: FilterKey | null;
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

      <p className="mt-3.5 text-label text-sub">高亮类别</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {filters.map((filter) => (
          <Chip key={filter.key} active={activeFilter === filter.key} onClick={() => onToggleFilter(filter.key)}>
            {filter.label}
          </Chip>
        ))}
      </div>
      <p className="mt-2.5 text-label leading-relaxed text-sub">
        高亮与搜索里的快速筛选是同一状态；底图始终显示。
      </p>
    </div>
  );
}
