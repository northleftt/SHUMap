import { Building2, SearchX } from "lucide-react";
import { Chip, ChipRow } from "../../components/ui/Chip";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListRow } from "../../components/ui/ListRow";
import { SearchInput } from "../../components/ui/SearchInput";
import { SectionHeader } from "../../components/ui/SectionHeader";
import { filters } from "../../lib/release/mapData";
import { useRelease } from "../../lib/release/ReleaseContext";
import { useRecents } from "../../lib/storage/recents";
import type { FilterKey, MapBuilding } from "../../lib/types";
import { categoryLabel } from "./category";

function PlaceSquareIcon() {
  return (
    <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary-container text-primary">
      <Building2 size={19} />
    </span>
  );
}

/** M1 搜索抽屉内容：搜索框 + 标签筛选 + 最近查看 / 搜索结果列表。 */
export function SearchHomeSheet({
  query,
  activeFilter,
  searchActive,
  results,
  onQueryChange,
  onQueryFocus,
  onClearQuery,
  onFilterToggle,
  onResultClick,
}: {
  query: string;
  activeFilter: FilterKey | null;
  searchActive: boolean;
  results: MapBuilding[];
  onQueryChange: (value: string) => void;
  onQueryFocus: () => void;
  onClearQuery: () => void;
  onFilterToggle: (key: FilterKey) => void;
  onResultClick: (poiKey: string) => void;
}) {
  const { recents } = useRecents();
  const { release } = useRelease();
  const buildings = release?.buildings ?? [];
  const recentBuildings = recents
    .map((view) => buildings.find((building) => building.poiKey === view.placeId))
    .filter((building): building is MapBuilding => Boolean(building))
    .slice(0, 6);

  return (
    <div className="flex h-full flex-col gap-3 px-4 pt-1 pb-3">
      <SearchInput value={query} onChange={onQueryChange} onFocus={onQueryFocus} />

      <div className="shrink-0">
        <SectionHeader
          title="标签筛选"
          action={
            activeFilter ? (
              <button type="button" className="text-primary" onClick={() => onFilterToggle(activeFilter)}>
                全部 ›
              </button>
            ) : null
          }
        />
        <ChipRow className="mt-2.5">
          {filters.map((filter) => (
            <Chip key={filter.key} active={activeFilter === filter.key} onClick={() => onFilterToggle(filter.key)}>
              {filter.label}
            </Chip>
          ))}
        </ChipRow>
      </div>

      {searchActive ? (
        <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl bg-surface">
          {results.length === 0 ? (
            <EmptyState
              icon={<SearchX size={24} />}
              title="没有相关搜索结果"
              action={
                <button type="button" className="rounded-full bg-primary-container px-4 py-2 text-body text-primary" onClick={onClearQuery}>
                  清空搜索条件
                </button>
              }
            />
          ) : (
            <div className="divide-y divide-line">
              {results.map((building) => (
                <ListRow
                  key={building.poiKey}
                  icon={<PlaceSquareIcon />}
                  title={building.name}
                  subtitle={`${categoryLabel(building)} · ${building.campusLabel}`}
                  onClick={() => onResultClick(building.poiKey)}
                />
              ))}
            </div>
          )}
        </div>
      ) : recentBuildings.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SectionHeader title="最近查看" />
          <div className="mt-2 divide-y divide-line overflow-hidden rounded-2xl bg-surface">
            {recentBuildings.map((building) => (
              <ListRow
                key={building.poiKey}
                icon={<PlaceSquareIcon />}
                title={building.name}
                subtitle={`${categoryLabel(building)} · ${building.campusLabel}`}
                onClick={() => onResultClick(building.poiKey)}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
