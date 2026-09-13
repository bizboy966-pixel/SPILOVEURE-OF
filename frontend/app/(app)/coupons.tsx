import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/src/theme";
import { BottomNav } from "@/src/components/BottomNav";

export default function CouponsScreen() {
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <SafeAreaView edges={["top"]}>
          <View style={styles.headRow}>
            <Ionicons name="ticket" size={22} color="#fff" />
            <Text style={styles.title}>Coupons</Text>
          </View>
        </SafeAreaView>
      </LinearGradient>
      <View style={styles.body}>
        <View style={styles.iconCircle}>
          <Ionicons name="ticket" size={56} color="#F59E0B" />
        </View>
        <Text style={styles.h1}>Coupons & Promotions</Text>
        <Text style={styles.desc} testID="coupons-soon">
          Cette section arrive très bientôt. Vous pourrez y activer des codes promotionnels
          et bénéficier de réductions sur vos activations et services.
        </Text>
      </View>
      <BottomNav />
    </View>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 16, paddingBottom: 14 },
  headRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
  title: { color: "#fff", fontSize: 20, fontWeight: "900" },
  body: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 },
  iconCircle: {
    width: 120, height: 120, borderRadius: 60,
    backgroundColor: "#FEF3C7",
    borderWidth: 8, borderColor: "#fff",
    alignItems: "center", justifyContent: "center",
    ...theme.shadow.card,
  },
  h1: { fontSize: 22, fontWeight: "900", color: theme.colors.textPrimary },
  desc: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 20, textAlign: "center" },
});
