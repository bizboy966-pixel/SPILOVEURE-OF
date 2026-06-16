/**
 * Admin — Paiements SendavaPay (monitoring + force-activation).
 *
 * Shows all payments routed through SendavaPay with filters:
 *   • All / Pending / Paid / Failed / Stuck (paid but activation pending)
 * Each row exposes a "Forcer l'activation" button for stuck cases.
 */
import React, { useEffect, useState, useCallback } from "react";
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { api } from "@/src/api";
import { theme } from "@/src/theme";

type Filter = "all" | "pending" | "paid" | "failed" | "stuck";

function fmtAmount(n: any, cur: string) { return `${Math.round(Number(n) || 0).toLocaleString("fr-FR")} ${cur || "XOF"}`; }
function fmtDate(s: string) {
  try { return new Date(s).toLocaleString("fr-FR"); } catch { return s; }
}

function StatusBadge({ p }: { p: any }) {
  const stuck = p.status === "paid" && !p.activation_done;
  const cfg: any = stuck
    ? { bg: "#FEF3C7", color: "#92400E", label: "🚨 ACTIVATION BLOQUÉE" }
    : ({
        pending: { bg: "#FEF3C7", color: "#92400E", label: "En attente" },
        paid:    { bg: "#D1FAE5", color: "#065F46", label: "✅ Payé + activé" },
        failed:  { bg: "#FEE2E2", color: "#991B1B", label: "❌ Échoué" },
      } as any)[p.status] || { bg: "#E5E7EB", color: "#374151", label: p.status };
  return (
    <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, backgroundColor: cfg.bg }}>
      <Text style={{ color: cfg.color, fontWeight: "800", fontSize: 10 }}>{cfg.label}</Text>
    </View>
  );
}

export default function AdminPayments() {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<any[]>([]);
  const [counts, setCounts] = useState<any>({});
  const [loading, setLoading] = useState(false);
  const [reprocessing, setReprocessing] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: string[] = ["limit=200"];
      if (filter === "stuck") params.push("stuck_only=true");
      else if (filter !== "all") params.push(`status=${filter}`);
      if (q.trim()) params.push(`q=${encodeURIComponent(q.trim())}`);
      const r = await api.get<any>(`/admin/payments?${params.join("&")}`);
      setItems(r.items || []);
      setCounts(r.counts || {});
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert(e?.detail || "Erreur de chargement");
    } finally {
      setLoading(false);
    }
  }, [filter, q]);

  useEffect(() => { load(); }, [load]);

  const reprocess = async (p: any) => {
    if (typeof window !== "undefined" && !window.confirm(
      `Forcer l'activation du niveau ${p.level} pour ${p.username} (${p.reference}) ?\n\nMontant: ${fmtAmount(p.amount, p.currency)}`
    )) return;
    setReprocessing(p.reference);
    try {
      const r = await api.post<any>(`/admin/payments/${p.reference}/reprocess`, {});
      if (typeof window !== "undefined") {
        if (r.already_activated) window.alert(`ℹ️ Déjà activé (niveau ${r.level})`);
        else window.alert(`✅ Niveau ${r.level} activé pour ${p.username}`);
      }
      await load();
    } catch (e: any) {
      const msg = e?.detail || "Échec de la réactivation";
      if (typeof window !== "undefined") window.alert(`❌ ${msg}`);
    } finally {
      setReprocessing(null);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} testID="payments-back">
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.hTitle}>💳 Paiements SoleasPay</Text>
        <TouchableOpacity onPress={load} testID="payments-refresh">
          <Ionicons name="refresh" size={22} color="#fff" />
        </TouchableOpacity>
      </LinearGradient>

      <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 80 }}>
        {/* Counts summary */}
        <View style={styles.statsRow}>
          <View style={styles.stat}><Text style={styles.statN}>{counts.total || 0}</Text><Text style={styles.statL}>Total</Text></View>
          <View style={styles.stat}><Text style={[styles.statN, { color: theme.colors.warning }]}>{counts.pending || 0}</Text><Text style={styles.statL}>En attente</Text></View>
          <View style={styles.stat}><Text style={[styles.statN, { color: theme.colors.success }]}>{counts.paid || 0}</Text><Text style={styles.statL}>Payés</Text></View>
          <View style={styles.stat}><Text style={[styles.statN, { color: theme.colors.danger }]}>{counts.failed || 0}</Text><Text style={styles.statL}>Échoués</Text></View>
          <View style={[styles.stat, { backgroundColor: (counts.stuck || 0) > 0 ? "#FEF3C7" : theme.colors.surface, borderColor: (counts.stuck || 0) > 0 ? theme.colors.warning : theme.colors.border }]}>
            <Text style={[styles.statN, { color: (counts.stuck || 0) > 0 ? "#92400E" : theme.colors.textPrimary }]}>{counts.stuck || 0}</Text>
            <Text style={styles.statL}>🚨 Bloqués</Text>
          </View>
        </View>

        {/* Filters */}
        <View style={styles.filterRow}>
          {(["all", "pending", "paid", "failed", "stuck"] as Filter[]).map((f) => (
            <TouchableOpacity
              key={f}
              style={[styles.chip, filter === f && styles.chipOn, f === "stuck" && (counts.stuck || 0) > 0 && !filter.includes(f) && { borderColor: theme.colors.danger, borderWidth: 1 }]}
              onPress={() => setFilter(f)}
              testID={`filter-${f}`}
            >
              <Text style={[styles.chipTxt, filter === f && { color: "#fff" }]}>
                {f === "all" ? `Tous (${counts.total || 0})` :
                 f === "pending" ? `En attente (${counts.pending || 0})` :
                 f === "paid" ? `Payés (${counts.paid || 0})` :
                 f === "failed" ? `Échoués (${counts.failed || 0})` :
                 `🚨 Bloqués (${counts.stuck || 0})`}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Search */}
        <View style={styles.searchBox}>
          <Ionicons name="search" size={14} color={theme.colors.textSecondary} />
          <TextInput
            placeholder="Rechercher (référence, utilisateur, transaction)…"
            placeholderTextColor={theme.colors.textSecondary}
            style={styles.searchI}
            value={q}
            onChangeText={setQ}
            testID="payments-search"
          />
          {q.length > 0 && (
            <TouchableOpacity onPress={() => setQ("")}>
              <Ionicons name="close-circle" size={16} color={theme.colors.textSecondary} />
            </TouchableOpacity>
          )}
        </View>

        {/* List */}
        {loading ? (
          <ActivityIndicator color={theme.colors.primary} style={{ marginTop: 20 }} />
        ) : items.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="receipt-outline" size={42} color={theme.colors.textSecondary} />
            <Text style={styles.emptyTxt}>Aucun paiement pour ce filtre.</Text>
          </View>
        ) : items.map((p: any) => {
          const stuck = p.status === "paid" && !p.activation_done;
          return (
            <View key={p.reference} style={[styles.card, stuck && { borderLeftColor: theme.colors.warning, borderLeftWidth: 4 }]} testID={`pay-row-${p.reference}`}>
              <View style={styles.cardHead}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.userTxt}>👤 {p.username}</Text>
                  <Text style={styles.metaTxt}>Niveau {p.level} • {p.country_code} • {p.phone}</Text>
                </View>
                <View style={{ alignItems: "flex-end", gap: 4 }}>
                  <Text style={styles.amountTxt}>{fmtAmount(p.amount, p.currency)}</Text>
                  <StatusBadge p={p} />
                </View>
              </View>

              <View style={styles.refRow}>
                <Text style={styles.refLbl}>Référence interne :</Text>
                <Text style={styles.refTxt}>{p.reference}</Text>
              </View>
              {p.transaction_id ? (
                <View style={styles.refRow}>
                  <Text style={styles.refLbl}>Transaction provider :</Text>
                  <Text style={styles.refTxt}>{p.transaction_id}</Text>
                </View>
              ) : null}
              <View style={styles.refRow}>
                <Text style={styles.refLbl}>Créé :</Text>
                <Text style={styles.refTxt}>{fmtDate(p.created_at)}</Text>
              </View>
              {p.activation_error ? (
                <View style={[styles.refRow, { backgroundColor: "#FEE2E2", padding: 6, borderRadius: 6 }]}>
                  <Text style={[styles.refLbl, { color: theme.colors.danger }]}>⚠️ Erreur :</Text>
                  <Text style={[styles.refTxt, { color: theme.colors.danger, flex: 1 }]} numberOfLines={3}>{p.activation_error}</Text>
                </View>
              ) : null}

              {stuck ? (
                <TouchableOpacity
                  style={[styles.forceBtn, reprocessing === p.reference && { opacity: 0.6 }]}
                  onPress={() => reprocess(p)}
                  disabled={reprocessing === p.reference}
                  testID={`force-activate-${p.reference}`}
                >
                  <Ionicons name="flash" size={16} color="#fff" />
                  <Text style={styles.forceTxt}>
                    {reprocessing === p.reference ? "Activation…" : "🚨 FORCER L'ACTIVATION"}
                  </Text>
                </TouchableOpacity>
              ) : null}

              {p.payment_url && p.status === "pending" ? (
                <TouchableOpacity
                  style={styles.linkBtn}
                  onPress={() => { if (typeof window !== "undefined") window.open(p.payment_url, "_blank"); }}
                  testID={`open-pay-url-${p.reference}`}
                >
                  <Ionicons name="open-outline" size={14} color={theme.colors.primary} />
                  <Text style={styles.linkTxt}>Ouvrir le lien de paiement</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 12 },
  hTitle: { color: "#fff", fontWeight: "800", fontSize: 16 },
  statsRow: { flexDirection: "row", gap: 6, marginBottom: 10, flexWrap: "wrap" },
  stat: { flex: 1, minWidth: 60, padding: 8, borderRadius: 10, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, alignItems: "center" },
  statN: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 16 },
  statL: { color: theme.colors.textSecondary, fontSize: 9, marginTop: 2, textAlign: "center" },
  filterRow: { flexDirection: "row", gap: 6, flexWrap: "wrap", marginBottom: 8 },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, backgroundColor: theme.colors.surfaceSecondary, borderWidth: 1, borderColor: theme.colors.border },
  chipOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  chipTxt: { color: theme.colors.textPrimary, fontSize: 11, fontWeight: "700" },
  searchBox: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, marginBottom: 10 },
  searchI: { flex: 1, color: theme.colors.textPrimary, fontSize: 13 },
  empty: { padding: 40, alignItems: "center" },
  emptyTxt: { color: theme.colors.textSecondary, marginTop: 8, fontStyle: "italic" },
  card: { padding: 12, borderRadius: 12, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, marginBottom: 8 },
  cardHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 },
  userTxt: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 13 },
  metaTxt: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 2 },
  amountTxt: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 14 },
  refRow: { flexDirection: "row", gap: 6, marginTop: 4, alignItems: "flex-start" },
  refLbl: { color: theme.colors.textSecondary, fontSize: 11, fontWeight: "600" },
  refTxt: { color: theme.colors.textPrimary, fontSize: 11, flex: 1 },
  forceBtn: { marginTop: 10, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 11, borderRadius: 18, backgroundColor: theme.colors.warning },
  forceTxt: { color: "#fff", fontWeight: "800", fontSize: 12 },
  linkBtn: { marginTop: 8, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 8 },
  linkTxt: { color: theme.colors.primary, fontWeight: "700", fontSize: 12 },
});
