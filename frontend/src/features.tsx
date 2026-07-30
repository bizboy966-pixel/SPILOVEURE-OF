import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "./api";

/**
 * Central store for feature flags. Fetches the public snapshot from
 * `GET /api/features` at mount and refreshes every 60 s so that a change in
 * the admin panel propagates without requiring users to reload.
 *
 * Any component can read the current state via `useFeature("<key>")` or the
 * full map via `useFeatures()`.
 */
export type FeatureKey =
  | "landing_page"
  | "crypto_auto"
  | "ads"
  | "ads_create_video"
  | "ads_create_poster"
  | "special_tasks"
  | "marketplace"
  | "marketplace_publish"
  | "service_request"
  | "paid_tasks";

type FeaturesMap = Record<FeatureKey, boolean>;

const DEFAULT: FeaturesMap = {
  landing_page: false,
  crypto_auto: false,
  ads: false,
  ads_create_video: false,
  ads_create_poster: false,
  special_tasks: false,
  marketplace: false,
  marketplace_publish: false,
  service_request: false,
  paid_tasks: false,
};

type Ctx = {
  features: FeaturesMap;
  loading: boolean;
  refresh: () => Promise<void>;
};

const FeaturesContext = createContext<Ctx>({
  features: DEFAULT,
  loading: true,
  refresh: async () => {},
});

export function FeaturesProvider({ children }: { children: React.ReactNode }) {
  const [features, setFeatures] = useState<FeaturesMap>(DEFAULT);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ features: FeaturesMap }>("/features", { auth: false });
      // Merge over default so any newly-added flag stays `false` until backend
      // exposes it, avoiding "undefined" checks at call sites.
      setFeatures({ ...DEFAULT, ...(r?.features || {}) });
    } catch {
      // On error keep last-known state — do not "open the gates".
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
  }, [refresh]);

  const value = useMemo(() => ({ features, loading, refresh }), [features, loading, refresh]);
  return <FeaturesContext.Provider value={value}>{children}</FeaturesContext.Provider>;
}

export function useFeatures(): Ctx {
  return useContext(FeaturesContext);
}

export function useFeature(key: FeatureKey): boolean {
  return useContext(FeaturesContext).features[key];
}
