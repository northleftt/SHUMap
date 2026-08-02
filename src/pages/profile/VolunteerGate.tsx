import { useState } from "react";
import { Outlet } from "react-router-dom";
import { useVolunteerAuth } from "../../lib/auth/VolunteerAuthContext";

export function VolunteerGate() {
  const auth = useVolunteerAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  if (auth.status === "loading") return <div className="grid h-full place-items-center bg-page text-body text-sub">正在检查志愿者身份…</div>;
  if (auth.status === "signed_in") return <Outlet />;
  if (auth.status === "error") {
    return (
      <div className="grid h-full place-items-center bg-page px-5">
        <div className="w-full max-w-sm rounded-2xl bg-surface p-5 shadow-card">
          <h1 className="text-card">身份检查失败</h1>
          <p className="mt-3 rounded-xl bg-error-bg px-3 py-2 text-aux text-error">{auth.error}</p>
          <button className="mt-5 w-full rounded-full bg-primary py-2.5 text-body font-semibold text-white" onClick={() => void auth.refresh()} type="button">重新检查</button>
          <button className="mt-2 w-full py-2 text-aux text-sub" onClick={() => history.back()} type="button">返回</button>
        </div>
      </div>
    );
  }
  if (auth.status === "forbidden") {
    return (
      <div className="grid h-full place-items-center bg-page px-5">
        <div className="w-full max-w-sm rounded-2xl bg-surface p-5 shadow-card">
          <h1 className="text-card">无采集权限</h1>
          <p className="mt-2 text-body text-sub">当前账号未加入志愿者名单，请联系管理员。</p>
          <button className="mt-5 w-full rounded-full bg-primary py-2.5 text-body font-semibold text-white" onClick={() => void auth.logout()} type="button">退出账号</button>
        </div>
      </div>
    );
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
        <h1 className="text-card">志愿者登录</h1>
        <p className="mt-1 text-aux text-sub">名单内账号可领取并跨设备继续采集。</p>
        <label className="mt-5 block text-label text-sub">邮箱<input className="mt-1.5 h-11 w-full rounded-xl bg-page px-3 text-body text-ink outline-none" onChange={(e) => setEmail(e.target.value)} required type="email" value={email} /></label>
        <label className="mt-3 block text-label text-sub">密码<input className="mt-1.5 h-11 w-full rounded-xl bg-page px-3 text-body text-ink outline-none" onChange={(e) => setPassword(e.target.value)} required type="password" value={password} /></label>
        {auth.error ? <p className="mt-3 rounded-xl bg-error-bg px-3 py-2 text-aux text-error">{auth.error}</p> : null}
        <button className="mt-5 w-full rounded-full bg-primary py-2.5 text-body font-semibold text-white disabled:opacity-50" disabled={busy} type="submit">{busy ? "登录中…" : "登录并开始采集"}</button>
        <button className="mt-2 w-full py-2 text-aux text-sub" onClick={() => history.back()} type="button">返回</button>
      </form>
    </div>
  );
}
