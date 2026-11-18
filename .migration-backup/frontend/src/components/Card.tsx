import React from "react";
import { StyleSheet, View, ViewStyle } from "react-native";
import { theme } from "@/src/theme";

/**
 * Card — composant partagé utilisé sur toutes les pages.
 *
 * Refonte design 2026-08-13 : padding plus généreux (20 vs 16), coins
 * plus arrondis (20 vs 16), bordure ultra-légère et ombre douce
 * inspirées des dashboards fintech modernes.
 *
 * Prop `variant`:
 *   • "default" — carte standard (identique à l'ancien comportement, en mieux)
 *   • "flat" — sans ombre, uniquement une bordure douce (pour listes denses)
 *   • "elevated" — ombre plus marquée (pour hero cards / dashboards)
 */
type Variant = "default" | "flat" | "elevated";

export function Card({
  children,
  style,
  testID,
  variant = "default",
  padded = true,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
  testID?: string;
  variant?: Variant;
  padded?: boolean;
}) {
  const shadow =
    variant === "flat" ? null :
    variant === "elevated" ? theme.shadow.lifted :
    theme.shadow.card;
  return (
    <View
      style={[
        styles.card,
        padded && styles.padded,
        shadow || {},
        style,
      ]}
      testID={testID}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  padded: {
    padding: theme.spacing.lg,
  },
});
