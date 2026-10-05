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

  // v27at (2026-03-05) — PWA installable (logo officiel SPILOVEURE).
  // Expo Router en mode `output: "single"` ne rend PAS `+html.tsx` à la
  // racine du bundle web : le `index.html` servi par Metro n'inclut que
  // le favicon + theme-color d'app.json, sans manifest ni icons PWA.
  // Pour que Chrome/Edge affichent « Installer l'application » et pas
  // « Impossible d'installer cette appli », on injecte au boot :
  //   • <link rel="manifest" href="/manifest.webmanifest">
  //   • <link rel="icon"       type="image/png" href="/icon-192.png">
  //   • <link rel="icon"       type="image/png" href="/icon-512.png">
  //   • <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  //   • <meta name="theme-color" content="#0B2D6F">        (override)
  //   • <meta name="apple-mobile-web-app-capable" content="yes">
  //   • <meta name="apple-mobile-web-app-title"   content="SPILOVEURE">
  // Puis on enregistre le service worker (passthrough réseau) qui est le
  // dernier critère PWA requis par les navigateurs Chromium.
  useEffect(() => {
    if (typeof window === "undefined") return;

    const ensureLink = (rel: string, href: string, extra: Record<string, string> = {}) => {
      try {
        const sel = `link[rel="${rel}"]${extra.sizes ? `[sizes="${extra.sizes}"]` : ""}`;
        let node = document.head.querySelector(sel) as HTMLLinkElement | null;
        if (!node) { node = document.createElement("link"); node.rel = rel; document.head.appendChild(node); }
        node.href = href;
        Object.entries(extra).forEach(([k, v]) => node!.setAttribute(k, v));
      } catch { /* ignore */ }
    };
    const ensureMeta = (name: string, content: string) => {
      try {
        let node = document.head.querySelector(`meta[name="${name}"]`) as HTMLMetaElement | null;
        if (!node) { node = document.createElement("meta"); node.name = name; document.head.appendChild(node); }
        node.content = content;
      } catch { /* ignore */ }
    };

    ensureLink("manifest", "/manifest.webmanifest");
    ensureLink("icon", "/icon-192.png", { sizes: "192x192", type: "image/png" });
    ensureLink("icon", "/icon-512.png", { sizes: "512x512", type: "image/png" });
    ensureLink("apple-touch-icon", "/apple-touch-icon.png", { sizes: "180x180" });
    ensureMeta("theme-color", "#0B2D6F");
    ensureMeta("apple-mobile-web-app-capable", "yes");
    ensureMeta("apple-mobile-web-app-title", "SPILOVEURE");
    ensureMeta("application-name", "SPILOVEURE");

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        /* installabilité facultative — ne jamais bloquer l'app */
      });
    }
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
