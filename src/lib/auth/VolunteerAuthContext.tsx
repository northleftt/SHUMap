import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { ApiError, apiFetch } from "../api/client";

interface VolunteerUser {
  id: string;
  email: string;
  displayName: string;
}

interface VolunteerAuthValue {
  status: "loading" | "signed_out" | "signed_in" | "forbidden" | "error";
  user: VolunteerUser | null;
  error: string;
  login(email: string, password: string): Promise<boolean>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
}

const VolunteerAuthContext = createContext<VolunteerAuthValue | null>(null);

interface SessionResponse {
  user: VolunteerUser;
  permissions: string[];
}

export function VolunteerAuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<VolunteerAuthValue["status"]>("loading");
  const [user, setUser] = useState<VolunteerUser | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setStatus("loading");
    setError("");
    try {
      const session = await apiFetch<SessionResponse>("/api/auth/session");
      setUser(session.user);
      setStatus(session.permissions.includes("collect:data") || session.permissions.includes("*") ? "signed_in" : "forbidden");
      setError("");
    } catch (reason) {
      setUser(null);
      if (reason instanceof ApiError && reason.isUnauthorized) {
        setStatus("signed_out");
        setError("");
      } else {
        setStatus("error");
        setError(reason instanceof Error ? reason.message : "无法检查志愿者身份");
      }
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    setError("");
    try {
      await apiFetch("/api/auth/login", { method: "POST", body: { email, password } });
      const session = await apiFetch<SessionResponse>("/api/auth/session");
      setUser(session.user);
      const allowed = session.permissions.includes("collect:data") || session.permissions.includes("*");
      setStatus(allowed ? "signed_in" : "forbidden");
      if (!allowed) setError("该账号不在志愿者名单中");
      return allowed;
    } catch (err) {
      setStatus(err instanceof ApiError && err.isUnauthorized ? "signed_out" : "error");
      setUser(null);
      setError(err instanceof Error ? err.message : "登录失败");
      return false;
    }
  }, []);

  const logout = useCallback(async () => {
    try { await apiFetch("/api/auth/logout", { method: "POST" }); } finally {
      setStatus("signed_out");
      setUser(null);
      setError("");
    }
  }, []);

  const value = useMemo(() => ({ status, user, error, login, logout, refresh }), [status, user, error, login, logout, refresh]);
  return <VolunteerAuthContext.Provider value={value}>{children}</VolunteerAuthContext.Provider>;
}

export function useVolunteerAuth(): VolunteerAuthValue {
  const value = useContext(VolunteerAuthContext);
  if (!value) throw new Error("useVolunteerAuth must be used within VolunteerAuthProvider");
  return value;
}
