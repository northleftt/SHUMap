import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { getSession, login as apiLogin, logout as apiLogout } from "../lib/api/admin";
import type { SessionUser } from "../lib/api/admin";
import { ApiError } from "../lib/api/client";

// Cookie-session auth. The HttpOnly session cookie is set by the Worker on login
// and sent automatically (credentials: "include"); there is NO localStorage token
// and NO public first-admin bootstrap UX — bootstrap is deployment-only.

interface AuthState {
  user: SessionUser;
  permissions: string[];
}

interface AuthContextValue {
  auth: AuthState | null;
  loading: boolean;
  sessionError: string;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  hasPermission: (permission: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionError, setSessionError] = useState("");

  const resolveSession = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setSessionError("");
    try {
      const session = await getSession(signal);
      if (signal?.aborted) return;
      setAuth({ user: session.user, permissions: session.permissions });
    } catch (error) {
      if (signal?.aborted) return;
      setAuth(null);
      if (error instanceof ApiError && error.isUnauthorized) {
        setSessionError("");
      } else {
        setSessionError(error instanceof Error ? error.message : "无法读取登录状态");
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  // Resolve the current cookie session on mount. A 401 means there is no active session.
  useEffect(() => {
    const controller = new AbortController();
    void resolveSession(controller.signal);
    return () => controller.abort();
  }, [resolveSession]);

  const refresh = useCallback(() => resolveSession(), [resolveSession]);

  const login = useCallback(async (email: string, password: string) => {
    await apiLogin(email, password);
    // Login sets the cookie; fetch full session (incl. permissions).
    const session = await getSession();
    setAuth({ user: session.user, permissions: session.permissions });
    setSessionError("");
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } finally {
      setAuth(null);
      setSessionError("");
    }
  }, []);

  const hasPermission = useCallback(
    (permission: string) => {
      if (!auth) return false;
      return auth.permissions.includes("*") || auth.permissions.includes(permission);
    },
    [auth],
  );

  const value = useMemo(
    () => ({ auth, loading, sessionError, login, logout, refresh, hasPermission }),
    [auth, loading, sessionError, login, logout, refresh, hasPermission],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
