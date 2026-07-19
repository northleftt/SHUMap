import { Building2, Navigation, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Chip, ChipRow } from "../../components/ui/Chip";
import { EmptyState } from "../../components/ui/EmptyState";
import { SearchInput } from "../../components/ui/SearchInput";
import { filters } from "../../lib/release/mapData";
import { useRecents } from "../../lib/storage/recents";
import type { MapBuilding } from "../../lib/types";
import { CampusSwitcher } from "./CampusSwitcher";
import { categoryLabel } from "./category";
import type { useMapPageState } from "./useMapPageState";

type MapState = ReturnType<typeof useMapPageState>;

/** D1 左侧信息栏：校区切换 + 搜索 + 筛选 chips + 结果列表。 */
export function DesktopMapPanel({ state }: { state: MapState }) {
  const { recents } = useRecents();
  const recentBuildings = recents
    .map((item) => state.campusBuildings.find((b) => b.poiKey === item.placeId))
    .filter((b): b is MapBuilding => Boolean(b))
    .slice(0, 6);

  const list = state.searchActive ? state.filteredResults : recentBuildings;

  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-r border-line bg-surface">
      <div className="border-b border-line px-5 pb-4 pt-5">
        <CampusSwitcher selectedCampus={state.selectedCampus} onSelect={state.resetForCampus} />
        <div className="mt-3.5">
          <SearchInput
            value={state.query}
            onChange={state.handleQueryChange}
            onFocus={state.handleQueryFocus}
          />
        </div>
        <ChipRow className="mt-3">
          {filters.map((filter) => (
            <Chip
              key={filter.key}
              active={state.activeFilter === filter.key}
              onClick={() => state.handleFilterToggle(filter.key)}
            >
              {filter.label}
            </Chip>
          ))}
        </ChipRow>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="px-2 pb-2 text-aux text-sub">
          {state.searchActive
            ? `${state.filteredResults.length} 个结果`
            : recentBuildings.length > 0
              ? "最近查看"
              : "搜索或点击地图查看地点"}
        </div>
        {state.searchActive && list.length === 0 ? (
          <EmptyState title="没有匹配的地点" subtitle="换个关键词或筛选条件试试" />
        ) : (
          list.map((building) => (
            <button
              key={building.poiKey}
              type="button"
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-page ${
                state.selectedPoi?.poiKey === building.poiKey ? "bg-primary-container" : ""
              }`}
              onClick={() => state.openPoi(building.poiKey, "search_result")}
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-page text-sub">
                <Building2 size={19} />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-body font-semibold text-ink">{building.name}</span>
                <span className="mt-0.5 block truncate text-aux text-sub">
                  {categoryLabel(building)} · {building.campusLabel}
                </span>
              </span>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}

/** D1 选中 POI 的地图小卡。 */
export function PoiMapCard({
  building,
  onClose,
}: {
  building: MapBuilding;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  return (
    <div className="absolute bottom-6 left-6 z-30 w-[300px] rounded-2xl bg-surface p-4 shadow-floating">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-card">{building.name}</h3>
          <p className="mt-0.5 text-aux text-sub">
            {categoryLabel(building)} · {building.campusLabel}
          </p>
        </div>
        <button
          type="button"
          aria-label="关闭"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-page text-sub"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>
      <div className="mt-3 flex gap-2">
        {building.navigationUrls ? (
          <a
            className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-primary py-2.5 text-body font-semibold text-white no-underline active:bg-primary-pressed"
            href={building.navigationUrls.amap}
            rel="noreferrer"
            target="_blank"
          >
            <Navigation size={14} />
            到这去
          </a>
        ) : null}
        <button
          type="button"
          className="flex-1 rounded-full bg-page py-2.5 text-body font-medium text-ink active:bg-line"
          onClick={() => navigate(`/places/${building.poiKey}/floors`)}
        >
          楼层设施
        </button>
      </div>
    </div>
  );
}
