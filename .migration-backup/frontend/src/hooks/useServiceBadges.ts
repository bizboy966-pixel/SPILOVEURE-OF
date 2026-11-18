import { useEffect, useState, useCallback } from "react";
import { usePathname } from "expo-router";
import { api } from "@/src/api";

/**
 * useServiceBadges — polls the unread-count endpoints used by the
 * service cards on the home dashboard and the "Voir tout" catalog.
 *
 * v27ao (2026-03-04) — in addition to the integer counts, we now fetch
 * the segmented "WhatsApp status"-style ring data for the Marketplace
 * card (`/marketplace/unread-ring`). Other services keep the plain
 * integer badge until explicitly upgraded.
 */
export type RingSegment = { id: string; seen: boolean; approved_at?: string | null };
export type ServiceBadges = {
  marketplace: number;
  ads: number;
  jobs: number;
  marketplaceRing: {
    unread_count: number;
    segments: RingSegment[];
    has_more: boolean;
  };
};

const ZERO: ServiceBadges = {
  marketplace: 0, ads: 0, jobs: 0,
  marketplaceRing: { unread_count: 0, segments: [], has_more: false },
};
const POLL_MS = 60_000;

export function useServiceBadges() {
  const [badges, setBadges] = useState<ServiceBadges>(ZERO);
  const pathname = usePathname();

  const fetchAll = useCallback(async () => {
    try {
      const [ring, a, j] = await Promise.all([
        api.get<{ unread_count: number; segments: RingSegment[]; has_more: boolean }>(
          "/marketplace/unread-ring",
        ).catch(() => ({ unread_count: 0, segments: [], has_more: false })),
        api.get<{ unread: number }>("/ads/unread-count").catch(() => ({ unread: 0 })),
        api.get<{ unread: number }>("/jobs/unread-count").catch(() => ({ unread: 0 })),
      ]);
      setBadges({
        marketplace: ring.unread_count || 0,
        ads: a.unread || 0,
        jobs: j.unread || 0,
        marketplaceRing: {
          unread_count: ring.unread_count || 0,
          segments: Array.isArray(ring.segments) ? ring.segments : [],
          has_more: !!ring.has_more,
        },
      });
    } catch {
      /* keep previous state on transient failure */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => { if (!cancelled) await fetchAll(); })();
    const iv = setInterval(() => { fetchAll(); }, POLL_MS);
    return () => { cancelled = true; clearInterval(iv); };
  }, [pathname, fetchAll]);

  // Expose a refresh fn so pages that mark items seen can bust the cache
  // without waiting 60 s for the next poll.
  (badges as any).refresh = fetchAll;
  return badges as ServiceBadges & { refresh: () => Promise<void> };
}
