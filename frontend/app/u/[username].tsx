import { useEffect } from "react";
import { ActivityIndicator, Platform, StyleSheet, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { theme } from "@/src/theme";

/**
 * Public referral landing route: /u/<username>
 * On web, redirects via `window.location.replace` to /register?ref=<username>
 * so the sponsor is auto-filled (and locked, see register.tsx).
 */
export default function ReferralRedirect() {
  const { username } = useLocalSearchParams<{ username: string }>();

  useEffect(() => {
    const ref = (typeof username === "string" ? username : "admin").trim() || "admin";
    if (Platform.OS === "web" && typeof window !== "undefined") {
      window.location.replace(`/register?ref=${encodeURIComponent(ref)}`);
    }
  }, [username]);

  return (
    <View style={styles.center}>
      <ActivityIndicator size="large" color={theme.colors.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, backgroundColor: theme.colors.background, alignItems: "center", justifyContent: "center" },
});
