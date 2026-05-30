import React, { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";
import { storage } from "@/src/utils/storage";
import { api } from "@/src/api";

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
      const me = await api.get<User>("/auth/me");
      setUser(me);
    } catch {
      setUser(null);
      await storage.secureRemove("auth_token");
    }
  }, []);

  useEffect(() => {
    (async () => {
      const tok = await storage.secureGet("auth_token", "");
      if (tok) {
        await refresh();
      }
      setLoading(false);
    })();
  }, [refresh]);

  const signIn = async (email: string, password: string) => {
    const r = await api.post<{ access_token: string; user: User }>(
      "/auth/login",
      { email, password },
      { auth: false }
    );
    await storage.secureSet("auth_token", r.access_token);
    setUser(r.user);
  };

  const signUp = async (payload: any) => {
    const r = await api.post<{ access_token: string; user: User }>(
      "/auth/register",
      payload,
      { auth: false }
    );
    await storage.secureSet("auth_token", r.access_token);
    setUser(r.user);
  };

  const signOut = async () => {
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
