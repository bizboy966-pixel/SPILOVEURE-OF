import React, { useEffect, useState } from "react";
import { Alert, FlatList, ScrollView, StyleSheet, Text, View, TouchableOpacity, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { Card } from "@/src/components/Card";
import { Input } from "@/src/components/Input";
import { Button } from "@/src/components/Button";
import { PasswordConfirmModal } from "@/src/components/PasswordConfirmModal";
import { api } from "@/src/api";
import { useAuth } from "@/src/auth";
import { theme } from "@/src/theme";
import { formatFCFA, formatDateTime } from "@/src/utils/format";

export default function Withdrawal() {
  const router = useRouter();
  const { user, refresh } = useAuth();
  const [wallet, setWallet] = useState<any>(null);
  const [amount, setAmount] = useState("");
  const [history, setHistory] = useState<any[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [showPwd, setShowPwd] = useState(false);
  const [wdSettings, setWdSettings] = useState<{ fee_percent: number; fee_flat: number; min_amount: number; max_amount: number | null; enabled: boolean }>({
    fee_percent: 0, fee_flat: 0, min_amount: 0, max_amount: null, enabled: true,
  });

  const load = async () => {
    try {
      const w = await api.get<any>("/wallet");
      setWallet(w);
      const h = await api.get<any[]>("/withdrawals/mine");
      setHistory(h);
      const s = await api.get<any>("/settings/withdrawal", { auth: false });
      setWdSettings(s);
    } catch {}
  };
  useEffect(() => { load(); }, []);

  const amt = parseInt(amount, 10) || 0;
  const feePreview = Math.min(amt, Math.round(amt * (wdSettings.fee_percent / 100) + wdSettings.fee_flat));
  const netPreview = Math.max(0, amt - feePreview);

  const submit = async (token: string) => {
    if (!amt || amt <= 0) return Alert.alert("Erreur", "Montant invalide.");
    try {
      await api.post("/withdrawals", { amount: amt }, { pwdConfirm: token });
      Alert.alert("✅", `Demande enregistrée. Vous recevrez ${formatFCFA(netPreview)} après validation admin.`);
      setAmount("");
      await refresh();
      await load();
    } catch (e: any) {
      Alert.alert("Erreur", e?.detail || "Erreur");
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back}>
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>Demande de retrait</Text>
        <Text style={styles.sub}>Disponible (profit) : {formatFCFA(user?.balance_profit)}</Text>
      </LinearGradient>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await refresh(); await load(); setRefreshing(false); }} />}
      >
        {!wallet ? (
          <Card>
            <View style={{ alignItems: "center", padding: 16 }}>
              <Ionicons name="alert-circle" size={40} color={theme.colors.warning} />
              <Text style={{ marginTop: 8, fontWeight: "700", color: theme.colors.textPrimary }}>
                Aucun portefeuille enregistré
              </Text>
              <Text style={{ color: theme.colors.textSecondary, textAlign: "center", marginTop: 4 }}>
                Vous devez d'abord enregistrer votre portefeuille de retrait.
              </Text>
              <Button title="Configurer mon portefeuille" onPress={() => router.push("/(app)/wallet")} style={{ marginTop: 12 }} testID="wd-config-wallet" />
            </View>
          </Card>
        ) : (
          <>
            <Card>
              <Text style={styles.section}>Portefeuille</Text>
              <Row label="Pays" value={wallet.country} />
              <Row label="Opérateur" value={wallet.operator} />
              <Row label="Numéro" value={wallet.phone} />
              <Row label="Nom complet" value={wallet.full_name} />
              <TouchableOpacity onPress={() => router.push("/(app)/wallet")} style={{ alignSelf: "flex-end" }}>
                <Text style={{ color: theme.colors.primary, fontWeight: "700" }}>Modifier</Text>
              </TouchableOpacity>
            </Card>

            <Card style={{ marginTop: 12 }}>
              <Text style={styles.section}>Montant à retirer (FCFA)</Text>
              <Input icon="cash-outline" placeholder="Ex: 50000" value={amount} onChangeText={setAmount} keyboardType="numeric" testID="wd-amount" />
              <Text style={{ color: theme.colors.textSecondary, fontSize: 12, marginBottom: 8 }}>
                ⚠️ Seul votre profit disponible est retirable. La réserve de mise à niveau est conservée.
              </Text>

              {(wdSettings.fee_percent > 0 || wdSettings.fee_flat > 0 || wdSettings.min_amount > 0) && (
                <View style={styles.feeBox}>
                  <View style={styles.feeRow}>
                    <Text style={styles.feeLbl}>Frais de retrait</Text>
                    <Text style={styles.feeVal}>
                      {wdSettings.fee_percent > 0 ? `${wdSettings.fee_percent}% ` : ""}
                      {wdSettings.fee_flat > 0 ? `+ ${formatFCFA(wdSettings.fee_flat)}` : ""}
                    </Text>
                  </View>
                  {wdSettings.min_amount > 0 && (
                    <View style={styles.feeRow}>
                      <Text style={styles.feeLbl}>Montant minimum</Text>
                      <Text style={styles.feeVal}>{formatFCFA(wdSettings.min_amount)}</Text>
                    </View>
                  )}
                  {amt > 0 && (
                    <>
                      <View style={[styles.feeRow, { marginTop: 6 }]}>
                        <Text style={styles.feeLbl}>Frais sur ce retrait</Text>
                        <Text style={[styles.feeVal, { color: theme.colors.danger }]}>− {formatFCFA(feePreview)}</Text>
                      </View>
                      <View style={[styles.feeRow, styles.feeTotal]}>
                        <Text style={[styles.feeLbl, { color: theme.colors.textPrimary, fontWeight: "800" }]}>Vous recevrez</Text>
                        <Text style={{ color: theme.colors.success, fontWeight: "800", fontSize: 16 }}>{formatFCFA(netPreview)}</Text>
                      </View>
                    </>
                  )}
                </View>
              )}

              <Button
                title="SOUMETTRE LE RETRAIT"
                icon={<Ionicons name="arrow-up-circle" size={18} color="#fff" />}
                onPress={() => setShowPwd(true)}
                testID="wd-submit"
              />
            </Card>
          </>
        )}

        <Card style={{ marginTop: 12 }}>
          <Text style={styles.section}>Historique des retraits</Text>
          {history.length === 0 ? (
            <Text style={{ color: theme.colors.textSecondary, textAlign: "center", padding: 16 }}>
              Aucune demande de retrait pour le moment.
            </Text>
          ) : (
            history.map((h) => (
              <View key={h.id} style={styles.hist}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: "700", color: theme.colors.textPrimary }}>{formatFCFA(h.amount)}</Text>
                  <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>{h.operator} • {h.phone}</Text>
                  <Text style={{ color: theme.colors.textSecondary, fontSize: 11 }}>{formatDateTime(h.created_at)}</Text>
                </View>
                <StatusBadge status={h.status} />
              </View>
            ))
          )}
        </Card>
      </ScrollView>

      <PasswordConfirmModal visible={showPwd} onClose={() => setShowPwd(false)} onConfirm={submit} title="Confirmer le retrait" />
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 6 }}>
      <Text style={{ color: theme.colors.textSecondary }}>{label}</Text>
      <Text style={{ color: theme.colors.textPrimary, fontWeight: "600" }}>{value}</Text>
    </View>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cfg: any = {
    pending: { bg: theme.colors.warningBg, color: theme.colors.warning, label: "En attente" },
    validated: { bg: theme.colors.successBg, color: theme.colors.success, label: "Validé" },
    rejected: { bg: theme.colors.dangerBg, color: theme.colors.danger, label: "Rejeté" },
  }[status] || { bg: "#eee", color: "#666", label: status };
  return (
    <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10, backgroundColor: cfg.bg }}>
      <Text style={{ color: cfg.color, fontWeight: "700", fontSize: 11 }}>{cfg.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: { padding: 16, paddingTop: 24, paddingBottom: 20 },
  back: { width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center", marginBottom: 8 },
  title: { color: "#fff", fontSize: 24, fontWeight: "800" },
  sub: { color: "#C7D9FF" },
  section: { fontWeight: "800", color: theme.colors.textPrimary, marginBottom: 8 },
  hist: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  feeBox: { padding: 12, borderRadius: 12, backgroundColor: theme.colors.surfaceSecondary, marginBottom: 12, borderWidth: 1, borderColor: theme.colors.border },
  feeRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 2 },
  feeLbl: { color: theme.colors.textSecondary, fontSize: 12 },
  feeVal: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 12 },
  feeTotal: { borderTopWidth: 1, borderTopColor: theme.colors.border, marginTop: 6, paddingTop: 8 },
});
