import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { theme } from "@/src/theme";

/**
 * Services hub — placeholder for the new "Services" bottom-nav tab.
 * The existing services (Formation, E-book, Premium apps, Marketplace,
 * Publicité, Emploi, Jackpot, etc.) stay reachable from the dashboard
 * via Accueil until they are moved here in a later iteration.
 */
export default function ServicesHub() {
  const router = useRouter();
  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="services-hub-back">
          <Ionicons name="chevron-back" size={22} color={theme.colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>🛠️ Services</Text>
        <View style={{ width: 40 }} />
      </View>
      <View style={styles.center} testID="services-hub-soon">
        <View style={styles.iconCircle}>
          <Ionicons name="apps" size={44} color="#F59E0B" />
        </View>
        <Text style={styles.title}>Bientôt disponible</Text>
        <Text style={styles.sub}>
          Vous retrouverez ici bientôt vos formations, e-books, applications premium,
          marketplace, publicités, offres d'emploi et jackpot dans une interface centralisée.
          Pour l'instant, retrouvez ces services depuis l'onglet Accueil.
        </Text>
        <TouchableOpacity onPress={() => router.push("/(app)/dashboard" as any)} style={styles.cta} testID="services-hub-go-home">
          <Ionicons name="home" size={16} color="#fff" />
          <Text style={styles.ctaTxt}>Retour à l'accueil</Text>
        </TouchableOpacity>
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
    padding: 24, paddingBottom: 100, gap: 12,
  },
  iconCircle: {
    width: 92, height: 92, borderRadius: 46,
    backgroundColor: "#F59E0B18",
    alignItems: "center", justifyContent: "center",
    marginBottom: 8,
  },
  title: { fontSize: 22, fontWeight: "900", color: theme.colors.textPrimary, letterSpacing: -0.5 },
  sub: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 20, textAlign: "center", maxWidth: 320 },
  cta: {
    marginTop: 8,
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 18, paddingVertical: 10,
    borderRadius: 22, backgroundColor: theme.colors.primary,
  },
  ctaTxt: { color: "#fff", fontWeight: "900", fontSize: 13 },
});
