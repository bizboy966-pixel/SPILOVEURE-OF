import React from "react";
import { SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { useFeature, FeatureKey } from "@/src/features";
import { theme } from "@/src/theme";

/**
 * Wrap a screen so it renders the "Fonctionnalité désactivée" placeholder
 * whenever the linked feature flag is OFF. This is the last line of defence
 * against direct-URL bypass — the corresponding backend endpoints also
 * enforce the flag with `require_feature(...)`.
 */
export function FeatureGuard({
  featureKey,
  children,
  title,
}: {
  featureKey: FeatureKey;
  children: React.ReactNode;
  title?: string;
}) {
  const enabled = useFeature(featureKey);
  const router = useRouter();

  if (enabled) return <>{children}</>;

  return (
    <SafeAreaView style={styles.safe} testID={`feature-disabled-${featureKey}`}>
      <View style={styles.card}>
        <View style={styles.iconBox}>
          <Ionicons name="lock-closed" size={44} color={theme.colors.warning} />
        </View>
        <Text style={styles.title}>{title || "Fonctionnalité désactivée"}</Text>
        <Text style={styles.desc}>
          Cette fonctionnalité est momentanément désactivée par l'administrateur.
          {"\n"}Elle sera de nouveau disponible dès son activation officielle.
        </Text>
        <TouchableOpacity
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/(app)/dashboard"))}
          style={styles.btn}
          testID={`feature-disabled-back-${featureKey}`}
        >
          <Ionicons name="arrow-back" size={16} color="#fff" />
          <Text style={styles.btnT}>Retour</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background, alignItems: "center", justifyContent: "center", padding: 24 },
  card: {
    width: "100%", maxWidth: 420,
    backgroundColor: theme.colors.surface,
    borderRadius: 20, padding: 28,
    borderWidth: 1, borderColor: theme.colors.border,
    alignItems: "center",
  },
  iconBox: {
    width: 90, height: 90, borderRadius: 45,
    backgroundColor: "#FEF3C7",
    alignItems: "center", justifyContent: "center",
    marginBottom: 16,
  },
  title: { fontSize: 20, fontWeight: "900", color: theme.colors.textPrimary, textAlign: "center" },
  desc: { fontSize: 13, color: theme.colors.textSecondary, lineHeight: 20, marginTop: 10, textAlign: "center" },
  btn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    marginTop: 20, backgroundColor: theme.colors.primary,
    paddingHorizontal: 20, paddingVertical: 11, borderRadius: 12,
  },
  btnT: { color: "#fff", fontWeight: "800", fontSize: 14 },
});
