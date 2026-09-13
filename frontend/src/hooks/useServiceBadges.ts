import { useEffect, useState } from "react";
import { usePathname } from "expo-router";
import { api } from "@/src/api";

/**
 * useServiceBadges — polls the unread-count endpoints used by the
 * service cards on the home dashboard and the "Voir tout" catalog.
 *
 * The badges displayed here mirror EXACTLY the same "new content"
 * indicators that were previously wired to the bottom-nav items.
 * Reorganising the interface must NEVER remove them.
 */
export type ServiceBadges = {
  marketplace: number;
  ads: number;
  jobs: number;
};

const ZERO: ServiceBadges = { marketplace: 0, ads: 0, jobs: 0 };
const POLL_MS = 60_000;

export function useServiceBadges(): ServiceBadges {
  const [badges, setBadges] = useState<ServiceBadges>(ZERO);
  const pathname = usePathname();

  useEffect(() => {
    let cancelled = false;
    const fetchAll = async () => {
      try {
        const [m, a, j] = await Promise.all([
          api.get<{ unread: number }>("/marketplace/unread-count").catch(() => ({ unread: 0 })),
          api.get<{ unread: number }>("/ads/unread-count").catch(() => ({ unread: 0 })),
          api.get<{ unread: number }>("/jobs/unread-count").catch(() => ({ unread: 0 })),
        ]);
        if (!cancelled) {
          setBadges({
            marketplace: m.unread || 0,
            ads: a.unread || 0,
            jobs: j.unread || 0,
          });
        }
      } catch {
        if (!cancelled) setBadges(ZERO);
      }
    };
    fetchAll();
    const iv = setInterval(fetchAll, POLL_MS);
    return () => { cancelled = true; clearInterval(iv); };
  }, [pathname]);

  return badges;
}
