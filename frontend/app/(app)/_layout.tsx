import { Stack, useRouter, useSegments } from "expo-router";
import { useEffect, useMemo } from "react";
import { View } from "react-native";
import { useAuth } from "@/src/auth";
import { useI18n } from "@/src/i18n";
import { CommunityPopup } from "@/src/components/CommunityPopup";
import { NotificationToaster } from "@/src/components/NotificationToaster";
import { PushBootstrap } from "@/src/components/PushBootstrap";
import TelegramFab from "@/src/components/TelegramFab";
import { ActivationProvider } from "@/src/components/ActivationGuard";

/**
 * v27c (2026-02-14) — activation flow rétabli.
 *
 * L'utilisateur veut : après inscription (ou login sans avoir activé),
 * on tombe DIRECTEMENT sur `/(app)/pay` (sélecteur Paiement Mobile /
 * Crypto). Impossible d'accéder au dashboard tant que le compte n'est
 * pas activé. Les seules routes ouvertes aux comptes pending sont donc :
 *   - /pay, /pay-ashtec (sélecteur + gateway direct)
 *   - /activation, /activation-ashtec, /activation-crypto-auto
 *   - /profile (permet à l'utilisateur de vérifier/modifier ses infos)
 * Toute autre route protégée bounce automatiquement vers `/(app)/pay`.
 *
 * Une fois `max_level >= 1`, le guard laisse passer (activation-required
 * modal on-demand pour les actions protégées si le compte redevient
 * pending, ce qui n'arrive pas en pratique).
 */
const PENDING_ALLOWED_SEGMENTS = new Set<string>([
  "pay", "pay-ashtec",
  "activation", "activation-ashtec", "activation-crypto-auto",
  "profile",
]);

export default function AppLayout() {
  const { user, loading } = useAuth();
  const { lang, setLang } = useI18n();
  const router = useRouter();
  const segments = useSegments() as string[];

  const isPending = useMemo(() => {
    if (!user) return false;
    return user.status === "pending" && (user.max_level || 0) === 0;
  }, [user]);

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
    if (isPending) {
      // segments = ["(app)", "<screen>", ...]
      const current = segments[1] || "";
      if (!PENDING_ALLOWED_SEGMENTS.has(current)) {
        router.replace("/(app)/pay");
      }
    }
  }, [user, loading, isPending, router, segments]);

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
