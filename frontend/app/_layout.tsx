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

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, error] = useIconFonts();

  useEffect(() => {
    if (loaded || error) {
      SplashScreen.hideAsync();
    }
  }, [loaded, error]);

  if (!loaded && !error) return null;

  return (
    <SafeAreaProvider>
      <I18nProvider>
        <AuthProvider>
          <FeaturesProvider>
            <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#F8FAFC" } }} />
            {/* Premium intro overlay — auto-dismisses after ~2.2 s, then
                remembers the visit via sessionStorage so navigations inside
                the same tab don't replay it. */}
            <AnimatedSplash />
            {/* One-shot "Bienvenue @username" mini banner after sign-in /
                sign-up. Read the pending flag from sessionStorage on user
                change, then clears it — never replays inside a session. */}
            <WelcomeSplash />
          </FeaturesProvider>
        </AuthProvider>
      </I18nProvider>
    </SafeAreaProvider>
  );
}
