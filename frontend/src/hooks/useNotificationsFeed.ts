/**
 * useNotificationsFeed — lightweight polling hook that:
 *   • hits `/api/me/notifications/unread-count` every 10 s
 *   • when the count increases, fetches new items and returns them
 *   • exposes `markAllRead()` to reset the badge
 *
 * Intentional design: no websockets / vendor SDK, portable, disables
 * itself gracefully if the endpoint is unavailable (dev preview outages
 * won't crash the shell).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/src/api";

export type AppNotification = {
  id: string;
  user_id: string;
  kind: string;
  title?: string;
  body?: string;
  message?: string;
  meta?: Record<string, any>;
  read: boolean;
  created_at: string;
};

type State = {
  unread: number;
  latest: AppNotification[];
  isReady: boolean;
};

export function useNotificationsFeed(pollMs: number = 10000) {
  const [state, setState] = useState<State>({ unread: 0, latest: [], isReady: false });
  const cancelledRef = useRef(false);
  const lastUnreadRef = useRef(0);

  const fetchOnce = useCallback(async () => {
    try {
      const c = await api.get<{ unread: number }>("/me/notifications/unread-count");
      const nextUnread = c.unread || 0;
      if (nextUnread > lastUnreadRef.current) {
        // Only fetch the actual items when the count grows — avoids
        // pulling the full list on every tick.
        const list = await api.get<{ items: AppNotification[] }>(
          "/me/notifications?unread_only=true&limit=10",
        );
        if (!cancelledRef.current) {
          setState({ unread: nextUnread, latest: list.items || [], isReady: true });
        }
      } else if (!cancelledRef.current) {
        setState((s) => ({ ...s, unread: nextUnread, isReady: true }));
      }
      lastUnreadRef.current = nextUnread;
    } catch {
      // Silent — endpoint may not exist in the preview backend yet.
      if (!cancelledRef.current) {
        setState((s) => ({ ...s, isReady: true }));
      }
    }
  }, []);

  const markAllRead = useCallback(async () => {
    try {
      await api.post("/me/notifications/mark-all-read", {});
      lastUnreadRef.current = 0;
      setState({ unread: 0, latest: [], isReady: true });
    } catch {}
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    fetchOnce();
    const t = setInterval(fetchOnce, Math.max(3000, pollMs));
    return () => {
      cancelledRef.current = true;
      clearInterval(t);
    };
  }, [fetchOnce, pollMs]);

  return { ...state, refresh: fetchOnce, markAllRead };
}
