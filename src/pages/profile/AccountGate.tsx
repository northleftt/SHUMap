import { useState } from "react";
import { Outlet } from "react-router-dom";
import { useAccountAuth } from "../../lib/auth/AccountAuthContext";

/**
 * 需要登录（可选再要求某项权限）的路由门。
 *
 * 志愿者采集走这里并要求 `collect:data`：采集是有组织的数据录入，必须能追责到账号。
 * 反馈**不**走这里——反馈允许匿名，见 FeedbackPage。
 */
export function AccountGate({ permission, title }: { permission?: string; title: string }) {
  const auth = useAccountAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  if (auth.status === "loading") {
    return <div className="grid h-full place-items-center bg-page text-body text-sub">正在检查登录状态…</div>;
  }

  if (auth.status === "error") {
    return (
      <div className="grid h-full place-items-center bg-page px-5">
        <div className="w-full max-w-sm rounded-2xl bg-surface p-5 shadow-card">
          <h1 className="text-card">身份检查失败</h1>
          <p className="mt-3 rounded-xl bg-error-bg px-3 py-2 text-aux text-error">{auth.error}</p>
          <button
            className="mt-5 w-full rounded-full bg-primary py-2.5 text-body font-semibold text-white"
            onClick={() => void auth.refresh()}
            type="button"
          >
            重新检查
          </button>
          <button className="mt-2 w-full py-2 text-aux text-sub" onClick={() => history.back()} type="button">返回</button>
        </div>
      </div>
    );
  }

  if (auth.status === "signed_in") {
    // 登录了但权限不够：这是账号问题，不是登录问题，所以不再给登录表单。
    if (permission && !auth.can(permission)) {
      return (
        <div className="grid h-full place-items-center bg-page px-5">
          <div className="w-full max-w-sm rounded-2xl bg-surface p-5 shadow-card">
            <h1 className="text-card">无采集权限</h1>
            <p className="mt-2 text-body text-sub">
              当前账号（{auth.user?.displayName ?? "未知"}）不在志愿者名单中，请联系管理员开通。
            </p>
            <button
              className="mt-5 w-full rounded-full bg-primary py-2.5 text-body font-semibold text-white"
              onClick={() => void auth.logout()}
              type="button"
            >
              换个账号登录
            </button>
            <button className="mt-2 w-full py-2 text-aux text-sub" onClick={() => history.back()} type="button">返回</button>
          </div>
        </div>
      );
    }
    return <Outlet />;
  }

  return (
    <div className="grid h-full place-items-center bg-page px-5">
      <form
        className="w-full max-w-sm rounded-2xl bg-surface p-5 shadow-card"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          void auth.login(email, password).finally(() => setBusy(false));
        }}
      >
        <h1 className="text-card">{title}</h1>
        <p className="mt-1 text-aux text-sub">与管理后台同一套账号，登录后可跨设备继续。</p>
        <label className="mt-5 block text-label text-sub">
          邮箱
          <input
            autoComplete="username"
            className="mt-1.5 h-11 w-full rounded-xl bg-page px-3 text-body text-ink outline-none"
            onChange={(event) => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />
        </label>
        <label className="mt-3 block text-label text-sub">
          密码
          <input
            autoComplete="current-password"
            className="mt-1.5 h-11 w-full rounded-xl bg-page px-3 text-body text-ink outline-none"
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
        </label>
        {auth.error ? <p className="mt-3 rounded-xl bg-error-bg px-3 py-2 text-aux text-error">{auth.error}</p> : null}
        <button
          className="mt-5 w-full rounded-full bg-primary py-2.5 text-body font-semibold text-white disabled:opacity-50"
          disabled={busy}
          type="submit"
        >
          {busy ? "登录中…" : "登录"}
        </button>
        <button className="mt-2 w-full py-2 text-aux text-sub" onClick={() => history.back()} type="button">返回</button>
      </form>
    </div>
  );
}
