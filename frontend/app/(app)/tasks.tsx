import React from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { theme } from "@/src/theme";
import { BottomNav } from "@/src/components/BottomNav";

/**
 * TÂCHES — new v17 landing (2026-02-14).
 *
 * Per the product spec, the tasks hub is now streamlined to only two
 * priority entry points: Missions rémunérées and Publicités rémunérées.
 * Every other tasks-related feature (Tâches spéciales, Challenges actifs
 * and the active user-submitted tasks list) has been moved behind the
 * `Voir plus` button that opens `/(app)/tasks-more`.
 *
 * No business logic is changed — cards are just new access points to the
 * existing routes.
 */
const MAIN_CARDS = [
  {
    key: "missions",
    title: "Missions rémunérées",
    subtitle: "Complétez des missions quotidiennes et recevez des gains par catégorie.",
    icon: "briefcase",
    color: "#10B981",
    bg: "#D1FAE5",
    route: "/(app)/missions",
  },
  {
    key: "ads-rewards",
    title: "Publicités rémunérées",
    subtitle: "Regardez, aimez et commentez des publicités pour gagner des FCFA.",
    icon: "megaphone",
    color: "#EC4899",
    bg: "#FCE7F3",
    route: "/(app)/reactor-rewards",
  },
];

export default function TasksScreen() {
  const router = useRouter();

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <SafeAreaView edges={["top"]}>
          <View style={styles.headerRow}>
            <TouchableOpacity onPress={() => router.back()} style={styles.back} testID="tasks-back">
              <Ionicons name="chevron-back" size={22} color="#fff" />
            </TouchableOpacity>
            <View>
              <Text style={styles.title}>Tâches</Text>
              <Text style={styles.subtitle}>Choisissez une catégorie</Text>
            </View>
          </View>
        </SafeAreaView>
      </LinearGradient>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 140 }} showsVerticalScrollIndicator={false}>
        {MAIN_CARDS.map((c) => (
          <TouchableOpacity
            key={c.key}
            style={styles.card}
            onPress={() => router.push(c.route as any)}
            activeOpacity={0.85}
            testID={`tasks-card-${c.key}`}
          >
            <View style={[styles.iconWrap, { backgroundColor: c.bg }]}>
              <Ionicons name={c.icon as any} size={28} color={c.color} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>{c.title}</Text>
              <Text style={styles.cardSub} numberOfLines={2}>{c.subtitle}</Text>
            </View>
            <Ionicons name="chevron-forward" size={22} color={theme.colors.textSecondary} />
          </TouchableOpacity>
        ))}

        <TouchableOpacity
          onPress={() => router.push("/(app)/tasks-more" as any)}
          style={styles.seeMoreBtn}
          activeOpacity={0.85}
          testID="tasks-see-more"
        >
          <Text style={styles.seeMoreTxt}>Voir plus</Text>
          <Ionicons name="chevron-down" size={16} color={theme.colors.primary} />
        </TouchableOpacity>
      </ScrollView>

      <BottomNav />
    </View>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 14, paddingBottom: 14 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 6 },
  back: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: "rgba(255,255,255,0.16)",
    alignItems: "center", justifyContent: "center",
  },
  title: { color: "#fff", fontSize: 20, fontWeight: "900", letterSpacing: -0.2 },
  subtitle: { color: "#A5C2FF", fontSize: 11, marginTop: 2 },

  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 16,
    borderRadius: 20,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginBottom: 14,
    ...theme.shadow.card,
  },
  iconWrap: {
    width: 60, height: 60, borderRadius: 20,
    alignItems: "center", justifyContent: "center",
  },
  cardTitle: {
    fontSize: 15, fontWeight: "900",
    color: theme.colors.textPrimary, letterSpacing: -0.2,
  },
  cardSub: {
    fontSize: 12, color: theme.colors.textSecondary,
    marginTop: 4, lineHeight: 18,
  },
  seeMoreBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    marginTop: 10,
    paddingVertical: 14,
    borderRadius: 16,
    backgroundColor: theme.colors.primaryBg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  seeMoreTxt: {
    color: theme.colors.primary,
    fontWeight: "900",
    fontSize: 14,
  },
});
