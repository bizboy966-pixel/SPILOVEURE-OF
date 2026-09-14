import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { theme } from "@/src/theme";
import { BottomNav } from "@/src/components/BottomNav";

type Props = {
  title: string;
  description?: string;
  icon?: any;
  iconColor?: string;
  iconBg?: string;
  testID?: string;
};

/**
 * ComingSoonScreen — reusable "Bientôt disponible" template shared by all
 * features currently in development (Trading, IA SPV, Dépôt, Envoyer,
 * Échange). Kept intentionally distinct from the activation-required
 * modal — this is a feature-availability state, not a permission gate.
 */
export const ComingSoonScreen: React.FC<Props> = ({
  title,
  description,
  icon = "construct",
  iconColor = "#F59E0B",
  iconBg = "#FEF3C7",
  testID,
}) => {
  const router = useRouter();
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <SafeAreaView edges={["top"]}>
          <View style={styles.headerRow}>
            <TouchableOpacity onPress={() => router.back()} style={styles.back} testID={`${testID || "coming-soon"}-back`}>
              <Ionicons name="chevron-back" size={22} color="#fff" />
            </TouchableOpacity>
            <Text style={styles.title}>{title}</Text>
          </View>
        </SafeAreaView>
      </LinearGradient>

      <View style={styles.body} testID={testID || "coming-soon"}>
        <View style={[styles.iconCircle, { backgroundColor: iconBg }]}>
          <Ionicons name={icon} size={56} color={iconColor} />
        </View>
        <Text style={styles.h1}>Bientôt disponible</Text>
        <Text style={styles.desc}>
          {description ||
            "Cette fonctionnalité est actuellement en cours de développement. Elle sera bientôt disponible sur SPILOVEURE."}
        </Text>
        <TouchableOpacity
          style={styles.cta}
          onPress={() => router.replace("/(app)/dashboard" as any)}
          testID={`${testID || "coming-soon"}-home`}
        >
          <Ionicons name="home" size={16} color="#fff" />
          <Text style={styles.ctaTxt}>Retour à l'accueil</Text>
        </TouchableOpacity>
      </View>

      <BottomNav />
    </View>
  );
};

const styles = StyleSheet.create({
  header: { paddingHorizontal: 14, paddingBottom: 14 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 6 },
  back: { width: 38, height: 38, borderRadius: 19, backgroundColor: "rgba(255,255,255,0.16)", alignItems: "center", justifyContent: "center" },
  title: { color: "#fff", fontSize: 20, fontWeight: "900", letterSpacing: -0.2 },
  body: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 14 },
  iconCircle: {
    width: 128, height: 128, borderRadius: 64,
    alignItems: "center", justifyContent: "center",
    borderWidth: 8, borderColor: "#fff",
    ...theme.shadow.card,
  },
  h1: { fontSize: 24, fontWeight: "900", color: theme.colors.textPrimary, letterSpacing: -0.4, textAlign: "center" },
  desc: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 20, textAlign: "center", maxWidth: 320 },
  cta: {
    marginTop: 12,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: theme.colors.primary,
    paddingHorizontal: 24, paddingVertical: 14,
    borderRadius: 14,
    ...theme.shadow.button,
  },
  ctaTxt: { color: "#fff", fontWeight: "900", fontSize: 14, letterSpacing: 0.3 },
});

export default ComingSoonScreen;
