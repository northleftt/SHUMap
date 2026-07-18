import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "./AuthContext";
import { ApiError } from "../lib/api/client";
import * as admin from "../lib/api/admin";
import type {
  AdminSection,
  CampaignRow,
  FacilityListItem,
  MapVersion,
  MerchantListItem,
  OperationalEventRow,
  PlaceListItem,
  ReferenceDataResponse,
  Severity,
  SpacesResponse,
  SubmissionRow,
  TransitResponse,
} from "./adminTypes";

// ===========================================================================
// v2 admin console. Cookie-session auth (no localStorage); every section is
// wired directly to the native v2 admin API. The legacy POI/marker/overview
// model has been removed — sections are organized around v2 domains.
// ===========================================================================

const navItems: Array<{ key: AdminSection; label: string; icon: string; permission?: string }> = [
  { key: "dashboard", label: "总览", icon: "⌂" },
  { key: "spaces", label: "空间结构", icon: "▤" },
  { key: "places", label: "地点", icon: "◇" },
  { key: "facilities", label: "设施", icon: "⚙" },
  { key: "merchants", label: "商户", icon: "▦" },
  { key: "maps", label: "底图版本", icon: "▧", permission: "write:maps" },
  { key: "operations", label: "运营与活动", icon: "◈" },
  { key: "transit", label: "校车交通", icon: "⇄" },
  { key: "submissions", label: "采集审核", icon: "✎", permission: "review:content" },
  { key: "releases", label: "发布", icon: "↑", permission: "publish:release" },
];

const severityClass: Record<Severity, string> = {
  ok: "bg-[var(--color-success-soft)] text-[var(--color-success)]",
  warning: "bg-[var(--color-warning-soft)] text-[var(--color-warning)]",
  error: "bg-[rgba(220,38,38,0.14)] text-[var(--color-danger)]",
  info: "bg-[var(--color-primary-soft)] text-[var(--color-primary)]",
};

const EDITORIAL_SEVERITY: Record<string, Severity> = {
  approved: "ok",
  draft: "warning",
  in_review: "info",
  rejected: "error",
  superseded: "info",
};

// ---------------------------------------------------------------------------
// Visual primitives (reused from the previous design)
// ---------------------------------------------------------------------------

function AdminIcon({ children }: { children: string }) {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-[8px] bg-white/10 text-[13px] font-semibold text-white">
      {children}
    </span>
  );
}

function StatusPill({ children, severity = "info" }: { children: React.ReactNode; severity?: Severity }) {
  return (
    <span className={`inline-flex h-7 items-center rounded-full px-3 text-[12px] font-semibold ${severityClass[severity]}`}>
      {children}
    </span>
  );
}

function Panel({
  title,
  action,
  children,
  className = "",
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-[8px] border border-[var(--color-border)]/70 bg-white ${className}`}>
      <header className="flex min-h-14 items-center justify-between border-b border-[var(--color-border)]/70 px-5">
        <h2 className="text-[16px] font-semibold text-[var(--color-text)]">{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-semibold text-[var(--color-text-muted)]">{label}</span>
      <input
        className="h-10 w-full rounded-[8px] border border-[var(--color-border)] bg-white px-3 text-[13px] text-[var(--color-text)] outline-none focus:border-[var(--color-primary)]"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type={type}
        value={value}
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-semibold text-[var(--color-text-muted)]">{label}</span>
      <select
        className="h-10 w-full rounded-[8px] border border-[var(--color-border)] bg-white px-3 text-[13px] text-[var(--color-text)] outline-none focus:border-[var(--color-primary)]"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

function ErrorBanner({ message }: { message: string }) {
  if (!message) return null;
  return <p className="rounded-[8px] bg-red-50 px-4 py-3 text-[13px] font-semibold text-[var(--color-danger)]">{message}</p>;
}

function LoadingState({ label = "加载中…" }: { label?: string }) {
  return <p className="rounded-[8px] bg-[var(--color-surface-muted)] px-4 py-8 text-center text-[13px] text-[var(--color-text-muted)]">{label}</p>;
}

function EmptyState({ label }: { label: string }) {
  return <p className="rounded-[8px] bg-[var(--color-surface-muted)] px-4 py-8 text-center text-[13px] text-[var(--color-text-muted)]">{label}</p>;
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : fallback;
}

// A small async-data hook shared by list sections.
function useAsyncData<T>(loader: (signal: AbortSignal) => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; data?: T; message?: string }>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    loader(controller.signal)
      .then((data) => setState({ status: "ready", data }))
      .catch((err) => {
        if (controller.signal.aborted) return;
        setState({ status: "error", message: errorMessage(err, "加载失败") });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return { state, reload };
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(errorMessage(err, "登录失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid h-full w-full place-items-center bg-[#f8fafc] text-[var(--color-text)]">
      <form className="w-[380px] rounded-[12px] border border-[var(--color-border)] bg-white p-7 shadow-sm" onSubmit={submit}>
        <p className="text-[22px] font-semibold">SHUMap 管理后台</p>
        <p className="mt-1.5 text-[13px] text-[var(--color-text-muted)]">使用管理员账号登录。会话通过安全 Cookie 维持。</p>
        <div className="mt-6 space-y-4">
          <Field label="邮箱" value={email} onChange={setEmail} placeholder="admin@example.com" type="email" />
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-semibold text-[var(--color-text-muted)]">密码</span>
            <input
              className="h-10 w-full rounded-[8px] border border-[var(--color-border)] bg-white px-3 text-[13px] outline-none focus:border-[var(--color-primary)]"
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              value={password}
            />
          </label>
          <ErrorBanner message={error} />
          <button
            className="h-11 w-full rounded-[8px] bg-[var(--color-primary)] text-[14px] font-semibold text-white disabled:opacity-50"
            disabled={busy || !email.trim() || !password}
            type="submit"
          >
            {busy ? "登录中…" : "登录"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function Dashboard() {
  const { state } = useAsyncData(async (signal) => {
    const [spaces, places, facilities, merchants, maps, submissions] = await Promise.all([
      admin.listSpaces<SpacesResponse>(signal),
      admin.listAdminPlaces<PlaceListItem>(signal),
      admin.listFacilities<FacilityListItem>(signal),
      admin.listMerchants<MerchantListItem>(signal),
      admin.listMapVersions(signal),
      admin.listSubmissions(signal),
    ]);
    return { spaces, places, facilities, merchants, maps, submissions };
  }, []);

  if (state.status === "loading") return <LoadingState label="加载总览…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  const data = state.data!;

  const pendingSubmissions = data.submissions.items.filter((s) => s.status === "pending" || s.status === "in_review").length;
  const publishedMaps = data.maps.items.filter((m) => m.lifecycleStatus === "published").length;
  const approvedPlaces = data.places.items.filter((p) => p.editorialStatus === "approved").length;

  const metrics: Array<{ label: string; value: string; hint: string; severity: Severity }> = [
    { label: "校区", value: String(data.spaces.campuses.length), hint: `${data.spaces.buildings.length} 栋建筑 · ${data.spaces.floors.length} 层`, severity: "info" },
    { label: "地点", value: String(data.places.items.length), hint: `${approvedPlaces} 个已审核通过`, severity: approvedPlaces === data.places.items.length ? "ok" : "warning" },
    { label: "设施 / 商户", value: `${data.facilities.items.length} / ${data.merchants.items.length}`, hint: "设施实例与商户门店", severity: "info" },
    { label: "底图版本", value: String(data.maps.items.length), hint: publishedMaps > 0 ? `${publishedMaps} 个已发布` : "尚无已发布底图", severity: publishedMaps > 0 ? "ok" : "warning" },
    { label: "待审采集", value: String(pendingSubmissions), hint: pendingSubmissions > 0 ? "有采集信息待审核" : "无待审内容", severity: pendingSubmissions > 0 ? "warning" : "ok" },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-5 gap-4">
        {metrics.map((metric) => (
          <div key={metric.label} className="rounded-[8px] border border-[var(--color-border)]/70 bg-white p-5">
            <div className="mb-5 flex items-center justify-between">
              <span className="text-[13px] font-semibold text-[var(--color-text-muted)]">{metric.label}</span>
              <StatusPill severity={metric.severity}>状态</StatusPill>
            </div>
            <p className="text-[26px] font-semibold leading-none text-[var(--color-text)]">{metric.value}</p>
            <p className="mt-3 text-[13px] text-[var(--color-text-muted)]">{metric.hint}</p>
          </div>
        ))}
      </div>
      <Panel title="发布前检查提示">
        <div className="space-y-2 p-5 text-[13px] text-[var(--color-text-muted)]">
          <p>· 发布 release 至少需要一个已发布或显式选择的底图版本。</p>
          <p>· 只有 editorial_status 为 approved 的地点 / 设施 / 商户修订会进入发布产物。</p>
          <p>· 校车到站时间在源数据仅含发车时刻时为 null，属预期现象。</p>
        </div>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Spaces
// ---------------------------------------------------------------------------

function SpacesSection() {
  const { state, reload } = useAsyncData((signal) => admin.listSpaces<SpacesResponse>(signal), []);

  if (state.status === "loading") return <LoadingState label="加载空间结构…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  const data = state.data!;
  const campusName = (id: string | null) => data.campuses.find((c) => c.id === id)?.name ?? "—";

  return (
    <div className="space-y-4">
      <Panel title="校区" action={<StatusPill severity="info">{data.campuses.length}</StatusPill>}>
        <div className="grid grid-cols-3 gap-3 p-5">
          {data.campuses.map((campus) => (
            <div key={campus.id} className="rounded-[8px] bg-[var(--color-surface-muted)] p-4">
              <div className="flex items-center justify-between">
                <p className="font-semibold text-[var(--color-text)]">{campus.name}</p>
                <StatusPill severity={campus.status === "active" ? "ok" : "info"}>{campus.status}</StatusPill>
              </div>
              <p className="mt-2 font-mono text-[12px] text-[var(--color-text-muted)]">{campus.code}</p>
              <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">{campus.timezone}</p>
            </div>
          ))}
          {data.campuses.length === 0 ? <p className="col-span-3"><EmptyState label="暂无校区" /></p> : null}
        </div>
      </Panel>

      <div className="grid grid-cols-2 gap-4">
        <Panel title="建筑" action={<StatusPill severity="info">{data.buildings.length}</StatusPill>}>
          <div className="max-h-[360px] divide-y divide-[var(--color-border)]/70 overflow-y-auto">
            {data.buildings.map((building) => (
              <div key={building.placeId} className="flex items-center justify-between px-5 py-3 text-[13px]">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-[var(--color-text)]">{building.displayName ?? building.placeId}</p>
                  <p className="text-[12px] text-[var(--color-text-muted)]">{campusName(building.campusId)} · {building.buildingCode ?? "无编号"}</p>
                </div>
                <StatusPill severity="info">{building.publicAccessLevel}</StatusPill>
              </div>
            ))}
            {data.buildings.length === 0 ? <EmptyState label="暂无建筑" /> : null}
          </div>
        </Panel>
        <FloorSpaceManager data={data} reload={reload} />
      </div>
    </div>
  );
}

function FloorSpaceManager({ data, reload }: { data: SpacesResponse; reload: () => void }) {
  const [buildingId, setBuildingId] = useState("");
  const [levelCode, setLevelCode] = useState("");
  const [levelOrder, setLevelOrder] = useState("0");
  const [floorName, setFloorName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const buildingFloors = data.floors.filter((f) => !buildingId || f.buildingPlaceId === buildingId);

  async function addFloor() {
    if (!buildingId || !levelCode.trim() || !floorName.trim()) return;
    setBusy(true);
    setError("");
    try {
      await admin.createFloor({
        buildingPlaceId: buildingId,
        levelCode: levelCode.trim(),
        levelOrder: Number(levelOrder) || 0,
        displayName: floorName.trim(),
      });
      setLevelCode("");
      setFloorName("");
      reload();
    } catch (err) {
      setError(errorMessage(err, "创建楼层失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="楼层">
      <div className="space-y-3 p-5">
        <ErrorBanner message={error} />
        <SelectField
          label="所属建筑"
          value={buildingId}
          onChange={setBuildingId}
          placeholder="选择建筑"
          options={data.buildings.map((b) => ({ value: b.placeId, label: b.displayName ?? b.placeId }))}
        />
        <div className="grid grid-cols-[1fr_90px] gap-2">
          <Field label="楼层代码" value={levelCode} onChange={setLevelCode} placeholder="如 F1 / B1" />
          <Field label="排序" value={levelOrder} onChange={setLevelOrder} type="number" />
        </div>
        <Field label="显示名称" value={floorName} onChange={setFloorName} placeholder="如 一层" />
        <button
          className="h-10 w-full rounded-[8px] bg-[var(--color-primary)] text-[13px] font-semibold text-white disabled:opacity-50"
          disabled={busy || !buildingId || !levelCode.trim() || !floorName.trim()}
          onClick={addFloor}
          type="button"
        >
          新增楼层
        </button>
        <div className="max-h-[220px] divide-y divide-[var(--color-border)]/70 overflow-y-auto rounded-[8px] border border-[var(--color-border)]/70">
          {buildingFloors.map((floor) => (
            <div key={floor.id} className="flex items-center justify-between px-3 py-2.5 text-[13px]">
              <span className="font-semibold text-[var(--color-text)]">{floor.displayName}</span>
              <span className="text-[12px] text-[var(--color-text-muted)]">{floor.levelCode} · #{floor.levelOrder}</span>
            </div>
          ))}
          {buildingFloors.length === 0 ? <EmptyState label="该建筑暂无楼层" /> : null}
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Places (list + revision lifecycle)
// ---------------------------------------------------------------------------

function PlacesSection({ canWrite, canReview }: { canWrite: boolean; canReview: boolean }) {
  const { state, reload } = useAsyncData((signal) => admin.listAdminPlaces<PlaceListItem>(signal), []);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");

  const items = state.status === "ready" ? state.data!.items : [];
  const filtered = items.filter((p) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return `${p.displayName ?? ""} ${p.id} ${p.kindId}`.toLowerCase().includes(q);
  });

  async function transition(place: PlaceListItem, action: "submit" | "approve" | "reject") {
    if (!place.currentRevisionId) return;
    setBusyId(place.id);
    setError("");
    try {
      if (action === "submit") {
        await admin.submitRevision("place", place.currentRevisionId);
      } else {
        await admin.reviewRevision("place", place.currentRevisionId, { decision: action });
      }
      reload();
    } catch (err) {
      setError(errorMessage(err, "操作失败"));
    } finally {
      setBusyId("");
    }
  }

  if (state.status === "loading") return <LoadingState label="加载地点…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;

  return (
    <div className="space-y-4">
      <Panel
        title="地点"
        action={<StatusPill severity="info">{items.length}</StatusPill>}
      >
        <div className="border-b border-[var(--color-border)]/70 p-5">
          <Field label="搜索地点" value={query} onChange={setQuery} placeholder="名称 / ID / 类型" />
          <ErrorBanner message={error} />
        </div>
        <table className="w-full border-collapse text-left text-[13px]">
          <thead className="bg-[var(--color-surface-muted)] text-[12px] text-[var(--color-text-muted)]">
            <tr>
              {["名称", "类型", "修订状态", "操作"].map((h) => (
                <th key={h} className="px-5 py-3 font-semibold">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]/70">
            {filtered.map((place) => {
              const status = place.editorialStatus ?? "draft";
              return (
                <tr key={place.id}>
                  <td className="px-5 py-4 font-semibold text-[var(--color-text)]">{place.displayName ?? place.id}</td>
                  <td className="px-5 py-4 text-[var(--color-text-muted)]">{place.kindId}</td>
                  <td className="px-5 py-4"><StatusPill severity={EDITORIAL_SEVERITY[status] ?? "info"}>{status}</StatusPill></td>
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-2">
                      {canWrite && status === "draft" ? (
                        <button className="rounded-full bg-[var(--color-primary-soft)] px-3 py-1 text-[11px] font-semibold text-[var(--color-primary)] disabled:opacity-50" disabled={busyId === place.id} onClick={() => transition(place, "submit")} type="button">提交审核</button>
                      ) : null}
                      {canReview && status === "in_review" ? (
                        <>
                          <button className="rounded-full bg-[var(--color-success-soft)] px-3 py-1 text-[11px] font-semibold text-[var(--color-success)] disabled:opacity-50" disabled={busyId === place.id} onClick={() => transition(place, "approve")} type="button">通过</button>
                          <button className="rounded-full bg-red-50 px-3 py-1 text-[11px] font-semibold text-[var(--color-danger)] disabled:opacity-50" disabled={busyId === place.id} onClick={() => transition(place, "reject")} type="button">驳回</button>
                        </>
                      ) : null}
                      {!canWrite && !canReview ? <span className="text-[12px] text-[var(--color-text-muted)]">只读</span> : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 ? <EmptyState label="暂无地点" /> : null}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Facilities + Merchants (read-focused lists)
// ---------------------------------------------------------------------------

function FacilitiesSection() {
  const { state } = useAsyncData((signal) => admin.listFacilities<FacilityListItem>(signal), []);
  if (state.status === "loading") return <LoadingState label="加载设施…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  const items = state.data!.items;
  return (
    <Panel title="设施实例" action={<StatusPill severity="info">{items.length}</StatusPill>}>
      <div className="divide-y divide-[var(--color-border)]/70">
        {items.map((facility) => (
          <div key={facility.id} className="flex items-center justify-between px-5 py-3 text-[13px]">
            <div className="min-w-0">
              <p className="truncate font-semibold text-[var(--color-text)]">{facility.displayName ?? facility.id}</p>
              <p className="text-[12px] text-[var(--color-text-muted)]">{facility.facilityTypeId ?? "—"} · host {facility.hostPlaceId ?? "—"}</p>
            </div>
            <StatusPill severity={facility.operationalStatus === "operational" ? "ok" : "info"}>{facility.operationalStatus ?? "—"}</StatusPill>
          </div>
        ))}
        {items.length === 0 ? <EmptyState label="暂无设施实例" /> : null}
      </div>
    </Panel>
  );
}

function MerchantsSection() {
  const { state } = useAsyncData((signal) => admin.listMerchants<MerchantListItem>(signal), []);
  if (state.status === "loading") return <LoadingState label="加载商户…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  const items = state.data!.items;
  return (
    <Panel title="商户门店" action={<StatusPill severity="info">{items.length}</StatusPill>}>
      <div className="divide-y divide-[var(--color-border)]/70">
        {items.map((merchant) => (
          <div key={merchant.id} className="flex items-center justify-between px-5 py-3 text-[13px]">
            <div className="min-w-0">
              <p className="truncate font-semibold text-[var(--color-text)]">{merchant.displayName ?? merchant.id}</p>
              <p className="text-[12px] text-[var(--color-text-muted)]">{merchant.businessType ?? "—"} · host {merchant.hostPlaceId ?? "—"}</p>
            </div>
            <StatusPill severity={EDITORIAL_SEVERITY[merchant.editorialStatus ?? "draft"] ?? "info"}>{merchant.editorialStatus ?? "—"}</StatusPill>
          </div>
        ))}
        {items.length === 0 ? <EmptyState label="暂无商户门店" /> : null}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Maps: upload intent -> PUT content -> import job -> version status
// ---------------------------------------------------------------------------

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function MapsSection() {
  const { state, reload } = useAsyncData((signal) => admin.listMapVersions(signal), []);
  const refData = useAsyncData((signal) => admin.listReferenceData<ReferenceDataResponse>(signal), []);
  const spaces = useAsyncData((signal) => admin.listSpaces<SpacesResponse>(signal), []);

  const [campusId, setCampusId] = useState("");
  const [versionLabel, setVersionLabel] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");

  const campuses = spaces.state.status === "ready" ? spaces.state.data!.campuses : [];
  const sources = refData.state.status === "ready" ? refData.state.data!.sources : [];

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!campusId) { setError("请先选择校区"); return; }
    if (!versionLabel.trim()) { setError("请填写版本号"); return; }
    setBusy(true);
    setError("");
    setProgress("");
    try {
      const bytes = await file.arrayBuffer();
      const hash = await sha256Hex(bytes);
      setProgress("创建上传意图…");
      const intent = await admin.createMapUploadIntent({
        assetType: "campus_svg",
        originalName: file.name,
        contentType: "image/svg+xml",
        byteSize: bytes.byteLength,
        sha256: hash,
        sourceId: sourceId || null,
      });
      setProgress("上传底图内容…");
      await admin.uploadMediaContent(intent.mediaAssetId, bytes, "image/svg+xml");
      setProgress("创建导入任务…");
      const job = await admin.createImportJob({
        mediaAssetId: intent.mediaAssetId,
        campusId,
        versionLabel: versionLabel.trim(),
        coordinateSpaceType: "svg_viewbox",
        coordinateSpace: {},
      });
      setProgress(`导入任务已创建（${job.status}）。导入完成后底图版本会出现在下方。`);
      setVersionLabel("");
      reload();
    } catch (err) {
      setError(errorMessage(err, "上传失败"));
      setProgress("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Panel
        title="上传底图 (SVG)"
        action={
          <label className={`inline-flex h-9 cursor-pointer items-center rounded-full px-4 text-[12px] font-semibold text-white ${busy ? "bg-gray-400" : "bg-[var(--color-primary)]"}`}>
            {busy ? "处理中…" : "选择 SVG"}
            <input accept=".svg,image/svg+xml" className="hidden" disabled={busy} onChange={handleFile} type="file" />
          </label>
        }
      >
        <div className="space-y-3 p-5">
          <div className="grid grid-cols-3 gap-3">
            <SelectField label="校区" value={campusId} onChange={setCampusId} placeholder="选择校区" options={campuses.map((c) => ({ value: c.id, label: c.name }))} />
            <Field label="版本号" value={versionLabel} onChange={setVersionLabel} placeholder="如 2026-07-01" />
            <SelectField label="数据来源（可选）" value={sourceId} onChange={setSourceId} placeholder="不指定" options={sources.map((s) => ({ value: s.id, label: s.title }))} />
          </div>
          <p className="rounded-[8px] bg-[var(--color-surface-muted)] px-4 py-3 text-[12px] text-[var(--color-text-muted)]">
            上传流程：创建上传意图 → 校验大小/哈希后写入 R2 → 入队导入任务解析 SVG 要素。导入为异步队列处理，完成后底图版本状态更新为 ready。
          </p>
          {progress ? <p className="rounded-[8px] bg-[var(--color-success-soft)] px-4 py-3 text-[13px] font-semibold text-[var(--color-success)]">{progress}</p> : null}
          <ErrorBanner message={error} />
        </div>
      </Panel>

      <Panel title="底图版本" action={<button className="rounded-full bg-[var(--color-surface-muted)] px-3 py-1.5 text-[12px] font-semibold text-[var(--color-text-muted)]" onClick={reload} type="button">刷新</button>}>
        {state.status === "loading" ? <LoadingState label="加载底图版本…" /> : state.status === "error" ? <ErrorBanner message={state.message ?? "加载失败"} /> : (
          <div className="grid grid-cols-3 gap-3 p-5">
            {state.data!.items.map((version: MapVersion) => (
              <div key={version.id} className="rounded-[8px] bg-[var(--color-surface-muted)] p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate font-semibold text-[var(--color-text)]">{version.versionLabel}</p>
                  <StatusPill severity={version.lifecycleStatus === "published" ? "ok" : version.lifecycleStatus === "ready" ? "info" : "warning"}>{version.lifecycleStatus}</StatusPill>
                </div>
                <p className="mt-2 text-[12px] text-[var(--color-text-muted)]">{version.featureCount} 个要素 · {version.coordinateSpaceType}</p>
                <p className="mt-1 font-mono text-[11px] text-[var(--color-text-muted)]">{version.id}</p>
              </div>
            ))}
            {state.data!.items.length === 0 ? <p className="col-span-3"><EmptyState label="暂无底图版本，请先上传 SVG" /></p> : null}
          </div>
        )}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Operations + campaigns
// ---------------------------------------------------------------------------

function OperationsSection({ canReview }: { canReview: boolean }) {
  const events = useAsyncData((signal) => admin.listAdminOperations<OperationalEventRow>(signal), []);
  const campaigns = useAsyncData((signal) => admin.listAdminCampaigns<CampaignRow>(signal), []);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");

  async function decide(id: string, decision: "approve" | "reject") {
    setBusyId(id);
    setError("");
    try {
      await admin.reviewOperation(id, { decision });
      events.reload();
    } catch (err) {
      setError(errorMessage(err, "操作失败"));
    } finally {
      setBusyId("");
    }
  }

  return (
    <div className="space-y-4">
      <ErrorBanner message={error} />
      <Panel title="运营事件">
        {events.state.status === "loading" ? <LoadingState label="加载运营事件…" /> : events.state.status === "error" ? <ErrorBanner message={events.state.message ?? "加载失败"} /> : (
          <div className="divide-y divide-[var(--color-border)]/70">
            {events.state.data!.items.map((event) => (
              <div key={event.id} className="flex items-start justify-between gap-4 px-5 py-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold text-[var(--color-text)]">{event.title}</p>
                    <StatusPill severity={event.severity === "critical" ? "error" : event.severity === "warning" ? "warning" : "info"}>{event.severity}</StatusPill>
                    <StatusPill severity={EDITORIAL_SEVERITY[event.editorialStatus] ?? "info"}>{event.editorialStatus}</StatusPill>
                  </div>
                  <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">{event.eventType} · 起 {event.startsAt}</p>
                </div>
                {canReview && (event.editorialStatus === "draft" || event.editorialStatus === "in_review") ? (
                  <div className="flex shrink-0 gap-2">
                    <button className="rounded-full bg-[var(--color-success-soft)] px-3 py-1.5 text-[12px] font-semibold text-[var(--color-success)] disabled:opacity-50" disabled={busyId === event.id} onClick={() => decide(event.id, "approve")} type="button">通过</button>
                    <button className="rounded-full bg-red-50 px-3 py-1.5 text-[12px] font-semibold text-[var(--color-danger)] disabled:opacity-50" disabled={busyId === event.id} onClick={() => decide(event.id, "reject")} type="button">驳回</button>
                  </div>
                ) : null}
              </div>
            ))}
            {events.state.data!.items.length === 0 ? <EmptyState label="暂无运营事件" /> : null}
          </div>
        )}
      </Panel>
      <Panel title="活动 / 推广">
        {campaigns.state.status === "loading" ? <LoadingState label="加载活动…" /> : campaigns.state.status === "error" ? <ErrorBanner message={campaigns.state.message ?? "加载失败"} /> : (
          <div className="divide-y divide-[var(--color-border)]/70">
            {campaigns.state.data!.items.map((campaign) => (
              <div key={campaign.id} className="flex items-center justify-between px-5 py-3 text-[13px]">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-[var(--color-text)]">{campaign.title}</p>
                  <p className="text-[12px] text-[var(--color-text-muted)]">{campaign.startsAt} → {campaign.endsAt}</p>
                </div>
                <StatusPill severity={EDITORIAL_SEVERITY[campaign.editorialStatus] ?? "info"}>{campaign.editorialStatus}</StatusPill>
              </div>
            ))}
            {campaigns.state.data!.items.length === 0 ? <EmptyState label="暂无活动" /> : null}
          </div>
        )}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Transit
// ---------------------------------------------------------------------------

function TransitSection() {
  const { state } = useAsyncData((signal) => admin.listAdminTransit<TransitResponse>(signal), []);
  if (state.status === "loading") return <LoadingState label="加载校车数据…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  const data = state.data!;
  return (
    <div className="grid grid-cols-2 gap-4">
      <Panel title="站点" action={<StatusPill severity="info">{data.stops.length}</StatusPill>}>
        <div className="max-h-[320px] divide-y divide-[var(--color-border)]/70 overflow-y-auto">
          {data.stops.map((stop) => (
            <div key={String(stop.id)} className="px-5 py-3 text-[13px]">
              <p className="font-semibold text-[var(--color-text)]">{String(stop.name ?? stop.id)}</p>
              <p className="font-mono text-[11px] text-[var(--color-text-muted)]">{String(stop.id)}</p>
            </div>
          ))}
          {data.stops.length === 0 ? <EmptyState label="暂无站点" /> : null}
        </div>
      </Panel>
      <Panel title="线路" action={<StatusPill severity="info">{data.routes.length}</StatusPill>}>
        <div className="max-h-[320px] divide-y divide-[var(--color-border)]/70 overflow-y-auto">
          {data.routes.map((route) => (
            <div key={String(route.id)} className="px-5 py-3 text-[13px]">
              <p className="font-semibold text-[var(--color-text)]">{String(route.name ?? route.id)}</p>
              <p className="text-[12px] text-[var(--color-text-muted)]">{data.trips.filter((t) => data.patterns.some((p) => p.id === (t as { patternId?: unknown }).patternId && (p as { routeId?: unknown }).routeId === route.id)).length} 个班次</p>
            </div>
          ))}
          {data.routes.length === 0 ? <EmptyState label="暂无线路" /> : null}
        </div>
      </Panel>
      <Panel title="班次" action={<StatusPill severity="info">{data.trips.length}</StatusPill>} className="col-span-2">
        <div className="p-5 text-[13px] text-[var(--color-text-muted)]">
          共 {data.trips.length} 个班次、{data.calendars.length} 个服务日历、{data.patterns.length} 个走向。班次与到站/发车时刻通过发布产物提供给用户端。
        </div>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Submissions review
// ---------------------------------------------------------------------------

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function SubmissionsSection() {
  const { state, reload } = useAsyncData((signal) => admin.listSubmissions(signal), []);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");

  async function decide(submission: SubmissionRow, decision: "accept" | "reject") {
    setBusyId(submission.id);
    setError("");
    try {
      await admin.reviewSubmission(submission.id, { decision });
      reload();
    } catch (err) {
      setError(errorMessage(err, "审核失败"));
    } finally {
      setBusyId("");
    }
  }

  if (state.status === "loading") return <LoadingState label="加载采集信息…" />;
  if (state.status === "error") return <ErrorBanner message={state.message ?? "加载失败"} />;
  const items = state.data!.items;

  return (
    <Panel title="采集信息审核" action={<StatusPill severity="info">{items.length}</StatusPill>}>
      <div className="border-b border-[var(--color-border)]/70 px-5 py-3"><ErrorBanner message={error} /></div>
      <div className="divide-y divide-[var(--color-border)]/70">
        {items.map((submission) => {
          const payload = safeParse(submission.payloadJson) as { detail?: { summary?: string; description?: string } } | null;
          const pending = submission.status === "pending" || submission.status === "in_review";
          return (
            <div key={submission.id} className="grid grid-cols-[1fr_200px] gap-4 p-5">
              <div className="min-w-0">
                <div className="mb-2 flex items-center gap-2">
                  <h3 className="text-[14px] font-semibold text-[var(--color-text)]">{submission.targetType} · {submission.targetId ?? "新地点"}</h3>
                  <StatusPill severity={pending ? "warning" : submission.status === "accepted" ? "ok" : "info"}>{submission.status}</StatusPill>
                </div>
                <p className="text-[12px] text-[var(--color-text-muted)]">{submission.submitterName || "匿名"} · {submission.createdAt}</p>
                <p className="mt-2 text-[13px] text-[var(--color-text)]">{payload?.detail?.description || payload?.detail?.summary || "（无文字描述）"}</p>
              </div>
              <div className="flex items-center justify-end gap-2">
                {pending ? (
                  <>
                    <button className="rounded-full bg-red-50 px-3 py-1.5 text-[12px] font-semibold text-[var(--color-danger)] disabled:opacity-50" disabled={busyId === submission.id} onClick={() => decide(submission, "reject")} type="button">驳回</button>
                    <button className="rounded-full bg-[var(--color-primary)] px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50" disabled={busyId === submission.id} onClick={() => decide(submission, "accept")} type="button">采纳</button>
                  </>
                ) : null}
              </div>
            </div>
          );
        })}
        {items.length === 0 ? <EmptyState label="暂无采集信息" /> : null}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Releases: validate/publish + rollback
// ---------------------------------------------------------------------------

function ReleasesSection({ canRollback }: { canRollback: boolean }) {
  const maps = useAsyncData((signal) => admin.listMapVersions(signal), []);
  const [version, setVersion] = useState("");
  const [summary, setSummary] = useState("");
  const [selectedMapIds, setSelectedMapIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<admin.PublishReleaseResult | null>(null);
  const [rollbackId, setRollbackId] = useState("");
  const [rollbackMsg, setRollbackMsg] = useState("");

  const mapVersions = maps.state.status === "ready" ? maps.state.data!.items : [];

  async function publish() {
    if (!version.trim()) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const res = await admin.publishRelease({
        version: version.trim(),
        summary: summary.trim() || undefined,
        mapVersionIds: selectedMapIds.length > 0 ? selectedMapIds : undefined,
      });
      setResult(res);
      if (res.status === "active") setVersion("");
    } catch (err) {
      setError(errorMessage(err, "发布失败"));
    } finally {
      setBusy(false);
    }
  }

  async function doRollback() {
    if (!rollbackId.trim()) return;
    setBusy(true);
    setRollbackMsg("");
    setError("");
    try {
      await admin.rollbackRelease(rollbackId.trim());
      setRollbackMsg(`已回滚到 ${rollbackId.trim()}`);
      setRollbackId("");
    } catch (err) {
      setError(errorMessage(err, "回滚失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Panel title="发布新版本">
        <div className="space-y-4 p-5">
          <div className="grid grid-cols-2 gap-3">
            <Field label="版本号" value={version} onChange={setVersion} placeholder="如 v2026.07.01" />
            <Field label="摘要（可选）" value={summary} onChange={setSummary} placeholder="本次发布说明" />
          </div>
          <div>
            <p className="mb-2 text-[12px] font-semibold text-[var(--color-text-muted)]">选择底图版本（留空则使用全部已发布底图）</p>
            <div className="grid grid-cols-2 gap-2">
              {mapVersions.map((mapVersion) => {
                const checked = selectedMapIds.includes(mapVersion.id);
                return (
                  <label key={mapVersion.id} className={`flex cursor-pointer items-center gap-2 rounded-[8px] border px-3 py-2 text-[13px] ${checked ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)]" : "border-[var(--color-border)]"}`}>
                    <input
                      checked={checked}
                      onChange={() => setSelectedMapIds((cur) => cur.includes(mapVersion.id) ? cur.filter((id) => id !== mapVersion.id) : [...cur, mapVersion.id])}
                      type="checkbox"
                    />
                    <span className="min-w-0 truncate">{mapVersion.versionLabel} <span className="text-[var(--color-text-muted)]">({mapVersion.lifecycleStatus})</span></span>
                  </label>
                );
              })}
              {mapVersions.length === 0 ? <p className="col-span-2"><EmptyState label="暂无底图版本" /></p> : null}
            </div>
          </div>
          <ErrorBanner message={error} />
          {result ? (
            <div className={`rounded-[8px] px-4 py-3 text-[13px] ${result.status === "active" ? "bg-[var(--color-success-soft)] text-[var(--color-success)]" : "bg-[var(--color-warning-soft)] text-[var(--color-warning)]"}`}>
              <p className="font-semibold">状态：{result.status}</p>
              {result.validation ? (
                <div className="mt-1 space-y-0.5">
                  {result.validation.errors.map((e, i) => <p key={i}>阻塞：{e}</p>)}
                  {result.validation.warnings.map((w, i) => <p key={i}>警告：{w}</p>)}
                  <p className="text-[12px]">计数：{Object.entries(result.validation.counts).map(([k, v]) => `${k}=${v}`).join(" · ")}</p>
                </div>
              ) : null}
            </div>
          ) : null}
          <button
            className="h-11 rounded-[8px] bg-[var(--color-primary)] px-6 text-[14px] font-semibold text-white disabled:opacity-50"
            disabled={busy || !version.trim()}
            onClick={publish}
            type="button"
          >
            {busy ? "处理中…" : "校验并发布"}
          </button>
        </div>
      </Panel>

      {canRollback ? (
        <Panel title="回滚">
          <div className="space-y-3 p-5">
            <p className="text-[13px] text-[var(--color-text-muted)]">输入目标 release ID，将其重新置为当前生效版本。请谨慎操作，回滚会立即影响线上用户端内容。</p>
            <div className="flex items-end gap-3">
              <div className="flex-1"><Field label="目标 Release ID" value={rollbackId} onChange={setRollbackId} placeholder="release_..." /></div>
              <button className="h-10 rounded-[8px] bg-[var(--color-warning)] px-5 text-[13px] font-semibold text-white disabled:opacity-50" disabled={busy || !rollbackId.trim()} onClick={doRollback} type="button">回滚</button>
            </div>
            {rollbackMsg ? <p className="rounded-[8px] bg-[var(--color-success-soft)] px-4 py-3 text-[13px] font-semibold text-[var(--color-success)]">{rollbackMsg}</p> : null}
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function renderSection(section: AdminSection, hasPermission: (p: string) => boolean) {
  switch (section) {
    case "dashboard": return <Dashboard />;
    case "spaces": return <SpacesSection />;
    case "places": return <PlacesSection canWrite={hasPermission("write:content")} canReview={hasPermission("review:content")} />;
    case "facilities": return <FacilitiesSection />;
    case "merchants": return <MerchantsSection />;
    case "maps": return <MapsSection />;
    case "operations": return <OperationsSection canReview={hasPermission("review:content")} />;
    case "transit": return <TransitSection />;
    case "submissions": return <SubmissionsSection />;
    case "releases": return <ReleasesSection canRollback={hasPermission("rollback:release")} />;
    default: return <Dashboard />;
  }
}

export function AdminPage() {
  const { auth, loading, logout, hasPermission } = useAuth();
  const [section, setSection] = useState<AdminSection>("dashboard");

  const visibleNav = useMemo(
    () => navItems.filter((item) => !item.permission || hasPermission(item.permission)),
    [hasPermission],
  );

  const activeNav = useMemo(
    () => navItems.find((item) => item.key === section) ?? navItems[0],
    [section],
  );

  if (loading) {
    return (
      <div className="grid h-full w-full place-items-center bg-[#f8fafc] text-[var(--color-text)]">
        <p className="text-[14px] font-semibold">加载中...</p>
      </div>
    );
  }

  if (!auth) return <LoginPage />;

  return (
    <div className="h-full w-full overflow-hidden bg-[#f8fafc] text-[var(--color-text)]">
      <div className="grid h-full grid-cols-[248px_1fr]">
        <aside className="flex min-h-0 flex-col bg-[#0f172a] px-4 py-5 text-white">
          <div className="px-3 pb-7">
            <p className="text-[24px] font-semibold leading-none">SHUMap</p>
            <p className="mt-2 text-[12px] font-medium text-slate-400">Admin Console · v2</p>
          </div>
          <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto">
            {visibleNav.map((item) => {
              const active = item.key === section;
              return (
                <button
                  key={item.key}
                  className={`flex h-11 w-full items-center gap-3 rounded-[8px] px-3 text-left text-[13px] font-semibold transition-colors ${
                    active ? "bg-[var(--color-primary)] text-white" : "text-slate-300 hover:bg-white/8 hover:text-white"
                  }`}
                  onClick={() => setSection(item.key)}
                  type="button"
                >
                  <AdminIcon>{item.icon}</AdminIcon>
                  {item.label}
                </button>
              );
            })}
          </nav>
          <div className="rounded-[8px] bg-white/8 p-3 text-[12px] text-slate-300">
            <p className="font-semibold text-white">{auth.user.displayName}</p>
            <p className="mt-1 truncate">{auth.user.email}</p>
          </div>
        </aside>

        <main className="min-h-0 overflow-y-auto">
          <header className="sticky top-0 z-10 flex h-20 items-center justify-between border-b border-[var(--color-border)]/70 bg-white/96 px-8 backdrop-blur">
            <div>
              <h1 className="text-[24px] font-semibold">{activeNav.label}</h1>
              <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">按 v2 领域管理空间、地点、设施、商户、底图、运营、交通、采集与发布。</p>
            </div>
            <button
              className="h-9 rounded-full bg-[var(--color-surface-muted)] px-4 text-[13px] font-semibold text-[var(--color-text)]"
              onClick={() => { void logout(); }}
              type="button"
            >
              退出
            </button>
          </header>
          <div className="p-8">{renderSection(section, hasPermission)}</div>
        </main>
      </div>
    </div>
  );
}
