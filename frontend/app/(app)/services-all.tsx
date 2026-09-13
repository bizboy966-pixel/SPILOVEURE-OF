import React from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { theme } from "@/src/theme";
import { BottomNav } from "@/src/components/BottomNav";
import { useServiceBadges } from "@/src/hooks/useServiceBadges";

/**
 * "Voir tout" — full catalog of every service available on the platform.
 * Each card is a shortcut to the pre-existing screen (no new business
 * logic is created here). The 8 main services from the home dashboard
 * are listed first, followed by the extra services accessible only from
 * this catalog page (Publier un article, Application Premium, Matrice,
 * Mon équipe, Communauté).
 */
type Service = {
  key: string;
  label: string;
  icon: any;
  color: string;
  bg: string;
  route: string;
};

const MAIN: Service[] = [
  { key: "marketplace", label: "Marketplace",  icon: "cart",      color: "#F59E0B", bg: "#FEF3C7", route: "/(app)/marketplace" },
  { key: "ads",         label: "Publicité",    icon: "megaphone", color: "#EC4899", bg: "#FCE7F3", route: "/(app)/ads" },
  { key: "formations",  label: "Formation",    icon: "school",    color: "#0EA5E9", bg: "#E0F2FE", route: "/(app)/formations" },
  { key: "ebooks",      label: "E-book",       icon: "book",      color: "#8B5CF6", bg: "#F3E8FF", route: "/(app)/ebooks" },
  { key: "emploi",      label: "Emploi",       icon: "briefcase", color: "#7B61FF", bg: "#EDE9FE", route: "/(app)/emploi" },
  { key: "premium",     label: "Application Premium", icon: "diamond", color: "#7B61FF", bg: "#EDE9FE", route: "/(app)/premium-apps" },
  { key: "lottery",     label: "Jackpot",      icon: "gift",      color: "#F97316", bg: "#FFEDD5", route: "/(app)/lottery" },
  { key: "advertising", label: "Espace publicitaire", icon: "tv", color: "#10B981", bg: "#D1FAE5", route: "/(app)/advertising" },
];

const EXTRA: Service[] = [
  { key: "publish",     label: "Publier un article", icon: "create",   color: "#1B5BFF", bg: "#DBEAFE", route: "/(app)/marketplace-create" },
  { key: "coupons",     label: "Coupon",        icon: "ticket",       color: "#F59E0B", bg: "#FEF3C7", route: "/(app)/coupons" },
  { key: "matrices",    label: "Matrice",       icon: "grid",         color: "#1B5BFF", bg: "#DBEAFE", route: "/(app)/matrices" },
  { key: "team",        label: "Mon équipe",    icon: "people",       color: "#10B981", bg: "#D1FAE5", route: "/(app)/equipe" },
  { key: "community",   label: "Communauté",    icon: "chatbubbles",  color: "#EC4899", bg: "#FCE7F3", route: "/(app)/community" },
];

export default function ServicesAllScreen() {
  const router = useRouter();
  const badges = useServiceBadges();

  const renderCard = (s: Service) => {
    const unread =
      s.key === "marketplace" ? badges.marketplace :
      s.key === "ads"         ? badges.ads :
      s.key === "emploi"      ? badges.jobs :
      0;
    return (
      <TouchableOpacity
        key={s.key}
        style={styles.card}
        onPress={() => router.push(s.route as any)}
        activeOpacity={0.85}
        testID={`services-all-${s.key}`}
      >
        <View style={styles.iconWrap}>
          <View style={[styles.icon, { backgroundColor: s.bg }]}>
            <Ionicons name={s.icon} size={24} color={s.color} />
          </View>
          {unread > 0 ? (
            <View style={styles.badge} testID={`services-all-${s.key}-badge`}>
              <Text style={styles.badgeTxt}>{unread > 9 ? "9+" : unread}</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.cardLabel} numberOfLines={2}>{s.label}</Text>
      </TouchableOpacity>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <SafeAreaView edges={["top"]}>
          <View style={styles.headerRow}>
            <TouchableOpacity onPress={() => router.back()} style={styles.back} testID="services-all-back">
              <Ionicons name="chevron-back" size={22} color="#fff" />
            </TouchableOpacity>
            <View>
              <Text style={styles.title}>Tous les services</Text>
              <Text style={styles.subtitle}>Catalogue complet SPILOVEURE</Text>
            </View>
          </View>
        </SafeAreaView>
      </LinearGradient>

      <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 140 }}>
        <Text style={styles.sectionTitle}>Services principaux</Text>
        <View style={styles.grid} testID="services-all-main">
          {MAIN.map(renderCard)}
        </View>

        <Text style={[styles.sectionTitle, { marginTop: 22 }]}>Plus de services</Text>
        <View style={styles.grid} testID="services-all-extra">
          {EXTRA.map(renderCard)}
        </View>
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
  title: { color: "#fff", fontSize: 18, fontWeight: "900", letterSpacing: -0.2 },
  subtitle: { color: "#A5C2FF", fontSize: 11, marginTop: 2 },

  sectionTitle: {
    fontSize: 14, fontWeight: "900",
    color: theme.colors.textPrimary,
    marginBottom: 10, marginTop: 4,
    letterSpacing: -0.2,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
  },
  card: {
    width: "23%",
    aspectRatio: 0.9,
    marginBottom: 10,
    backgroundColor: theme.colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
    paddingVertical: 10,
    ...theme.shadow.card,
  },
  iconWrap: {
    position: "relative",
    marginBottom: 8,
  },
  icon: {
    width: 46, height: 46, borderRadius: 23,
    alignItems: "center", justifyContent: "center",
  },
  badge: {
    position: "absolute", top: -4, right: -6,
    minWidth: 18, height: 18, borderRadius: 10,
    backgroundColor: "#EF4444",
    alignItems: "center", justifyContent: "center",
    borderWidth: 1.5, borderColor: theme.colors.surface,
    paddingHorizontal: 4,
  },
  badgeTxt: { color: "#fff", fontWeight: "900", fontSize: 9 },
  cardLabel: {
    fontSize: 10,
    fontWeight: "800",
    color: theme.colors.textPrimary,
    textAlign: "center",
  },
});
