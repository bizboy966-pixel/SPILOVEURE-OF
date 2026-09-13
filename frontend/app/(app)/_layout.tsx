import { Stack, useRouter, useSegments } from "expo-router";
import { useEffect, useRef } from "react";
import { View } from "react-native";
import { useAuth } from "@/src/auth";
import { useI18n } from "@/src/i18n";
import { CommunityPopup } from "@/src/components/CommunityPopup";
import { NotificationToaster } from "@/src/components/NotificationToaster";
import { PushBootstrap } from "@/src/components/PushBootstrap";
import TelegramFab from "@/src/components/TelegramFab";

// Routes accessible to non-activated users. They can browse the "Services"
// showcase (formations, e-books, premium apps, trading) even before paying
// their activation — those pages act as the platform's storefront and must
// not redirect them back to /activation automatically.
const ALLOWED_FOR_PENDING = new Set([
  "activation", "activation-crypto-auto", "activation-ashtec", "pay-ashtec", "pay", "profile", "settings",
  "services", "formations", "ebooks", "premium-apps", "trading",
]);

// ⚡ POST-ACTIVATION GRACE WINDOW
// When a payment flow succeeds it drops a `just_activated` flag in
// localStorage before hard-reloading to /dashboard. During the 60 s
// grace window that follows:
//   • the guard NEVER redirects to /pay, even if /auth/me briefly
//     returns `max_level=0` (Mongo replication lag, CDN cache, etc.),
//   • it actively re-polls refresh() every 500 ms until it sees
//     `max_level ≥ 1` and clears the flag.
// This guarantees convergence and eliminates the "compte s'active
// puis se désactive" bug reported on 2026-09-07 (v3).
const ACTIVATION_GRACE_MS = 60_000;
const ACTIVATION_POLL_MS = 500;

function readJustActivated(): { ts: number; reference?: string; level?: number } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem("just_activated");
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj.ts !== "number") return null;
    if (Date.now() - obj.ts > ACTIVATION_GRACE_MS) {
      window.localStorage.removeItem("just_activated");
      return null;
    }
    return obj;
  } catch {
    return null;
  }
}

function clearJustActivated() {
  if (typeof window === "undefined") return;
  try { window.localStorage.removeItem("just_activated"); } catch {}
}

export default function AppLayout() {
  const { user, loading, refresh } = useAuth();
  const { lang, setLang } = useI18n();
  const router = useRouter();
  const segments = useSegments() as string[];
  const pollTimerRef = useRef<any>(null);

  // Sync the user's stored language preference with the i18n context as soon as
  // /auth/me returns. This ensures the UI flips to the right language on first
  // login (even on a fresh device with empty AsyncStorage).
  useEffect(() => {
    const pref = user?.preferred_language;
    if ((pref === "fr" || pref === "en") && pref !== lang) {
      setLang(pref).catch(() => {});
    }
  }, [user?.preferred_language, lang, setLang]);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace("/(auth)/login");
      return;
    }
    // ─── Pending detection — ONLY if BOTH conditions fail ─────────────
    // Previously we treated a user as pending if EITHER `status !== active`
    // OR `max_level === 0`. That bounced any user who had already gone
    // through activation but ended up in an intermediate state (e.g.
    // the historical "status=active + max_level=0" ghost) — which is
    // exactly the "compte s'active puis se désactive" bug reported on
    // 2026-09-07 (v5). The correct rule is:
    //
    //   A user has completed activation iff at least ONE of the two
    //   activation markers is set (status=active OR max_level ≥ 1).
    //
    // If BOTH are still at their initial values (status=pending AND
    // max_level=0), we redirect them through the payment flow.
    const isPending = user.status === "pending" && (user.max_level || 0) === 0;
    const flag = readJustActivated();

    // ─── User is fully active — clear any lingering activation flag ─
    if (!isPending) {
      clearJustActivated();
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }

    // ─── We are on a "safe" page (payment flow itself, services, etc.)
    // — no guard action required.
    const current = segments[1] || "";
    if (ALLOWED_FOR_PENDING.has(current)) return;

    // ─── Grace window: freshly-activated user whose /auth/me hasn't
    // yet converged. NEVER redirect. Instead, keep refreshing until
    // the fresh state arrives (max ACTIVATION_GRACE_MS).
    if (flag) {
      if (!pollTimerRef.current) {
        pollTimerRef.current = setInterval(() => {
          const stillPending = readJustActivated();
          if (!stillPending) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
            return;
          }
          refresh().catch(() => {});
        }, ACTIVATION_POLL_MS);
      }
      return;
    }

    // ─── No grace flag and user really looks pending → the legitimate
    // "please pay first" flow.
    router.replace("/(app)/pay");
  }, [user, loading, router, segments, refresh]);

  // Housekeeping — stop the poller when the layout unmounts.
  useEffect(() => () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // Mirror the AND-based rule from the guard useEffect above — a user
  // is considered pending ONLY if both markers are at their initial
  // values. This keeps the floating widgets (NotificationToaster, etc.)
  // visible for anyone who has completed activation (even a ghost).
  const isPending = !user || (user.status === "pending" && (user.max_level || 0) === 0);

  return (
    <View style={{ flex: 1 }}>
      <Stack screenOptions={{ headerShown: false }} />
      {user && !isPending && (
        <>
          <CommunityPopup userId={user.id} />
          <NotificationToaster />
          <PushBootstrap />
          <TelegramFab />
        </>
      )}
    </View>
  );
}
