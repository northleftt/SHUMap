import { CalendarDays, CircleAlert, Plus, Wrench } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import * as admin from "../../lib/api/admin";
import { useAuth } from "../AuthContext";
import type { CampaignRow, OperationalEventRow } from "../adminTypes";
import {
  Chip,
  EditorialPill,
  EmptyState,
  ErrorBanner,
  EVENT_TYPE_LABELS,
  LoadingState,
  OPERATIONAL_STATUS_LABELS,
  OPERATIONAL_STATUS_TONE,
  Panel,
  Pill,
  PrimaryButton,
  SEVERITY_LABELS,
  fmtDay,
  useAsyncData,
} from "../components/primitives";

// ---------------------------------------------------------------------------
// A4 运营信息管理
// ---------------------------------------------------------------------------

const STATUS_FILTERS = [
  { key: "all", label: "全部" },
  { key: "active", label: "进行中" },
  { key: "review", label: "待审核" },
  { key: "scheduled", label: "已排期" },
  { key: "ended", label: "已结束" },
] as const;

function matchesFilter(event: OperationalEventRow, filter: string): boolean {
  if (filter === "all") return true;
  if (filter === "review") return event.editorialStatus === "draft" || event.editorialStatus === "in_review";
  if (filter === "active") return event.operationalStatus === "active";
  if (filter === "scheduled") return event.operationalStatus === "scheduled" && event.editorialStatus === "approved";
  return event.operationalStatus === "resolved" || event.operationalStatus === "expired" || event.operationalStatus === "cancelled";
}

const SEVERITY_BAR: Record<string, string> = {
  info: "bg-primary",
  warning: "bg-warning",
  critical: "bg-error",
};

export function OperationsPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission("write:content");
  const [filter, setFilter] = useState<string>("all");
  const events = useAsyncData((signal) => admin.listAdminOperations<OperationalEventRow>(signal), []);
  const campaigns = useAsyncData((signal) => admin.listAdminCampaigns<CampaignRow>(signal), []);

  if (events.state.status === "loading") return <LoadingState label="加载运营事件…" />;
  if (events.state.status === "error") return <ErrorBanner message={events.state.message ?? "加载失败"} />;
  const items = events.state.data!.items;
  const visible = items.filter((e) => matchesFilter(e, filter));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {STATUS_FILTERS.map((f) => (
          <Chip key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)}>
            {f.label} {f.key === "all" ? items.length : items.filter((e) => matchesFilter(e, f.key)).length}
          </Chip>
        ))}
        <div className="flex-1" />
        {canWrite ? (
          <Link to="/admin/operations/new">
            <PrimaryButton>
              <Plus size={15} /> 新建运营事件
            </PrimaryButton>
          </Link>
        ) : null}
      </div>

      <div className="space-y-3">
        {visible.map((event) => {
          const pending = event.editorialStatus === "draft" || event.editorialStatus === "in_review";
          const ended = event.operationalStatus === "resolved" || event.operationalStatus === "expired" || event.operationalStatus === "cancelled";
          const TypeIcon = event.eventType === "activity" ? CalendarDays : event.eventType === "closure" ? CircleAlert : Wrench;
          const iconColor = event.severity === "critical" ? "text-error" : event.severity === "warning" ? "text-warning" : "text-primary";
          return (
            <div key={event.id} className="flex overflow-hidden rounded-xl bg-surface">
              <span className={`w-1 shrink-0 ${SEVERITY_BAR[event.severity] ?? "bg-primary"}`} />
              <div className="flex flex-1 items-center gap-4 px-5 py-4">
                <div className="min-w-0 flex-1">
                  <div className={`flex items-center gap-1.5 text-aux font-medium ${iconColor}`}>
                    <TypeIcon size={14} />
                    {EVENT_TYPE_LABELS[event.eventType] ?? event.eventType} · {SEVERITY_LABELS[event.severity] ?? event.severity}
                  </div>
                  <p className="mt-1 text-emphasis">{event.title}</p>
                  <p className="mt-0.5 text-aux text-sub">
                    {fmtDay(event.startsAt)} 起{event.expectedEndsAt ? ` · 预计 ${fmtDay(event.expectedEndsAt)} 恢复` : ""}
                  </p>
                </div>
                {pending ? (
                  <EditorialPill status={event.editorialStatus} />
                ) : (
                  <Pill tone={OPERATIONAL_STATUS_TONE[event.operationalStatus] ?? "neutral"}>
                    {OPERATIONAL_STATUS_LABELS[event.operationalStatus] ?? event.operationalStatus}
                  </Pill>
                )}
                <div className="shrink-0 text-aux font-medium">
                  <div className="flex items-center gap-3">
                    {pending ? (
                      <Link className="text-primary" to="/admin/review">去审核 ›</Link>
                    ) : ended ? (
                      <Link className="text-primary" to={`/admin/operations/${event.id}`}>查看 ›</Link>
                    ) : (
                      <Link className="text-primary" to={`/admin/operations/${event.id}`}>更新进展 ›</Link>
                    )}
                    {canWrite && !ended ? (
                      <Link className="text-primary" to={`/admin/operations/${event.id}/edit`}>编辑 ›</Link>
                    ) : null}
                    {canWrite ? (
                      <button
                        className="text-error"
                        onClick={() => {
                          if (!window.confirm(`确定删除运营事件「${event.title}」？该操作不可恢复。`)) return;
                          void admin.deleteOperation(event.id).then(() => events.reload()).catch(() => window.alert("删除失败，请稍后重试"));
                        }}
                        type="button"
                      >
                        删除 ›
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        {visible.length === 0 ? <EmptyState label="该状态下暂无运营事件" /> : null}
      </div>

      <Panel
        title="活动推广（campaigns）"
        action={<span className="text-aux text-sub">新建推广 ›</span>}
        padded={false}
      >
        {campaigns.state.status === "loading" ? (
          <div className="p-5"><LoadingState label="加载活动…" /></div>
        ) : campaigns.state.status === "error" ? (
          <div className="p-5"><ErrorBanner message={campaigns.state.message ?? "加载失败"} /></div>
        ) : (
          <div className="grid grid-cols-2 gap-3 p-5">
            {campaigns.state.data!.items.map((campaign) => (
              <div key={campaign.id} className="rounded-lg bg-page p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-body font-semibold text-ink">{campaign.title}</p>
                  <Pill tone={campaign.lifecycleStatus === "active" ? "ok" : "neutral"}>
                    {campaign.lifecycleStatus === "active" ? "进行中" : campaign.lifecycleStatus === "scheduled" ? "草稿" : "已结束"}
                  </Pill>
                </div>
                <p className="mt-1.5 text-aux text-sub">{fmtDay(campaign.startsAt)} → {fmtDay(campaign.endsAt)}</p>
              </div>
            ))}
            {campaigns.state.data!.items.length === 0 ? <p className="col-span-2"><EmptyState label="暂无活动" /></p> : null}
          </div>
        )}
      </Panel>
    </div>
  );
}
