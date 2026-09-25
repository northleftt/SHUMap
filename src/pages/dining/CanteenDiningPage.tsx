import { ChevronRight, Clock, Moon, Phone, Store, Sun, Sunrise, Wallet } from "lucide-react";
import { useMemo, useState } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { EmptyState, LoadingState } from "../../components/ui/EmptyState";
import { ImagePreview } from "../../components/ui/ImagePreview";
import { PageHeader } from "../../components/ui/PageHeader";
import { SectionHeader } from "../../components/ui/SectionHeader";
import { usePageView } from "../../lib/analytics";
import {
  DAY_TYPE_LABELS,
  MEAL_LABELS,
  buildCanteens,
  floorMediaOf,
  floorOpenStatus,
  floorStatusLabel,
  levelShortLabel,
  shanghaiMinutes,
  type CanteenView,
  type DiningFloorView,
  type DiningMeal,
  type DiningMealPeriod,
  type DiningScheduleResponse,
} from "../../lib/dining/schedule";
import { useDiningSchedule, useMerchantStatus, type MerchantStatusState } from "../../lib/hooks/useDining";
import { useNow } from "../../lib/hooks/useNow";
import { groupMerchantsByPlace } from "../../lib/release/merchants";
import { useRelease } from "../../lib/release/ReleaseContext";
import type { LoadedRelease } from "../../lib/release/mapData";
import type { MerchantSummary } from "../../lib/types";

const MEAL_ICONS: Record<DiningMeal, typeof Sunrise> = {
  breakfast: Sunrise,
  lunner: Sun,
  latenight: Moon,
};

const MEAL_ORDER: readonly DiningMeal[] = ["breakfast", "lunner", "latenight"];

/**
 * 食堂详情页（D4/D7）：楼层 pills + 当前层供餐卡 + 本层商家 + 本层图片。
 * 楼层/商家骨架来自 release，日型/时段/开放安排与商家营业状态走实时接口，
 * 实时接口失败时骨架照常、状态行提示加载失败。
 */
export function CanteenDiningPage() {
  const { placeId = "" } = useParams();
  const releaseState = useRelease();
  if (releaseState.status === "loading") {
    return (
      <div className="h-full bg-page">
        <LoadingState label="正在加载食堂信息…" />
      </div>
    );
  }
  if (releaseState.status !== "ready") {
    return (
      <div className="h-full bg-page px-5 pt-16">
        <EmptyState
          title={releaseState.status === "error" ? "食堂信息加载失败" : "暂无该食堂信息"}
          subtitle={releaseState.status === "error" ? "请稍后重试" : undefined}
        />
      </div>
    );
  }
  return <ReadyCanteenDiningPage placeId={placeId} release={releaseState.release} />;
}

function ReadyCanteenDiningPage({ release, placeId }: { release: LoadedRelease; placeId: string }) {
  const navigate = useNavigate();
  usePageView("canteen_dining");
  const scheduleState = useDiningSchedule();
  const merchantStatus = useMerchantStatus();
  const [searchParams] = useSearchParams();
  const [activeFloorId, setActiveFloorId] = useState<string | null>(searchParams.get("floor"));
  const [openMerchantId, setOpenMerchantId] = useState<string | null>(null);
  const now = useNow(30_000);
  const nowMinutes = shanghaiMinutes(now);

  const canteens = useMemo(
    () => buildCanteens(release.manifest, release.campuses, groupMerchantsByPlace(release.manifest.merchants)),
    [release],
  );
  const canteen = canteens.find((item) => item.placeId === placeId) ?? null;
  const schedule = scheduleState.status === "ready" ? scheduleState.schedule : null;

  const floorIds = useMemo(() => new Set((canteen?.floors ?? []).map((floor) => floor.floorId)), [canteen]);
  // 整楼休息（D7）：食堂 lifecycle 关闭，或开放安排白名单整楼未命中（工作日例外安排同机制）。
  // 无楼层数据的食堂不参与白名单判定（some 恒 false 会把「暂无楼层信息」误标成「今日休息」）。
  const wholeDayRest = Boolean(
    canteen && (
      canteen.closed
      || (schedule
        && schedule.arrangement
        && floorIds.size > 0
        && !schedule.arrangement.floors.some((floor) => floorIds.has(floor.floorId)))
    ),
  );
  const noArrangement = Boolean(schedule && schedule.dayType !== "weekday" && !schedule.arrangement);

  if (!canteen) {
    return (
      <div className="h-full bg-page px-5 pt-16">
        <EmptyState title="暂无该食堂信息" />
      </div>
    );
  }

  const selectedFloorId = activeFloorId && floorIds.has(activeFloorId)
    ? activeFloorId
    : canteen.floors[0]?.floorId ?? null;
  const selectedFloor = canteen.floors.find((floor) => floor.floorId === selectedFloorId) ?? null;

  function switchFloor(floorId: string) {
    setActiveFloorId(floorId);
    setOpenMerchantId(null);
  }

  // 「今天这些食堂营业」的就近引导：同校区、今天至少有一层可就餐的食堂。
  const alternatives = wholeDayRest && schedule
    ? canteens.filter((item) =>
      item.placeId !== canteen.placeId
      && item.campusKey === canteen.campusKey
      && item.floors.some((floor) =>
        floorOpenStatus({
          dayType: schedule.dayType,
          arrangement: schedule.arrangement,
          floorId: floor.floorId,
          meals: floor.meals,
          periods: schedule.mealPeriods,
          nowMinutes,
          placeClosed: item.closed,
        }).kind !== "rest"))
    : [];

  return (
    <div className="flex h-full flex-col bg-page">
      <div className="mx-auto flex h-full w-full max-w-[780px] flex-col">
        <PageHeader
          title={canteen.name}
          subtitle={`${canteen.campusLabel} · 食堂`}
          right={
            wholeDayRest ? (
              <span className="shrink-0 rounded-full bg-page px-3 py-1.5 text-aux font-semibold text-sub">今日休息</span>
            ) : null
          }
        />

        <div className="flex-1 overflow-y-auto pb-6">
          {scheduleState.status === "error" ? (
            <div className="mx-4 mt-3 rounded-2xl bg-error-bg px-4 py-3 text-aux text-error">
              就餐时段与开放安排加载失败：{scheduleState.message}
            </div>
          ) : null}
          {merchantStatus.status === "error" ? (
            <div className="mx-4 mt-3 rounded-2xl bg-error-bg px-4 py-3 text-aux text-error">
              商家营业状态加载失败：{merchantStatus.message}
            </div>
          ) : null}

          {/* 开放安排 banner（周末/假日安排与工作日例外安排同机制） */}
          {schedule && schedule.arrangement && !wholeDayRest ? (
            <div className="mx-4 mt-3 rounded-2xl bg-primary-container px-4 py-3.5">
              <div className="text-label text-sub">{DAY_TYPE_LABELS[schedule.dayType]}安排</div>
              <div className="mt-1 text-body font-medium leading-relaxed text-primary">
                {`${DAY_TYPE_LABELS[schedule.dayType]}仅部分楼层开放，请以各楼层标注为准`}
              </div>
            </div>
          ) : null}
          {noArrangement ? (
            <div className="mx-4 mt-3 rounded-2xl bg-warning-bg px-4 py-3 text-body text-warning">
              今日暂无就餐安排信息，请以食堂现场公告为准
            </div>
          ) : null}
          {wholeDayRest ? (
            <div className="mx-4 mt-3 rounded-2xl bg-page px-4 py-3 text-body text-sub">
              {(() => {
                // 就近引导列表为空（如 schedule 接口失败）时，文案不提「看看附近」
                const suffix = alternatives.length > 0 ? "，看看附近还在营业的食堂" : "";
                return canteen.closed
                  ? `该食堂今日暂停营业${suffix}`
                  : `该食堂${schedule ? DAY_TYPE_LABELS[schedule.dayType] : "今日"}不开放${suffix}`;
              })()}
            </div>
          ) : null}

          {/* 整楼休息态：主体灰化，仅保留引导列表可点 */}
          <div className={wholeDayRest ? "pointer-events-none opacity-50 grayscale" : undefined}>
            {/* 楼层 pills（与 FloorsPage 同式） */}
            {canteen.floors.length > 1 ? (
              <div className="scrollbar-hidden flex shrink-0 gap-2 overflow-x-auto px-4 pt-3">
                {canteen.floors.map((floor) => {
                  const active = floor.floorId === selectedFloorId;
                  return (
                    <button
                      className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl text-body font-semibold ${
                        active ? "bg-primary text-white" : "bg-surface text-ink active:bg-line"
                      }`}
                      key={floor.floorId}
                      onClick={() => switchFloor(floor.floorId)}
                      type="button"
                    >
                      {levelShortLabel(floor.levelCode)}
                    </button>
                  );
                })}
              </div>
            ) : null}

            {selectedFloor ? (
              <>
                <FloorMealCard
                  canteen={canteen}
                  floor={selectedFloor}
                  nowMinutes={nowMinutes}
                  schedule={schedule}
                />
                <FloorMerchants
                  floor={selectedFloor}
                  merchantStatus={merchantStatus}
                  onToggle={(merchantId) =>
                    setOpenMerchantId((current) => (current === merchantId ? null : merchantId))}
                  openMerchantId={openMerchantId}
                />
                <FloorMedia canteen={canteen} floor={selectedFloor} />
              </>
            ) : (
              <div className="mx-4 mt-3 rounded-2xl bg-surface shadow-card">
                <EmptyState title="该食堂暂无楼层信息" subtitle="楼层信息正在完善中" />
              </div>
            )}
          </div>

          {/* D7 就近引导 */}
          {alternatives.length > 0 ? (
            <div className="mx-4 mt-4">
              <SectionHeader title="今天这些食堂营业" />
              <div className="mt-2 overflow-hidden rounded-2xl bg-surface shadow-card">
                {alternatives.map((item, index) => (
                  <button
                    className={`flex w-full items-center gap-3 px-4 py-3.5 text-left active:bg-page ${
                      index > 0 ? "border-t border-line" : ""
                    }`}
                    key={item.placeId}
                    onClick={() => navigate(`/places/${item.placeId}/dining`)}
                    type="button"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body font-semibold text-ink">{item.name}</span>
                      <span className="mt-0.5 block text-aux text-sub">{item.campusLabel}</span>
                    </span>
                    <ChevronRight size={16} className="shrink-0 text-sub" />
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** 当前层供餐卡：餐别行（icon + 餐别名 + 品类 + 右侧时段），不供应的餐别整行灰化。 */
function FloorMealCard({
  canteen,
  floor,
  schedule,
  nowMinutes,
}: {
  canteen: CanteenView;
  floor: DiningFloorView;
  schedule: DiningScheduleResponse | null;
  nowMinutes: number;
}) {
  const status = schedule
    ? floorOpenStatus({
      dayType: schedule.dayType,
      arrangement: schedule.arrangement,
      floorId: floor.floorId,
      meals: floor.meals,
      periods: schedule.mealPeriods,
      nowMinutes,
      placeClosed: canteen.closed,
    })
    : null;
  const statusText = status ? floorStatusLabel(status) : null;

  const periodsByMeal = new Map<DiningMeal, DiningMealPeriod[]>();
  for (const period of schedule?.mealPeriods ?? []) {
    const list = periodsByMeal.get(period.meal) ?? [];
    list.push(period);
    periodsByMeal.set(period.meal, list);
  }

  return (
    <div className="mx-4 mt-3 rounded-2xl bg-surface p-4 shadow-card">
      <div className="flex items-center gap-2">
        <h2 className="text-emphasis">{`${levelShortLabel(floor.levelCode)} · ${floor.displayName}`}</h2>
        {statusText ? (
          <span className="rounded-full bg-page px-2 py-0.5 text-label text-sub">{statusText}</span>
        ) : null}
      </div>
      <div className="mt-2 divide-y divide-line">
        {MEAL_ORDER.map((meal) => {
          const noBreakfast = meal === "breakfast"
            && Boolean(schedule?.arrangement?.floors.find(row => row.floorId === floor.floorId)?.noBreakfast);
          const served = floor.meals.includes(meal) && !noBreakfast;
          const Icon = MEAL_ICONS[meal];
          const periods = periodsByMeal.get(meal) ?? [];
          return (
            <div className={`flex items-center gap-3 py-3 ${served ? "" : "opacity-40"}`} key={meal}>
              <Icon className="shrink-0 text-primary" size={18} />
              <span className="shrink-0 text-body font-semibold text-ink">{MEAL_LABELS[meal]}</span>
              <span className="min-w-0 flex-1 truncate text-aux text-sub">
                {served ? floor.stallTypes.join(" · ") : noBreakfast ? "今日不供应" : "不供应"}
              </span>
              <span className="shrink-0 text-[11px] text-sub">
                {served ? periods.map((period) => `${period.startTime}–${period.endTime}`).join(" · ") : ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 本层商家：列表 + 点入展开详情（facts / 菜单 / 图片，参照 merchantDetail 的 facts 结构）。 */
function FloorMerchants({
  floor,
  merchantStatus,
  openMerchantId,
  onToggle,
}: {
  floor: DiningFloorView;
  merchantStatus: MerchantStatusState;
  openMerchantId: string | null;
  onToggle: (merchantId: string) => void;
}) {
  if (floor.merchants.length === 0) return null;
  return (
    <div className="mx-4 mt-3 rounded-2xl bg-surface shadow-card">
      <div className="px-4 pt-4">
        <SectionHeader title={`本层商家 (${floor.merchants.length})`} />
      </div>
      <div className="mt-1 divide-y divide-line px-4 pb-2">
        {floor.merchants.map((merchant) => {
          const lifecycle = merchantStatus.status === "ready" ? merchantStatus.statuses[merchant.id] : undefined;
          const open = openMerchantId === merchant.id;
          return (
            <div key={merchant.id}>
              <button
                className="flex w-full items-center gap-3 py-3 text-left active:bg-page"
                onClick={() => onToggle(merchant.id)}
                type="button"
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary-container text-primary">
                  <Store size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-body font-semibold text-ink">{merchant.name}</span>
                    {lifecycle === "temporarily_closed" ? (
                      <span className="shrink-0 rounded-full bg-warning-bg px-2 py-0.5 text-label text-warning">
                        暂停营业
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block truncate text-aux text-sub">
                    {[merchant.businessType, merchant.openingHours].filter(Boolean).join(" · ") || "营业信息完善中"}
                  </span>
                </span>
                <ChevronRight
                  className={`shrink-0 text-sub transition-transform ${open ? "rotate-90" : ""}`}
                  size={16}
                />
              </button>
              {open ? <MerchantDetail merchant={merchant} /> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MerchantDetail({ merchant }: { merchant: MerchantSummary }) {
  const facts: Array<{ label: string; value: string; icon: typeof Clock }> = [
    { label: "营业时间", value: merchant.openingHours, icon: Clock },
    { label: "档口号", value: merchant.stallCode, icon: Store },
    { label: "人均", value: merchant.avgPrice, icon: Wallet },
    { label: "联系电话", value: merchant.phone, icon: Phone },
  ].filter((fact) => fact.value.trim());

  return (
    <div className="pb-4">
      {merchant.media.length > 0 ? (
        <div className="scrollbar-hidden mt-1 flex gap-2 overflow-x-auto">
          {merchant.media.map((item, index) => (
            <ImagePreview
              alt={item.alt?.trim() || `${merchant.name} 图片 ${index + 1}`}
              buttonClassName="h-28 w-40 shrink-0 rounded-xl"
              imageClassName="h-full w-full object-cover"
              key={item.url}
              loading="lazy"
              src={item.url}
            />
          ))}
        </div>
      ) : null}
      {facts.length > 0 ? (
        <div className="mt-2 divide-y divide-line">
          {facts.map((fact) => {
            const Icon = fact.icon;
            return (
              <div className="flex items-center gap-3 py-2.5" key={fact.label}>
                <Icon className="shrink-0 text-sub" size={16} />
                <span className="flex-1 text-aux text-sub">{fact.label}</span>
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
      ) : null}
      {merchant.summary.trim() ? (
        <p className="mt-2 text-body leading-relaxed text-ink">{merchant.summary}</p>
      ) : null}
      {merchant.menu.length > 0 ? (
        <div className="mt-3">
          <div className="text-label text-sub">菜单</div>
          <div className="mt-1 divide-y divide-line">
            {merchant.menu.map((entry, index) => (
              <div className="flex items-start gap-3 py-2.5" key={`${entry.name}:${index}`}>
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
  );
}

/** 本层图片：平面图（floor.imageUrl）+ 楼层实拍（detail.media 按 floorLevelCode 过滤）。 */
function FloorMedia({ canteen, floor }: { canteen: CanteenView; floor: DiningFloorView }) {
  const photos = floorMediaOf(canteen.placeId, canteen.content, floor.levelCode);
  const items = [
    ...(floor.imageUrl ? [{ url: floor.imageUrl, label: "平面图" }] : []),
    ...photos.map((url, index) => ({ url, label: `实拍图 ${index + 1}` })),
  ];
  if (items.length === 0) return null;
  return (
    <div className="mx-4 mt-3 rounded-2xl bg-surface py-4 shadow-card">
      <div className="px-4">
        <SectionHeader title="本层图片" />
      </div>
      <div className="scrollbar-hidden mt-2 flex gap-2 overflow-x-auto px-4">
        {items.map((item, index) => (
          <div className="shrink-0" key={`${item.url}:${index}`}>
            <ImagePreview
              alt={`${canteen.name} ${levelShortLabel(floor.levelCode)} ${item.label}`}
              buttonClassName="h-28 w-40 rounded-xl"
              imageClassName="h-full w-full rounded-xl object-cover"
              loading={index === 0 ? "eager" : "lazy"}
              src={item.url}
            />
            <div className="mt-1 text-center text-label text-sub">{item.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
