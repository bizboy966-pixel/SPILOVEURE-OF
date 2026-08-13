import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/src/theme";
import { api } from "@/src/api";
import { Card } from "@/src/components/Card";

const fmt = (v: any) => `${Math.round(Number(v) || 0).toLocaleString("fr-FR")} FCFA`;

export default function AdminRecharges() {
  const [items, setItems] = useState<any[]>([]);
  const [filter, setFilter] = useState<"" | "pending" | "validated" | "rejected">("pending");

  const load = useCallback(async () => {
    try {
      const r = await api.get<any[]>(`/admin/recharges${filter ? `?status_filter=${filter}` : ""}`);
      setItems(r || []);
    } catch {}
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  const validate = async (r: any) => {
    if (typeof window !== "undefined" && !window.confirm(`Valider la recharge de ${fmt(r.amount)} pour ${r.username} ?\nRéférence : ${r.transaction_ref}`)) return;
    try {
      await api.post(`/admin/recharges/${r.id}/validate`, {});
      await load();
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert(`❌ ${e?.detail || "Échec"}`);
    }
  };
  const reject = async (r: any) => {
    const reason = typeof window !== "undefined" ? (window.prompt("Motif de rejet :") || "") : "";
    if (!reason) return;
    try {
      await api.post(`/admin/recharges/${r.id}/reject`, { reason });
      await load();
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert(`❌ ${e?.detail || "Échec"}`);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 14 }} testID="admin-recharges-page">
      <Text style={styles.h1}>💳 Demandes de Recharge</Text>
      <View style={styles.filterRow}>
        {(["pending", "validated", "rejected", ""] as const).map((s) => (
          <TouchableOpacity key={s || "all"} style={[styles.chip, filter === s && styles.chipOn]} onPress={() => setFilter(s)} testID={`rch-filter-${s || "all"}`}>
            <Text style={[styles.chipT, filter === s && { color: "#fff" }]}>
              {s === "pending" ? "🟡 En attente" : s === "validated" ? "🟢 Validés" : s === "rejected" ? "🔴 Rejetés" : "Tous"}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      {items.length === 0 ? (
        <Card style={{ marginTop: 12 }}><Text style={{ color: theme.colors.textSecondary }}>Aucune recharge.</Text></Card>
      ) : items.map((r) => (
        <Card key={r.id} style={{ marginTop: 10 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text style={styles.user}>{r.username}</Text>
            <Text style={styles.amt}>{fmt(r.amount)}</Text>
          </View>
          <Text style={styles.kv}>📱 {r.operator} — {r.phone}</Text>
          <Text style={styles.kv}>🔖 Réf : <Text style={{ fontFamily: "monospace" }}>{r.transaction_ref}</Text></Text>
          <Text style={styles.kv}>📅 {(r.created_at || "").slice(0, 16).replace("T", " ")}</Text>
          {r.note ? <Text style={styles.note}>📝 {r.note}</Text> : null}
          {r.reject_reason ? <Text style={styles.rejReason}>❌ Motif rejet : {r.reject_reason}</Text> : null}
          {r.status === "pending" ? (
            <View style={styles.actRow}>
              <TouchableOpacity style={[styles.btn, { backgroundColor: theme.colors.success }]} onPress={() => validate(r)} testID={`rch-validate-${r.id}`}>
                <Ionicons name="checkmark" size={14} color="#fff" />
                <Text style={styles.btnT}>Valider & créditer</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.btn, { backgroundColor: theme.colors.danger }]} onPress={() => reject(r)} testID={`rch-reject-${r.id}`}>
                <Ionicons name="close" size={14} color="#fff" />
                <Text style={styles.btnT}>Rejeter</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={[styles.pill, r.status === "validated" ? styles.pOk : styles.pKo]}>
              <Text style={styles.pT}>{r.status === "validated" ? "🟢 Validé" : "🔴 Rejeté"} {r.decided_by || r.validated_by || r.rejected_by || ""}</Text>
            </View>
          )}
        </Card>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  h1: { fontSize: 20, fontWeight: "900", color: theme.colors.textPrimary, marginBottom: 10 },
  filterRow: { flexDirection: "row", gap: 5, flexWrap: "wrap" },
  chip: { paddingHorizontal: 9, paddingVertical: 5, borderRadius: 14, backgroundColor: theme.colors.surfaceSecondary, borderWidth: 1, borderColor: theme.colors.border },
  chipOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  chipT: { fontSize: 11, fontWeight: "700", color: theme.colors.textPrimary },
  user: { fontSize: 14, fontWeight: "800", color: theme.colors.textPrimary },
  amt: { fontSize: 14, fontWeight: "900", color: theme.colors.primary },
  kv: { fontSize: 11, color: theme.colors.textSecondary, marginTop: 3 },
  note: { fontSize: 11, color: theme.colors.textPrimary, marginTop: 4, padding: 6, backgroundColor: theme.colors.surfaceSecondary, borderRadius: 8 },
  rejReason: { fontSize: 11, color: theme.colors.danger, marginTop: 4, fontStyle: "italic" },
  actRow: { flexDirection: "row", gap: 6, marginTop: 10 },
  btn: { flex: 1, padding: 9, borderRadius: 10, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4 },
  btnT: { color: "#fff", fontWeight: "800", fontSize: 12 },
  pill: { marginTop: 8, padding: 6, borderRadius: 8, alignItems: "center" },
  pOk: { backgroundColor: "#D1FAE5" },
  pKo: { backgroundColor: "#FEE2E2" },
  pT: { fontSize: 11, fontWeight: "700", color: "#1F2937" },
});
