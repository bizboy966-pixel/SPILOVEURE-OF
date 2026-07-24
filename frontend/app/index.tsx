import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";

import { useAuth } from "@/src/auth";
import { theme } from "@/src/theme";
import LandingPage from "@/src/components/LandingPage";

export default function Index() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading || !user) return;
    if (user.role === "admin") {
      router.replace("/(admin)");
    } else if (user.status === "pending" || user.max_level === 0) {
      router.replace("/(app)/activation");
    } else {
      router.replace("/(app)/dashboard");
    }
  }, [user, loading, router]);

  // While auth state is being resolved, avoid a "flash" of the landing page.
  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  // Authenticated users are being redirected via the effect above — show a
  // spinner in the meantime rather than the marketing page.
  if (user) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  // Public visitors → marketing landing page.
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
