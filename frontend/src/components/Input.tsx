import React from "react";
import { StyleSheet, Text, TextInput, TextInputProps, View, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/src/theme";

type Props = TextInputProps & {
  label?: string;
  error?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  rightIcon?: keyof typeof Ionicons.glyphMap;
  onRightIconPress?: () => void;
  testID?: string;
};

export function Input({ label, error, icon, rightIcon, onRightIconPress, style, testID, ...rest }: Props) {
  return (
    <View style={styles.wrap}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <View style={[styles.field, error ? styles.fieldErr : null]}>
        {icon ? <Ionicons name={icon} size={18} color={theme.colors.textSecondary} style={styles.icon} /> : null}
        <TextInput
          placeholderTextColor={theme.colors.textSecondary}
          style={[styles.input, style as any]}
          testID={testID}
          {...rest}
        />
        {rightIcon ? (
          <TouchableOpacity onPress={onRightIconPress} hitSlop={10}>
            <Ionicons name={rightIcon} size={18} color={theme.colors.textSecondary} />
          </TouchableOpacity>
        ) : null}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: theme.spacing.md },
  label: {
    fontSize: theme.font.body,
    fontWeight: theme.font.semibold,
    color: theme.colors.textPrimary,
    marginBottom: 6,
  },
  field: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 12,
  },
  fieldErr: { borderColor: theme.colors.danger },
  icon: { marginRight: 8 },
  input: {
    flex: 1,
    fontSize: theme.font.bodyLg,
    color: theme.colors.textPrimary,
    paddingVertical: 14,
  },
  error: { color: theme.colors.danger, fontSize: theme.font.bodySm, marginTop: 4 },
});
