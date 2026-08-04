import { Plus, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import * as admin from "../../lib/api/admin";
import { ApiError } from "../../lib/api/client";
import { useAuth } from "../AuthContext";
import type { FacilityListItem, MerchantListItem, PlaceListItem, SpacesResponse } from "../adminTypes";
import {
  Chip,
  EditorialPill,
  EmptyState,
  ErrorBanner,
  GhostButton,
  InfoNote,
  LoadingState,
  Pill,
  Panel,
  PrimaryButton,
  type Tone,
  errorMessage,
  fmtDateTime,
  useAsyncData,
} from "../components/primitives";

// ---------------------------------------------------------------------------
// A2 内容管理（地点 / 设施 / 商户 合并表格）
// ---------------------------------------------------------------------------

type Tab = "places" | "facilities" | "merchants";

const TAB_LABELS: Record<Tab, string> = { places: "地点", facilities: "设施", merchants: "商户" };

const STATUS_FILTERS = [
  { key: "all", label: "全部" },
  { key: "draft", label: "草稿" },
  { key: "in_review", label: "待审核" },
  { key: "approved", label: "已发布" },
] as const;

/**
 * 生命周期与编辑状态是两件事：编辑状态说的是「这次改动审到哪一步」，生命周期说的
 * 是「这个东西现在还在不在」。同一行两个 pill，因为一个已发布的地点也可能已停用。
 */
const LIFECYCLE_LABELS: Record<string, string> = {
  planned: "筹建中",
  active: "启用",
  temporarily_closed: "暂时关闭",
  retired: "已停用",
};

const LIFECYCLE_TONE: Record<string, Tone> = {
  planned: "info",
  active: "ok",
  temporarily_closed: "warning",
  retired: "neutral",
};

function LifecyclePill({ status }: { status: string | null | undefined }) {
  const key = status ?? "active";
  return <Pill tone={LIFECYCLE_TONE[key] ?? "neutral"}>{LIFECYCLE_LABELS[key] ?? key}</Pill>;
}

/**
 * 409 的机器码翻成能照着做的话。删除受阻时后端一律指向「改用停用」，这里照搬那个
 * 建议，别让人对着 place_in_use 猜。
 */
const ERROR_TEXT: Record<string, string> = {
  place_in_use: "这个地点下面还挂着东西（下级地点 / 设施 / 商户 / 校车站点 / 楼层 / 供稿）。先把它们移走，或者直接停用这个地点。",
  place_released: "这个地点已经进过发布版本，删掉会让历史版本指向不存在的数据。改用停用。",
  facility_in_use: "还有供稿或运营事件指着这个设施。先处理掉它们，或者直接停用。",
  facility_released: "这个设施已经进过发布版本，删掉会让历史版本指向不存在的数据。改用停用。",
};

function describeActionError(error: unknown, fallback: string): string {
  const code = error instanceof ApiError ? error.code : null;
  return (code && ERROR_TEXT[code]) || errorMessage(error, fallback);
}

export function ContentPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission("write:content");
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "places";
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [query, setQuery] = useState(params.get("q") ?? "");

  const [actionBusy, setActionBusy] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionNotice, setActionNotice] = useState("");

  const { state, reload } = useAsyncData(async (signal) => {
    const [spaces, places, facilities, merchants] = await Promise.all([
      admin.listSpaces<SpacesResponse>(signal),
      admin.listAdminPlaces<PlaceListItem>(signal),
      admin.listFacilities<FacilityListItem>(signal),
      admin.listMerchants<MerchantListItem>(signal),
    ]);
    return { spaces, places: places.items, facilities: facilities.items, merchants: merchants.items };
  }, []);

  /** 三种实体的停用与删除共用一条通道：跑完都重新拉列表，状态 pill 才不会说谎。 */
  async function runAction(rowId: string, label: string, action: () => Promise<unknown>) {
    setActionBusy(rowId);
    setActionError("");
    setActionNotice("");
    try {
      await action();
      setActionNotice(label);
      reload();
    } catch (error) {
      setActionError(describeActionError(error, "操作失败"));
    } finally {
      setActionBusy("");
    }
  }

  const campusName = useMemo(() => {
    const map = new Map<string, string>();
    if (state.status === "ready") for (const c of state.data!.spaces.campuses) map.set(c.id, c.name.replace("校区", ""));
    return (id: string | null | undefined) => (id ? (map.get(id) ?? "—") : "—");
  }, [state]);

  const placeName = useMemo(() => {
    const map = new Map<string, string>();
    if (state.status === "ready") for (const p of state.data!.places) map.set(p.id, p.displayName ?? p.id);
    return (id: string | null | undefined) => (id ? (map.get(id) ?? "—") : "—");
  }, [state]);

  if (state.status === "loading") return <LoadingState label="加载内容…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  const data = state.data!;

  // 三种实体的停用与删除接口不同，但行为一致，所以每行自带自己的两个动作，
  // 表格只管画按钮。商户没有删除端点（历史上只做了 lifecycle），deletable 为 false。
  const rows: Array<{
    id: string;
    name: string;
    type: string;
    campus: string;
    status: string;
    lifecycle: string;
    updatedAt: string;
    to: string;
    retire: (() => Promise<unknown>) | null;
    remove: (() => Promise<unknown>) | null;
  }> =
    tab === "places"
      ? data.places.map((p) => ({
          id: p.id,
          name: p.displayName ?? p.id,
          type: p.kindName,
          campus: campusName(p.campusId),
          status: p.editorialStatus ?? "draft",
          lifecycle: p.lifecycleStatus,
          updatedAt: p.updatedAt,
          to: `/admin/content/places/${p.id}`,
          retire: () => admin.updatePlaceLifecycle(p.id, "retired"),
          remove: () => admin.deletePlace(p.id),
        }))
      : tab === "facilities"
        ? data.facilities.map((f) => ({
            id: f.id,
            name: String(f.displayName ?? f.facilityTypeName ?? f.id),
            type: String(f.facilityTypeName ?? f.facilityTypeId ?? "—"),
            campus: placeName(f.hostPlaceId),
            status: f.editorialStatus ?? "draft",
            lifecycle: String(f.lifecycleStatus ?? "active"),
            updatedAt: String(f.lastVerifiedAt ?? ""),
            to: `/admin/content/facilities/${f.id}`,
            retire: () => admin.updateFacilityLifecycle(f.id, "retired"),
            remove: () => admin.deleteFacility(f.id),
          }))
        : data.merchants.map((m) => ({
            id: m.id,
            name: String(m.displayName ?? m.id),
            type: String(m.businessType ?? "—"),
            campus: placeName(m.hostPlaceId),
            status: m.editorialStatus ?? "draft",
            lifecycle: String(m.lifecycleStatus ?? "active"),
            updatedAt: String(m.updatedAt ?? ""),
            to: `/admin/content/merchants/${m.id}`,
            retire: () => admin.updateMerchantLifecycle(m.id, "retired"),
            remove: null,
          }));

  const q = query.trim().toLowerCase();
  const searched = q ? rows.filter((r) => `${r.name} ${r.type} ${r.id}`.toLowerCase().includes(q)) : rows;
  const filtered = statusFilter === "all" ? searched : searched.filter((r) => r.status === statusFilter);
  const countOf = (key: string) => (key === "all" ? searched.length : searched.filter((r) => r.status === key).length);

  return (
    <div className="space-y-4">
      {/* 页签 */}
      <div className="flex gap-1 rounded-xl bg-track p-1 self-start w-fit">
        {(Object.keys(TAB_LABELS) as Tab[]).map((key) => (
          <button
            key={key}
            className={`h-8 rounded-lg px-5 text-body font-medium transition-colors ${
              tab === key ? "bg-surface text-ink shadow-sm" : "text-sub hover:text-ink"
            }`}
            onClick={() => {
              setParams(key === "places" ? {} : { tab: key });
              setStatusFilter("all");
            }}
            type="button"
          >
            {TAB_LABELS[key]}
          </button>
        ))}
      </div>

      {/* 状态 chips + 搜索 + 新建 */}
      <div className="flex items-center gap-2">
        {STATUS_FILTERS.map((filter) => (
          <Chip key={filter.key} active={statusFilter === filter.key} onClick={() => setStatusFilter(filter.key)}>
            {filter.label} {countOf(filter.key)}
          </Chip>
        ))}
        <div className="flex-1" />
        <div className="relative w-[220px]">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sub" />
          <input
            className="h-9 w-full rounded-lg bg-surface pl-8 pr-3 text-body outline-none placeholder:text-sub"
            placeholder={`搜索${TAB_LABELS[tab]}…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {canWrite ? (
          <Link to={tab === "places" ? "/admin/content/places/new" : tab === "facilities" ? "/admin/content/facilities/new" : "/admin/content/merchants/new"}>
            <PrimaryButton>
              <Plus size={15} /> 新建{TAB_LABELS[tab]}
            </PrimaryButton>
          </Link>
        ) : null}
      </div>

      {actionError ? <ErrorBanner message={actionError} /> : null}
      {actionNotice ? <InfoNote tone="info">{actionNotice}</InfoNote> : null}

      {/* 表格 */}
      <Panel padded={false}>
        <table className="w-full border-collapse text-left text-body">
          <thead>
            <tr className="text-label text-sub">
              <th className="px-5 pb-2 pt-4 font-medium">名称</th>
              <th className="px-5 pb-2 pt-4 font-medium">{tab === "places" ? "类型" : tab === "facilities" ? "类型" : "分类"}</th>
              <th className="px-5 pb-2 pt-4 font-medium">{tab === "places" ? "校区" : "所在地点"}</th>
              <th className="px-5 pb-2 pt-4 font-medium">编辑状态</th>
              <th className="px-5 pb-2 pt-4 font-medium">状态</th>
              <th className="px-5 pb-2 pt-4 font-medium">更新时间</th>
              <th className="px-5 pb-2 pt-4 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {filtered.map((row) => {
              const busy = actionBusy === row.id;
              const retired = row.lifecycle === "retired";
              return (
              <tr key={row.id}>
                <td className="px-5 py-3.5 font-medium text-ink">{row.name}</td>
                <td className="px-5 py-3.5 text-sub">{row.type}</td>
                <td className="px-5 py-3.5 text-sub">{row.campus}</td>
                <td className="px-5 py-3.5"><EditorialPill status={row.status} /></td>
                <td className="px-5 py-3.5"><LifecyclePill status={row.lifecycle} /></td>
                <td className="px-5 py-3.5 text-sub">{row.updatedAt ? fmtDateTime(row.updatedAt) : "—"}</td>
                <td className="px-5 py-3.5">
                  <div className="flex items-center justify-end gap-2">
                    <Link className="text-aux font-medium text-primary" to={canWrite ? row.to : `/admin/content?tab=${tab}`}>
                      {canWrite && row.status !== "in_review" ? "编辑 ›" : "查看 ›"}
                    </Link>
                    {/* 停用是首选：它保留历史与审计线索，而删除会把修订一起级联掉。
                        所以删除只在旁边、只对没人引用过的数据生效（否则后端回 409）。 */}
                    {canWrite && row.retire ? (
                      <GhostButton
                        disabled={busy || retired}
                        onClick={() => void runAction(row.id, `已停用「${row.name}」`, row.retire!)}
                        title={retired ? "已经是停用状态" : "从地图与搜索里下架，保留数据与历史"}
                      >
                        停用
                      </GhostButton>
                    ) : null}
                    {canWrite && row.remove ? (
                      <GhostButton
                        danger
                        disabled={busy}
                        onClick={() => {
                          if (!window.confirm(`删除「${row.name}」？只有没被任何东西引用、也没进过发布版本的数据才能删。想下架请用「停用」。`)) return;
                          void runAction(row.id, `已删除「${row.name}」`, row.remove!);
                        }}
                        title="彻底删除，仅限建错的数据"
                      >
                        <Trash2 size={14} />
                      </GhostButton>
                    ) : null}
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 ? <div className="p-5"><EmptyState label={`暂无${TAB_LABELS[tab]}`} /></div> : null}
        <p className="px-5 pb-4 pt-3 text-right text-label text-sub">共 {filtered.length} 条</p>
      </Panel>
    </div>
  );
}
