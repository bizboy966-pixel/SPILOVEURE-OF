import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View, TouchableOpacity } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";

import { Card } from "@/src/components/Card";
import { api } from "@/src/api";
import { theme } from "@/src/theme";
import { formatFCFA } from "@/src/utils/format";

type Tx = {
  type: "activation" | "payment" | "withdrawal";
  status: string;
  amount: number;
  fee?: number | null;
  net?: number | null;
  currency: string;
  label: string;
  ref?: string | null;
  date?: string;
  meta?: any;
};

type Filter = "all" | "activation" | "payment" | "withdrawal";

const STATUS_LABEL: Record<string, { txt: string; bg: string; fg: string }> = {
  pending: { txt: "En attente", bg: "#FEF3C7", fg: "#92400E" },
  paid: { txt: "Payé", bg: "#DCFCE7", fg: "#166534" },
  validated: { txt: "Validé", bg: "#DCFCE7", fg: "#166534" },
  active: { txt: "Validé", bg: "#DCFCE7", fg: "#166534" },
  completed: { txt: "Complété", bg: "#DCFCE7", fg: "#166534" },
  failed: { txt: "Échoué", bg: "#FEE2E2", fg: "#991B1B" },
  rejected: { txt: "Rejeté", bg: "#FEE2E2", fg: "#991B1B" },
  refunded: { txt: "Remboursé", bg: "#E0E7FF", fg: "#3730A3" },
};

function fmtDate(s?: string) {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleString("fr-FR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return s; }
}

export default function Transactions() {
  const router = useRouter();
  const [items, setItems] = useState<Tx[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback(async () => {
    try {
      const data = await api.get<Tx[]>("/transactions");
      setItems(data || []);
    } catch {}
  }, []);

  useEffect(() => {
    (async () => { setLoading(true); await load(); setLoading(false); })();
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const filtered = items.filter((t) => filter === "all" ? true : t.type === filter);

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <TouchableOpacity onPress={() => router.back()} style={styles.back} testID="tx-back">
            <Ionicons name="chevron-back" size={22} color="#fff" />
          </TouchableOpacity>
          <View>
            <Text style={styles.title}>Historique des transactions</Text>
            <Text style={styles.sub}>Toutes vos activités sur Spiloveure.</Text>
          </View>
        </View>
      </LinearGradient>

      <View style={styles.filterRow}>
        {(["all", "activation", "payment", "withdrawal"] as const).map((f) => {
          const lbl = f === "all" ? "Tout" : f === "activation" ? "Activations" : f === "payment" ? "Paiements" : "Retraits";
          const on = filter === f;
          return (
            <TouchableOpacity
              key={f}
              style={[styles.filterChip, on && styles.filterChipOn]}
              onPress={() => setFilter(f)}
              testID={`tx-filter-${f}`}
            >
              <Text style={[styles.filterTxt, on && { color: "#fff" }]}>{lbl}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {loading ? (
        <View style={{ padding: 32, alignItems: "center" }}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      ) : filtered.length === 0 ? (
        <Card style={{ margin: 16 }}>
          <View style={{ alignItems: "center", padding: 16 }}>
            <Ionicons name="receipt-outline" size={48} color={theme.colors.textSecondary} />
            <Text style={styles.emptyTitle}>Aucune transaction</Text>
            <Text style={styles.emptySub}>Vos activités apparaîtront ici une fois que vous aurez effectué une activation, un paiement ou un retrait.</Text>
          </View>
        </Card>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(it, idx) => `${it.ref || idx}-${it.type}`}
          contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          renderItem={({ item }) => {
            const isWd = item.type === "withdrawal";
            const isActOrPay = item.type === "activation" || item.type === "payment";
            const sign = isWd ? "−" : isActOrPay ? "↓" : "";
            const color = isWd ? theme.colors.danger : (item.status === "paid" || item.status === "validated" || item.status === "active" || item.status === "completed") ? theme.colors.success : theme.colors.textPrimary;
            const st = STATUS_LABEL[item.status] || { txt: item.status, bg: "#E5E7EB", fg: "#374151" };
            const icon: any = isWd ? "arrow-up-circle" : item.type === "payment" ? "card" : "ribbon";
            return (
              <Card style={{ marginBottom: 10 }}>
                <View style={styles.txHead}>
                  <View style={[styles.iconBox, { backgroundColor: isWd ? "#FEE2E2" : "#DBEAFE" }]}>
                    <Ionicons name={icon} size={18} color={isWd ? theme.colors.danger : theme.colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.txLbl}>{item.label}</Text>
                    <Text style={styles.txDate}>{fmtDate(item.date)}</Text>
                  </View>
                  <View style={{ alignItems: "flex-end" }}>
                    <Text style={[styles.txAmt, { color }]}>
                      {sign} {formatFCFA(item.amount)}
                    </Text>
                    <View style={[styles.statusPill, { backgroundColor: st.bg }]}>
                      <Text style={[styles.statusTxt, { color: st.fg }]}>{st.txt}</Text>
                    </View>
                  </View>
                </View>

                {isWd && (item.fee != null || item.net != null) && (
                  <View style={styles.kvBox}>
                    {item.fee != null && (
                      <View style={styles.kvRow}>
                        <Text style={styles.kvLbl}>Frais</Text>
                        <Text style={[styles.kvVal, { color: theme.colors.danger }]}>− {formatFCFA(item.fee)}</Text>
                      </View>
                    )}
                    {item.net != null && (
                      <View style={styles.kvRow}>
                        <Text style={styles.kvLbl}>Montant net</Text>
                        <Text style={[styles.kvVal, { color: theme.colors.success, fontWeight: "800" }]}>{formatFCFA(item.net)}</Text>
                      </View>
                    )}
                    {!!item.meta?.operator && (
                      <View style={styles.kvRow}>
                        <Text style={styles.kvLbl}>Opérateur</Text>
                        <Text style={styles.kvVal}>{item.meta.operator}</Text>
                      </View>
                    )}
                  </View>
                )}

                {isActOrPay && item.meta && (item.meta.operator || item.meta.transaction_ref) && (
                  <View style={styles.kvBox}>
                    {!!item.meta.operator && (
                      <View style={styles.kvRow}>
                        <Text style={styles.kvLbl}>Opérateur</Text>
                        <Text style={styles.kvVal}>{item.meta.operator}</Text>
                      </View>
                    )}
                    {!!item.meta.transaction_ref && (
                      <View style={styles.kvRow}>
                        <Text style={styles.kvLbl}>Réf. transaction</Text>
                        <Text style={[styles.kvVal, { fontSize: 11 }]} numberOfLines={1}>{item.meta.transaction_ref}</Text>
                      </View>
                    )}
                  </View>
                )}

                {!!item.ref && (
                  <Text style={styles.refTxt} selectable>Réf : {item.ref}</Text>
                )}
              </Card>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: { padding: 20, paddingTop: 20 },
  back: { width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.15)", alignItems: "center", justifyContent: "center" },
  title: { color: "#fff", fontSize: 20, fontWeight: "800" },
  sub: { color: "#C7D9FF", fontSize: 12 },
  filterRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, padding: 14, paddingBottom: 0 },
  filterChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, backgroundColor: theme.colors.surfaceSecondary, borderWidth: 1, borderColor: theme.colors.border },
  filterChipOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  filterTxt: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 12 },
  emptyTitle: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 16, marginTop: 12 },
  emptySub: { color: theme.colors.textSecondary, fontSize: 13, marginTop: 6, textAlign: "center" },
  txHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  iconBox: { width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  txLbl: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 14 },
  txDate: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 2 },
  txAmt: { fontWeight: "800", fontSize: 15 },
  statusPill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, marginTop: 4 },
  statusTxt: { fontSize: 10, fontWeight: "800" },
  kvBox: { marginTop: 10, padding: 10, backgroundColor: theme.colors.surfaceSecondary, borderRadius: 10 },
  kvRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
  kvLbl: { color: theme.colors.textSecondary, fontSize: 12 },
  kvVal: { color: theme.colors.textPrimary, fontWeight: "600", fontSize: 12 },
  refTxt: { color: theme.colors.textSecondary, fontSize: 10, marginTop: 8, fontFamily: "monospace" },
});
