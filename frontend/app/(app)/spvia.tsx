import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { theme } from "@/src/theme";

/**
 * SPVIA — placeholder for the upcoming SPILOVEURE AI assistant.
 * Future scope : conversational assistant, prompt library,
 * text/image/video generation. Nothing is wired yet.
 */
export default function Spvia() {
  const router = useRouter();
  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="spvia-back">
          <Ionicons name="chevron-back" size={22} color={theme.colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>🤖 SPVIA</Text>
        <View style={{ width: 40 }} />
      </View>
      <View style={styles.center} testID="spvia-soon">
        <View style={styles.iconCircle}>
          <Ionicons name="sparkles" size={48} color="#8B5CF6" />
        </View>
        <Text style={styles.title}>SPVIA</Text>
        <Text style={styles.subTitle}>Votre assistant intelligent arrive bientôt.</Text>
        <View style={styles.badge}>
          <Ionicons name="hourglass-outline" size={14} color="#8B5CF6" />
          <Text style={styles.badgeTxt}>Bientôt disponible</Text>
        </View>
        <Text style={styles.sub}>
          SPVIA vous accompagnera pour générer du texte, des images, des vidéos et interagir
          avec un assistant conversationnel dédié à votre activité SPILOVEURE.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 14, paddingTop: 12, paddingBottom: 10,
  },
  headerTitle: { fontSize: 20, fontWeight: "900", color: theme.colors.textPrimary, letterSpacing: -0.3 },
  iconBtn: {
    width: 40, height: 40, borderRadius: 12,
    alignItems: "center", justifyContent: "center",
    backgroundColor: theme.colors.surfaceMuted,
  },
  center: {
    flex: 1, alignItems: "center", justifyContent: "center",
    padding: 24, paddingBottom: 100, gap: 10,
  },
  iconCircle: {
    width: 96, height: 96, borderRadius: 48,
    backgroundColor: "#8B5CF618",
    alignItems: "center", justifyContent: "center",
    marginBottom: 4,
  },
  title: { fontSize: 30, fontWeight: "900", color: theme.colors.textPrimary, letterSpacing: -0.8 },
  subTitle: { color: theme.colors.textPrimary, fontSize: 14, fontWeight: "700", textAlign: "center" },
  badge: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
    backgroundColor: "#8B5CF618",
    marginTop: 4,
  },
  badgeTxt: { color: "#8B5CF6", fontWeight: "900", fontSize: 11 },
  sub: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 19, textAlign: "center", maxWidth: 320, marginTop: 8 },
});
