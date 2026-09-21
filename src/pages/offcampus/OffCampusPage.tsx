import { CalendarX2, ChevronRight, Globe, MapPin, Store } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { EmptyState, LoadingState } from "../../components/ui/EmptyState";
import { usePageView } from "../../lib/analytics";
import {
  buildCanteens,
  floorOpenStatus,
  floorStatusLabel,
  levelShortLabel,
  orderCampusKeys,
  periodBarText,
  shanghaiMinutes,
  type CanteenView,
  type DiningFloorView,
  type FloorOpenStatus,
} from "../../lib/dining/schedule";
import { useDiningSchedule, useMerchantStatus, type DiningScheduleState, type MerchantStatusState } from "../../lib/hooks/useDining";
import { useLocatedCampusKey } from "../../lib/hooks/useLocatedCampusKey";
import { useNow } from "../../lib/hooks/useNow";
import { groupMerchantsByPlace } from "../../lib/release/merchants";
import { useRelease } from "../../lib/release/ReleaseContext";
import type { LoadedRelease } from "../../lib/release/mapData";

/** 校内外就餐（D1/D2/D8）。校内 = 校区分组食堂卡片；校外 = 筹备中空态。 */
export function OffCampusPage() {
  const releaseState = useRelease();
  if (releaseState.status === "loading") {
    return (
      <div className="h-full bg-page">
        <LoadingState label="正在加载就餐信息…" />
      </div>
    );
  }
  if (releaseState.status !== "ready") {
    return (
      <div className="h-full bg-page px-5 pt-16">
        <EmptyState
          title={releaseState.status === "error" ? "就餐信息加载失败" : "就餐信息尚未发布"}
          subtitle={releaseState.status === "error" ? "请稍后重试" : undefined}
        />
      </div>
    );
  }
  return <ReadyDiningPage release={releaseState.release} />;
}

function ReadyDiningPage({ release }: { release: LoadedRelease }) {
  usePageView("dining");
  const [scope, setScope] = useState<"campus" | "offcampus">("campus");

  return (
    <div className="flex h-full flex-col bg-page">
      <div className="mx-auto flex h-full w-full max-w-[780px] flex-col">
        <header className="flex items-center justify-between gap-3 bg-surface px-4 pb-3 pt-4">
          <h1 className="text-card">校内外就餐</h1>
          <div className="flex shrink-0 overflow-hidden rounded-full bg-page p-0.5">
            {(
              [
                ["campus", "校内"],
                ["offcampus", "校外"],
              ] as const
            ).map(([value, label]) => (
              <button
                aria-pressed={scope === value}
                className={`flex h-8 items-center rounded-full px-4 text-aux ${
                  scope === value ? "bg-primary text-white" : "text-sub"
                }`}
                key={value}
                onClick={() => setScope(value)}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>
        </header>

        {scope === "offcampus" ? (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState
              icon={<Globe size={26} />}
              title="校外就餐信息筹备中"
              subtitle={"周边美食信息正在整理，\n先看看校内食堂吧！"}
              action={
                <button
                  className="rounded-full bg-primary px-5 py-2.5 text-body font-semibold text-white active:bg-primary-pressed"
                  onClick={() => setScope("campus")}
                  type="button"
                >
                  先看看校内食堂
                </button>
              }
            />
          </div>
        ) : (
          <CampusDining release={release} />
        )}
      </div>
    </div>
  );
}

function CampusDining({ release }: { release: LoadedRelease }) {
  const navigate = useNavigate();
  const scheduleState = useDiningSchedule();
  const merchantStatus = useMerchantStatus();
  const locatedCampus = useLocatedCampusKey(release.campuses);
  const now = useNow(30_000);
  const nowMinutes = shanghaiMinutes(now);

  const canteens = useMemo(
    () => buildCanteens(release.manifest, release.campuses, groupMerchantsByPlace(release.manifest.merchants)),
    [release],
  );
  const schedule = scheduleState.status === "ready" ? scheduleState.schedule : null;

  const campusKeys = useMemo(() => {
    const present = Array.from(new Set(canteens.map((canteen) => canteen.campusKey)));
    return orderCampusKeys(present, locatedCampus);
  }, [canteens, locatedCampus]);

  // 周末/节假日无 arrangement：明确空态，不按工作日猜（worker 注释同口径）。
  const noArrangement = schedule !== null && schedule.dayType !== "weekday" && !schedule.arrangement;

  return (
    <div className="flex-1 overflow-y-auto pb-6">
      {/* 时段条（纯文字无图标） */}
      <div className="px-4 pt-3 text-aux text-sub">
        {scheduleState.status === "ready"
          ? periodBarText(scheduleState.schedule, nowMinutes)
          : scheduleState.status === "loading"
            ? "正在加载就餐时段…"
            : null}
      </div>
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

      {noArrangement ? (
        <div className="mx-4 mt-3 rounded-2xl bg-surface shadow-card">
          <EmptyState
            icon={<CalendarX2 size={24} />}
            title="今日暂无就餐安排信息"
            subtitle="周末/节假日开放安排尚未发布，请以食堂现场公告为准"
          />
        </div>
      ) : canteens.length === 0 ? (
        <div className="mx-4 mt-3 rounded-2xl bg-surface shadow-card">
          <EmptyState title="暂无食堂信息" subtitle="食堂信息正在完善中" />
        </div>
      ) : (
        campusKeys.map((campusKey) => {
          const group = canteens.filter((canteen) => canteen.campusKey === campusKey);
          if (group.length === 0) return null;
          return (
            <CampusGroup
              canteens={group}
              key={campusKey}
              located={campusKey === locatedCampus}
              merchantStatus={merchantStatus}
              nowMinutes={nowMinutes}
              onOpenMap={(placeId) => navigate(`/map?poi=${placeId}`)}
              onOpenDetail={(placeId, floorId) =>
                navigate(`/places/${placeId}/dining${floorId ? `?floor=${floorId}` : ""}`)}
              scheduleState={scheduleState}
            />
          );
        })
      )}
    </div>
  );
}

function CampusGroup({
  canteens,
  located,
  scheduleState,
  merchantStatus,
  nowMinutes,
  onOpenMap,
  onOpenDetail,
}: {
  canteens: CanteenView[];
  located: boolean;
  scheduleState: DiningScheduleState;
  merchantStatus: MerchantStatusState;
  nowMinutes: number;
  onOpenMap: (placeId: string) => void;
  onOpenDetail: (placeId: string, floorId?: string) => void;
}) {
  return (
    <section className="mt-4 px-4">
      <div className="flex items-center gap-2 px-1">
        <h2 className="text-emphasis">{canteens[0].campusLabel}</h2>
        {located ? (
          <span className="rounded-full bg-primary-container px-2 py-0.5 text-label text-primary">当前</span>
        ) : null}
      </div>
      <div className="mt-2 space-y-3">
        {canteens.map((canteen) => (
          <CanteenCard
            canteen={canteen}
            key={canteen.placeId}
            merchantStatus={merchantStatus}
            nowMinutes={nowMinutes}
            onOpenDetail={onOpenDetail}
            onOpenMap={onOpenMap}
            scheduleState={scheduleState}
          />
        ))}
      </div>
    </section>
  );
}

function floorStatusOf(
  canteen: CanteenView,
  floor: DiningFloorView,
  scheduleState: DiningScheduleState,
  nowMinutes: number,
): FloorOpenStatus | null {
  if (scheduleState.status !== "ready") return null;
  return floorOpenStatus({
    dayType: scheduleState.schedule.dayType,
    arrangement: scheduleState.schedule.arrangement,
    floorId: floor.floorId,
    meals: floor.meals,
    periods: scheduleState.schedule.mealPeriods,
    nowMinutes,
    placeClosed: canteen.closed,
  });
}

function CanteenCard({
  canteen,
  scheduleState,
  merchantStatus,
  nowMinutes,
  onOpenMap,
  onOpenDetail,
}: {
  canteen: CanteenView;
  scheduleState: DiningScheduleState;
  merchantStatus: MerchantStatusState;
  nowMinutes: number;
  onOpenMap: (placeId: string) => void;
  onOpenDetail: (placeId: string, floorId?: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-2xl bg-surface shadow-card">
      {/* 卡片头：食堂名 + 地图 pin + ›（本体点击进详情） */}
      <div className="flex items-center gap-1 pl-4 pr-2 pt-1">
        <button
          className="min-w-0 flex-1 py-2.5 text-left text-emphasis text-ink active:text-primary"
          onClick={() => onOpenDetail(canteen.placeId)}
          type="button"
        >
          {canteen.name}
        </button>
        <button
          aria-label={`在地图上查看${canteen.name}`}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-primary active:bg-page"
          onClick={() => onOpenMap(canteen.placeId)}
          type="button"
        >
          <MapPin size={17} />
        </button>
        <button
          aria-label={`查看${canteen.name}详情`}
          className="grid h-9 w-7 shrink-0 place-items-center rounded-full text-sub active:bg-page"
          onClick={() => onOpenDetail(canteen.placeId)}
          type="button"
        >
          <ChevronRight size={17} />
        </button>
      </div>

      {canteen.floors.length === 0 ? (
        <p className="px-4 pb-4 text-aux text-sub">该食堂的楼层信息正在完善中</p>
      ) : (
        <div className="pb-2">
          {canteen.floors.map((floor) => (
            <FloorRow
              canteen={canteen}
              floor={floor}
              key={floor.floorId}
              merchantStatus={merchantStatus}
              nowMinutes={nowMinutes}
              onOpenDetail={onOpenDetail}
              scheduleState={scheduleState}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FloorRow({
  canteen,
  floor,
  scheduleState,
  merchantStatus,
  nowMinutes,
  onOpenDetail,
}: {
  canteen: CanteenView;
  floor: DiningFloorView;
  scheduleState: DiningScheduleState;
  merchantStatus: MerchantStatusState;
  nowMinutes: number;
  onOpenDetail: (placeId: string, floorId?: string) => void;
}) {
  const status = floorStatusOf(canteen, floor, scheduleState, nowMinutes);
  const statusText = status ? floorStatusLabel(status) : null;
  return (
    <button
      className="flex w-full items-start gap-3 px-4 py-2.5 text-left active:bg-page"
      onClick={() => onOpenDetail(canteen.placeId, floor.floorId)}
      type="button"
    >
      <span className="grid h-9 w-10 shrink-0 place-items-center rounded-lg bg-primary-container text-body font-semibold text-primary">
        {levelShortLabel(floor.levelCode)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-body font-semibold text-ink">{floor.displayName}</span>
          {/* 右侧只标例外：正常营业不标注 */}
          {statusText ? <span className="shrink-0 text-aux text-sub">{statusText}</span> : null}
        </span>
        {floor.stallTypes.length > 0 ? (
          <span className="mt-0.5 block truncate text-aux text-sub">{floor.stallTypes.join(" · ")}</span>
        ) : null}
        {floor.merchants.length > 0 ? (
          <span className="mt-1.5 flex flex-wrap gap-1.5">
            {floor.merchants.map((merchant) => {
              const lifecycle = merchantStatus.status === "ready" ? merchantStatus.statuses[merchant.id] : undefined;
              const closed = lifecycle === "temporarily_closed";
              return (
                <span
                  className={`rounded-full px-2.5 py-1 text-label ${
                    closed ? "bg-page text-sub line-through" : "bg-primary-container text-primary"
                  }`}
                  key={merchant.id}
                >
                  <Store className="mr-1 inline-block align-[-2px]" size={11} />
                  {merchant.name}
                  {merchant.openingHours ? ` ${merchant.openingHours}` : ""}
                </span>
              );
            })}
          </span>
        ) : null}
      </span>
    </button>
  );
}
