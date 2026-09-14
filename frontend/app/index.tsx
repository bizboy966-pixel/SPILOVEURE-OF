import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import { useAuth } from "@/src/auth";
import { useFeature, useFeatures } from "@/src/features";
import { theme } from "@/src/theme";
import LandingPage from "@/src/components/LandingPage";

export default function Index() {
  const { user, loading: authLoading } = useAuth();
  const { loading: featLoading } = useFeatures();
  const landingEnabled = useFeature("landing_page");
  const params = useLocalSearchParams<{ ref?: string }>();
  const refCode = typeof params.ref === "string" ? params.ref : "";
  const router = useRouter();

  useEffect(() => {
    if (authLoading || featLoading) return;
    if (user) {
      if (user.role === "admin") {
        router.replace("/(admin)");
      } else {
        // v16 (2026-02-14) — new activation flow.
        // Pending users are no longer bounced to /pay. They land on the
        // dashboard and can browse the platform freely. The activation
        // modal only pops when they try to run a protected action (via
        // `useActivationGuard()`), and the backend still enforces the
        // rule on protected endpoints (withdrawal, etc.).
        router.replace("/(app)/dashboard");
      }
      return;
    }
    // Referral visitor → ALWAYS see the landing page (regardless of the
    // landing_page feature flag). Direct visitor + landing disabled → login.
    if (!landingEnabled && !refCode) {
      router.replace("/(auth)/login" as any);
    }
  }, [user, authLoading, featLoading, landingEnabled, router, refCode]);

  const stillLoading = authLoading || featLoading;
  // Show the landing page whenever it is enabled OR the visitor came via a
  // referral link (forced storefront discovery per product spec).
  const showLanding = landingEnabled || !!refCode;
  if (stillLoading || user || !showLanding) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  return <LandingPage refCode={refCode} />;
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    backgroundColor: theme.colors.background,
    alignItems: "center",
    justifyContent: "center",
  },
});
