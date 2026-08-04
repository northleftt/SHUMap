import {
  Building2,
  Bus,
  FileText,
  Inbox,
  Layers,
  LayoutGrid,
  LogOut,
  Map as MapIcon,
  Megaphone,
  Rocket,
  Search,
  SquareCheckBig,
  Tags,
  Users,
} from "lucide-react";
import { useMemo, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { PendingReleaseProvider, usePendingRelease } from "./PendingReleaseContext";
import { ErrorBanner, Field, errorMessage } from "./components/primitives";
import { OverviewPage } from "./pages/OverviewPage";
import { ContentPage } from "./pages/ContentPage";
import { PlaceEditorPage } from "./pages/PlaceEditorPage";
import { FacilityEditorPage } from "./pages/FacilityEditorPage";
import { MerchantEditorPage } from "./pages/MerchantEditorPage";
import { ReviewPage } from "./pages/ReviewPage";
import { OperationsPage } from "./pages/OperationsPage";
import { OperationCreatePage } from "./pages/OperationCreatePage";
import { OperationDetailPage } from "./pages/OperationDetailPage";
import { TransitPage } from "./pages/TransitPage";
import { MapsPage } from "./pages/MapsPage";
import { SubmissionsPage } from "./pages/SubmissionsPage";
import { ReleasesPage } from "./pages/ReleasesPage";
import { UsersPage } from "./pages/UsersPage";
import { TaxonomyPage } from "./pages/TaxonomyPage";
import { FloorsPage } from "./pages/FloorsPage";
import { OrganizationsPage } from "./pages/OrganizationsPage";

// ===========================================================================
// v2 管理后台（A1-A14）。深蓝侧边栏 + 顶栏 + 嵌套路由；
// 各页面在 ./pages，共享原语在 ./components/primitives。
// ===========================================================================

const NAV_GROUPS = [
  {
    label: "内容与地图",
    items: [
      { to: "/admin/content", end: false, label: "内容管理", icon: FileText },
      { to: "/admin/taxonomy", end: false, label: "分类管理", icon: Tags },
      { to: "/admin/organizations", end: false, label: "品牌与机构", icon: Building2, permission: "write:content" },
      { to: "/admin/floors", end: false, label: "楼层与楼层图", icon: Layers, permission: "write:maps" },
      { to: "/admin/maps", end: false, label: "地图版本", icon: MapIcon, permission: "write:maps" },
      { to: "/admin/review", end: false, label: "审核中心", icon: SquareCheckBig, permission: "review:content" },
      { to: "/admin/releases", end: false, label: "发布中心", icon: Rocket, permission: "publish:release" },
    ],
  },
  {
    label: "实时运营",
    items: [
      { to: "/admin/operations", end: false, label: "运营信息", icon: Megaphone },
      { to: "/admin/transit", end: false, label: "校车时刻", icon: Bus, permission: "write:transit" },
      { to: "/admin/submissions", end: false, label: "用户提交", icon: Inbox, permission: "review:content" },
    ],
  },
  {
    label: "系统",
    items: [
      { to: "/admin", end: true, label: "概览", icon: LayoutGrid },
      { to: "/admin/users", end: false, label: "账户管理", icon: Users, permission: "manage:users" },
    ],
  },
] as const;

function titleFor(pathname: string): string {
  if (pathname === "/admin") return "概览";
  if (pathname.startsWith("/admin/content/places/")) return "内容管理 · 地点编辑";
  if (pathname.startsWith("/admin/content/facilities/")) return "内容管理 · 设施编辑";
  if (pathname.startsWith("/admin/content/merchants/")) return "内容管理 · 商户编辑";
  if (pathname.startsWith("/admin/content")) return "内容管理";
  if (pathname.startsWith("/admin/taxonomy")) return "分类管理";
  if (pathname.startsWith("/admin/organizations")) return "品牌与机构管理";
  if (pathname.startsWith("/admin/review")) return "审核中心";
  if (pathname.startsWith("/admin/operations/new")) return "新建运营事件 · 地图编辑器";
  if (pathname.endsWith("/edit") && pathname.startsWith("/admin/operations/")) return "运营事件 · 编辑几何";
  if (pathname.startsWith("/admin/operations/")) return "运营信息 · 事件详情与进展";
  if (pathname.startsWith("/admin/operations")) return "运营信息管理";
  if (pathname.startsWith("/admin/transit")) return "校车时刻";
  if (pathname.startsWith("/admin/floors")) return "楼层与楼层图管理";
  if (pathname.startsWith("/admin/maps")) return "地图版本管理";
  if (pathname.startsWith("/admin/submissions")) return "用户提交 · 处理";
  if (pathname.startsWith("/admin/releases")) return "发布中心";
  if (pathname.startsWith("/admin/users")) return "账户管理";
  return "概览";
}

// ---------------------------------------------------------------------------
// 登录
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
    <div className="grid h-full w-full place-items-center bg-page text-ink">
      <form className="w-[380px] rounded-2xl bg-surface p-7 shadow-card" onSubmit={submit}>
        <p className="text-detail">SHUMap 管理后台</p>
        <p className="mt-1.5 text-body text-sub">请使用管理员账号登录</p>
        <div className="mt-6 space-y-4">
          <Field label="邮箱" value={email} onChange={setEmail} placeholder="admin@example.com" type="email" />
          <label className="block">
            <span className="mb-1.5 block text-label text-sub">密码</span>
            <input
              className="h-9 w-full rounded-lg border border-line bg-surface px-3 text-body outline-none focus:border-primary"
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              value={password}
            />
          </label>
          <ErrorBanner message={error} />
          <button
            className="h-11 w-full rounded-lg bg-primary text-emphasis text-white disabled:opacity-50"
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
// Chrome：侧边栏 + 顶栏
// ---------------------------------------------------------------------------

function Sidebar({ displayName, email }: { displayName: string; email: string }) {
  const { hasPermission } = useAuth();
  const { pending } = usePendingRelease();
  const groups = NAV_GROUPS
    .map((group) => ({
      label: group.label,
      items: group.items.filter((item) => !("permission" in item) || !item.permission || hasPermission(item.permission)),
    }))
    .filter((group) => group.items.length > 0);
  return (
    <aside className="flex min-h-0 w-[232px] shrink-0 flex-col bg-primary-pressed px-3 py-5 text-white">
      <div className="flex items-center gap-2.5 px-2 pb-6">
        <span className="grid h-8.5 w-8.5 place-items-center rounded-lg bg-primary">
          <MapIcon size={18} />
        </span>
        <div>
          <p className="text-[15px] font-semibold leading-tight">SHUMap</p>
          <p className="text-[10px] text-white/60">校园地图管理后台</p>
        </div>
      </div>
      <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto">
        {groups.map((group) => (
          <div className="space-y-1" key={group.label}>
            <p className="px-3 pb-1 text-label font-semibold tracking-wide text-white/45">{group.label}</p>
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                end={item.end}
                to={item.to}
                className={({ isActive }) =>
                  `flex h-9.5 items-center gap-2.5 rounded-lg px-3 text-body font-medium transition-colors ${
                    isActive ? "bg-white/15 text-white" : "text-white/70 hover:bg-white/8 hover:text-white"
                  }`
                }
              >
                <item.icon size={16} />
                {item.label}
                {/* 小黄点：库里有改动但还没发版。只挂在发布中心那一项上，因为它是
                    唯一能解决这件事的地方；数字用 total，让人知道量级。 */}
                {item.to === "/admin/releases" && pending && pending.hasPendingChanges ? (
                  <span
                    className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-warning px-1.5 text-[10px] font-semibold text-white"
                    title={`有 ${pending.total} 项改动尚未发版`}
                  >
                    {pending.total > 99 ? "99+" : pending.total}
                  </span>
                ) : null}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className="flex items-center gap-2.5 rounded-lg bg-white/8 p-3">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/15 text-aux font-semibold">
          {displayName.slice(0, 1)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-aux font-semibold">{displayName}</p>
          <p className="truncate text-label text-white/60">{email}</p>
        </div>
      </div>
    </aside>
  );
}

function Topbar({ displayName }: { displayName: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { logout } = useAuth();
  const title = titleFor(location.pathname);
  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-line bg-surface px-6">
      <h1 className="w-56 shrink-0 text-card">{title}</h1>
      <div className="flex-1" />
      <div className="relative w-[200px]">
        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sub" />
        <input
          className="h-7 w-full rounded-full bg-page pl-8 pr-3 text-aux outline-none placeholder:text-sub"
          placeholder="搜索内容…"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              const q = (event.target as HTMLInputElement).value.trim();
              navigate(q ? `/admin/content?q=${encodeURIComponent(q)}` : "/admin/content");
            }
          }}
        />
      </div>
      <span className="inline-flex h-7 items-center rounded-full bg-warning-bg px-3 text-aux font-medium text-warning">
        生产环境
      </span>
      <span className="text-aux text-ink">{displayName} · 管理员</span>
      <span className="grid h-8 w-8 place-items-center rounded-full bg-primary text-body font-semibold text-white">
        {displayName.slice(0, 1)}
      </span>
      <button
        type="button"
        aria-label="退出登录"
        title="退出登录"
        className="grid h-8 w-8 place-items-center rounded-lg text-sub hover:bg-page hover:text-error"
        onClick={() => void logout()}
      >
        <LogOut size={16} />
      </button>
    </header>
  );
}

// ---------------------------------------------------------------------------
// 壳
// ---------------------------------------------------------------------------

export function AdminPage() {
  const { auth, loading, sessionError, refresh, hasPermission, logout } = useAuth();

  const routes = useMemo(
    () => (
      <Routes>
        <Route index element={<OverviewPage />} />
        <Route path="content" element={<ContentPage />} />
        <Route path="content/places/:id" element={hasPermission("write:content") ? <PlaceEditorPage /> : <Navigate to="/admin/content" replace />} />
        <Route path="content/facilities/:id" element={hasPermission("write:content") ? <FacilityEditorPage /> : <Navigate to="/admin/content" replace />} />
        <Route path="content/merchants/:id" element={hasPermission("write:content") ? <MerchantEditorPage /> : <Navigate to="/admin/content" replace />} />
        <Route path="taxonomy" element={hasPermission("write:content") ? <TaxonomyPage /> : <Navigate to="/admin" replace />} />
        {/* 地点类型、设施类型、地图标签原先是三个入口，合并后旧路径重定向，收藏的链接不失效。 */}
        <Route path="labels" element={<Navigate to="/admin/taxonomy" replace />} />
        <Route path="facility-types" element={<Navigate to="/admin/taxonomy" replace />} />
        <Route path="map-filters" element={<Navigate to="/admin/taxonomy" replace />} />
        <Route path="organizations" element={hasPermission("write:content") ? <OrganizationsPage /> : <Navigate to="/admin" replace />} />
        <Route path="review" element={hasPermission("review:content") ? <ReviewPage /> : <Navigate to="/admin" replace />} />
        <Route path="operations" element={<OperationsPage />} />
        <Route path="operations/new" element={hasPermission("write:content") ? <OperationCreatePage /> : <Navigate to="/admin/operations" replace />} />
        <Route path="operations/:id/edit" element={hasPermission("write:content") ? <OperationCreatePage /> : <Navigate to="/admin/operations" replace />} />
        <Route path="operations/:id" element={<OperationDetailPage />} />
        <Route path="transit" element={hasPermission("write:transit") ? <TransitPage /> : <Navigate to="/admin" replace />} />
        <Route path="floors" element={hasPermission("write:maps") ? <FloorsPage /> : <Navigate to="/admin" replace />} />
        <Route path="maps" element={hasPermission("write:maps") ? <MapsPage /> : <Navigate to="/admin" replace />} />
        <Route path="submissions" element={hasPermission("review:content") ? <SubmissionsPage /> : <Navigate to="/admin" replace />} />
        <Route path="releases" element={hasPermission("publish:release") ? <ReleasesPage /> : <Navigate to="/admin" replace />} />
        <Route path="users" element={hasPermission("manage:users") ? <UsersPage /> : <Navigate to="/admin" replace />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    ),
    [hasPermission],
  );

  if (loading) {
    return (
      <div className="grid h-full w-full place-items-center bg-page text-ink">
        <p className="text-emphasis">加载中...</p>
      </div>
    );
  }

  if (sessionError) {
    return (
      <div className="grid h-full w-full place-items-center bg-page px-5 text-ink">
        <div className="w-full max-w-md rounded-2xl bg-surface p-7 shadow-card">
          <h1 className="text-detail">无法检查登录状态</h1>
          <div className="mt-4"><ErrorBanner message={sessionError} /></div>
          <button
            className="mt-5 w-full rounded-lg bg-primary px-4 py-3 text-body font-semibold text-white"
            onClick={() => void refresh()}
            type="button"
          >
            重新加载
          </button>
        </div>
      </div>
    );
  }

  if (!auth) return <LoginPage />;
  if (!hasPermission("read:admin")) {
    return (
      <div className="grid h-full w-full place-items-center bg-page px-5 text-ink">
        <div className="w-full max-w-md rounded-2xl bg-surface p-7 shadow-card">
          <h1 className="text-detail">无后台访问权限</h1>
          <p className="mt-2 text-body text-sub">当前账号仅可使用志愿者数据采集功能。</p>
          <div className="mt-5 flex gap-3">
            <button className="flex-1 rounded-lg bg-primary px-4 py-3 text-body font-semibold text-white" onClick={() => window.location.assign("/collect")} type="button">前往数据采集</button>
            <button className="rounded-lg border border-line px-4 py-3 text-body font-semibold" onClick={() => void logout()} type="button">退出账号</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    // Provider 包在整个后台外面：侧栏的小黄点与发布中心的清单必须读同一份数据，
    // 两处说法不一致会比没有提示更糟。
    <PendingReleaseProvider>
      <div className="flex h-full w-full overflow-hidden bg-page text-ink">
        <Sidebar displayName={auth.user.displayName} email={auth.user.email} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar displayName={auth.user.displayName} />
          <main className="min-h-0 flex-1 overflow-y-auto p-6">{routes}</main>
        </div>
      </div>
    </PendingReleaseProvider>
  );
}
