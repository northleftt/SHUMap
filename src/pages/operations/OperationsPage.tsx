import { CalendarDays, CheckCircle2, Clock, Wrench } from "lucide-react";
import { useParams } from "react-router-dom";
import { EmptyState, LoadingState } from "../../components/ui/EmptyState";
import { PageHeader } from "../../components/ui/PageHeader";
import { StatusPill, type StatusTone } from "../../components/ui/StatusPill";
import { severityOf } from "../../components/ui/SeverityBanner";
import type { OperationalEvent } from "../../lib/api/types";
import { usePageView } from "../../lib/analytics";
import { useNow } from "../../lib/hooks/useNow";
import { useOperations } from "../../lib/hooks/useOperations";
import { releaseFacilitiesForPlace } from "../../lib/release/mapData";
import { useRelease } from "../../lib/release/ReleaseContext";

const EVENT_TYPE_LABELS: Record<OperationalEvent["eventType"], string> = {
  maintenance: "维修",
  activity: "活动",
  notice: "通知",
  closure: "关闭",
};

const SEVERITY_LABELS: Record<OperationalEvent["severity"], string> = {
  info: "通知",
  warning: "警告",
  critical: "严重",
};

const OPERATIONAL_STATUS_LABELS: Record<OperationalEvent["operationalStatus"], string> = {
  active: "进行中",
  scheduled: "已排期",
  resolved: "已解决",
  cancelled: "已取消",
  expired: "已过期",
};

function statusTone(status: OperationalEvent["operationalStatus"]): StatusTone {
  if (status === "active") return "success";
  if (status === "scheduled") return "info";
  return "neutral";
}

function formatDateRange(event: OperationalEvent): string {
  const start = new Date(event.startsAt);
  const fmt = (d: Date) => `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  const end = event.expectedEndsAt ? new Date(event.expectedEndsAt) : null;
  return end ? `${fmt(start)} – ${fmt(end)}` : `${fmt(start)} 起`;
}

/** 「信息更新于 X 前」相对时间。 */
function relativeTime(iso: string, now: number): string {
  const delta = Math.max(0, now - new Date(iso).getTime());
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}

function scheduledPillLabel(event: OperationalEvent): string {
  const start = new Date(event.startsAt);
  return `${start.getMonth() + 1}/${start.getDate()} 开始`;
}

/** M6 运营信息页（按楼宇过滤 targets）。 */
export function OperationsPage() {
  const { placeId = "" } = useParams();
  const operations = useOperations();
  const releaseState = useRelease();
  const now = useNow(60_000);
  usePageView("operations");

  if (releaseState.status === "loading") {
    return (
      <div className="h-full bg-page">
        <LoadingState label="正在加载楼宇信息…" />
      </div>
    );
  }
  if (releaseState.status !== "ready") {
    return (
      <div className="h-full bg-page px-5 pt-16">
        <EmptyState
          title={releaseState.status === "error" ? "楼宇信息加载失败" : "暂无该楼宇信息"}
          subtitle={releaseState.status === "error" ? "请稍后重试" : undefined}
        />
      </div>
    );
  }

  // 楼宇与楼内设施取自发布快照；事件本身是实时数据（useOperations）。
  const place = releaseState.release.manifest.places.find((row) => row.id === placeId) ?? null;
  const facilityIds = new Set(releaseFacilitiesForPlace(releaseState.release.manifest, placeId).map((f) => f.id));

  // targets 命中本楼或楼内设施；空 targets 表示全局事件。
  const matches = (event: OperationalEvent) => {
    if (event.targets.length === 0) return true;
    return event.targets.some(
      (target) =>
        (target.targetType === "place" && target.targetId === placeId) ||
        (target.targetType === "facility" && facilityIds.has(target.targetId)),
    );
  };
  const active = operations.status === "ready" ? operations.activeEvents.filter(matches) : null;
  const ended = operations.status === "ready" ? operations.endedEvents.filter(matches) : null;

  return (
    <div className="flex h-full flex-col bg-page">
      <div className="mx-auto flex h-full w-full max-w-[780px] flex-col">
        <PageHeader title="运营信息" subtitle={place ? place.displayName : undefined} />

        <div className="flex-1 overflow-y-auto px-4 pb-6">
        {operations.status === "loading" ? (
          <LoadingState label="正在加载运营信息…" />
        ) : operations.status === "error" ? (
          <EmptyState
            title="运营信息加载失败"
            subtitle={operations.message}
            action={
              <button type="button" className="rounded-full bg-primary-container px-4 py-2 text-body text-primary" onClick={operations.reload}>
                重新加载
              </button>
            }
          />
        ) : active && ended && active.length === 0 && ended.length === 0 ? (
          <EmptyState title="暂无运营信息" subtitle="该楼宇当前没有进行中或近期的运营事件" />
        ) : (
          <>
            {active && active.length > 0 ? (
              <div className="mt-4">
                <h2 className="text-emphasis">进行中 · {active.length}</h2>
                <div className="mt-2.5 space-y-3">
                  {active.map((event) => {
                    const severity = severityOf(event.severity);
                    const TypeIcon = event.eventType === "activity" ? CalendarDays : Wrench;
                    const typeColor =
                      severity === "warning"
                        ? "text-warning"
                        : severity === "critical"
                          ? "text-error"
                          : "text-primary";
                    const lastUpdate = event.updates[0]?.createdAt ?? event.updatedAt;
                    return (
                      <article key={event.id} className="rounded-2xl bg-surface p-4 shadow-card">
                        <div className="flex items-center justify-between">
                          <div className={`flex items-center gap-1.5 text-aux font-medium ${typeColor}`}>
                            <TypeIcon size={15} />
                            {EVENT_TYPE_LABELS[event.eventType]} · {SEVERITY_LABELS[severity]}
                          </div>
                          <StatusPill tone={statusTone(event.operationalStatus)}>
                            {event.operationalStatus === "scheduled"
                              ? scheduledPillLabel(event)
                              : OPERATIONAL_STATUS_LABELS[event.operationalStatus]}
                          </StatusPill>
                        </div>
                        <h3 className="mt-2 text-card">{event.title}</h3>
                        <div className="mt-1.5 flex items-center gap-1.5 text-aux text-sub">
                          <Clock size={13} />
                          {formatDateRange(event)}
                        </div>
                        {event.description ? (
                          <p className="mt-2 text-body leading-relaxed text-ink">{event.description}</p>
                        ) : null}
                        {event.targets.length > 0 ? (
                          <div className="mt-2.5 flex flex-wrap gap-1.5">
                            {event.targets.map((target, index) => (
                              <span key={index} className="rounded-lg bg-page px-2.5 py-1 text-label text-sub">
                                {target.targetType === "facility" ? "设施" : "楼宇"}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        <div className="mt-3 text-label text-sub">
                          信息更新于 {relativeTime(lastUpdate, now)}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {ended && ended.length > 0 ? (
              <div className="mt-5">
                <h2 className="text-emphasis">已结束</h2>
                <div className="mt-2.5 overflow-hidden rounded-2xl bg-surface shadow-card">
                  {ended.map((event, index) => (
                    <div
                      key={event.id}
                      className={`flex items-start gap-2.5 px-4 py-3.5 ${index > 0 ? "border-t border-line" : ""}`}
                    >
                      <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-success" />
                      <div className="min-w-0">
                        <div className="text-body font-medium text-ink">{event.title}</div>
                        <div className="mt-0.5 text-aux text-sub">
                          {new Date(event.resolvedAt ?? event.updatedAt).toLocaleDateString("zh-CN")} ·{" "}
                          {OPERATIONAL_STATUS_LABELS[event.operationalStatus]}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}
        </div>
      </div>
    </div>
  );
}
