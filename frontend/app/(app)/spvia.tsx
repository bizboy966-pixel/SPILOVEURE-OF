import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/src/theme";
import { BottomNav } from "@/src/components/BottomNav";

export default function SpviaScreen() {
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <SafeAreaView edges={["top"]}>
          <View style={styles.headRow}>
            <Ionicons name="sparkles" size={22} color="#fff" />
            <Text style={styles.title}>IA SPV</Text>
          </View>
        </SafeAreaView>
      </LinearGradient>
      <View style={styles.body}>
        <View style={styles.iconCircle}>
          <Ionicons name="sparkles" size={56} color={theme.colors.secondary} />
        </View>
        <Text style={styles.h1}>Assistant IA SPV</Text>
        <Text style={styles.desc} testID="spvia-soon">
          Votre assistant intelligent arrive bientôt. Il pourra analyser votre matrice, suggérer
          des stratégies et répondre à vos questions 24h/24.
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
    backgroundColor: "#F5F3FF",
    borderWidth: 8, borderColor: "#fff",
    alignItems: "center", justifyContent: "center",
    ...theme.shadow.card,
  },
  h1: { fontSize: 22, fontWeight: "900", color: theme.colors.textPrimary },
  desc: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 20, textAlign: "center" },
});
