import { Building2, ChevronLeft, ChevronRight, Clock, Heart, Navigation, Phone, Store, Wallet } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getPlace } from "../../lib/api/public";
import type { OperationalEvent } from "../../lib/api/types";
import { IconBadge } from "../../components/ui/IconBadge";
import { SectionHeader } from "../../components/ui/SectionHeader";
import { SeverityBanner, severityOf } from "../../components/ui/SeverityBanner";
import { facilityIcon } from "../../lib/facilityIcons";
import { useAsyncData } from "../../lib/hooks/useAsyncData";
import { useFavorites } from "../../lib/storage/favorites";
import type { MapBuilding, MerchantSummary, PoiDetailData } from "../../lib/types";
import { categoryLabel } from "./category";

const FACT_ICONS = [Clock, Building2, Phone];

/** M2 楼宇 POI 详情（商户 outlet 复用同一版式）。 */
export function PoiDetailSheet({
  building,
  events,
  initialMerchantId = null,
}: {
  building: MapBuilding;
  events: OperationalEvent[];
  /** 深链/搜索命中商户时直接展开该商户视图。 */
  initialMerchantId?: string | null;
}) {
  const navigate = useNavigate();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [openMerchantId, setOpenMerchantId] = useState<string | null>(initialMerchantId);
  const { isFavorite, toggleFavorite } = useFavorites();
  const favorite = isFavorite(building.poiKey);

  // 切换楼宇（或外部指定商户）时重置内嵌商户视图
  useEffect(() => {
    setOpenMerchantId(initialMerchantId);
  }, [building.poiKey, initialMerchantId]);

  const merchants = building.merchants;
  const openMerchant = merchants.find((merchant) => merchant.id === openMerchantId) ?? null;

  const { state: placeState } = useAsyncData((signal) => getPlace(building.poiKey, signal), [building.poiKey]);
  const facilities = placeState.status === "ready" && placeState.data ? placeState.data.facilities : [];

  // 运营信息槽位：targets 命中本楼或楼内设施的活动事件；无事件整体隐藏
  const facilityIds = new Set(facilities.map((facility) => facility.id));
  const activeEvents = events.filter((event) =>
    (event.targets ?? []).some(
      (target) =>
        (target.targetType === "place" && target.targetId === building.poiKey) ||
        (target.targetType === "facility" && facilityIds.has(target.targetId)),
    ),
  );
  const bannerEvent = activeEvents[0] ?? null;

  const facts = building.detail.facts;
  const media = building.detail.media.filter((item) => item.url.trim());
  const navigationOptions = building.navigationUrls
    ? [
        { label: "高德地图", url: building.navigationUrls.amap },
        { label: "腾讯地图", url: building.navigationUrls.tencent },
        { label: "百度地图", url: building.navigationUrls.baidu },
        { label: "系统地图", url: building.navigationUrls.system },
      ]
    : [];

  // 商户详情不单设页面：在同一 sheet 内复用 M2 结构渲染
  if (openMerchant) {
    return (
      <MerchantDetailView
        building={building}
        merchant={openMerchant}
        onBack={() => setOpenMerchantId(null)}
      />
    );
  }

  return (
    <div className="pb-6">
      {/* 标题行 */}
      <div className="flex items-start gap-3 px-5 pt-1">
        <div className="min-w-0 flex-1">
          <h2 className="text-detail">{building.name}</h2>
          <p className="mt-0.5 text-aux text-sub">
            {categoryLabel(building)} · {building.campusLabel}
          </p>
        </div>
        <button
          type="button"
          aria-label="收藏"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-page"
          onClick={() => toggleFavorite(building.poiKey)}
        >
          <Heart size={19} className={favorite ? "fill-primary text-primary" : "text-sub"} />
        </button>
        <div className="relative shrink-0">
          <button
            type="button"
            disabled={!building.navigationUrls}
            className={`flex h-10 items-center gap-1.5 rounded-full px-4 text-body font-semibold ${
              building.navigationUrls ? "bg-primary text-white active:bg-primary-pressed" : "bg-line text-sub"
            }`}
            onClick={() => setNavigationOpen((open) => !open)}
          >
            <Navigation size={15} />
            到这去
          </button>
          {navigationOpen && navigationOptions.length > 0 ? (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setNavigationOpen(false)} />
              <div className="absolute right-0 top-12 z-20 w-[132px] overflow-hidden rounded-xl border border-line bg-surface shadow-floating">
                {navigationOptions.map((option) => (
                  <a
                    key={option.label}
                    className="block px-4 py-2.5 text-body font-medium text-ink no-underline active:bg-page"
                    href={option.url}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {option.label}
                  </a>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>

      {/* 运营信息通栏横幅（severity 三色，无事件隐藏） */}
      {bannerEvent ? (
        <div className="mt-3">
          <SeverityBanner
            severity={severityOf(bannerEvent.severity)}
            title={bannerEvent.title}
            onClick={() => navigate(`/places/${building.poiKey}/operations`)}
          />
        </div>
      ) : null}

      <div className="px-5">
        {/* 照片区：横滑轮播 + 真实分页点 */}
        <PhotoCarousel alt={building.name} media={media} />

        {/* 信息字段行 */}
        {facts.length > 0 ? (
          <div className="mt-4 divide-y divide-line">
            {facts.map((fact, index) => {
              const Icon = FACT_ICONS[index % FACT_ICONS.length];
              const isPhone = fact.label.includes("电话");
              return (
                <div key={`${fact.label}:${index}`} className="flex items-center gap-3 py-3">
                  <Icon size={17} className="shrink-0 text-sub" />
                  <span className="flex-1 text-body text-ink">{fact.label}</span>
                  {isPhone && fact.value.trim() ? (
                    <a className="text-body text-primary no-underline" href={`tel:${fact.value.replace(/[^\d-]/g, "")}`}>
                      {fact.value}
                    </a>
                  ) : (
                    <span className="text-body text-ink">{fact.value.trim() || "—"}</span>
                  )}
                </div>
              );
            })}
          </div>
        ) : null}

        {/* 楼内设施指引 */}
        <div className="mt-4">
          <SectionHeader
            title="楼内设施指引"
            action={
              <button type="button" className="text-primary" onClick={() => navigate(`/places/${building.poiKey}/floors`)}>
                查看楼层图 ›
              </button>
            }
          />
          {facilities.length > 0 ? (
            <div className="scrollbar-hidden mt-3 flex gap-4 overflow-x-auto pb-1">
              {facilities.map((facility) => {
                const Icon = facilityIcon(facility.typeCode);
                return <IconBadge key={facility.id} icon={<Icon size={16} />} label={facility.displayName || facility.typeName} />;
              })}
            </div>
          ) : (
            <p className="mt-2 text-aux text-sub">该楼宇的设施信息正在完善中</p>
          )}
        </div>

        {/* 楼内商户（release manifest merchants，按 hostPlaceId 归到本楼） */}
        {merchants.length > 0 ? (
          <div className="mt-4">
            <SectionHeader title={`楼内商户 (${merchants.length})`} />
            <div className="mt-1 divide-y divide-line">
              {merchants.map((merchant) => (
                <button
                  key={merchant.id}
                  type="button"
                  className="flex w-full items-center gap-3 py-3 text-left active:bg-page"
                  onClick={() => setOpenMerchantId(merchant.id)}
                >
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary-container text-primary">
                    <Store size={16} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body font-semibold text-ink">
                      {merchant.name}
                      {merchant.stallCode ? <span className="ml-1.5 font-normal text-sub">{merchant.stallCode}</span> : null}
                    </span>
                    <span className="mt-0.5 block truncate text-aux text-sub">
                      {[merchant.businessType, merchant.openingHours].filter(Boolean).join(" · ") || "营业信息完善中"}
                    </span>
                  </span>
                  <ChevronRight size={16} className="shrink-0 text-sub" />
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {building.detail.description.trim() ? (
          <p className="mt-4 text-body leading-relaxed text-ink">{building.detail.description}</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * M2 照片区：横滑轮播 + 真实分页点。
 *
 * 用 CSS scroll-snap 做吸附（不引手势库），滚动时按容器宽度换算当前页更新分页点；
 * 点击分页点用 scrollTo 回滚到对应页。数据源同时兼容 place content 里的外链 URL 和
 * `/api/public/media/:id` 相对路径——后者是用户提交照片被审核采纳后发布的地址。
 */
function PhotoCarousel({
  media,
  alt,
}: {
  media: PoiDetailData["media"];
  alt: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  // 图片可能 404（外链失效 / media 尚未发布），失败的整张跳过而不是留白框
  const [broken, setBroken] = useState<Set<string>>(new Set());

  const usable = media.filter((item) => !broken.has(item.url));

  if (usable.length === 0) {
    return (
      <div className="mt-4">
        <div className="grid h-44 w-full place-items-center rounded-xl bg-line/60 text-body text-sub">实拍图</div>
      </div>
    );
  }

  const current = Math.min(page, usable.length - 1);

  return (
    <div className="mt-4">
      <div
        className="flex h-44 w-full snap-x snap-mandatory gap-2 overflow-x-auto scroll-smooth rounded-xl [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onScroll={(event) => {
          const track = event.currentTarget;
          const width = track.clientWidth;
          if (width > 0) setPage(Math.round(track.scrollLeft / width));
        }}
        ref={trackRef}
      >
        {usable.map((item, index) => (
          <img
            alt={item.alt?.trim() || `${alt} 实拍图 ${index + 1}`}
            className="h-44 w-full shrink-0 snap-start rounded-xl object-cover"
            key={item.url}
            loading={index === 0 ? "eager" : "lazy"}
            onError={() => setBroken((cur) => new Set(cur).add(item.url))}
            src={item.url}
          />
        ))}
      </div>
      {usable.length > 1 ? (
        <div className="mt-2 flex justify-center gap-1.5">
          {usable.map((item, index) => (
            <button
              aria-current={index === current}
              aria-label={`查看第 ${index + 1} 张照片`}
              className={`h-1.5 rounded-full transition-all ${index === current ? "w-3 bg-primary" : "w-1.5 bg-line"}`}
              key={item.url}
              onClick={() => {
                const track = trackRef.current;
                if (!track) return;
                track.scrollTo({ left: index * track.clientWidth, behavior: "smooth" });
                setPage(index);
              }}
              type="button"
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 商户详情：复用 M2 POI 详情版式（标题行 / 信息字段行 / 通栏区块），
 * 停留在同一 sheet 内，返回即回到所在楼宇详情。
 */
function MerchantDetailView({
  building,
  merchant,
  onBack,
}: {
  building: MapBuilding;
  merchant: MerchantSummary;
  onBack: () => void;
}) {
  const facts: Array<{ label: string; value: string; icon: typeof Clock }> = [
    { label: "营业时间", value: merchant.openingHours, icon: Clock },
    { label: "档口号", value: merchant.stallCode, icon: Store },
    { label: "人均", value: merchant.avgPrice, icon: Wallet },
    { label: "联系电话", value: merchant.phone, icon: Phone },
  ].filter((fact) => fact.value.trim());

  return (
    <div className="pb-6">
      <div className="flex items-start gap-3 px-5 pt-1">
        <button
          type="button"
          aria-label="返回楼宇详情"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-page text-sub"
          onClick={onBack}
        >
          <ChevronLeft size={19} />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="text-detail">{merchant.name}</h2>
          <p className="mt-0.5 text-aux text-sub">
            {[merchant.businessType, building.name].filter(Boolean).join(" · ")}
          </p>
        </div>
      </div>

      <div className="px-5">
        {facts.length > 0 ? (
          <div className="mt-3 divide-y divide-line">
            {facts.map((fact) => {
              const Icon = fact.icon;
              return (
                <div key={fact.label} className="flex items-center gap-3 py-3">
                  <Icon size={17} className="shrink-0 text-sub" />
                  <span className="flex-1 text-body text-ink">{fact.label}</span>
                  {fact.label === "联系电话" ? (
                    <a className="text-body text-primary no-underline" href={`tel:${fact.value.replace(/[^\d-]/g, "")}`}>
                      {fact.value}
                    </a>
                  ) : (
                    <span className="text-body text-ink">{fact.value}</span>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="mt-3 text-aux text-sub">该商户的营业信息正在完善中</p>
        )}

        {merchant.summary.trim() ? (
          <p className="mt-4 text-body leading-relaxed text-ink">{merchant.summary}</p>
        ) : null}

        {/* 菜单（content.menu，可选扩展字段） */}
        {merchant.menu.length > 0 ? (
          <div className="mt-4">
            <SectionHeader title="菜单" />
            <div className="mt-1 divide-y divide-line">
              {merchant.menu.map((entry, index) => (
                <div key={`${entry.name}:${index}`} className="flex items-start gap-3 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block text-body text-ink">{entry.name}</span>
                    {entry.description ? (
                      <span className="mt-0.5 block text-aux leading-relaxed text-sub">{entry.description}</span>
                    ) : null}
                  </span>
                  {entry.price ? <span className="shrink-0 text-body font-semibold text-ink">{entry.price}</span> : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
