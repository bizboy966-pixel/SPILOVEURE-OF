import { Stack, useRouter, useSegments } from "expo-router";
import { useEffect } from "react";
import { View } from "react-native";
import { useAuth } from "@/src/auth";
import { useI18n } from "@/src/i18n";
import { CommunityPopup } from "@/src/components/CommunityPopup";
import { NotificationToaster } from "@/src/components/NotificationToaster";
import { PushBootstrap } from "@/src/components/PushBootstrap";
import ChatBubble from "@/src/components/ChatBubble";

// Routes accessible to non-activated users. They can browse the "Services"
// showcase (formations, e-books, premium apps, trading) even before paying
// their activation — those pages act as the platform's storefront and must
// not redirect them back to /activation automatically.
const ALLOWED_FOR_PENDING = new Set([
  "activation", "activation-crypto-auto", "activation-ashtec", "pay-ashtec", "pay", "profile", "settings",
  "services", "formations", "ebooks", "premium-apps", "trading",
]);

export default function AppLayout() {
  const { user, loading } = useAuth();
  const { lang, setLang } = useI18n();
  const router = useRouter();
  const segments = useSegments() as string[];

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
    // Non-activated users (status=pending OR max_level=0) cannot access the
    // services / dashboard / wallet / team. They are forced back to /activation.
    const isPending = user.status === "pending" || (user.max_level || 0) === 0;
    if (!isPending) return;

    // segments looks like ["(app)", "dashboard"] or ["(app)", "services"]
    const current = segments[1] || "";
    if (!ALLOWED_FOR_PENDING.has(current)) {
      router.replace("/(app)/pay");
    }
  }, [user, loading, router, segments]);

  // A user is "activated" once they have successfully unlocked at least one
  // matrix level. Until then, no floating widgets, no community popup, and no
  // access to lottery/services/missions/etc.
  const isPending = !user || user.status === "pending" || (user.max_level || 0) === 0;

  return (
    <View style={{ flex: 1 }}>
      <Stack screenOptions={{ headerShown: false }} />
      {/* Welcome splash — needs to show even for pending users right after
          they sign up / sign in. Always mount when a user is loaded. */}
      {user && !isPending && (
        <>
          <CommunityPopup userId={user.id} />
          <NotificationToaster />
          <PushBootstrap />
          <ChatBubble />
        </>
      )}
    </View>
  );
}
