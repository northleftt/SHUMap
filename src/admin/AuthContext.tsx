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
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  hasPermission: (permission: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [loading, setLoading] = useState(true);

  // Resolve the current cookie session on mount. A 401 simply means "not logged in".
  useEffect(() => {
    const controller = new AbortController();
    getSession(controller.signal)
      .then((session) => setAuth({ user: session.user, permissions: session.permissions }))
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.isUnauthorized) {
          setAuth(null);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    await apiLogin(email, password);
    // Login sets the cookie; fetch full session (incl. permissions).
    const session = await getSession();
    setAuth({ user: session.user, permissions: session.permissions });
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } finally {
      setAuth(null);
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
    () => ({ auth, loading, login, logout, hasPermission }),
    [auth, loading, login, logout, hasPermission],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
