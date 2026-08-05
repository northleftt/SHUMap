import { Building2, CircleAlert, MapPin, RotateCcw, SearchX, Store } from "lucide-react";
import { Chip, ChipRow } from "../../components/ui/Chip";
import { EmptyState, LoadingState } from "../../components/ui/EmptyState";
import { ListRow } from "../../components/ui/ListRow";
import { SearchInput } from "../../components/ui/SearchInput";
import { SectionHeader } from "../../components/ui/SectionHeader";
import { useRecents } from "../../lib/storage/recents";
import { facilityIconByKey } from "../../lib/facilityIcons";
import type { FilterKey, MapPoi } from "../../lib/types";
import type { MapSearchStatus } from "./useMapPageState";

function PlaceSquareIcon({ poi }: { poi: MapPoi }) {
  // 设施与校车站点的图标都由 markerIconKey 决定（站点固定为 bus）。
  const Icon = poi.entityType === "building"
    ? Building2
    : poi.entityType === "merchant"
      ? Store
      : poi.entityType === "facility" || poi.entityType === "transit_stop"
        ? facilityIconByKey(poi.markerIconKey)
        : MapPin;
  return (
    <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary-container text-primary">
      <Icon size={19} />
    </span>
  );
}

/** M1 搜索抽屉内容：搜索框 + 标签筛选 + 最近查看 / 搜索结果列表。 */
export function SearchHomeSheet({
  query,
  activeFilters,
  searchActive,
  searchStatus,
  searchError,
  results,
  pois,
  filters,
  onQueryChange,
  onQueryFocus,
  onClearQuery,
  onRetrySearch,
  onFilterToggle,
  onClearFilters,
  onOpenAllFilters,
  onResultClick,
}: {
  query: string;
  activeFilters: FilterKey[];
  searchActive: boolean;
  searchStatus: MapSearchStatus;
  searchError: string;
  results: MapPoi[];
  pois: MapPoi[];
  filters: Array<{ key: FilterKey; label: string }>;
  onQueryChange: (value: string) => void;
  onQueryFocus: () => void;
  onClearQuery: () => void;
  onRetrySearch: () => void;
  onFilterToggle: (key: FilterKey) => void;
  onClearFilters: () => void;
  onOpenAllFilters: () => void;
  onResultClick: (poiKey: string) => void;
}) {
  const { recents } = useRecents();
  const recentPois = recents
    .map((view) => pois.find((poi) => poi.poiKey === view.placeId))
    .filter((poi): poi is MapPoi => Boolean(poi))
    .slice(0, 6);
  const resetSearch = () => {
    onClearQuery();
    onClearFilters();
  };

  return (
    <div className="flex h-full flex-col gap-3 px-4 pt-1 pb-3">
      <SearchInput value={query} onChange={onQueryChange} onFocus={onQueryFocus} />

      {filters.length > 0 ? (
        <div className="shrink-0">
          <SectionHeader
            title="标签筛选"
            action={
              <div className="flex items-center gap-3">
                {activeFilters.length > 0 ? (
                  <button type="button" className="flex items-center gap-1 text-sub" onClick={onClearFilters}>
                    <RotateCcw size={13} />
                    重置
                  </button>
                ) : null}
                <button type="button" className="text-primary" onClick={onOpenAllFilters}>
                  全部 ›
                </button>
              </div>
            }
          />
          <ChipRow className="mt-2.5">
            {filters.map((filter) => (
              <Chip key={filter.key} active={activeFilters.includes(filter.key)} onClick={() => onFilterToggle(filter.key)}>
                {filter.label}
              </Chip>
            ))}
          </ChipRow>
        </div>
      ) : null}

      {searchActive ? (
        <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl bg-surface">
          {query.trim() && searchStatus === "loading" ? (
            <LoadingState label="正在搜索…" />
          ) : query.trim() && searchStatus === "error" ? (
            <EmptyState
              icon={<CircleAlert size={24} />}
              title="搜索失败"
              subtitle={searchError || "请检查网络后重试"}
              action={
                <button type="button" className="rounded-full bg-primary-container px-4 py-2 text-body text-primary" onClick={onRetrySearch}>
                  重新搜索
                </button>
              }
            />
          ) : results.length === 0 ? (
            <EmptyState
              icon={<SearchX size={24} />}
              title="没有相关搜索结果"
              action={
                <button type="button" className="rounded-full bg-primary-container px-4 py-2 text-body text-primary" onClick={resetSearch}>
                  清空搜索条件
                </button>
              }
            />
          ) : (
            <div className="divide-y divide-line">
              {results.map((building) => (
                <ListRow
                  key={building.poiKey}
                  icon={<PlaceSquareIcon poi={building} />}
                  title={building.name}
                  subtitle={`${building.kindName} · ${building.campusLabel}`}
                  onClick={() => onResultClick(building.poiKey)}
                />
              ))}
            </div>
          )}
        </div>
      ) : recentPois.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SectionHeader title="最近查看" />
          <div className="mt-2 divide-y divide-line overflow-hidden rounded-2xl bg-surface">
            {recentPois.map((building) => (
              <ListRow
                key={building.poiKey}
                icon={<PlaceSquareIcon poi={building} />}
                title={building.name}
                subtitle={`${building.kindName} · ${building.campusLabel}`}
                onClick={() => onResultClick(building.poiKey)}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
