import { Stack, useRouter, useSegments } from "expo-router";
import { useEffect } from "react";
import { View } from "react-native";
import { useAuth } from "@/src/auth";
import { useI18n } from "@/src/i18n";
import { CommunityPopup } from "@/src/components/CommunityPopup";
import { NotificationToaster } from "@/src/components/NotificationToaster";
import { PushBootstrap } from "@/src/components/PushBootstrap";
import TelegramFab from "@/src/components/TelegramFab";
import { ActivationProvider } from "@/src/components/ActivationGuard";

/**
 * v16 (2026-02-14) — new activation flow.
 *
 * The historical guard used to bounce pending users to `/(app)/pay`
 * automatically. Product spec says otherwise now: a pending user
 * should be able to browse the whole platform, and only be prompted
 * for activation when they try to run a PROTECTED action (retrait,
 * publier, participer, etc.). The `<ActivationProvider>` centralises
 * this — see `useActivationGuard()`.
 *
 * Therefore this layout ONLY handles auth (not-logged-in → /login).
 */
export default function AppLayout() {
  const { user, loading } = useAuth();
  const { lang, setLang } = useI18n();
  const router = useRouter();
  const segments = useSegments() as string[];

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
  }, [user, loading, router, segments]);

  return (
    <ActivationProvider>
      <View style={{ flex: 1 }}>
        <Stack screenOptions={{ headerShown: false }} />
        {user && (
          <>
            <CommunityPopup userId={user.id} />
            <NotificationToaster />
            <PushBootstrap />
            <TelegramFab />
          </>
        )}
      </View>
    </ActivationProvider>
  );
}
