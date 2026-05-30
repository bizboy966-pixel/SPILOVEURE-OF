import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "@/src/auth";
import { theme } from "@/src/theme";

export default function Index() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace("/(auth)/login");
    } else if (user.role === "admin") {
      router.replace("/(admin)");
    } else if (user.status === "pending" || user.max_level === 0) {
      router.replace("/(app)/activation");
    } else {
      router.replace("/(app)/dashboard");
    }
  }, [user, loading, router]);

  return (
    <View style={styles.center}>
      <ActivityIndicator size="large" color={theme.colors.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, backgroundColor: theme.colors.background, alignItems: "center", justifyContent: "center" },
});
