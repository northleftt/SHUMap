import { Building2, ChevronRight, CircleAlert, MapPin, Navigation, Store, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Chip, ChipRow } from "../../components/ui/Chip";
import { EmptyState, LoadingState } from "../../components/ui/EmptyState";
import { SearchInput } from "../../components/ui/SearchInput";
import { FacilityGlyph } from "../../lib/facilityIcons";
import { useRecents } from "../../lib/storage/recents";
import type { MapPoi } from "../../lib/types";
import { CampusSwitcher } from "./CampusSwitcher";
import type { useMapPageState } from "./useMapPageState";

type MapState = Extract<ReturnType<typeof useMapPageState>, { releaseStatus: "ready" }>;

/** D1 左侧信息栏：校区切换 + 搜索 + 筛选 chips + 结果列表。 */
export function DesktopMapPanel({ state }: { state: MapState }) {
  const { recents } = useRecents();
  const filters = state.releaseData.filters;
  const recentPois = recents
    .map((item) => state.campusPois.find((poi) => poi.poiKey === item.placeId))
    .filter((poi): poi is MapPoi => Boolean(poi))
    .slice(0, 6);

  const list = state.searchActive ? state.filteredResults : recentPois;

  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-r border-line bg-surface">
      <div className="border-b border-line px-5 pb-4 pt-5">
        <CampusSwitcher campuses={state.campuses} selectedCampus={state.selectedCampus} onSelect={state.resetForCampus} />
        <div className="mt-3.5">
          <SearchInput
            value={state.query}
            onChange={state.handleQueryChange}
            onFocus={state.handleQueryFocus}
          />
        </div>
        {filters.length > 0 ? (
          <ChipRow className="mt-3">
            {filters.map((filter) => (
              <Chip
                key={filter.key}
                active={state.activeFilters.includes(filter.key)}
                onClick={() => state.handleFilterToggle(filter.key)}
              >
                {filter.label}
              </Chip>
            ))}
          </ChipRow>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="px-2 pb-2 text-aux text-sub">
          {state.query.trim() && state.searchStatus === "loading"
            ? "正在搜索…"
            : state.query.trim() && state.searchStatus === "error"
              ? "搜索失败"
              : state.searchActive
            ? `${state.filteredResults.length} 个结果`
            : recentPois.length > 0
              ? "最近查看"
              : "搜索或点击地图查看地点"}
        </div>
        {state.query.trim() && state.searchStatus === "loading" ? (
          <LoadingState label="正在搜索…" />
        ) : state.query.trim() && state.searchStatus === "error" ? (
          <EmptyState
            icon={<CircleAlert size={24} />}
            title="搜索失败"
            subtitle={state.searchError || "请检查网络后重试"}
            action={
              <button type="button" className="rounded-full bg-primary-container px-4 py-2 text-body text-primary" onClick={state.retrySearch}>
                重新搜索
              </button>
            }
          />
        ) : state.searchActive && list.length === 0 ? (
          <EmptyState title="没有匹配的地点" subtitle="换个关键词或筛选条件试试" />
        ) : (
          list.map((building) => {
            // 设施与校车站点的图标都由 markerIconKey 决定（站点固定为 bus）。自定义
            // 图标（custom- 前缀）是服务端的 SVG，只能由 FacilityGlyph 渲染成 <img>，
            // 所以这里给的是「已经画好的节点」而不是一个组件。
            const glyph = building.entityType === "building"
              ? <Building2 size={19} />
              : building.entityType === "merchant"
                ? <Store size={19} />
                : building.entityType === "facility" || building.entityType === "transit_stop"
                  ? <FacilityGlyph iconKey={building.markerIconKey} size={19} />
                  : <MapPin size={19} />;
            return (
            <button
              key={building.poiKey}
              type="button"
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-page ${
                state.selectedPoi?.poiKey === building.poiKey ? "bg-primary-container" : ""
              }`}
              onClick={() => state.openPoi(building.poiKey, "search_result")}
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-page text-sub">
                {glyph}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-body font-semibold text-ink">{building.name}</span>
                <span className="mt-0.5 block truncate text-aux text-sub">
                  {building.kindName} · {building.campusLabel}
                </span>
              </span>
            </button>
            );
          })
        )}
      </div>
    </aside>
  );
}

/** D1 选中 POI 的地图小卡。 */
export function PoiMapCard({
  building,
  onClose,
  onOpenMerchants,
}: {
  building: MapPoi;
  onClose: () => void;
  /** 打开楼内商户（桌面端详情面板）。 */
  onOpenMerchants?: () => void;
}) {
  const navigate = useNavigate();
  const merchantCount = building.merchants.length;
  return (
    <div className="absolute bottom-6 left-6 z-30 w-[300px] rounded-2xl bg-surface p-4 shadow-floating">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-card">{building.name}</h3>
          <p className="mt-0.5 text-aux text-sub">
            {building.kindName} · {building.campusLabel}
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
      {/* 楼内商户入口（release manifest merchants 归到本楼） */}
      {merchantCount > 0 ? (
        <button
          type="button"
          className="mt-3 flex w-full items-center gap-2.5 rounded-xl bg-page px-3 py-2.5 text-left hover:bg-line"
          onClick={onOpenMerchants}
        >
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary-container text-primary">
            <Store size={14} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-body font-medium text-ink">楼内商户 {merchantCount} 家</span>
            <span className="mt-0.5 block truncate text-aux text-sub">
              {building.merchants.map((merchant) => merchant.name).join("、")}
            </span>
          </span>
          <ChevronRight size={15} className="shrink-0 text-sub" />
        </button>
      ) : null}

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
        {building.entityType === "building" ? (
          <button
            type="button"
            className="flex-1 rounded-full bg-page py-2.5 text-body font-medium text-ink active:bg-line"
            onClick={() => navigate(`/places/${building.entityId}/floors`)}
          >
            楼层设施
          </button>
        ) : null}
      </div>
    </div>
  );
}
