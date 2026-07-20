import { Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import * as admin from "../../lib/api/admin";
import { useAuth } from "../AuthContext";
import type { FacilityListItem, MerchantListItem, PlaceListItem, SpacesResponse } from "../adminTypes";
import {
  Chip,
  EditorialPill,
  EmptyState,
  ErrorBanner,
  KIND_LABELS,
  LoadingState,
  Pill,
  Panel,
  PrimaryButton,
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

export function ContentPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission("write:content");
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "places";
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [query, setQuery] = useState(params.get("q") ?? "");

  const { state } = useAsyncData(async (signal) => {
    const [spaces, places, facilities, merchants] = await Promise.all([
      admin.listSpaces<SpacesResponse>(signal),
      admin.listAdminPlaces<PlaceListItem>(signal),
      admin.listFacilities<FacilityListItem>(signal),
      admin.listMerchants<MerchantListItem>(signal),
    ]);
    return { spaces, places: places.items, facilities: facilities.items, merchants: merchants.items };
  }, []);

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

  const rows =
    tab === "places"
      ? data.places.map((p) => ({
          id: p.id,
          name: p.displayName ?? p.id,
          type: KIND_LABELS[p.kindId] ?? p.kindId,
          campus: campusName(p.campusId),
          status: p.editorialStatus ?? "draft",
          updatedAt: p.updatedAt,
          to: `/admin/content/places/${p.id}`,
        }))
      : tab === "facilities"
        ? data.facilities.map((f) => ({
            id: f.id,
            name: String(f.displayName ?? f.facilityTypeName ?? f.id),
            type: String(f.facilityTypeName ?? f.facilityTypeId ?? "—"),
            campus: placeName(f.hostPlaceId),
            status: f.editorialStatus ?? "draft",
            updatedAt: String(f.lastVerifiedAt ?? ""),
            to: `/admin/content/facilities/${f.id}`,
          }))
        : data.merchants.map((m) => ({
            id: m.id,
            name: String(m.displayName ?? m.id),
            type: String(m.businessType ?? "—"),
            campus: placeName(m.hostPlaceId),
            status: m.editorialStatus ?? "draft",
            updatedAt: String(m.updatedAt ?? ""),
            to: `/admin/content/merchants/${m.id}`,
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

      {/* 表格 */}
      <Panel padded={false}>
        <table className="w-full border-collapse text-left text-body">
          <thead>
            <tr className="text-label text-sub">
              <th className="px-5 pb-2 pt-4 font-medium">名称</th>
              <th className="px-5 pb-2 pt-4 font-medium">{tab === "places" ? "类型" : tab === "facilities" ? "类型" : "分类"}</th>
              <th className="px-5 pb-2 pt-4 font-medium">{tab === "places" ? "校区" : "所在地点"}</th>
              <th className="px-5 pb-2 pt-4 font-medium">编辑状态</th>
              <th className="px-5 pb-2 pt-4 font-medium">更新时间</th>
              <th className="px-5 pb-2 pt-4 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {filtered.map((row) => (
              <tr key={row.id}>
                <td className="px-5 py-3.5 font-medium text-ink">{row.name}</td>
                <td className="px-5 py-3.5 text-sub">{row.type}</td>
                <td className="px-5 py-3.5 text-sub">{row.campus}</td>
                <td className="px-5 py-3.5"><EditorialPill status={row.status} /></td>
                <td className="px-5 py-3.5 text-sub">{row.updatedAt ? fmtDateTime(row.updatedAt) : "—"}</td>
                <td className="px-5 py-3.5 text-right">
                  <Link className="text-aux font-medium text-primary" to={canWrite ? row.to : `/admin/content?tab=${tab}`}>
                    {canWrite && row.status !== "in_review" ? "编辑 ›" : "查看 ›"}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 ? <div className="p-5"><EmptyState label={`暂无${TAB_LABELS[tab]}`} /></div> : null}
        <p className="px-5 pb-4 pt-3 text-right text-label text-sub">共 {filtered.length} 条</p>
      </Panel>
    </div>
  );
}
