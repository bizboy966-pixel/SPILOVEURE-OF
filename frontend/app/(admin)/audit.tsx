import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, TextInput } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { theme } from "@/src/theme";
import { api } from "@/src/api";
import { Card } from "@/src/components/Card";

const fmt = (v: any) => `${Math.round(Number(v) || 0).toLocaleString("fr-FR")} FCFA`;

type Tab = "free-activations" | "orphan-commissions" | "l2plus-splits" | "trace";

const REASON_LABEL: Record<string, { label: string; color: string }> = {
  no_origin: { label: "❌ SANS ORIGINE VALIDE", color: theme.colors.danger },
  admin_l1_only: { label: "⚠️ Admin manuel niveau 1", color: "#F59E0B" },
};

const SOURCE_HINT: Record<string, string> = {
  soleaspay: "🟢 Paiement SoleasPay",
  ashtecpay: "🟢 Paiement AshtecPay",
  gateway_return: "🟢 Retour passerelle",
  admin_validate: "🟢 Validation admin (Mobile Money)",
  admin_manual: "⚠️ Activation admin manuelle (pas de paiement)",
  manual: "🟢 Réserve mise à niveau (user)",
  auto_upgrade: "🟢 Auto-upgrade (cascade)",
  manual_reprocess: "🟢 Réémission manuelle admin",
  legacy_payment: "🟡 Paiement pré-audit (legacy)",
  legacy_manual_activation: "🟡 Activation manuelle pré-audit (legacy)",
  no_record_found: "🔴 AUCUN enregistrement d'origine",
  unknown: "🔴 Source inconnue",
};

export default function AdminAudit() {
  const [tab, setTab] = useState<Tab>("free-activations");
  const [loading, setLoading] = useState(false);
  const [freeData, setFreeData] = useState<any>(null);
  const [orphanData, setOrphanData] = useState<any>(null);
  const [splitData, setSplitData] = useState<any>(null);
  const [traceQuery, setTraceQuery] = useState("");
  const [traceData, setTraceData] = useState<any>(null);
  const [traceError, setTraceError] = useState<string | null>(null);

  const loadFree = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get<any>("/admin/audit/free-activations");
      setFreeData(r);
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert(`❌ ${e?.detail || "Échec"}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadOrphan = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get<any>("/admin/audit/orphan-commissions");
      setOrphanData(r);
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert(`❌ ${e?.detail || "Échec"}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSplits = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get<any>("/admin/audit/spillover-l2plus-splits");
      setSplitData(r);
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert(`❌ ${e?.detail || "Échec"}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTrace = useCallback(async () => {
    const q = traceQuery.trim();
    if (!q) return;
    setLoading(true);
    setTraceError(null);
    try {
      const r = await api.get<any>(`/admin/audit/user/${encodeURIComponent(q)}/trace`);
      setTraceData(r);
    } catch (e: any) {
      setTraceData(null);
      setTraceError(e?.detail || "Utilisateur introuvable ou erreur");
    } finally {
      setLoading(false);
    }
  }, [traceQuery]);

  useEffect(() => {
    if (tab === "free-activations" && !freeData) loadFree();
    if (tab === "orphan-commissions" && !orphanData) loadOrphan();
    if (tab === "l2plus-splits" && !splitData) loadSplits();
  }, [tab, freeData, orphanData, splitData, loadFree, loadOrphan, loadSplits]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 14 }} testID="admin-audit-page">
      <Text style={styles.h1}>🔎 Audit d'intégrité</Text>
      <Text style={styles.subtitle}>Détection des activations sans paiement et commissions sans origine.</Text>

      <View style={styles.tabRow}>
        {([
          { k: "free-activations" as Tab, label: "🚨 Activations suspectes" },
          { k: "orphan-commissions" as Tab, label: "💸 Commissions orphelines" },
          { k: "l2plus-splits" as Tab, label: "⚖️ Splits L2+ erronés" },
          { k: "trace" as Tab, label: "🔍 Tracer un utilisateur" },
        ]).map((it) => (
          <TouchableOpacity
            key={it.k}
            style={[styles.tab, tab === it.k && styles.tabOn]}
            onPress={() => setTab(it.k)}
            testID={`audit-tab-${it.k}`}
          >
            <Text style={[styles.tabT, tab === it.k && { color: "#fff" }]}>{it.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={{ padding: 30, alignItems: "center" }}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      ) : null}

      {/* ═══ TAB 1: FREE ACTIVATIONS ═══ */}
      {tab === "free-activations" && freeData && (
        <View>
          <TouchableOpacity style={styles.reloadBtn} onPress={loadFree} testID="audit-free-refresh">
            <Ionicons name="refresh" size={16} color="#fff" />
            <Text style={styles.reloadTxt}>Actualiser</Text>
          </TouchableOpacity>

          <View style={styles.statRow}>
            <View style={styles.statBox}><Text style={styles.statN}>{freeData.summary?.total_findings || 0}</Text><Text style={styles.statL}>Total</Text></View>
            <View style={styles.statBox}><Text style={[styles.statN, { color: theme.colors.danger }]}>{freeData.summary?.critical || 0}</Text><Text style={styles.statL}>❌ Critique</Text></View>
            <View style={styles.statBox}><Text style={[styles.statN, { color: "#F59E0B" }]}>{freeData.summary?.warning || 0}</Text><Text style={styles.statL}>⚠️ Info L1</Text></View>
          </View>

          {(freeData.findings || []).length === 0 ? (
            <Card style={{ marginTop: 12 }}>
              <Text style={{ color: theme.colors.success, fontWeight: "700", textAlign: "center" }}>
                ✅ Aucune activation suspecte détectée.
              </Text>
            </Card>
          ) : (
            (freeData.findings || []).map((f: any, i: number) => (
              <Card key={`f-${i}`} style={{ marginTop: 10 }} testID={`finding-${i}`}>
                <View style={styles.findingHead}>
                  <Text style={styles.findingUser}>@{f.username || "?"}</Text>
                  <View style={[styles.badge, { backgroundColor: REASON_LABEL[f.reason]?.color || theme.colors.danger }]}>
                    <Text style={styles.badgeT}>{REASON_LABEL[f.reason]?.label || f.reason}</Text>
                  </View>
                </View>
                <Text style={styles.findingLine}>Niveau : <Text style={{ fontWeight: "800" }}>{f.level}</Text> • ID : <Text style={styles.mono}>{f.user_id.slice(0, 8)}…</Text></Text>
                <Text style={styles.findingLine}>Source détectée : {SOURCE_HINT[f.detected_source] || f.detected_source}</Text>
                {f.activation_reference ? (
                  <Text style={styles.findingLine}>Référence : <Text style={styles.mono}>{f.activation_reference}</Text></Text>
                ) : null}
                <Text style={styles.findingLine}>Parrain : @{f.sponsor_username || "—"}</Text>
                <Text style={styles.findingLine}>Créé le : {(f.user_created_at || "").slice(0, 19).replace("T", " ")}</Text>
                <TouchableOpacity
                  style={styles.traceBtn}
                  onPress={() => { setTraceQuery(f.user_id); setTab("trace"); }}
                  testID={`trace-open-${i}`}
                >
                  <Text style={styles.traceBtnT}>🔍 Tracer cet utilisateur</Text>
                </TouchableOpacity>
              </Card>
            ))
          )}
        </View>
      )}

      {/* ═══ TAB 2: ORPHAN COMMISSIONS ═══ */}
      {tab === "orphan-commissions" && orphanData && (
        <View>
          <TouchableOpacity style={styles.reloadBtn} onPress={loadOrphan} testID="audit-orphan-refresh">
            <Ionicons name="refresh" size={16} color="#fff" />
            <Text style={styles.reloadTxt}>Actualiser</Text>
          </TouchableOpacity>

          <View style={styles.statRow}>
            <View style={styles.statBox}><Text style={styles.statN}>{orphanData.total_scanned || 0}</Text><Text style={styles.statL}>Analysées</Text></View>
            <View style={styles.statBox}><Text style={[styles.statN, { color: theme.colors.danger }]}>{orphanData.flagged || 0}</Text><Text style={styles.statL}>❌ Anormales</Text></View>
          </View>

          {(orphanData.findings || []).length === 0 ? (
            <Card style={{ marginTop: 12 }}>
              <Text style={{ color: theme.colors.success, fontWeight: "700", textAlign: "center" }}>
                ✅ Aucune commission suspecte détectée.
              </Text>
            </Card>
          ) : (
            (orphanData.findings || []).map((f: any, i: number) => (
              <Card key={`o-${i}`} style={{ marginTop: 10 }} testID={`orphan-${i}`}>
                <Text style={styles.findingLine}><Text style={styles.mono}>{f.commission_id?.slice(0, 8) || "?"}</Text> • Niveau {f.level} • {f.kind}</Text>
                <Text style={[styles.findingLine, { fontWeight: "800", color: theme.colors.textPrimary }]}>Montant : {fmt(f.amount)}</Text>
                <Text style={styles.findingLine}>Créditée à : <Text style={styles.mono}>{f.user_id?.slice(0, 8)}…</Text></Text>
                <Text style={styles.findingLine}>Origine : <Text style={styles.mono}>{f.from_user_id?.slice(0, 8) || "—"}</Text></Text>
                <Text style={styles.findingLine}>Date : {(f.created_at || "").slice(0, 19).replace("T", " ")}</Text>
                <View style={{ marginTop: 6 }}>
                  {(f.issues || []).map((iss: string, k: number) => (
                    <Text key={`i-${k}`} style={styles.issueLine}>• {iss}</Text>
                  ))}
                </View>
              </Card>
            ))
          )}
        </View>
      )}

      {/* ═══ TAB 3: L2+ SPLITS ERRONES ═══ */}
      {tab === "l2plus-splits" && splitData && (
        <View>
          <TouchableOpacity style={styles.reloadBtn} onPress={loadSplits} testID="audit-splits-refresh">
            <Ionicons name="refresh" size={16} color="#fff" />
            <Text style={styles.reloadTxt}>Actualiser</Text>
          </TouchableOpacity>

          <Card style={{ marginTop: 10, backgroundColor: "#FEF3C7" }}>
            <Text style={{ color: "#78350F", fontSize: 12 }}>
              ℹ️ {splitData.spec_reference}
            </Text>
          </Card>

          <View style={styles.statRow}>
            <View style={styles.statBox}>
              <Text style={styles.statN}>{splitData.impacted_user_count || 0}</Text>
              <Text style={styles.statL}>Utilisateurs impactés</Text>
            </View>
            <View style={styles.statBox}>
              <Text style={styles.statN}>{splitData.grand_totals?.erroneous_commission_rows || 0}</Text>
              <Text style={styles.statL}>Lignes concernées</Text>
            </View>
          </View>
          <View style={styles.statRow}>
            <View style={styles.statBox}>
              <Text style={[styles.statN, { color: theme.colors.success }]}>
                +{fmt(splitData.grand_totals?.shortfall_fcfa)}
              </Text>
              <Text style={styles.statL}>💰 Total DÛ (à re-créditer)</Text>
            </View>
            <View style={styles.statBox}>
              <Text style={[styles.statN, { color: theme.colors.danger }]}>
                −{fmt(splitData.grand_totals?.overpaid_fcfa)}
              </Text>
              <Text style={styles.statL}>⚠️ Total PERÇU EN TROP</Text>
            </View>
          </View>

          {(splitData.findings || []).length === 0 ? (
            <Card style={{ marginTop: 12 }}>
              <Text style={{ color: theme.colors.success, fontWeight: "700", textAlign: "center" }}>
                ✅ Aucun split L2+ erroné détecté.
              </Text>
            </Card>
          ) : (
            (splitData.findings || []).map((f: any, i: number) => (
              <Card key={`sp-${i}`} style={{ marginTop: 10 }} testID={`l2plus-split-${i}`}>
                <Text style={styles.findingLine}>
                  👤 <Text style={{ fontWeight: "800" }}>@{f.username || "?"}</Text>
                  {" "}• N{f.max_level || "?"} • <Text style={styles.mono}>{f.user_id?.slice(0, 8)}</Text>
                </Text>
                <Text style={styles.findingLine}>Email : {f.email || "—"}</Text>
                <Text style={styles.findingLine}>
                  Niveaux affectés : {(f.levels_affected || []).map((l: number) => `L${l}`).join(", ")}
                  {"  "}({f.row_count || 0} lignes)
                </Text>
                {f.shortfall_fcfa > 0 && (
                  <Text style={[styles.findingLine, { color: theme.colors.success, fontWeight: "700" }]}>
                    💰 À re-créditer : +{fmt(f.shortfall_fcfa)}
                  </Text>
                )}
                {f.overpaid_fcfa > 0 && (
                  <Text style={[styles.findingLine, { color: theme.colors.danger, fontWeight: "700" }]}>
                    ⚠️ Perçu en trop : −{fmt(f.overpaid_fcfa)}
                  </Text>
                )}
              </Card>
            ))
          )}
        </View>
      )}

      {/* ═══ TAB 4: TRACE ═══ */}
      {tab === "trace" && (
        <View>
          <Card>
            <Text style={styles.section}>Tracer un utilisateur</Text>
            <Text style={styles.helper}>Colle un user_id ou username pour voir l'intégralité de son historique.</Text>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
              <TextInput
                style={styles.input}
                value={traceQuery}
                onChangeText={setTraceQuery}
                placeholder="user_id ou UUID"
                placeholderTextColor={theme.colors.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
                testID="audit-trace-input"
              />
              <TouchableOpacity style={[styles.reloadBtn, { flex: 0 }]} onPress={loadTrace} testID="audit-trace-btn">
                <Text style={styles.reloadTxt}>🔍 Tracer</Text>
              </TouchableOpacity>
            </View>
            {traceError ? <Text style={{ color: theme.colors.danger, marginTop: 6 }}>{traceError}</Text> : null}
          </Card>

          {traceData && (
            <View>
              <Card style={{ marginTop: 10 }}>
                <Text style={styles.section}>👤 {traceData.user.username || "?"}</Text>
                <Text style={styles.findingLine}>ID : <Text style={styles.mono}>{traceData.user.id}</Text></Text>
                <Text style={styles.findingLine}>Email : {traceData.user.email}</Text>
                <Text style={styles.findingLine}>Niveau max : <Text style={{ fontWeight: "800" }}>{traceData.user.max_level}</Text> • Statut : {traceData.user.status}</Text>
                <Text style={styles.findingLine}>Parrain : @{traceData.user.sponsor_username || "—"}</Text>
                <Text style={styles.findingLine}>Solde profit : {fmt(traceData.user.balance_profit)} • Upgrade : {fmt(traceData.user.balance_upgrade)}</Text>
              </Card>

              <Card style={{ marginTop: 10 }}>
                <Text style={styles.section}>📊 Origine des activations par niveau</Text>
                {(traceData.level_sources || []).map((s: any, i: number) => (
                  <View key={`lv-${i}`} style={styles.sourceRow}>
                    <Text style={styles.sourceLv}>N{s.level}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontWeight: "700", color: s.reason === "no_origin" ? theme.colors.danger : s.reason === "admin_l1_only" ? "#F59E0B" : theme.colors.success }}>
                        {s.reason === "no_origin" ? "❌ SANS ORIGINE" : s.reason === "admin_l1_only" ? "⚠️ Admin L1" : "✅ Valide"}
                      </Text>
                      <Text style={styles.findingLine}>{SOURCE_HINT[s.source] || s.source}{s.reference ? ` — ${s.reference}` : ""}</Text>
                    </View>
                  </View>
                ))}
              </Card>

              <Card style={{ marginTop: 10 }}>
                <Text style={styles.section}>💰 Commissions reçues ({traceData.totals.received_count} — {fmt(traceData.totals.received_amount)})</Text>
                {(traceData.commissions_received || []).length === 0 ? (
                  <Text style={{ color: theme.colors.textSecondary, fontStyle: "italic" }}>Aucune commission reçue.</Text>
                ) : (traceData.commissions_received || []).map((c: any, i: number) => (
                  <View key={`cr-${i}`} style={styles.commLine}>
                    <Text style={styles.commAmount}>{fmt(c.amount)}</Text>
                    <Text style={styles.commKind}>{c.kind} L{c.level}</Text>
                    <Text style={styles.mono}>{(c.from_user_id || "").slice(0, 8)}</Text>
                    <Text style={styles.findingLine}>{(c.created_at || "").slice(0, 16).replace("T", " ")}</Text>
                  </View>
                ))}
              </Card>

              <Card style={{ marginTop: 10 }}>
                <Text style={styles.section}>💸 Commissions générées ({traceData.totals.generated_count})</Text>
                {(traceData.commissions_generated || []).slice(0, 20).map((c: any, i: number) => (
                  <View key={`cg-${i}`} style={styles.commLine}>
                    <Text style={styles.commAmount}>{fmt(c.amount)}</Text>
                    <Text style={styles.commKind}>{c.kind} L{c.level}</Text>
                    <Text style={styles.mono}>→ {(c.user_id || "").slice(0, 8)}</Text>
                    <Text style={styles.findingLine}>{(c.created_at || "").slice(0, 16).replace("T", " ")}</Text>
                  </View>
                ))}
              </Card>
            </View>
          )}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  h1: { fontSize: 22, fontWeight: "900", color: theme.colors.textPrimary },
  subtitle: { color: theme.colors.textSecondary, marginBottom: 12, fontSize: 12 },
  tabRow: { flexDirection: "row", gap: 4, marginBottom: 10, flexWrap: "wrap" },
  tab: { flex: 1, minWidth: 140, padding: 10, borderRadius: 8, backgroundColor: theme.colors.surfaceSecondary, alignItems: "center" },
  tabOn: { backgroundColor: theme.colors.primary },
  tabT: { fontSize: 11, fontWeight: "700", color: theme.colors.textPrimary },
  reloadBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: theme.colors.primary, padding: 10, borderRadius: 10, marginBottom: 10 },
  reloadTxt: { color: "#fff", fontWeight: "800", fontSize: 12 },
  statRow: { flexDirection: "row", gap: 6, marginBottom: 8 },
  statBox: { flex: 1, padding: 10, borderRadius: 10, backgroundColor: theme.colors.surface, alignItems: "center" },
  statN: { fontSize: 20, fontWeight: "900", color: theme.colors.textPrimary },
  statL: { fontSize: 10, color: theme.colors.textSecondary, marginTop: 2 },
  findingHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
  findingUser: { fontSize: 14, fontWeight: "800", color: theme.colors.textPrimary },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  badgeT: { color: "#fff", fontSize: 10, fontWeight: "800" },
  findingLine: { fontSize: 11, color: theme.colors.textSecondary, marginTop: 2 },
  mono: { fontFamily: "monospace", color: theme.colors.textPrimary },
  issueLine: { fontSize: 11, color: theme.colors.danger, marginTop: 2, fontWeight: "600" },
  traceBtn: { marginTop: 8, padding: 8, borderRadius: 8, backgroundColor: theme.colors.surfaceSecondary, alignItems: "center" },
  traceBtnT: { color: theme.colors.primary, fontWeight: "700", fontSize: 12 },
  section: { fontSize: 14, fontWeight: "800", color: theme.colors.textPrimary, marginBottom: 6 },
  helper: { color: theme.colors.textSecondary, fontSize: 12 },
  input: { flex: 1, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 10, color: theme.colors.textPrimary, fontSize: 13, backgroundColor: theme.colors.surface },
  sourceRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  sourceLv: { width: 30, fontWeight: "800", color: theme.colors.textPrimary },
  commLine: { paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  commAmount: { fontWeight: "800", color: theme.colors.success, fontSize: 12 },
  commKind: { color: theme.colors.textSecondary, fontSize: 10 },
});
