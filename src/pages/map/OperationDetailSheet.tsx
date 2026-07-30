import { Ban, CalendarDays, ChevronRight, Clock, Info, MapPin, Wrench, X, type LucideIcon } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { SheetModal } from "../../components/ui/SheetModal";
import { SeverityIcon, severityOf, type Severity } from "../../components/ui/SeverityBanner";
import { StatusPill, type StatusTone } from "../../components/ui/StatusPill";
import type { OperationalEvent } from "../../lib/api/types";
import { useRelease } from "../../lib/release/ReleaseContext";

const TYPE_LABELS: Record<string, string> = {
  closure: "关闭",
  maintenance: "维修",
  activity: "活动",
  notice: "通知",
};

const TYPE_ICONS: Record<string, LucideIcon> = {
  closure: Ban,
  maintenance: Wrench,
  activity: CalendarDays,
  notice: Info,
};

const SEVERITY_LABELS: Record<Severity, string> = {
  info: "通知",
  warning: "警告",
  critical: "严重",
};

const SEVERITY_TONES: Record<Severity, StatusTone> = {
  info: "info",
  warning: "warning",
  critical: "error",
};

const STATUS_LABELS: Record<string, string> = {
  active: "进行中",
  scheduled: "已排期",
  resolved: "已解决",
  cancelled: "已取消",
  expired: "已过期",
};

function statusTone(status: string): StatusTone {
  if (status === "active") return "success";
  if (status === "scheduled") return "info";
  return "neutral";
}

function formatDay(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 起止时间：有结束时间显示区间，否则「起 · 长期」。 */
function formatDateRange(event: OperationalEvent): string {
  const start = formatDay(event.startsAt);
  if (!start) return "时间待定";
  const end = event.expectedEndsAt ? formatDay(event.expectedEndsAt) : null;
  return end ? `${start} - ${end}` : `${start} 起 · 长期`;
}

/**
 * 事件详情卡：地图事件摘要的「查看详情」落地页。
 * 移动端走底部弹卡，桌面端居中浮层；数据来自已加载的事件，不额外请求。
 */
export function OperationDetailSheet({
  event,
  variant = "sheet",
  onClose,
}: {
  event: OperationalEvent | null;
  /** sheet = 移动端底部弹卡；panel = 桌面端居中浮层 */
  variant?: "sheet" | "panel";
  onClose: () => void;
}) {
  if (variant === "panel") {
    if (!event) return null;
    return (
      <div className="fixed inset-0 z-50">
        <div className="absolute inset-0 bg-ink/40" onClick={onClose} />
        {/* 关闭钮挂在不滚动的外层，内容再长也保持可见 */}
        <div className="absolute left-1/2 top-1/2 flex max-h-[80%] w-[420px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl bg-surface shadow-floating">
          <button
            type="button"
            aria-label="关闭事件详情"
            className="absolute right-4 top-4 z-10 grid h-8 w-8 place-items-center rounded-full bg-page text-sub"
            onClick={onClose}
          >
            <X size={15} />
          </button>
          <div className="min-h-0 flex-1 overflow-y-auto pt-4">
            <OperationDetailContent event={event} onNavigate={onClose} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <SheetModal open={event !== null} onClose={onClose} expandable initialHeight={0.62}>
      {event ? <OperationDetailContent event={event} onNavigate={onClose} /> : null}
    </SheetModal>
  );
}

function OperationDetailContent({ event, onNavigate }: { event: OperationalEvent; onNavigate: () => void }) {
  const navigate = useNavigate();
  const { release } = useRelease();
  const severity = severityOf(event.severity);
  const TypeIcon = TYPE_ICONS[event.eventType] ?? Info;
  const typeLabel = TYPE_LABELS[event.eventType] ?? "通知";
  const targets = event.targets ?? [];
  const placeTargets = targets.filter((target) => target.targetType === "place");
  const facilityTargetCount = targets.filter((target) => target.targetType === "facility").length;
  const updates = event.updates ?? [];

  const placeName = (placeId: string) =>
    release?.buildings.find((building) => building.poiKey === placeId)?.name ?? "关联地点";

  const openPlace = (placeId: string) => {
    onNavigate();
    navigate(`/places/${placeId}/operations`);
  };

  return (
    <div className="px-5 pb-8 pt-1">
      <div className="flex items-center gap-2 pr-10">
        <StatusPill tone={SEVERITY_TONES[severity]}>
          <TypeIcon size={12} className="mr-1" />
          {typeLabel}
        </StatusPill>
        <StatusPill tone={statusTone(event.operationalStatus)}>
          {STATUS_LABELS[event.operationalStatus] ?? event.operationalStatus}
        </StatusPill>
      </div>

      <h2 className="mt-2.5 text-detail">{event.title}</h2>

      <div className="mt-3 divide-y divide-line">
        <div className="flex items-center gap-3 py-3">
          <Clock size={17} className="shrink-0 text-sub" />
          <span className="flex-1 text-body text-ink">时间</span>
          <span className="text-body text-ink">{formatDateRange(event)}</span>
        </div>
        <div className="flex items-center gap-3 py-3">
          <SeverityIcon severity={severity} size={17} />
          <span className="flex-1 text-body text-ink">影响程度</span>
          <span className="text-body text-ink">{SEVERITY_LABELS[severity]}</span>
        </div>
      </div>

      {event.description ? (
        <p className="mt-3 whitespace-pre-line text-body leading-relaxed text-ink">{event.description}</p>
      ) : (
        <p className="mt-3 text-aux text-sub">暂无更多说明</p>
      )}

      {placeTargets.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-emphasis">影响范围</h3>
          <div className="mt-2 divide-y divide-line overflow-hidden rounded-2xl bg-page">
            {placeTargets.map((target) => (
              <button
                key={`${target.targetType}:${target.targetId}`}
                type="button"
                className="flex w-full items-center gap-2.5 px-3.5 py-3 text-left active:bg-line"
                onClick={() => openPlace(target.targetId)}
              >
                <MapPin size={16} className="shrink-0 text-primary" />
                <span className="min-w-0 flex-1 truncate text-body font-medium text-ink">
                  {placeName(target.targetId)}
                </span>
                <ChevronRight size={15} className="shrink-0 text-sub" />
              </button>
            ))}
          </div>
          {facilityTargetCount > 0 ? (
            <p className="mt-2 text-aux text-sub">另涉及 {facilityTargetCount} 处楼内设施</p>
          ) : null}
        </div>
      ) : facilityTargetCount > 0 ? (
        <p className="mt-4 text-aux text-sub">涉及 {facilityTargetCount} 处楼内设施</p>
      ) : (
        <p className="mt-4 text-aux text-sub">影响范围以地图上标注的区域为准</p>
      )}

      {updates.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-emphasis">进展</h3>
          <div className="mt-2 space-y-2.5">
            {updates.map((update) => (
              <div key={update.id} className="rounded-2xl bg-page px-3.5 py-3">
                <div className="text-aux text-sub">{formatDay(update.createdAt) ?? ""}</div>
                <p className="mt-0.5 text-body leading-relaxed text-ink">{update.message}</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
