import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { ApiError, apiFetch } from "../api/client";

// ---------------------------------------------------------------------------
// 用户端账号会话。
//
// 用户端与管理端共用同一张 users 表和同一个 cookie 会话（GET /api/auth/session），
// 因此这里不区分「志愿者账号」「管理员账号」——差别只在角色权限上。本 Provider 只
// 负责回答「当前是谁」，权限判断交给 AccountGate 的 permission 参数，这样一个
// Provider 能同时服务采集（需要 collect:data）和反馈（任何有效账号即可）两条链路。
// ---------------------------------------------------------------------------

export interface AccountUser {
  id: string;
  email: string;
  displayName: string;
}

export type AccountAuthStatus = "loading" | "signed_out" | "signed_in" | "error";

interface AccountAuthValue {
  status: AccountAuthStatus;
  user: AccountUser | null;
  permissions: string[];
  error: string;
  /** 会话是否具备某项权限（`*` 通吃）。 */
  can(permission: string): boolean;
  login(email: string, password: string): Promise<boolean>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
}

const AccountAuthContext = createContext<AccountAuthValue | null>(null);

interface SessionResponse {
  user: AccountUser;
  permissions: string[];
}

export function AccountAuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AccountAuthStatus>("loading");
  const [user, setUser] = useState<AccountUser | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [error, setError] = useState("");

  const applySession = useCallback((session: SessionResponse) => {
    setUser(session.user);
    setPermissions(session.permissions);
    setStatus("signed_in");
    setError("");
  }, []);

  const clearSession = useCallback(() => {
    setUser(null);
    setPermissions([]);
  }, []);

  const refresh = useCallback(async () => {
    setStatus("loading");
    setError("");
    try {
      applySession(await apiFetch<SessionResponse>("/api/auth/session"));
    } catch (reason) {
      clearSession();
      if (reason instanceof ApiError && reason.isUnauthorized) {
        setStatus("signed_out");
        setError("");
      } else {
        setStatus("error");
        setError(reason instanceof Error ? reason.message : "无法检查登录状态");
      }
    }
  }, [applySession, clearSession]);

  useEffect(() => { void refresh(); }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    setError("");
    try {
      await apiFetch("/api/auth/login", { method: "POST", body: { email, password } });
      applySession(await apiFetch<SessionResponse>("/api/auth/session"));
      return true;
    } catch (err) {
      clearSession();
      setStatus(err instanceof ApiError && err.isUnauthorized ? "signed_out" : "error");
      setError(err instanceof Error ? err.message : "登录失败");
      return false;
    }
  }, [applySession, clearSession]);

  const logout = useCallback(async () => {
    try { await apiFetch("/api/auth/logout", { method: "POST" }); } finally {
      clearSession();
      setStatus("signed_out");
      setError("");
    }
  }, [clearSession]);

  const can = useCallback(
    (permission: string) => permissions.includes("*") || permissions.includes(permission),
    [permissions],
  );

  const value = useMemo(
    () => ({ status, user, permissions, error, can, login, logout, refresh }),
    [status, user, permissions, error, can, login, logout, refresh],
  );
  return <AccountAuthContext.Provider value={value}>{children}</AccountAuthContext.Provider>;
}

export function useAccountAuth(): AccountAuthValue {
  const value = useContext(AccountAuthContext);
  if (!value) throw new Error("useAccountAuth must be used within AccountAuthProvider");
  return value;
}

/** 未挂 Provider 时返回 null，供「我的」这类可选展示账号状态的页面使用。 */
export function useOptionalAccountAuth(): AccountAuthValue | null {
  return useContext(AccountAuthContext);
}
