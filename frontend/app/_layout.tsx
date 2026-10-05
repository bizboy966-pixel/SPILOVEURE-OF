import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { useIconFonts } from "@/src/hooks/use-icon-fonts";
import { AuthProvider } from "@/src/auth";
import { I18nProvider } from "@/src/i18n";
import { FeaturesProvider } from "@/src/features";
import { AnimatedSplash } from "@/src/components/AnimatedSplash";
import { WelcomeSplash } from "@/src/components/WelcomeSplash";
import { GlobalFonts } from "@/src/components/GlobalFonts";

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, error] = useIconFonts();

  // v27as (2026-03-04) — SPILOVEURE Service Worker + UpdateGate retirés
  // à la demande utilisateur. On nettoie proactivement toute installation
  // SW et tous les caches shell laissés par les versions v27an/v27aq afin
  // que les clients existants ne soient plus bloqués par un ancien
  // bundle en cache et que Chrome arrête d'afficher « Impossible
  // d'installer cette appli ». Zéro impact fonctionnel sur les utilisateurs
  // nouveaux.
  useEffect(() => {
    if (typeof window === "undefined") return;
    (async () => {
      try {
        if ("serviceWorker" in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
        }
        if (typeof caches !== "undefined") {
          const keys = await caches.keys();
          await Promise.all(
            keys
              .filter((k) => k.startsWith("spiloveure-"))
              .map((k) => caches.delete(k).catch(() => false)),
          );
        }
      } catch { /* ignore */ }
    })();
  }, []);

  useEffect(() => {
    if (loaded || error) {
      SplashScreen.hideAsync();
    }
  }, [loaded, error]);

  if (!loaded && !error) return null;

  return (
    <SafeAreaProvider>
      {/* Applique Nunito à l'ensemble de la plateforme SPILOVEURE (v11
          typographie globale — s'occupe des Text/TextInput RN et injecte les
          règles CSS Google Fonts côté web). Zéro impact sur les couleurs,
          layouts et icônes. */}
      <GlobalFonts />
      <I18nProvider>
        <AuthProvider>
          <FeaturesProvider>
            <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#F8FAFC" } }} />
            <AnimatedSplash />
            <WelcomeSplash />
          </FeaturesProvider>
        </AuthProvider>
      </I18nProvider>
    </SafeAreaProvider>
  );
}
