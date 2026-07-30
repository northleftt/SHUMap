import { ArrowRight, CirclePlus, Rocket } from "lucide-react";
import { Link } from "react-router-dom";
import * as admin from "../../lib/api/admin";
import { getCurrentRelease } from "../../lib/api/public";
import type { ReleaseManifest } from "../../lib/api/types";
import type {
  FacilityListItem,
  MerchantListItem,
  OperationalEventRow,
  PlaceListItem,
  SpacesResponse,
  SubmissionRow,
} from "../adminTypes";
import {
  EmptyState,
  ErrorBanner,
  LoadingState,
  Panel,
  Pill,
  fmtDateTime,
  fmtRelative,
  useAsyncData,
} from "../components/primitives";

// ---------------------------------------------------------------------------
// A1 概览
// ---------------------------------------------------------------------------

interface OverviewData {
  spaces: SpacesResponse;
  places: PlaceListItem[];
  facilities: FacilityListItem[];
  merchants: MerchantListItem[];
  submissions: SubmissionRow[];
  operations: OperationalEventRow[];
  release: ReleaseManifest | null;
}

interface TodoItem {
  key: string;
  type: string;
  title: string;
  at: string;
}

/** 用户提交的目标类型 → 中文，避免界面上出现原始编码。 */
const TARGET_TYPE_LABELS: Record<string, string> = {
  place: "地点",
  new_place: "新地点",
  facility: "设施",
  merchant_outlet: "商户",
  transit_stop: "校车站点",
};

function targetTypeLabel(targetType: string): string {
  return TARGET_TYPE_LABELS[targetType] ?? "其他";
}

export function OverviewPage() {
  const { state } = useAsyncData<OverviewData>(async (signal) => {
    const [spaces, places, facilities, merchants, submissions, operations, release] = await Promise.all([
      admin.listSpaces<SpacesResponse>(signal),
      admin.listAdminPlaces<PlaceListItem>(signal),
      admin.listFacilities<FacilityListItem>(signal),
      admin.listMerchants<MerchantListItem>(signal),
      admin.listSubmissions(signal),
      admin.listAdminOperations<OperationalEventRow>(signal).catch(() => ({ items: [] as OperationalEventRow[] })),
      getCurrentRelease(signal).catch(() => null),
    ]);
    return {
      spaces,
      places: places.items,
      facilities: facilities.items,
      merchants: merchants.items,
      submissions: submissions.items,
      operations: operations.items,
      release,
    };
  }, []);

  if (state.status === "loading") return <LoadingState label="加载总览…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  const data = state.data!;

  const inReviewPlaces = data.places.filter((p) => p.editorialStatus === "in_review");
  const inReviewFacilities = data.facilities.filter((f) => f.editorialStatus === "in_review");
  const inReviewMerchants = data.merchants.filter((m) => m.editorialStatus === "in_review");
  const pendingSubmissions = data.submissions.filter((s) => s.status === "pending" || s.status === "in_review");
  const activeOperations = data.operations.filter((e) => e.operationalStatus === "active" || e.operationalStatus === "scheduled");

  const reviewCount = inReviewPlaces.length + inReviewFacilities.length + inReviewMerchants.length;
  const oldestSubmission = pendingSubmissions.reduce<string | null>(
    (min, s) => (min === null || s.createdAt < min ? s.createdAt : min),
    null,
  );
  const waitDays = oldestSubmission ? Math.max(0, Math.floor((Date.now() - new Date(oldestSubmission).getTime()) / 86_400_000)) : 0;

  const todos: TodoItem[] = [
    ...inReviewFacilities.map((f): TodoItem => ({ key: `f:${f.id}`, type: "设施", title: String(f.displayName ?? f.id), at: String(f.lastVerifiedAt ?? "") })),
    ...inReviewPlaces.map((p): TodoItem => ({ key: `p:${p.id}`, type: "地点", title: p.displayName ?? p.id, at: p.updatedAt })),
    ...data.operations
      .filter((e) => e.editorialStatus === "draft" || e.editorialStatus === "in_review")
      .map((e): TodoItem => ({ key: `o:${e.id}`, type: "运营", title: e.title, at: e.createdAt })),
    ...pendingSubmissions.map((s): TodoItem => ({ key: `s:${s.id}`, type: "提交", title: `${targetTypeLabel(s.targetType)}反馈`, at: s.createdAt })),
    ...inReviewMerchants.map((m): TodoItem => ({ key: `m:${m.id}`, type: "商户", title: String(m.displayName ?? m.id), at: String(m.updatedAt ?? "") })),
  ]
    .sort((a, b) => (a.at > b.at ? -1 : 1))
    .slice(0, 6);

  // 最近动态：无动态流 API，用现有列表时间戳近似推导
  const activity = [
    ...(data.release
      ? [{ key: "rel", dot: "bg-success", text: `发布了 ${data.release.release.version}`, at: data.release.release.createdAt }]
      : []),
    ...data.submissions.slice(0, 4).map((s) => ({
      key: `sub:${s.id}`,
      dot: "bg-primary",
      text: `${s.submitterName || "用户"} 提交了「${targetTypeLabel(s.targetType)}」反馈`,
      at: s.createdAt,
    })),
    ...data.operations.slice(0, 2).map((e) => ({
      key: `op:${e.id}`,
      dot: "bg-sub",
      text: `运营事件「${e.title}」${e.editorialStatus === "approved" ? "已通过审核" : "待审核"}`,
      at: e.createdAt,
    })),
  ]
    .sort((a, b) => (a.at > b.at ? -1 : 1))
    .slice(0, 6);

  const statCards = [
    {
      label: "当前发布版本",
      value: data.release ? data.release.release.version : "—",
      sub: data.release ? `已上线 · ${fmtDateTime(data.release.release.createdAt)}` : "尚无已发布版本",
      subClass: "text-success",
      dot: true,
    },
    {
      label: "待审核修订",
      value: String(reviewCount),
      sub: `地点 ${inReviewPlaces.length} · 设施 ${inReviewFacilities.length} · 商户 ${inReviewMerchants.length}`,
      subClass: reviewCount > 0 ? "text-warning" : "text-sub",
      dot: false,
    },
    {
      label: "进行中运营事件",
      value: String(activeOperations.length),
      sub: `维修 ${activeOperations.filter((e) => e.eventType === "maintenance").length} · 活动 ${activeOperations.filter((e) => e.eventType === "activity").length}`,
      subClass: "text-sub",
      dot: false,
    },
    {
      label: "待处理用户提交",
      value: String(pendingSubmissions.length),
      sub: pendingSubmissions.length > 0 ? `最早已等待 ${waitDays} 天` : "无待处理提交",
      subClass: pendingSubmissions.length > 0 ? "text-warning" : "text-sub",
      dot: false,
    },
  ];

  return (
    <div className="space-y-4">
      {/* 指标卡 */}
      <div className="grid grid-cols-4 gap-4">
        {statCards.map((card) => (
          <div key={card.label} className="rounded-xl bg-surface p-4">
            <p className="text-aux text-sub">{card.label}</p>
            <p className="mt-2 text-title">{card.value}</p>
            <p className={`mt-1.5 flex items-center gap-1.5 text-aux ${card.subClass}`}>
              {card.dot ? <span className="h-1.5 w-1.5 rounded-full bg-success" /> : null}
              {card.sub}
            </p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-[1fr_380px] gap-4">
        {/* 待办事项 */}
        <Panel
          title="待办事项"
          action={
            <Link className="flex items-center gap-0.5 text-aux font-medium text-primary" to="/admin/review">
              前往审核中心 <ArrowRight size={13} />
            </Link>
          }
          padded={false}
        >
          <div className="divide-y divide-line px-5 pb-2">
            {todos.map((todo) => (
              <div key={todo.key} className="flex items-center gap-3 py-3">
                <Pill>{todo.type}</Pill>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body font-medium text-ink">{todo.title}</p>
                  <p className="text-label text-sub">{fmtRelative(todo.at)}</p>
                </div>
                <Link className="shrink-0 text-aux font-medium text-primary" to="/admin/review">
                  去审核 ›
                </Link>
              </div>
            ))}
            {todos.length === 0 ? <div className="py-2"><EmptyState label="暂无待办，所有内容均已处理" /></div> : null}
          </div>
        </Panel>

        {/* 最近动态 */}
        <Panel title="最近动态" padded={false}>
          <div className="space-y-3.5 px-5 pb-5 pt-1">
            {activity.map((item) => (
              <div key={item.key} className="flex gap-2.5">
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${item.dot}`} />
                <div className="min-w-0">
                  <p className="text-body text-ink">{item.text}</p>
                  <p className="text-label text-sub">{fmtRelative(item.at)}</p>
                </div>
              </div>
            ))}
            {activity.length === 0 ? <EmptyState label="暂无动态" /> : null}
          </div>
        </Panel>

        {/* 快捷操作 */}
        <Panel title="快捷操作">
          <div className="flex gap-3">
            <Link
              className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-line text-body font-medium text-primary"
              to="/admin/operations/new"
            >
              <CirclePlus size={15} /> 新建运营事件
            </Link>
            <Link
              className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-line text-body font-medium text-primary"
              to="/admin/content/places/new"
            >
              <CirclePlus size={15} /> 新建地点
            </Link>
            <Link
              className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-line text-body font-medium text-primary"
              to="/admin/releases"
            >
              <Rocket size={15} /> 发布新版本
            </Link>
          </div>
        </Panel>

        {/* 内容总量 */}
        <Panel title="内容总量">
          <div className="grid grid-cols-4">
            {[
              { label: "地点", value: data.places.length },
              { label: "设施", value: data.facilities.length },
              { label: "商户", value: data.merchants.length },
              { label: "校区", value: data.spaces.campuses.length },
            ].map((item) => (
              <div key={item.label}>
                <p className="text-title text-primary">{item.value}</p>
                <p className="mt-1 text-aux text-sub">{item.label}</p>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
