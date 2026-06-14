/**
 * Admin — Audit & Recompute platform.
 *
 * 3 tabs:
 *  1) Vue d'ensemble — stats + summary of all detected anomalies
 *  2) Recalcul — dry-run preview + apply (counter fixes, orphan cleanup, pending upgrades)
 *  3) Utilisateur — deep audit by username
 */
import React, { useEffect, useState, useCallback } from "react";
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View, Alert, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { api } from "@/src/api";
import { theme } from "@/src/theme";

type Tab = "overview" | "recompute" | "user";

const SEVERITY_COLOR: Record<string, string> = {
  "🔴": theme.colors.danger,
  "🟠": theme.colors.warning,
  "🟡": "#9CA3AF",
};

function fmt(n: any) { return Math.round(Number(n) || 0).toLocaleString("fr-FR"); }

export default function AdminAudit() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("overview");
  const [report, setReport] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [dryRun, setDryRun] = useState<any>(null);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<any>(null);
  const [opts, setOpts] = useState({ clean: true, upgrade: true, restoreAdmin: true });
  const [username, setUsername] = useState("");
  const [userReport, setUserReport] = useState<any>(null);
  const [userErr, setUserErr] = useState<string | null>(null);
  const [userLoading, setUserLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get<any>("/admin/audit");
      setReport(r);
    } catch (e: any) {
      Alert.alert("Erreur", e?.detail || "Audit a échoué");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const doDryRun = async () => {
    setDryRun(null);
    setApplied(null);
    setApplying(true);
    try {
      const r = await api.post<any>(
        `/admin/audit/recompute?dry_run=true&clean_orphan_placements=${opts.clean}&trigger_pending_upgrades=${opts.upgrade}&restore_admin_placements=${opts.restoreAdmin}`,
        {}
      );
      setDryRun(r);
    } catch (e: any) {
      Alert.alert("Erreur", e?.detail || "Échec du dry-run");
    } finally {
      setApplying(false);
    }
  };

  const doApply = async () => {
    if (typeof window !== "undefined") {
      const ok = window.confirm(
        `⚠️ CONFIRMATION REQUISE\n\nVous allez appliquer ces changements :\n\n` +
        `• ${dryRun?.totals?.counter_updates || 0} compteurs utilisateurs corrigés\n` +
        `• ${dryRun?.totals?.orphan_placements_deleted || 0} placements orphelins supprimés\n` +
        `• ${dryRun?.totals?.upgrades_triggered || 0} auto-upgrades déclenchées\n` +
        `• ${dryRun?.totals?.admin_placements_restored || 0} placements admin restaurés\n\n` +
        `Les soldes (balance_profit / balance_upgrade) ne sont PAS modifiés.\n\n` +
        `Continuer ?`
      );
      if (!ok) return;
    }
    setApplying(true);
    try {
      const r = await api.post<any>(
        `/admin/audit/recompute?dry_run=false&clean_orphan_placements=${opts.clean}&trigger_pending_upgrades=${opts.upgrade}&restore_admin_placements=${opts.restoreAdmin}`,
        {}
      );
      setApplied(r);
      setDryRun(null);
      await load();
      if (typeof window !== "undefined") window.alert("✅ Corrections appliquées avec succès");
    } catch (e: any) {
      Alert.alert("Erreur", e?.detail || "Échec de l'application");
    } finally {
      setApplying(false);
    }
  };

  const lookupUser = async () => {
    if (!username.trim()) return;
    setUserLoading(true);
    setUserErr(null);
    setUserReport(null);
    try {
      const r = await api.get<any>(`/admin/audit/user/${encodeURIComponent(username.trim())}`);
      setUserReport(r);
    } catch (e: any) {
      setUserErr(e?.detail || "Utilisateur introuvable");
    } finally {
      setUserLoading(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} testID="audit-back">
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.hTitle}>🔍 Audit Plateforme</Text>
        <TouchableOpacity onPress={load} testID="audit-refresh">
          <Ionicons name="refresh" size={22} color="#fff" />
        </TouchableOpacity>
      </LinearGradient>

      <View style={styles.tabRow}>
        {(["overview", "recompute", "user"] as Tab[]).map((t) => (
          <TouchableOpacity
            key={t}
            style={[styles.tab, tab === t && styles.tabOn]}
            onPress={() => setTab(t)}
            testID={`audit-tab-${t}`}
          >
            <Text style={[styles.tabTxt, tab === t && { color: "#fff" }]}>
              {t === "overview" ? "📊 Vue d'ensemble" : t === "recompute" ? "🔧 Recalcul" : "🔎 Utilisateur"}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 80 }}>
        {loading && !report ? (
          <View style={{ padding: 40, alignItems: "center" }}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={{ marginTop: 10, color: theme.colors.textSecondary }}>Analyse de la base en cours…</Text>
          </View>
        ) : tab === "overview" ? (
          <OverviewTab report={report} />
        ) : tab === "recompute" ? (
          <RecomputeTab
            dryRun={dryRun}
            applied={applied}
            applying={applying}
            opts={opts}
            setOpts={setOpts}
            doDryRun={doDryRun}
            doApply={doApply}
          />
        ) : (
          <UserTab
            username={username}
            setUsername={setUsername}
            lookup={lookupUser}
            loading={userLoading}
            report={userReport}
            error={userErr}
          />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function OverviewTab({ report }: { report: any }) {
  if (!report) return null;
  const issuesEntries = Object.entries(report.issues || {});
  return (
    <>
      <View style={styles.statsRow}>
        <View style={styles.stat}><Text style={styles.statN}>{report.stats.users_total}</Text><Text style={styles.statL}>Utilisateurs</Text></View>
        <View style={styles.stat}><Text style={[styles.statN, { color: theme.colors.success }]}>{report.stats.users_active}</Text><Text style={styles.statL}>Actifs</Text></View>
        <View style={styles.stat}><Text style={styles.statN}>{report.stats.placements_total}</Text><Text style={styles.statL}>Placements</Text></View>
        <View style={styles.stat}><Text style={styles.statN}>{report.stats.commissions_total}</Text><Text style={styles.statL}>Commissions</Text></View>
      </View>

      <View style={[styles.statsRow, { marginTop: 8 }]}>
        <View style={[styles.stat, { flex: 1 }]}>
          <Text style={[styles.statN, { color: report.stats.issues_total > 0 ? theme.colors.danger : theme.colors.success }]}>
            {report.stats.issues_total}
          </Text>
          <Text style={styles.statL}>Anomalies détectées</Text>
        </View>
      </View>

      {/* Distribution par niveau */}
      <Text style={styles.section}>📈 Distribution par niveau</Text>
      <View style={styles.levelsGrid}>
        {Object.entries(report.stats.users_by_level || {}).map(([lvl, n]: [string, any]) => (
          n > 0 ? (
            <View key={lvl} style={styles.lvlPill} testID={`lvl-pill-${lvl}`}>
              <Text style={styles.lvlPillTxt}>N{lvl}</Text>
              <Text style={styles.lvlPillN}>{n}</Text>
            </View>
          ) : null
        ))}
      </View>

      <Text style={styles.section}>⚠️ Anomalies par catégorie</Text>
      {issuesEntries.length === 0 ? (
        <View style={styles.ok} testID="audit-no-issues">
          <Ionicons name="checkmark-circle" size={28} color={theme.colors.success} />
          <Text style={styles.okTxt}>✅ Aucune anomalie détectée. La plateforme est cohérente.</Text>
        </View>
      ) : (
        issuesEntries.map(([cat, rows]: [string, any]) => {
          const sev = (report.severity || {})[cat] || "🟡";
          const color = SEVERITY_COLOR[sev] || theme.colors.textSecondary;
          return (
            <View key={cat} style={[styles.issueCard, { borderLeftColor: color }]} testID={`issue-cat-${cat}`}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <Text style={[styles.issueTitle, { color }]}>{sev} {cat}</Text>
                <View style={[styles.issueCount, { backgroundColor: color }]}>
                  <Text style={styles.issueCountTxt}>{rows.length}</Text>
                </View>
              </View>
              {rows.slice(0, 5).map((r: any, i: number) => (
                <Text key={i} style={styles.issueLine} numberOfLines={2}>
                  • {r.username ? `${r.username}` : ""}{r.email ? ` (${r.email})` : ""}{" — "}
                  {Object.entries(r).filter(([k]) => !["id", "username", "email", "role", "status"].includes(k)).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")}
                </Text>
              ))}
              {rows.length > 5 ? <Text style={styles.more}>… +{rows.length - 5} autre(s)</Text> : null}
            </View>
          );
        })
      )}
    </>
  );
}

function RecomputeTab({ dryRun, applied, applying, opts, setOpts, doDryRun, doApply }: any) {
  return (
    <>
      <View style={styles.warnBox} testID="audit-recompute-warn">
        <Text style={styles.warnTitle}>⚠️ Opération sensible</Text>
        <Text style={styles.warnBody}>
          Le recalcul ne touche JAMAIS aux soldes <Text style={{ fontWeight: "800" }}>balance_profit</Text> ni <Text style={{ fontWeight: "800" }}>balance_upgrade</Text>.
          Il recalcule uniquement les compteurs (commission_direct, commission_spillover, total_earned, earnings_per_level)
          à partir de la collection <Text style={{ fontWeight: "800" }}>commissions</Text>, supprime les placements orphelins
          et déclenche les auto-upgrades en attente.
        </Text>
        <Text style={[styles.warnBody, { marginTop: 6 }]}>
          🛡 Effectuez TOUJOURS un dry-run d'abord. Un backup MongoDB est disponible dans <Text style={{ fontWeight: "700" }}>/app/backups/</Text>.
        </Text>
      </View>

      <View style={styles.optsRow}>
        <TouchableOpacity
          style={[styles.optChip, opts.clean && styles.optChipOn]}
          onPress={() => setOpts((s: any) => ({ ...s, clean: !s.clean }))}
          testID="opt-clean-orphans"
        >
          <Ionicons name={opts.clean ? "checkmark-circle" : "ellipse-outline"} size={14} color={opts.clean ? "#fff" : theme.colors.textPrimary} />
          <Text style={[styles.optChipTxt, opts.clean && { color: "#fff" }]}>Nettoyer placements orphelins</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.optChip, opts.upgrade && styles.optChipOn]}
          onPress={() => setOpts((s: any) => ({ ...s, upgrade: !s.upgrade }))}
          testID="opt-trigger-upgrades"
        >
          <Ionicons name={opts.upgrade ? "checkmark-circle" : "ellipse-outline"} size={14} color={opts.upgrade ? "#fff" : theme.colors.textPrimary} />
          <Text style={[styles.optChipTxt, opts.upgrade && { color: "#fff" }]}>Déclencher auto-upgrades en attente</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.optChip, opts.restoreAdmin && styles.optChipOn]}
          onPress={() => setOpts((s: any) => ({ ...s, restoreAdmin: !s.restoreAdmin }))}
          testID="opt-restore-admin"
        >
          <Ionicons name={opts.restoreAdmin ? "checkmark-circle" : "ellipse-outline"} size={14} color={opts.restoreAdmin ? "#fff" : theme.colors.textPrimary} />
          <Text style={[styles.optChipTxt, opts.restoreAdmin && { color: "#fff" }]}>Restaurer placements admin manquants</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity
        style={[styles.bigBtn, { backgroundColor: theme.colors.primary }, applying && { opacity: 0.6 }]}
        onPress={doDryRun}
        disabled={applying}
        testID="audit-dry-run"
      >
        <Ionicons name="play-circle" size={18} color="#fff" />
        <Text style={styles.bigBtnTxt}>{applying ? "Analyse…" : "🔍 Simuler les corrections (dry-run)"}</Text>
      </TouchableOpacity>

      {dryRun ? (
        <>
          <Text style={[styles.section, { marginTop: 16 }]}>📝 Plan d'action (simulation)</Text>
          <View style={styles.summaryGrid}>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryN}>{dryRun.totals?.counter_updates || 0}</Text>
              <Text style={styles.summaryL}>Compteurs</Text>
            </View>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryN}>{dryRun.totals?.orphan_placements_deleted || 0}</Text>
              <Text style={styles.summaryL}>Orphelins</Text>
            </View>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryN}>{dryRun.totals?.upgrades_triggered || 0}</Text>
              <Text style={styles.summaryL}>Upgrades</Text>
            </View>
          </View>

          {(dryRun.counter_updates || []).slice(0, 20).map((u: any, i: number) => (
            <View key={i} style={styles.diffCard} testID={`diff-${i}`}>
              <Text style={styles.diffUser}>{u.user.username}</Text>
              {["commission_direct", "commission_spillover", "total_earned"].map((k) => (
                u.before[k] !== u.after[k] ? (
                  <Text key={k} style={styles.diffLine}>
                    • {k} : <Text style={{ color: theme.colors.danger }}>{fmt(u.before[k])}</Text>
                    {" → "}
                    <Text style={{ color: theme.colors.success, fontWeight: "700" }}>{fmt(u.after[k])}</Text>
                  </Text>
                ) : null
              ))}
            </View>
          ))}

          {(dryRun.orphan_placements_deleted || []).slice(0, 20).map((p: any, i: number) => (
            <View key={`orph-${i}`} style={styles.diffCard}>
              <Text style={styles.diffLine}>🗑 Suppression placement L{p.level} de user {p.placement_user_id.slice(0, 8)}… (parent inexistant {p.orphan_parent_id.slice(0, 8)}…)</Text>
            </View>
          ))}

          <TouchableOpacity
            style={[styles.bigBtn, { backgroundColor: theme.colors.success, marginTop: 16 }, applying && { opacity: 0.6 }]}
            onPress={doApply}
            disabled={applying}
            testID="audit-apply"
          >
            <Ionicons name="checkmark-circle" size={18} color="#fff" />
            <Text style={styles.bigBtnTxt}>{applying ? "Application…" : "✅ Appliquer les corrections"}</Text>
          </TouchableOpacity>
        </>
      ) : null}

      {applied ? (
        <>
          <Text style={[styles.section, { marginTop: 16, color: theme.colors.success }]}>✅ Corrections appliquées</Text>
          <View style={styles.summaryGrid}>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryN}>{applied.totals?.counter_updates || 0}</Text>
              <Text style={styles.summaryL}>Compteurs corrigés</Text>
            </View>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryN}>{applied.totals?.orphan_placements_deleted || 0}</Text>
              <Text style={styles.summaryL}>Placements nettoyés</Text>
            </View>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryN}>{applied.totals?.upgrades_triggered || 0}</Text>
              <Text style={styles.summaryL}>Upgrades déclenchées</Text>
            </View>
          </View>
        </>
      ) : null}
    </>
  );
}

function UserTab({ username, setUsername, lookup, loading, report, error }: any) {
  return (
    <>
      <Text style={styles.section}>🔎 Recherche par nom d'utilisateur</Text>
      <View style={styles.searchBox}>
        <Ionicons name="person" size={14} color={theme.colors.textSecondary} />
        <TextInput
          placeholder="Ex: alicea43c41 ou admin"
          placeholderTextColor={theme.colors.textSecondary}
          style={styles.searchI}
          value={username}
          onChangeText={setUsername}
          onSubmitEditing={lookup}
          testID="audit-user-search"
        />
        <TouchableOpacity onPress={lookup} style={styles.searchBtn} testID="audit-user-search-btn">
          <Ionicons name="search" size={14} color="#fff" />
        </TouchableOpacity>
      </View>

      {loading ? <ActivityIndicator color={theme.colors.primary} /> : null}
      {error ? (
        <View style={styles.errBanner} testID="audit-user-error">
          <Ionicons name="alert-circle" size={16} color={theme.colors.danger} />
          <Text style={styles.errBannerTxt}>{error}</Text>
        </View>
      ) : null}

      {report ? (
        <>
          <View style={styles.userCard} testID="audit-user-card">
            <Text style={styles.userName}>{report.user.username}</Text>
            <Text style={styles.userEmail}>{report.user.email}</Text>
            <View style={styles.userMetaRow}>
              <View style={styles.userMetaPill}>
                <Text style={styles.userMetaTxt}>Niveau {report.user.max_level || 0}</Text>
              </View>
              <View style={[styles.userMetaPill, { backgroundColor: report.user.status === "active" ? theme.colors.success : theme.colors.warning }]}>
                <Text style={styles.userMetaTxt}>{report.user.status}</Text>
              </View>
              <View style={styles.userMetaPill}>
                <Text style={styles.userMetaTxt}>{report.user.role}</Text>
              </View>
            </View>
            <View style={styles.balancesRow}>
              <View style={styles.balCard}>
                <Text style={styles.balL}>Profit retirable</Text>
                <Text style={[styles.balN, { color: theme.colors.success }]}>{fmt(report.user.balance_profit)} FCFA</Text>
              </View>
              <View style={styles.balCard}>
                <Text style={styles.balL}>Réserve upgrade</Text>
                <Text style={[styles.balN, { color: theme.colors.warning }]}>{fmt(report.user.balance_upgrade)} FCFA</Text>
              </View>
            </View>
            <View style={styles.balancesRow}>
              <View style={styles.balCard}>
                <Text style={styles.balL}>Commission directe</Text>
                <Text style={styles.balN}>{fmt(report.user.commission_direct)} FCFA</Text>
              </View>
              <View style={styles.balCard}>
                <Text style={styles.balL}>Commission spillover</Text>
                <Text style={styles.balN}>{fmt(report.user.commission_spillover)} FCFA</Text>
              </View>
            </View>
            <View style={styles.balancesRow}>
              <View style={styles.balCard}>
                <Text style={styles.balL}>Total gagné</Text>
                <Text style={[styles.balN, { fontSize: 16 }]}>{fmt(report.user.total_earned)} FCFA</Text>
              </View>
              <View style={styles.balCard}>
                <Text style={styles.balL}>Filleuls directs</Text>
                <Text style={styles.balN}>{report.direct_downline_count}</Text>
              </View>
            </View>
          </View>

          {report.pending_upgrade ? (
            <View style={[styles.upgradeCard, report.pending_upgrade.can_upgrade_now && { borderColor: theme.colors.danger, backgroundColor: "#FEF2F2" }]} testID="audit-pending-upgrade">
              <Text style={styles.upgradeTitle}>
                ⬆️ Vers Niveau {report.pending_upgrade.next_level}
              </Text>
              <Text style={styles.upgradeLine}>
                Prix : <Text style={{ fontWeight: "700" }}>{fmt(report.pending_upgrade.next_price)} FCFA</Text>
              </Text>
              <Text style={styles.upgradeLine}>
                Réserve : <Text style={{ fontWeight: "700", color: report.pending_upgrade.has_enough_reserve ? theme.colors.success : theme.colors.danger }}>
                  {fmt(report.pending_upgrade.balance_upgrade)} FCFA {report.pending_upgrade.has_enough_reserve ? "✅" : "❌"}
                </Text>
              </Text>
              <Text style={styles.upgradeLine}>
                Descendants au N{report.user.max_level} : <Text style={{ fontWeight: "700", color: report.pending_upgrade.matrix_ready ? theme.colors.success : theme.colors.danger }}>
                  {report.pending_upgrade.current_descendants}/{report.pending_upgrade.required_descendants || "?"} {report.pending_upgrade.matrix_ready ? "✅" : "❌"}
                </Text>
              </Text>
              {report.pending_upgrade.can_upgrade_now ? (
                <Text style={[styles.upgradeLine, { color: theme.colors.danger, fontWeight: "800", marginTop: 6 }]}>
                  🚨 Cet utilisateur PEUT être upgradé MAINTENANT — exécutez le recalcul.
                </Text>
              ) : null}
            </View>
          ) : null}

          <Text style={styles.section}>💰 Commissions reçues par niveau</Text>
          {Object.keys(report.commissions_received_per_level || {}).length === 0 ? (
            <Text style={styles.empty}>Aucune commission reçue.</Text>
          ) : Object.entries(report.commissions_received_per_level).map(([lvl, d]: [string, any]) => (
            <View key={lvl} style={styles.row}>
              <Text style={styles.rowL}>Niveau {lvl}</Text>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={styles.rowN}>{fmt(d.amount)} FCFA</Text>
                <Text style={styles.rowS}>{d.count} commission(s)</Text>
              </View>
            </View>
          ))}

          <Text style={styles.section}>👥 Filleuls directs ({report.direct_downline_count})</Text>
          {(report.direct_downline || []).length === 0 ? (
            <Text style={styles.empty}>Aucun filleul direct.</Text>
          ) : (report.direct_downline || []).map((d: any, i: number) => (
            <View key={i} style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowL}>{d.username}</Text>
                <Text style={styles.rowS}>{d.email}</Text>
              </View>
              <View style={[styles.userMetaPill, { backgroundColor: d.status === "active" ? theme.colors.success : theme.colors.warning }]}>
                <Text style={styles.userMetaTxt}>N{d.max_level || 0} {d.status}</Text>
              </View>
            </View>
          ))}

          <Text style={styles.section}>🌳 Descendants par niveau</Text>
          {Object.entries(report.descendants_per_level || {}).map(([lvl, n]: [string, any]) => (
            <View key={lvl} style={styles.row}>
              <Text style={styles.rowL}>Niveau {lvl}</Text>
              <Text style={styles.rowN}>{n} membre(s)</Text>
            </View>
          ))}
        </>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 12 },
  hTitle: { color: "#fff", fontWeight: "800", fontSize: 16 },
  tabRow: { flexDirection: "row", gap: 6, padding: 10, paddingBottom: 0 },
  tab: { flex: 1, paddingVertical: 9, borderRadius: 18, backgroundColor: theme.colors.surfaceSecondary, alignItems: "center", borderWidth: 1, borderColor: theme.colors.border },
  tabOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  tabTxt: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 11 },
  statsRow: { flexDirection: "row", gap: 8 },
  stat: { flex: 1, padding: 10, borderRadius: 12, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, alignItems: "center" },
  statN: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 18 },
  statL: { color: theme.colors.textSecondary, fontSize: 10, marginTop: 2 },
  section: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 13, marginTop: 14, marginBottom: 8 },
  levelsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  lvlPill: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, backgroundColor: theme.colors.primary, flexDirection: "row", alignItems: "center", gap: 4 },
  lvlPillTxt: { color: "#fff", fontWeight: "700", fontSize: 11 },
  lvlPillN: { color: "#fff", fontSize: 11 },
  ok: { padding: 18, borderRadius: 12, backgroundColor: theme.colors.successBg, alignItems: "center", flexDirection: "row", gap: 10 },
  okTxt: { color: theme.colors.success, fontWeight: "700", flex: 1 },
  issueCard: { padding: 12, borderRadius: 10, backgroundColor: theme.colors.surface, borderLeftWidth: 4, marginBottom: 8 },
  issueTitle: { fontWeight: "800", fontSize: 12 },
  issueCount: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, minWidth: 28, alignItems: "center" },
  issueCountTxt: { color: "#fff", fontWeight: "800", fontSize: 11 },
  issueLine: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 3 },
  more: { color: theme.colors.textSecondary, fontSize: 10, marginTop: 4, fontStyle: "italic" },
  warnBox: { padding: 14, borderRadius: 12, backgroundColor: "#FEF3C7", borderLeftWidth: 4, borderLeftColor: theme.colors.warning, marginBottom: 12 },
  warnTitle: { color: theme.colors.warning, fontWeight: "800", fontSize: 13, marginBottom: 6 },
  warnBody: { color: "#92400E", fontSize: 12, lineHeight: 17 },
  optsRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 12 },
  optChip: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 14, backgroundColor: theme.colors.surfaceSecondary, borderWidth: 1, borderColor: theme.colors.border },
  optChipOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  optChipTxt: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 11 },
  bigBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 13, borderRadius: 20 },
  bigBtnTxt: { color: "#fff", fontWeight: "800", fontSize: 14 },
  summaryGrid: { flexDirection: "row", gap: 8, marginBottom: 8 },
  summaryCard: { flex: 1, padding: 12, borderRadius: 12, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, alignItems: "center" },
  summaryN: { color: theme.colors.primary, fontWeight: "800", fontSize: 22 },
  summaryL: { color: theme.colors.textSecondary, fontSize: 10, marginTop: 2 },
  diffCard: { padding: 10, borderRadius: 10, backgroundColor: theme.colors.surface, borderLeftWidth: 3, borderLeftColor: theme.colors.primary, marginBottom: 6 },
  diffUser: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 12, marginBottom: 4 },
  diffLine: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 2 },
  searchBox: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, marginBottom: 12 },
  searchI: { flex: 1, color: theme.colors.textPrimary, fontSize: 13 },
  searchBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, backgroundColor: theme.colors.primary },
  err: { color: theme.colors.danger, fontWeight: "700", marginTop: 6 },
  errBanner: { flexDirection: "row", alignItems: "center", gap: 8, padding: 12, borderRadius: 10, backgroundColor: theme.colors.dangerBg, borderLeftWidth: 4, borderLeftColor: theme.colors.danger, marginVertical: 8 },
  errBannerTxt: { color: theme.colors.danger, fontWeight: "700", fontSize: 12, flex: 1 },
  userCard: { padding: 14, borderRadius: 14, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, marginBottom: 10 },
  userName: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 16 },
  userEmail: { color: theme.colors.textSecondary, fontSize: 12, marginTop: 2 },
  userMetaRow: { flexDirection: "row", gap: 6, marginTop: 8, flexWrap: "wrap" },
  userMetaPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, backgroundColor: theme.colors.primary },
  userMetaTxt: { color: "#fff", fontWeight: "700", fontSize: 10 },
  balancesRow: { flexDirection: "row", gap: 6, marginTop: 8 },
  balCard: { flex: 1, padding: 8, borderRadius: 8, backgroundColor: theme.colors.surfaceSecondary, borderWidth: 1, borderColor: theme.colors.border },
  balL: { color: theme.colors.textSecondary, fontSize: 10 },
  balN: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 13, marginTop: 2 },
  upgradeCard: { padding: 12, borderRadius: 12, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, marginBottom: 10 },
  upgradeTitle: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 13, marginBottom: 6 },
  upgradeLine: { color: theme.colors.textPrimary, fontSize: 12, marginTop: 3 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, marginBottom: 5 },
  rowL: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 12, flex: 1 },
  rowN: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 13 },
  rowS: { color: theme.colors.textSecondary, fontSize: 10, marginTop: 2 },
  empty: { color: theme.colors.textSecondary, fontStyle: "italic", marginVertical: 8 },
});
