import { useState } from "react";
import type { FilterKey, MapBuilding, MapSheetMode } from "../lib/types";

interface FilterOption {
  key: FilterKey;
  label: string;
}

interface MapBottomSheetProps {
  mode: MapSheetMode;
  sideInset: number;
  top: number;
  bottom: number;
  dragOffset: number;
  query: string;
  activeFilter: FilterKey | null;
  filters: FilterOption[];
  hasResults: boolean;
  results: MapBuilding[];
  selectedPoi: MapBuilding | null;
  onQueryChange: (value: string) => void;
  onQueryFocus: () => void;
  onFilterToggle: (key: FilterKey) => void;
  onResultClick: (poiKey: string) => void;
  onClearQuery: () => void;
  onClosePoi: () => void;
  onOpenFullResults: () => void;
  onDragPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  filterOpen: boolean;
  onToggleFilterOpen: () => void;
  isCompact: boolean;
  isShort: boolean;
  isNarrow: boolean;
}

const PARTIAL_RESULTS_PREVIEW_COUNT = 2;
const DRAG_HANDLE_OFFSET_TOP_PX = 28;

function SearchIcon() {
  return (
    <svg aria-hidden="true" className="size-5" viewBox="0 0 24 24" fill="none">
      <circle cx="11" cy="11" r="6.25" stroke="currentColor" strokeWidth="2" />
      <path d="M16 16L21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" className="size-3.5" viewBox="0 0 16 16" fill="none">
      <path d="M3 3L13 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M13 3L3 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg aria-hidden="true" className="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </svg>
  );
}

function SearchBar({
  value,
  showClose,
  placeholder,
  onChange,
  onFocus,
  onClear,
  isCompact,
}: {
  value: string;
  showClose: boolean;
  placeholder: string;
  onChange: (value: string) => void;
  onFocus: () => void;
  onClear: () => void;
  isCompact: boolean;
}) {
  return (
    <div
      className={`flex items-center rounded-[20.5px] border border-white/70 bg-[#edf0f4] text-[var(--color-text-muted)] shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] ${
        isCompact ? "h-[38px] px-3.5" : "h-[41px] px-4"
      }`}
    >
      <SearchIcon />
      <input
        className={`h-full min-w-0 flex-1 bg-transparent font-medium text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)] ${
          isCompact ? "ml-2.5 text-[16px]" : "ml-3 text-[16px]"
        }`}
        onFocus={onFocus}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {showClose ? (
        <button
          className="grid size-6 place-items-center rounded-full bg-white text-[var(--color-text-muted)] shadow-sm"
          onClick={onClear}
          type="button"
        >
          <CloseIcon />
        </button>
      ) : null}
    </div>
  );
}

function FilterPopup({
  activeFilter,
  filters,
  onToggle,
  isCompact,
  isNarrow,
}: {
  activeFilter: FilterKey | null;
  filters: FilterOption[];
  onToggle: (key: FilterKey) => void;
  isCompact: boolean;
  isNarrow: boolean;
}) {
  return (
    <div className={isCompact ? "px-4 py-2" : "px-5 py-2.5"}>
      <div
        className={`grid grid-cols-4 max-h-[148px] overflow-y-auto ${
          isCompact ? "gap-x-2.5 gap-y-2" : "gap-x-3 gap-y-2.5"
        }`}
      >
        {filters.map((filter) => {
          const active = activeFilter === filter.key;
          return (
            <button
              key={filter.key}
              className={`rounded-[16px] px-2 font-medium transition-colors ${
                isCompact ? "h-[28px]" : "h-[30px]"
              } ${isNarrow ? "text-[10px]" : "text-[11px]"}`}
              style={{
                background: active ? "var(--color-primary)" : "var(--color-primary-soft)",
                color: active ? "#d7e8f3" : "var(--color-primary)",
              }}
              onClick={() => onToggle(filter.key)}
              type="button"
            >
              {filter.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function getMetaTags(building: MapBuilding) {
  return building.tags ?? [];
}

function getDisplayText(value: string) {
  const trimmed = value.trim();
  return trimmed || "\u00A0";
}

function getMediaUrl(building: MapBuilding, role: "cover" | "gallery", index = 0) {
  const items = building.detail.media.filter((item) => item.role === role && item.url.trim());
  return items[index]?.url ?? "";
}

function PoiMetaTags({
  building,
  compact,
}: {
  building: MapBuilding;
  compact?: boolean;
}) {
  const tags = getMetaTags(building);

  if (tags.length === 0) {
    return null;
  }

  return (
    <div className={`${compact ? "" : "mt-3"} flex flex-wrap gap-2`}>
      {tags.map((tag) => (
        <span
          key={tag}
          className="rounded-full bg-[var(--color-primary-soft)] px-2 py-[2px] text-[10px] font-medium text-[var(--color-primary)]"
        >
          {tag}
        </span>
      ))}
    </div>
  );
}

function PoiImage({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className: string;
}) {
  const hasImage = src.trim().length > 0;

  if (hasImage) {
    return <img alt={alt} className={`${className} object-cover`} src={src} />;
  }

  return (
    <div
      aria-hidden="true"
      className={`${className} bg-[#EEF3F8] shadow-[inset_0_1px_0_rgba(255,255,255,0.65)]`}
    />
  );
}

function ResultCardArrow() {
  return (
    <svg aria-hidden="true" className="size-4" viewBox="0 0 16 16" fill="none">
      <path
        d="M6 3.5L10.5 8L6 12.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function ResultCard({
  building,
  onClick,
  isLast = false,
}: {
  building: MapBuilding;
  onClick: (poiKey: string) => void;
  isLast?: boolean;
}) {
  const openHours = building.detail.facts.find((fact) => fact.label === "开放时间")?.value.trim() ?? "";

  return (
    <button
      className={`group w-full px-4 py-3 text-left transition-colors hover:bg-white/80 ${
        isLast ? "" : "border-b border-[rgba(203,213,225,0.85)]"
      }`}
      onClick={() => onClick(building.poiKey)}
      type="button"
    >
      <div className="flex items-start gap-4">
        <PoiImage
          alt={building.name}
          className="h-[68px] w-[88px] shrink-0 rounded-[4px]"
          src={getMediaUrl(building, "cover")}
        />
        <div className="min-w-0 flex-1 pr-1">
          <div className="flex items-start gap-3">
            <div className="flex h-[68px] min-w-0 flex-1 flex-col justify-between py-[2px]">
              <div className="flex min-w-0 items-center gap-2">
                <h3 className="truncate text-[21px] font-semibold leading-none tracking-[0.005em] text-[var(--color-text)]">
                  {building.name}
                </h3>
                <span className="shrink-0 rounded-full bg-[rgba(215,232,243,0.75)] px-2 py-[3px] text-[10px] font-semibold leading-none text-[var(--color-primary)]">
                  {building.campusLabel.replace("校区", "")}
                </span>
              </div>
              <p className="text-[11px] leading-none text-[var(--color-text-muted)]">
                {openHours ? `开放时间：${openHours}` : "\u00A0"}
              </p>
              <PoiMetaTags building={building} compact />
            </div>
            <span className="mt-[4px] shrink-0 text-[var(--color-text-muted)] transition-transform group-hover:translate-x-0.5">
              <ResultCardArrow />
            </span>
          </div>
        </div>
      </div>
    </button>
  );
}

function NavArrowIcon() {
  // 从设计稿 SVG 直接照抄的 4 点导航箭头多边形，归一化到 9×10 viewBox
  return (
    <svg aria-hidden="true" className="size-[13px]" viewBox="0 0 9 10" fill="currentColor">
      <polygon points="0,4.80 9,0 6.79,10 5.74,5.14" />
    </svg>
  );
}

function PoiDetail({
  building,
}: {
  building: MapBuilding;
}) {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const defaultFacts = ["所属单位", "进入方式", "开放时间", "联系电话"];
  const facts = building.detail.facts.length > 0
    ? building.detail.facts
    : defaultFacts.map((label) => ({ label, value: "" }));
  const navigationOptions = building.navigationUrls
    ? [
      { label: "高德地图", url: building.navigationUrls.amap },
      { label: "腾讯地图", url: building.navigationUrls.tencent },
      { label: "百度地图", url: building.navigationUrls.baidu },
      { label: "系统地图", url: building.navigationUrls.system },
    ]
    : [];

  return (
    <div className="pb-8 pl-10 pr-8 pt-6">
      {/* 标题行：楼名左对齐，到这去靠右 */}
      <div className="mb-4 flex items-center gap-4">
        <h2 className="min-w-0 flex-1 text-[30px] font-medium leading-tight text-black">
          {building.name}
        </h2>
        <div className="relative shrink-0">
          <button
            className={`inline-flex h-[34px] shrink-0 items-center gap-1.5 rounded-full px-4 text-[13px] font-semibold no-underline ${
              building.navigationUrls
                ? "bg-[var(--color-primary-soft)] text-[var(--color-primary)]"
                : "bg-[rgba(203,213,225,0.7)] text-[rgba(255,255,255,0.9)]"
            }`}
            disabled={!building.navigationUrls}
            onClick={() => setNavigationOpen((open) => !open)}
            type="button"
          >
            <NavArrowIcon />
            到这去
          </button>
          {navigationOpen && navigationOptions.length > 0 ? (
            <div className="absolute right-0 top-10 z-50 w-[128px] overflow-hidden rounded-[8px] border border-[var(--color-border)] bg-white shadow-[var(--shadow-floating)]">
              {navigationOptions.map((option) => (
                <a
                  className="block px-4 py-2 text-[13px] font-semibold text-[var(--color-text)] no-underline hover:bg-[var(--color-surface-muted)]"
                  href={option.url}
                  key={option.label}
                  rel="noreferrer"
                  target="_blank"
                >
                  {option.label}
                </a>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className="mb-3 h-px bg-[var(--color-border)]" />
      {/* tags 仅展示，不重复开放时间（底部信息行已有） */}
      <PoiMetaTags building={building} />
      <div className="mt-3 grid grid-cols-2 gap-4">
        <PoiImage
          alt={`${building.name} 图片 1`}
          className="h-[81px] rounded-[4px]"
          src={getMediaUrl(building, "cover")}
        />
        <PoiImage
          alt={`${building.name} 图片 2`}
          className="h-[81px] rounded-[4px]"
          src={getMediaUrl(building, "gallery")}
        />
      </div>
      {building.detail.description.trim() ? (
        <p className="mt-4 text-[13px] leading-5 text-[var(--color-text)]">{building.detail.description}</p>
      ) : null}
      <div className="mt-5 space-y-3 text-[13px]">
        {facts.map((fact) => (
          <p className="flex items-center justify-between gap-4 leading-none" key={`${fact.label}:${fact.value}`}>
            <span className="text-[var(--color-text-muted)]">{fact.label}</span>
            <span className="font-medium text-[var(--color-text)]">{getDisplayText(fact.value)}</span>
          </p>
        ))}
      </div>
    </div>
  );
}

function ResultsEmptyState({
  activeFilter,
  query,
  onClearFilter,
  onClearQuery,
}: {
  activeFilter: FilterKey | null;
  query: string;
  onClearFilter: (key: FilterKey) => void;
  onClearQuery: () => void;
}) {
  const hasQuery = Boolean(query.trim());
  const actionLabel = activeFilter ? "清除筛选条件" : hasQuery ? "清空搜索词" : null;
  const handleAction = activeFilter
    ? () => onClearFilter(activeFilter)
    : hasQuery
      ? onClearQuery
      : null;

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 px-6 pb-10 text-center">
      <p className="text-[14px] font-medium text-[var(--color-text-muted)]">没有相关搜索结果</p>
      {actionLabel && handleAction ? (
        <button
          className="rounded-full bg-[var(--color-primary-soft)] px-4 py-2 text-[13px] font-medium text-[var(--color-primary)]"
          onClick={handleAction}
          type="button"
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

function SearchPromptState() {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-2 px-6 pb-10 text-center">
      <p className="text-[14px] font-medium text-[var(--color-text-muted)]">
        输入关键词或选择分类开始搜索
      </p>
    </div>
  );
}

export function MapBottomSheet({
  mode,
  sideInset,
  top,
  bottom,
  dragOffset,
  query,
  activeFilter,
  filters,
  hasResults,
  results,
  selectedPoi,
  onQueryChange,
  onQueryFocus,
  onFilterToggle,
  onResultClick,
  onClearQuery,
  onClosePoi,
  onOpenFullResults,
  onDragPointerDown,
  filterOpen,
  onToggleFilterOpen,
  isCompact,
  isShort,
  isNarrow,
}: MapBottomSheetProps) {
  const hasSearchCriteria = Boolean(query.trim()) || Boolean(activeFilter);
  const visibleResults =
    mode === "partial_results" ? results.slice(0, PARTIAL_RESULTS_PREVIEW_COUNT) : results;

  return (
    <section
      className="absolute z-30 rounded-t-[28px] shadow-[var(--shadow-sheet)]"
      style={{ insetInline: sideInset, top: top + dragOffset, bottom }}
    >
      {/* 关闭按钮：悬浮在卡片顶部上方，独立于卡片 overflow-hidden 之外 */}
      {mode === "poi_detail" && (
        <button
          aria-label="关闭详情"
          className="absolute -top-5 right-4 z-40 grid size-9 place-items-center rounded-full border border-[rgba(148,163,184,0.35)] bg-white/95 text-[var(--color-text-muted)] shadow-[var(--shadow-floating)] backdrop-blur-sm"
          onClick={onClosePoi}
          type="button"
        >
          <CloseIcon />
        </button>
      )}

      {/* drag handle：pointer-events-none 外层避免遮挡关闭按钮，仅中间小区域响应拖拽 */}
      <div
        className="pointer-events-none absolute inset-x-0 z-40"
        style={{ top: -DRAG_HANDLE_OFFSET_TOP_PX }}
      >
        <div
          className="pointer-events-auto mx-auto flex h-8 w-24 items-center justify-center"
          onPointerDown={onDragPointerDown}
          style={{ touchAction: "none" }}
        >
          <span className="block h-[3px] w-[57px] rounded-full bg-white/60 shadow-sm" />
        </div>
      </div>

      {/* 卡片主体：overflow-hidden 保持圆角裁切 */}
      <div className="overflow-hidden rounded-t-[28px] bg-white" style={{ height: "100%" }}>
      {mode === "fullscreen_map" ? null : (
        <div className="flex h-full flex-col">
          {mode !== "poi_detail" ? (
            <div className={isCompact ? "px-4 pt-6" : "px-5 pt-7"}>
              <div className="flex items-center gap-2.5">
                <div className="min-w-0 flex-1">
                  <SearchBar
                    value={query}
                    showClose={mode === "partial_results" || mode === "full_results" || Boolean(query.trim())}
                    placeholder="搜索地点"
                    onChange={onQueryChange}
                    onFocus={onQueryFocus}
                    onClear={onClearQuery}
                    isCompact={isCompact}
                  />
                </div>
                <button
                  className={`shrink-0 grid place-items-center rounded-full border border-white/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] transition-colors ${
                    isCompact ? "size-[38px]" : "size-[41px]"
                  } ${
                    activeFilter
                      ? "bg-[var(--color-primary)] text-white border-[var(--color-primary)]"
                      : "bg-[#edf0f4] text-[var(--color-text-muted)]"
                  }`}
                  onClick={onToggleFilterOpen}
                  type="button"
                >
                  <FilterIcon />
                </button>
              </div>
            </div>
          ) : null}
          {filterOpen && mode !== "poi_detail" ? (
            <FilterPopup
              activeFilter={activeFilter}
              filters={filters}
              isCompact={isCompact}
              isNarrow={isNarrow}
              onToggle={onFilterToggle}
            />
          ) : null}

          {mode === "default_search" ? (
            filterOpen ? (
              <div className="flex-1" />
            ) : (
              <div className="flex-1 flex items-start pt-2">
                <p className={`text-center w-full text-[var(--color-text-muted)] ${isCompact ? "text-[11px] leading-none" : "text-[12px] leading-none"}`}>
                  点击
                  <svg aria-hidden="true" className="size-[13px] inline-block mx-0.5 -translate-y-px" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                  </svg>
                  按分类筛选地点
                </p>
              </div>
            )
          ) : null}

          {mode === "partial_results" ? (
            <div className={`flex-1 overflow-hidden border-t border-transparent ${isCompact ? "px-3.5 pb-3" : "px-4 pb-4"}`}>
              {hasSearchCriteria && hasResults ? (
                <div className="flex h-full min-h-0 flex-col">
                  <div
                    className="overflow-hidden rounded-[4px] border border-[rgba(203,213,225,0.95)] bg-[#f4f7fb]"
                    style={{ maxHeight: isCompact ? "calc(100% - 28px)" : "calc(100% - 30px)" }}
                  >
                    {visibleResults.map((building, index) => (
                      <ResultCard
                        building={building}
                        isLast={index === visibleResults.length - 1}
                        key={building.poiKey}
                        onClick={onResultClick}
                      />
                    ))}
                  </div>
                  <button
                    className={`shrink-0 w-full text-center tracking-[0.02em] text-[var(--color-text-muted)] ${
                      isCompact ? "mt-2 pb-0.5 text-[10px]" : "mt-2.5 pb-1 text-[10px]"
                    }`}
                    onClick={onOpenFullResults}
                    type="button"
                  >
                    向上拉动查看全部搜索结果
                  </button>
                </div>
              ) : !hasSearchCriteria ? (
                <SearchPromptState />
              ) : (
                <ResultsEmptyState
                  activeFilter={activeFilter}
                  onClearFilter={onFilterToggle}
                  onClearQuery={onClearQuery}
                  query={query}
                />
              )}
            </div>
          ) : null}

          {mode === "full_results" ? (
            <div className={`scrollbar-hidden flex-1 overflow-y-auto ${isCompact ? "px-3.5 pb-3" : "px-4 pb-4"}`}>
              {hasSearchCriteria && hasResults ? (
                <div className="overflow-hidden rounded-[4px] border border-[rgba(203,213,225,0.95)] bg-[#f4f7fb]">
                  {visibleResults.map((building, index) => (
                    <ResultCard
                      building={building}
                      isLast={index === visibleResults.length - 1}
                      key={building.poiKey}
                      onClick={onResultClick}
                    />
                  ))}
                </div>
              ) : !hasSearchCriteria ? (
                <SearchPromptState />
              ) : (
                <ResultsEmptyState
                  activeFilter={activeFilter}
                  onClearFilter={onFilterToggle}
                  onClearQuery={onClearQuery}
                  query={query}
                />
              )}
            </div>
          ) : null}

          {mode === "poi_detail" && selectedPoi ? (
            <div className={`flex-1 overflow-y-auto ${isShort ? "pb-2" : ""}`}>
              <PoiDetail building={selectedPoi} />
            </div>
          ) : null}
        </div>
      )}
      </div>
    </section>
  );
}
