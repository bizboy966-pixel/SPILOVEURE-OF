import { Stack, useRouter, useSegments } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { useAuth } from "@/src/auth";
import { useI18n } from "@/src/i18n";
import { CommunityPopup } from "@/src/components/CommunityPopup";
import { SupportGroupPopup } from "@/src/components/SupportGroupPopup";
import { NotificationToaster } from "@/src/components/NotificationToaster";
import { PushBootstrap } from "@/src/components/PushBootstrap";
import TelegramFab from "@/src/components/TelegramFab";
import { ActivationProvider } from "@/src/components/ActivationGuard";
import { NavigationTransitionProvider } from "@/src/messenger/NavigationTransition";
import { api } from "@/src/api";

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
  const [communityDone, setCommunityDone] = useState(false);
  const [payChatStatus, setPayChatStatus] = useState<"idle" | "checking" | "done">("idle");

  const isPending = useMemo(() => {
    if (!user) return false;
    return user.status === "pending" && (user.max_level || 0) === 0;
  }, [user]);

  // v27e (2026-02-14) — le bouton flottant Telegram et le pop-up chaîne
  // d'information ne doivent apparaître QUE pour les comptes réellement
  // activés (paiement confirmé). Un compte "pending" (inscrit mais non
  // activé) ne doit pas y avoir accès.
  const isActivated = useMemo(() => {
    if (!user) return false;
    return user.status === "active" && (user.max_level || 0) >= 1;
  }, [user]);
  const needsAccountAccess = !!user && user.auth_flow_version === 2 && isActivated &&
    !user.main_password_created;

  // v27d (2026-02-14) — compute the "bounce" decision at render time so
  // we can short-circuit `<Stack>` BEFORE the target screen has a chance
  // to render + flash. Previously the target route mounted, its `load()`
  // spinner rendered, and only then the `useEffect` fired `router.replace`
  // → the user saw the target page appear then instantly disappear.
  // Expo can retain this layout while a root-level identity route opens.
  // An off-screen payment guard must not redirect that route back to /pay.
  const inAppGroup = segments[0] === "(app)";
  const currentSeg = inAppGroup ? (segments[1] || "") : "";
  const isMessenger = currentSeg === "messenger";
  const isDashboard = inAppGroup && currentSeg === "dashboard";
  useEffect(() => {
    if (loading || user || currentSeg !== "pay") {
      if (user || currentSeg !== "pay") setPayChatStatus("idle");
      return;
    }
    let active = true;
    setPayChatStatus("checking");
    api.get<{ user: { id: string } }>("/identity/chat/session", { auth: false, credentials: "include" })
      .then(() => { if (active) router.replace("/account-access?source=chat" as any); })
      .catch(() => { if (active) router.replace("/(auth)/login" as any); })
      .finally(() => { if (active) setPayChatStatus("done"); });
    return () => { active = false; };
  }, [loading, user, currentSeg, router]);
  const shouldBounceToPay = inAppGroup &&
    !loading && !!user && isPending && !isMessenger && !PENDING_ALLOWED_SEGMENTS.has(currentSeg);

  useEffect(() => {
    const pref = user?.preferred_language;
    if ((pref === "fr" || pref === "en") && pref !== lang) {
      setLang(pref).catch(() => {});
    }
  }, [user?.preferred_language, lang, setLang]);

  useEffect(() => {
    if (loading || !inAppGroup) return;
    if (!user && currentSeg === "pay") return;
    if (!user && !isMessenger) {
      router.replace("/(auth)/login");
      return;
    }
    if (needsAccountAccess && !isMessenger) {
      router.replace("/account-access" as any);
      return;
    }
    if (shouldBounceToPay) {
      router.replace("/(app)/pay");
    }
  }, [user, loading, shouldBounceToPay, router, isMessenger, needsAccountAccess, currentSeg, inAppGroup]);

  // While we're about to bounce, render an empty screen so the target
  // page never has a chance to mount + call its API + spin. This kills
  // the "click, enter, exit" flash the user reported.
  if (shouldBounceToPay || (inAppGroup && needsAccountAccess && !isMessenger)) {
    return <View style={{ flex: 1, backgroundColor: "#fff" }} />;
  }
  if (!loading && !user && currentSeg === "pay" && payChatStatus !== "done") {
    return <View style={{ flex: 1, backgroundColor: "#F6F8FB", alignItems: "center", justifyContent: "center" }} />;
  }

  return (
    <ActivationProvider>
      <View style={{ flex: 1 }}>
        <NavigationTransitionProvider>
          <>
            <Stack screenOptions={{ headerShown: false }} />
            {user && inAppGroup && (
              <>
                {!isMessenger && isActivated && <CommunityPopup userId={user.id} onDone={() => setCommunityDone(true)} />}
                {!isMessenger && isActivated && <SupportGroupPopup enabled={communityDone} />}
                {!isMessenger && <NotificationToaster />}
                {!isMessenger && <PushBootstrap />}
                {isDashboard && isActivated && <TelegramFab />}
              </>
            )}
          </>
        </NavigationTransitionProvider>
      </View>
    </ActivationProvider>
  );
}
