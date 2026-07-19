import { Building2, Clock, Heart, Navigation, Phone } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { getPlace } from "../../lib/api/public";
import type { OperationalEvent } from "../../lib/api/types";
import { IconBadge } from "../../components/ui/IconBadge";
import { SectionHeader } from "../../components/ui/SectionHeader";
import { SeverityBanner, severityOf } from "../../components/ui/SeverityBanner";
import { facilityIcon } from "../../lib/facilityIcons";
import { useAsyncData } from "../../lib/hooks/useAsyncData";
import { useFavorites } from "../../lib/storage/favorites";
import type { MapBuilding } from "../../lib/types";
import { categoryLabel } from "./category";

const FACT_ICONS = [Clock, Building2, Phone];

/** M2 楼宇 POI 详情（商户 outlet 复用同一版式）。 */
export function PoiDetailSheet({
  building,
  events,
}: {
  building: MapBuilding;
  events: OperationalEvent[];
}) {
  const navigate = useNavigate();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const { isFavorite, toggleFavorite } = useFavorites();
  const favorite = isFavorite(building.poiKey);

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
        {/* 照片区：单张通宽 + 分页点 */}
        <div className="mt-4">
          {media.length > 0 ? (
            <img src={media[0].url} alt={media[0].alt ?? building.name} className="h-44 w-full rounded-xl object-cover" />
          ) : (
            <div className="grid h-44 w-full place-items-center rounded-xl bg-line/60 text-body text-sub">实拍图</div>
          )}
          {media.length > 1 ? (
            <div className="mt-2 flex justify-center gap-1.5">
              {media.map((item, index) => (
                <span key={index} className={`h-1.5 w-1.5 rounded-full ${index === 0 ? "bg-primary" : "bg-line"}`} />
              ))}
            </div>
          ) : null}
        </div>

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

        {building.detail.description.trim() ? (
          <p className="mt-4 text-body leading-relaxed text-ink">{building.detail.description}</p>
        ) : null}
      </div>
    </div>
  );
}
