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
