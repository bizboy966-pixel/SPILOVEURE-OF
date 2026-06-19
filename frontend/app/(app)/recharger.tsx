import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, Alert } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { theme } from "@/src/theme";
import { api } from "@/src/api";
import { Card } from "@/src/components/Card";

const fmt = (v: any) => `${Math.round(Number(v) || 0).toLocaleString("fr-FR")} FCFA`;

const OPERATORS = ["MTN MoMo", "Orange Money", "Moov Money", "Wave", "T-Money", "Airtel Money", "Autre"];

export default function RechargePage() {
  const router = useRouter();
  const [balance, setBalance] = useState(0);
  const [history, setHistory] = useState<any[]>([]);
  const [amount, setAmount] = useState("");
  const [operator, setOperator] = useState(OPERATORS[0]);
  const [phone, setPhone] = useState("");
  const [txRef, setTxRef] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [manualSettings, setManualSettings] = useState<any>(null);

  const load = useCallback(async () => {
    try {
      const [b, h, ps] = await Promise.all([
        api.get<any>("/me/recharge-balance"),
        api.get<any[]>("/me/recharge-history"),
        api.get<any>("/settings/payments"),
      ]);
      setBalance(Number(b.balance_recharge) || 0);
      setHistory(h || []);
      setManualSettings(ps);
    } catch {}
  }, []);
  useEffect(() => { load(); }, [load]);

  const submitManual = async () => {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) {
      if (typeof window !== "undefined") window.alert("❌ Montant invalide.");
      return;
    }
    if (!txRef.trim()) {
      if (typeof window !== "undefined") window.alert("❌ Référence de transaction requise.");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("/me/recharge/manual", {
        amount: amt, operator, phone: phone.trim(), transaction_ref: txRef.trim(), note: note.trim(),
      });
      if (typeof window !== "undefined") window.alert("✅ Demande envoyée. Le solde sera crédité après validation par l'administrateur.");
      setAmount(""); setPhone(""); setTxRef(""); setNote("");
      await load();
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert(`❌ ${e?.detail || "Échec"}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 16 }} testID="recharge-page">
      <LinearGradient colors={["#10B981", "#0EA5E9"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.hero}>
        <Ionicons name="wallet" size={32} color="#fff" />
        <View style={{ marginLeft: 12, flex: 1 }}>
          <Text style={styles.heroLbl}>Solde rechargé</Text>
          <Text style={styles.heroBal} testID="recharge-balance">{fmt(balance)}</Text>
        </View>
      </LinearGradient>

      <Card style={{ marginTop: 14 }}>
        <Text style={styles.title}>💳 Recharger mon compte (manuel)</Text>
        <Text style={styles.sub}>Effectuez un dépôt Mobile Money puis renseignez la référence ci-dessous. Validé par l'admin sous 24h.</Text>

        <Text style={styles.lbl}>Montant (FCFA)</Text>
        <TextInput style={styles.input} value={amount} onChangeText={setAmount} keyboardType="numeric" placeholder="Ex: 5000" placeholderTextColor={theme.colors.textSecondary} testID="recharge-amount" />

        <Text style={styles.lbl}>Opérateur</Text>
        <View style={styles.chips}>
          {OPERATORS.map((o) => (
            <TouchableOpacity key={o} style={[styles.chip, operator === o && styles.chipOn]} onPress={() => setOperator(o)} testID={`recharge-op-${o}`}>
              <Text style={[styles.chipT, operator === o && { color: "#fff" }]}>{o}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={styles.lbl}>Numéro Mobile Money (expéditeur)</Text>
        <TextInput style={styles.input} value={phone} onChangeText={setPhone} placeholder="+22890000000" placeholderTextColor={theme.colors.textSecondary} testID="recharge-phone" />

        <Text style={styles.lbl}>Référence de transaction *</Text>
        <TextInput style={styles.input} value={txRef} onChangeText={setTxRef} placeholder="Ex: MP2606...12345" placeholderTextColor={theme.colors.textSecondary} testID="recharge-txref" />

        <Text style={styles.lbl}>Note (optionnel)</Text>
        <TextInput style={styles.input} value={note} onChangeText={setNote} placeholder="Précisions éventuelles" placeholderTextColor={theme.colors.textSecondary} testID="recharge-note" />

        <TouchableOpacity style={[styles.btn, submitting && { opacity: 0.6 }]} onPress={submitManual} disabled={submitting} testID="recharge-submit">
          <Ionicons name="send" size={16} color="#fff" />
          <Text style={styles.btnT}>{submitting ? "Envoi…" : "📤 Envoyer la demande"}</Text>
        </TouchableOpacity>
      </Card>

      <Card style={{ marginTop: 14 }}>
        <Text style={styles.title}>📜 Historique des rechargements ({history.length})</Text>
        {history.length === 0 ? (
          <Text style={{ color: theme.colors.textSecondary, marginTop: 8 }}>Aucune recharge effectuée.</Text>
        ) : history.map((r) => (
          <View key={r.id} style={styles.histRow} testID={`recharge-hist-${r.id}`}>
            <View style={{ flex: 1 }}>
              <Text style={styles.histAmt}>{fmt(r.amount)}</Text>
              <Text style={styles.histSub}>{r.operator} • {r.phone || "—"}</Text>
              <Text style={styles.histSub}>{(r.created_at || "").slice(0, 16).replace("T", " ")}</Text>
              {r.reject_reason ? <Text style={styles.histRej}>Motif : {r.reject_reason}</Text> : null}
            </View>
            <View style={[styles.pill, r.status === "validated" ? styles.pillOk : r.status === "rejected" ? styles.pillKo : styles.pillWait]}>
              <Text style={styles.pillT}>{r.status === "validated" ? "🟢 Validé" : r.status === "rejected" ? "🔴 Rejeté" : "🟡 En attente"}</Text>
            </View>
          </View>
        ))}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  hero: { padding: 16, borderRadius: 14, flexDirection: "row", alignItems: "center" },
  heroLbl: { color: "rgba(255,255,255,0.85)", fontSize: 11, fontWeight: "700" },
  heroBal: { color: "#fff", fontSize: 24, fontWeight: "900", marginTop: 4 },
  title: { fontSize: 15, fontWeight: "900", color: theme.colors.textPrimary },
  sub: { fontSize: 11, color: theme.colors.textSecondary, marginTop: 4, marginBottom: 8 },
  lbl: { color: theme.colors.textSecondary, fontSize: 11, fontWeight: "700", marginTop: 10, marginBottom: 4 },
  input: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 9, color: theme.colors.textPrimary, fontSize: 13 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 5 },
  chip: { paddingHorizontal: 8, paddingVertical: 5, borderRadius: 14, backgroundColor: theme.colors.surfaceSecondary, borderWidth: 1, borderColor: theme.colors.border },
  chipOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  chipT: { color: theme.colors.textPrimary, fontSize: 11, fontWeight: "700" },
  btn: { marginTop: 14, padding: 12, borderRadius: 10, backgroundColor: theme.colors.primary, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
  btnT: { color: "#fff", fontWeight: "800", fontSize: 13 },
  histRow: { flexDirection: "row", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.colors.border, alignItems: "center" },
  histAmt: { fontSize: 14, fontWeight: "900", color: theme.colors.textPrimary },
  histSub: { fontSize: 11, color: theme.colors.textSecondary, marginTop: 1 },
  histRej: { fontSize: 11, color: theme.colors.danger, marginTop: 2, fontStyle: "italic" },
  pill: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  pillOk: { backgroundColor: "#D1FAE5" },
  pillKo: { backgroundColor: "#FEE2E2" },
  pillWait: { backgroundColor: "#FEF3C7" },
  pillT: { fontSize: 10, fontWeight: "800", color: "#374151" },
});
