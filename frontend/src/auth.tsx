import React, { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";
import { storage } from "@/src/utils/storage";
import { api, setAuthToken, setUnauthorizedHandler } from "@/src/api";

export type User = {
  id: string;
  username: string;
  email: string;
  phone: string;
  country: string;
  role: "user" | "admin";
  status: "pending" | "active" | "blocked" | "banned";
  max_level: number;
  sponsor_id: string | null;
  sponsor_username: string | null;
  balance_profit: number;
  balance_upgrade: number;
  commission_direct: number;
  commission_spillover: number;
  total_earned: number;
  total_withdrawn: number;
  withdrawals_disabled?: boolean;
  preferred_language?: "fr" | "en";
  created_at: string;
};

type Ctx = {
  user: User | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (payload: any) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<Ctx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      // Cache-bust `/auth/me` with a timestamp so no proxy/CDN/browser
      // layer serves us stale user data (max_level/status). This is
      // critical right after an activation — the layout guard reads
      // this value and redirects to /pay when it looks pending.
      const me = await api.get<User>(`/auth/me?_t=${Date.now()}`);
      setUser(me);
    } catch (e: any) {
      // v27aa (2026-03-04) — CRITICAL fix : previous version wiped the
      // user + token on ANY error, which meant a single aborted fetch
      // (rapid page navigation cancels in-flight requests on web) or a
      // transient 502 was enough to log the user out mid-session. Now
      // we ONLY wipe on a genuine 401 JWT failure — the api.ts 401
      // handler already routes those to signOut anyway, so this catch
      // becomes a soft no-op for real auth expiry and a NO-OP for every
      // other transient error.
      const status = e?.status;
      const isAbort =
        e?.name === "AbortError" ||
        e?.message === "The user aborted a request." ||
        e?.message === "Failed to fetch";
      if (status === 401) {
        setUser(null);
        setAuthToken(null);
        await storage.secureRemove("auth_token");
      } else if (isAbort) {
        // silent — component unmount / navigation cancelled our request
      } else {
        // keep the existing user in state ; log for observability
        // eslint-disable-next-line no-console
        console.warn("[auth.refresh] transient error, keeping session:", e?.detail || e?.message || e);
      }
    }
  }, []);

  useEffect(() => {
    (async () => {
      const tok = await storage.secureGet("auth_token", "");
      if (tok) {
        setAuthToken(tok as string); // hydrate sync cache BEFORE first /auth/me
        await refresh();
      }
      setLoading(false);
    })();
  }, [refresh]);

  // ── Global sign-out on JWT expiry ────────────────────────────────
  // Once mounted, register a hook so any API 401 that matches a JWT
  // failure (Session expirée / Token invalide / Token manquant / ...)
  // clears the local session and forces a fresh login. Prior to this,
  // pages with expired tokens produced an endless stream of
  // "Session expirée" alerts on every action (Challenge Performance
  // being the most visible offender).
  useEffect(() => {
    setUnauthorizedHandler((message) => {
      setUser(null);
      setAuthToken(null);
      // fire-and-forget — no need to block on storage flush
      storage.secureRemove("auth_token").catch(() => {});
      if (typeof window !== "undefined") {
        // Alert once, then let the auth guard redirect the user.
        // Use a small delay so React finishes the current render.
        setTimeout(() => {
          try { window.alert(`⚠️ ${message} Veuillez vous reconnecter.`); } catch {}
          try { window.location.assign("/(auth)/login"); } catch {}
        }, 50);
      }
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const signIn = async (email: string, password: string) => {
    const r = await api.post<{ access_token: string; user: User }>(
      "/auth/login",
      { email, password },
      { auth: false }
    );
    setAuthToken(r.access_token); // sync update BEFORE any subsequent request
    await storage.secureSet("auth_token", r.access_token);
    setUser(r.user);
  };

  const signUp = async (payload: any) => {
    const r = await api.post<{ access_token: string; user: User }>(
      "/auth/register",
      payload,
      { auth: false }
    );
    setAuthToken(r.access_token);
    await storage.secureSet("auth_token", r.access_token);
    setUser(r.user);
  };

  const signOut = async () => {
    setAuthToken(null);
    await storage.secureRemove("auth_token");
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signUp, signOut, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const c = useContext(AuthContext);
  if (!c) throw new Error("useAuth must be inside AuthProvider");
  return c;
}
