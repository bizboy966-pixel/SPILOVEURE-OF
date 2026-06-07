import React from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/src/theme";

export function EmptySoon({
  icon = "construct",
  title = "Bientôt disponible",
  message = "Cette section est actuellement en cours de préparation.\nNos équipes travaillent à la mise en ligne du contenu.\n\nMerci de votre patience.",
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  title?: string;
  message?: string;
}) {
  return (
    <View style={styles.wrap} testID="empty-soon">
      <View style={styles.circle}>
        <Ionicons name={icon} size={48} color={theme.colors.primary} />
      </View>
      <Text style={styles.flag}>🚧</Text>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.msg}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", padding: 32, marginTop: 24 },
  circle: {
    width: 96, height: 96, borderRadius: 48,
    backgroundColor: "#DBEAFE",
    alignItems: "center", justifyContent: "center",
    borderWidth: 4, borderColor: "#fff",
  },
  flag: { fontSize: 28, marginTop: 12 },
  title: { fontSize: 20, fontWeight: "800", color: theme.colors.textPrimary, marginTop: 6 },
  msg: { color: theme.colors.textSecondary, textAlign: "center", marginTop: 8, lineHeight: 19, fontSize: 13 },
});

void Image;
