import React, { useState } from "react";
import { Modal, StyleSheet, Text, View, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/src/theme";
import { Input } from "./Input";
import { Button } from "./Button";
import { api } from "@/src/api";

type Props = {
  visible: boolean;
  onClose: () => void;
  onConfirm: (token: string) => Promise<void> | void;
  title?: string;
};

export function PasswordConfirmModal({ visible, onClose, onConfirm, title = "Confirmer le mot de passe" }: Props) {
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    setLoading(true);
    try {
      const r = await api.post<{ confirm_token: string }>("/auth/confirm-password", { password: pw });
      await onConfirm(r.confirm_token);
      setPw("");
      onClose();
    } catch (e: any) {
      setErr(e?.detail || "Mot de passe incorrect.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10} testID="pwd-modal-close">
              <Ionicons name="close" size={22} color={theme.colors.textSecondary} />
            </TouchableOpacity>
          </View>
          <Text style={styles.sub}>Veuillez entrer votre mot de passe pour confirmer.</Text>
          <Input
            icon="lock-closed-outline"
            placeholder="Mot de passe"
            value={pw}
            onChangeText={setPw}
            secureTextEntry={!show}
            rightIcon={show ? "eye-off-outline" : "eye-outline"}
            onRightIconPress={() => setShow((s) => !s)}
            error={err || undefined}
            testID="pwd-modal-input"
          />
          <View style={styles.actions}>
            <Button title="Annuler" variant="outline" onPress={onClose} style={{ flex: 1 }} testID="pwd-modal-cancel" />
            <Button title="Confirmer" variant="primary" onPress={submit} loading={loading} style={{ flex: 1 }} testID="pwd-modal-confirm" />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(11,45,111,0.55)", justifyContent: "center", padding: 24 },
  sheet: { backgroundColor: "#fff", borderRadius: theme.radius.xl, padding: theme.spacing.lg },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  title: { fontSize: theme.font.h4, fontWeight: theme.font.bold, color: theme.colors.textPrimary },
  sub: { color: theme.colors.textSecondary, marginVertical: 8 },
  actions: { flexDirection: "row", gap: 12, marginTop: 4 },
});
