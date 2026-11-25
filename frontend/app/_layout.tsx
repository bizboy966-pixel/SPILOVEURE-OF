import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { BackHandler, Platform } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { useIconFonts } from "@/src/hooks/use-icon-fonts";
import { KeyboardProvider } from "@/src/components/KeyboardProvider";
import { AuthProvider } from "@/src/auth";
import { I18nProvider } from "@/src/i18n";
import { FeaturesProvider } from "@/src/features";
import { AnimatedSplash } from "@/src/components/AnimatedSplash";
import { WelcomeSplash } from "@/src/components/WelcomeSplash";
import { GlobalFonts } from "@/src/components/GlobalFonts";
import { ChatProvider } from "@/src/chat/ChatContext";
import ChatPushBootstrap from "@/src/components/ChatPushBootstrap";
import AndroidApkUpdateManager from "@/src/components/AndroidApkUpdateManager";
import { confirmAndroidAppExit, resolveAndroidBackAction } from "@/src/navigation/androidBack";

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, error] = useIconFonts();
  const router = useRouter();
  const segments = useSegments() as string[];
  const isMessengerRoute = segments[segments.length - 1] === "messenger";

  useEffect(() => {
    if (Platform.OS !== "web" || process.env.EXPO_PUBLIC_CAPACITOR_NATIVE !== "1") return;
    const onBack = (event: Event) => {
      if (event.defaultPrevented || !router.canGoBack()) return;
      event.preventDefault();
      router.back();
    };
    window.addEventListener("spv-capacitor-back", onBack);
    return () => window.removeEventListener("spv-capacitor-back", onBack);
  }, [router]);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      const action = resolveAndroidBackAction({
        scope: "root",
        isMessengerRoute,
        hasOpenConversation: false,
        canGoBack: router.canGoBack(),
      });
      if (action === "defer-to-messenger" || action === "navigate-back") return false;
      confirmAndroidAppExit();
      return true;
    });
    return () => subscription.remove();
  }, [isMessengerRoute, router]);

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
    // React Native also exposes `window` and `navigator`, but has no browser
    // document or service worker. Keep this PWA-only boot work off Android/iOS.
    if (Platform.OS !== "web" || typeof document === "undefined" || process.env.EXPO_PUBLIC_CAPACITOR_NATIVE === "1") return;

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
      navigator.serviceWorker.getRegistration("/").then(existing => {
        // Both workers use root scope: never replace an active push subscription
        // with the installability-only worker on the next page load.
        const worker = existing?.active || existing?.waiting || existing?.installing;
        if (worker?.scriptURL.includes("/firebase-messaging-sw.js")) return existing;
        return navigator.serviceWorker.register("/sw.js", { scope: "/" });
      }).catch(() => {
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
      <KeyboardProvider>
      {/* Applique Nunito à l'ensemble de la plateforme SPILOVEURE (v11
          typographie globale — s'occupe des Text/TextInput RN et injecte les
          règles CSS Google Fonts côté web). Zéro impact sur les couleurs,
          layouts et icônes. */}
      <GlobalFonts />
      <I18nProvider>
        <AuthProvider>
          <ChatProvider>
          <FeaturesProvider>
            <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#F8FAFC" } }}>
              <Stack.Screen name="index" options={{ contentStyle: { backgroundColor: "#022BA3" } }} />
            </Stack>
            <AnimatedSplash />
            <WelcomeSplash />
            {process.env.EXPO_PUBLIC_CAPACITOR_NATIVE !== "1" && <ChatPushBootstrap />}
            <AndroidApkUpdateManager />
          </FeaturesProvider>
          </ChatProvider>
        </AuthProvider>
      </I18nProvider>
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}
