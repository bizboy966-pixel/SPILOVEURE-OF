import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";

import { useAuth } from "@/src/auth";
import { useFeature, useFeatures } from "@/src/features";
import { theme } from "@/src/theme";
import LandingPage from "@/src/components/LandingPage";

export default function Index() {
  const { user, loading: authLoading } = useAuth();
  const { loading: featLoading } = useFeatures();
  const landingEnabled = useFeature("landing_page");
  const router = useRouter();

  useEffect(() => {
    if (authLoading || featLoading) return;
    if (user) {
      if (user.role === "admin") {
        router.replace("/(admin)");
      } else if (user.status === "pending" || user.max_level === 0) {
        router.replace("/(app)/activation");
      } else {
        router.replace("/(app)/dashboard");
      }
      return;
    }
    // Public visitor + landing DISABLED → send them straight to /login.
    if (!landingEnabled) {
      router.replace("/(auth)/login");
    }
  }, [user, authLoading, featLoading, landingEnabled, router]);

  const stillLoading = authLoading || featLoading;
  if (stillLoading || user || !landingEnabled) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  // Public visitor + landing ENABLED → render the marketing page.
  return <LandingPage />;
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    backgroundColor: theme.colors.background,
    alignItems: "center",
    justifyContent: "center",
  },
});
