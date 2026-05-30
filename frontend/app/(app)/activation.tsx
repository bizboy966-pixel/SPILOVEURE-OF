import React, { useEffect, useState } from "react";
import {
  ScrollView, StyleSheet, Text, View, TouchableOpacity, Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { Button } from "@/src/components/Button";
import { Card } from "@/src/components/Card";
import { PasswordConfirmModal } from "@/src/components/PasswordConfirmModal";
import { api } from "@/src/api";
import { useAuth } from "@/src/auth";
import { theme } from "@/src/theme";
import { formatFCFA } from "@/src/utils/format";

const PAYMENT_METHODS = [
  { key: "mobile_money", label: "Mobile Money", icon: "phone-portrait" },
  { key: "card", label: "Carte bancaire", icon: "card" },
  { key: "crypto", label: "Crypto", icon: "logo-bitcoin" },
] as const;

export default function Activation() {
  const router = useRouter();
  const { user, refresh } = useAuth();
  const [level1, setLevel1] = useState<any>(null);
  const [method, setMethod] = useState<"mobile_money" | "card" | "crypto">("mobile_money");
  const [operators, setOperators] = useState<string[]>([]);
  const [operator, setOperator] = useState<string | null>(null);
  const [paymentPhone, setPaymentPhone] = useState("");
  const [txRef, setTxRef] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    (async () => {
      const cfg = await api.get<{ levels: any[]; operators_by_country: Record<string, string[]> }>(
        "/config", { auth: false }
      );
      setLevel1(cfg.levels[0]);
      const ops = cfg.operators_by_country[user?.country || "TG"] || [];
      setOperators(ops);
      setOperator(ops[0] || null);
    })();
  }, [user?.country]);

  const submit = async (confirmToken: string) => {
    setSubmitting(true);
    try {
      await api.post("/activations/request", {
        level: 1,
        payment_method: method,
        operator,
        payment_phone: paymentPhone || user?.phone,
        transaction_ref: txRef,
      }, { pwdConfirm: confirmToken });
      Alert.alert(
        "Demande envoyée ✅",
        "Votre demande d'activation a été soumise. L'administrateur va la valider rapidement.",
        [{ text: "OK", onPress: async () => { await refresh(); router.replace("/(app)/dashboard"); } }],
      );
    } catch (e: any) {
      Alert.alert("Erreur", e?.detail || "Erreur d'activation.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Ionicons name="shield-checkmark" size={28} color="#fff" />
          <View>
            <Text style={styles.brand}>SPILIVERE</Text>
            <Text style={styles.brandSub}>AFFILIATE SYSTEM</Text>
          </View>
        </View>
        <Text style={styles.title}>Activation du compte</Text>
        <Text style={styles.sub}>Activez votre Niveau 1 pour accéder à toutes les fonctionnalités.</Text>
      </LinearGradient>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        <Card>
          <Text style={styles.section}>Informations utilisateur</Text>
          <Row label="Nom d'utilisateur" value={user?.username || "—"} icon="person" />
          <Row label="Téléphone" value={user?.phone || "—"} icon="call" />
          <Row label="E-mail" value={user?.email || "—"} icon="mail" />
        </Card>

        <Card style={{ marginTop: 12 }}>
          <Text style={styles.section}>Détails du paiement</Text>
          <View style={styles.lvlBadge}>
            <Ionicons name="ribbon" size={16} color="#F59E0B" />
            <Text style={styles.lvlText}>Niveau à activer : {level1?.name || "Débutant"}</Text>
          </View>
          <View style={styles.amountBox}>
            <Text style={styles.amountLabel}>Montant d'activation</Text>
            <Text style={styles.amount}>{formatFCFA(level1?.price || 2500)}</Text>
            <Text style={styles.amountHint}>Montant non modifiable</Text>
            <View style={{ marginTop: 8, gap: 4 }}>
              <Text style={styles.detail}>• {formatFCFA((level1?.price || 0) - (level1?.platform_fee || 0))} → Commission</Text>
              <Text style={styles.detail}>• {formatFCFA(level1?.platform_fee || 0)} → Frais plateforme</Text>
            </View>
          </View>
        </Card>

        <Card style={{ marginTop: 12 }}>
          <Text style={styles.section}>Choisissez votre mode de paiement</Text>
          <View style={styles.methodRow}>
            {PAYMENT_METHODS.map((m) => (
              <TouchableOpacity
                key={m.key}
                style={[styles.methodCard, method === m.key && styles.methodCardOn]}
                onPress={() => setMethod(m.key)}
                testID={`payment-method-${m.key}`}
              >
                <Ionicons name={m.icon as any} size={22} color={method === m.key ? "#fff" : theme.colors.textPrimary} />
                <Text style={[styles.methodLabel, method === m.key && { color: "#fff" }]}>{m.label}</Text>
                {method === m.key ? <Ionicons name="checkmark-circle" size={16} color="#fff" /> : null}
              </TouchableOpacity>
            ))}
          </View>

          {method === "mobile_money" && operators.length > 0 ? (
            <View style={{ marginTop: 16 }}>
              <Text style={styles.section}>Sélectionnez votre opérateur</Text>
              <View style={styles.opGrid}>
                {operators.map((op) => (
                  <TouchableOpacity
                    key={op}
                    style={[styles.opChip, operator === op && styles.opChipOn]}
                    onPress={() => setOperator(op)}
                    testID={`operator-${op}`}
                  >
                    <Text style={[styles.opText, operator === op && { color: "#fff" }]}>{op}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          ) : null}

          <View style={{ marginTop: 12 }}>
            <Text style={styles.lblSmall}>Numéro utilisé pour le paiement</Text>
            <TouchableOpacity style={styles.input} activeOpacity={1}>
              <Text style={styles.inputText}>{paymentPhone || user?.phone || "Saisir le numéro"}</Text>
            </TouchableOpacity>
            <Text style={styles.lblSmall}>Référence de la transaction (optionnel)</Text>
            <TouchableOpacity style={styles.input} activeOpacity={1}>
              <Text style={styles.inputText}>{txRef || "Ex: TX-12345"}</Text>
            </TouchableOpacity>
          </View>

          <View style={{ marginTop: 16 }}>
            <Button
              title="ACTIVER MON COMPTE"
              icon={<Ionicons name="lock-closed" size={18} color="#fff" />}
              onPress={() => setShowPwd(true)}
              loading={submitting}
              testID="activate-submit"
            />
            <Text style={styles.notice}>🔒 En cliquant, vous acceptez les conditions d'utilisation.</Text>
          </View>
        </Card>

        <Card style={{ marginTop: 12 }}>
          <Text style={styles.section}>Comment ça fonctionne ?</Text>
          <Step n={1} label="Activation" desc="Vous effectuez le paiement pour activer le Niveau 1." />
          <Step n={2} label="Paiement" desc="Demande envoyée via Mobile Money." />
          <Step n={3} label="Validation" desc="L'administrateur valide votre paiement." />
          <Step n={4} label="Accès" desc="Votre compte est activé et vous accédez au tableau de bord." />
        </Card>
      </ScrollView>

      <PasswordConfirmModal
        visible={showPwd}
        onClose={() => setShowPwd(false)}
        onConfirm={submit}
        title="Confirmer le paiement"
      />
    </SafeAreaView>
  );
}

function Row({ label, value, icon }: { label: string; value: string; icon: any }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowIcon}><Ionicons name={icon} size={16} color={theme.colors.primary} /></View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowLbl}>{label}</Text>
        <Text style={styles.rowVal}>{value}</Text>
      </View>
    </View>
  );
}

function Step({ n, label, desc }: { n: number; label: string; desc: string }) {
  return (
    <View style={styles.step}>
      <View style={styles.stepN}><Text style={styles.stepNT}>{n}</Text></View>
      <View style={{ flex: 1 }}>
        <Text style={styles.stepLbl}>{label}</Text>
        <Text style={styles.stepDesc}>{desc}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: { padding: 20, paddingTop: 24 },
  brand: { color: "#fff", fontWeight: "800", letterSpacing: 2 },
  brandSub: { color: "#A5C2FF", fontSize: 9, letterSpacing: 2 },
  title: { color: "#fff", fontSize: 24, fontWeight: "800", marginTop: 16 },
  sub: { color: "#C7D9FF", marginTop: 4 },
  section: { fontWeight: "800", color: theme.colors.textPrimary, marginBottom: 10, fontSize: 16 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
  rowIcon: { width: 32, height: 32, borderRadius: 8, backgroundColor: "#DBEAFE", alignItems: "center", justifyContent: "center" },
  rowLbl: { color: theme.colors.textSecondary, fontSize: 12 },
  rowVal: { color: theme.colors.textPrimary, fontWeight: "600" },
  lvlBadge: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: "#DBEAFE", paddingVertical: 6, paddingHorizontal: 10, borderRadius: 12, alignSelf: "flex-start",
  },
  lvlText: { color: theme.colors.primary, fontWeight: "700" },
  amountBox: { marginTop: 12, padding: 16, backgroundColor: theme.colors.surfaceSecondary, borderRadius: 16 },
  amountLabel: { color: theme.colors.textSecondary, fontSize: 12 },
  amount: { color: theme.colors.primary, fontSize: 32, fontWeight: "800" },
  amountHint: { color: theme.colors.textSecondary, fontSize: 11 },
  detail: { color: theme.colors.textSecondary, fontSize: 12 },
  methodRow: { flexDirection: "row", gap: 8 },
  methodCard: {
    flex: 1, padding: 12, borderRadius: 12,
    borderWidth: 1.5, borderColor: theme.colors.border,
    alignItems: "center", gap: 4, backgroundColor: "#fff",
  },
  methodCardOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  methodLabel: { fontSize: 11, color: theme.colors.textPrimary, fontWeight: "600", textAlign: "center" },
  opGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  opChip: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 12, backgroundColor: theme.colors.surfaceSecondary, borderWidth: 1, borderColor: theme.colors.border },
  opChipOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  opText: { color: theme.colors.textPrimary, fontWeight: "600" },
  lblSmall: { color: theme.colors.textSecondary, fontSize: 12, marginTop: 8, marginBottom: 4 },
  input: { backgroundColor: theme.colors.surfaceSecondary, padding: 12, borderRadius: 12, marginBottom: 4 },
  inputText: { color: theme.colors.textPrimary },
  notice: { textAlign: "center", color: theme.colors.textSecondary, fontSize: 11, marginTop: 8 },
  step: { flexDirection: "row", gap: 12, marginTop: 8, alignItems: "flex-start" },
  stepN: { width: 28, height: 28, borderRadius: 14, backgroundColor: theme.colors.primary, alignItems: "center", justifyContent: "center" },
  stepNT: { color: "#fff", fontWeight: "800" },
  stepLbl: { fontWeight: "700", color: theme.colors.textPrimary },
  stepDesc: { color: theme.colors.textSecondary, fontSize: 12 },
});
