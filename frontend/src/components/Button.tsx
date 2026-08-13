import React from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, ViewStyle } from "react-native";
import { theme } from "@/src/theme";

type Props = {
  title: string;
  onPress?: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "outline" | "danger";
  style?: ViewStyle;
  testID?: string;
  icon?: React.ReactNode;
};

export function Button({ title, onPress, loading, disabled, variant = "primary", style, testID, icon }: Props) {
  const isDisabled = disabled || loading;
  const containerStyle: ViewStyle[] = [styles.base];
  const textStyle: any[] = [styles.text];
  if (variant === "primary") {
    containerStyle.push(styles.primary);
    textStyle.push(styles.textInverse);
  } else if (variant === "secondary") {
    containerStyle.push(styles.secondary);
    textStyle.push(styles.textInverse);
  } else if (variant === "outline") {
    containerStyle.push(styles.outline);
    textStyle.push(styles.textPrimary);
  } else if (variant === "danger") {
    containerStyle.push(styles.danger);
    textStyle.push(styles.textInverse);
  }
  if (isDisabled) containerStyle.push(styles.disabled);
  if (style) containerStyle.push(style);
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      disabled={isDisabled}
      onPress={onPress}
      style={containerStyle}
      testID={testID}
    >
      {loading ? (
        <ActivityIndicator color={variant === "outline" ? theme.colors.primary : "#fff"} />
      ) : (
        <>
          {icon}
          <Text style={textStyle}>{title}</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    paddingHorizontal: 22,
    borderRadius: theme.radius.lg,
    minHeight: 50,
  },
  primary: { backgroundColor: theme.colors.primary, ...theme.shadow.button },
  secondary: { backgroundColor: theme.colors.secondary },
  outline: { backgroundColor: "transparent", borderWidth: 1.5, borderColor: theme.colors.primary },
  danger: { backgroundColor: theme.colors.danger },
  disabled: { opacity: 0.5 },
  text: {
    fontSize: theme.font.bodyLg,
    fontWeight: theme.font.semibold,
    letterSpacing: 0.2,
  },
  textInverse: { color: theme.colors.textInverse },
  textPrimary: { color: theme.colors.primary },
});
