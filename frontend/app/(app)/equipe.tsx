import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator, RefreshControl, ScrollView, StyleSheet,
  Text, TouchableOpacity, View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { Card } from "@/src/components/Card";
import { api } from "@/src/api";
import { theme } from "@/src/theme";

type Member = {
  id: string;
  username: string;
  phone?: string;
  status?: string;
  max_level?: number;
  created_at?: string;
  activated_at?: string;
  level_activated_at?: Record<string, string>;
};
type Bucket = {
  members: Member[];
  active: number;
  inactive: number;
  total: number;
};
type Tab = "direct" | "indirect";

const fmtDate = (v?: string) => {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
};

// Une activation = premier passage à L1. On récupère level_activated_at["1"] si dispo.
const getActivationDate = (m: Member): string => {
  const la = m.level_activated_at;
  if (la && la["1"]) return fmtDate(la["1"]);
  if (m.activated_at) return fmtDate(m.activated_at);
  return (m.status === "active" || (m.max_level || 0) >= 1) ? fmtDate(m.created_at) : "—";
};

export default function EquipePage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("direct");
  const [direct, setDirect] = useState<Bucket | null>(null);
  const [indirect, setIndirect] = useState<Bucket | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, i] = await Promise.all([
        api.get<Bucket>("/team/direct"),
        api.get<Bucket>("/team/indirect"),
      ]);
      setDirect(d);
      setIndirect(i);
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert(`❌ ${e?.detail || "Échec chargement de l'équipe."}`);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const currentBucket = tab === "direct" ? direct : indirect;
  const isActive = (m: Member) => m.status === "active" || (m.max_level || 0) >= 1;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }} testID="team-page">
      <LinearGradient
        colors={[theme.colors.primary, theme.colors.primaryDark || "#2563EB"]}
        style={styles.header}
      >
        <View style={styles.headerTopRow}>
          <TouchableOpacity
            onPress={() => (router.canGoBack() ? router.back() : router.push("/(app)/dashboard"))}
            style={styles.backBtn}
            hitSlop={12}
            testID="team-back"
          >
            <Ionicons name="arrow-back" size={22} color="#fff" />
            <Text style={styles.backTxt}>Retour</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.headerTitle}>👥 Mon Équipe</Text>
        <Text style={styles.headerSub}>
          Consultez la composition de votre réseau
        </Text>
      </LinearGradient>

      <ScrollView
        contentContainerStyle={{ padding: 14, paddingBottom: 60 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
      >
        {/* TABS */}
        <View style={styles.tabRow}>
          <TouchableOpacity
            style={[styles.tab, tab === "direct" && styles.tabOn]}
            onPress={() => setTab("direct")}
            testID="team-tab-direct"
          >
            <Ionicons name="person" size={16} color={tab === "direct" ? "#fff" : theme.colors.textPrimary} />
            <Text style={[styles.tabT, tab === "direct" && { color: "#fff" }]}>
              👤 Équipe directe{direct ? ` (${direct.total})` : ""}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tab, tab === "indirect" && styles.tabOn]}
            onPress={() => setTab("indirect")}
            testID="team-tab-indirect"
          >
            <Ionicons name="git-network" size={16} color={tab === "indirect" ? "#fff" : theme.colors.textPrimary} />
            <Text style={[styles.tabT, tab === "indirect" && { color: "#fff" }]}>
              🌐 Équipe indirecte{indirect ? ` (${indirect.total})` : ""}
            </Text>
          </TouchableOpacity>
        </View>

        {/* STATS ROW */}
        {currentBucket && (
          <View style={styles.statsRow} testID={`team-stats-${tab}`}>
            <View style={styles.statBox}>
              <Text style={styles.statN}>{currentBucket.total}</Text>
              <Text style={styles.statL}>Total</Text>
            </View>
            <View style={styles.statBox}>
              <Text style={[styles.statN, { color: theme.colors.success }]}>{currentBucket.active}</Text>
              <Text style={styles.statL}>🟢 Actifs</Text>
            </View>
            <View style={styles.statBox}>
              <Text style={[styles.statN, { color: theme.colors.danger }]}>{currentBucket.inactive}</Text>
              <Text style={styles.statL}>🔴 Inactifs</Text>
            </View>
          </View>
        )}

        {/* CONTEXTUAL EXPLAINER */}
        <View style={styles.explainerBox}>
          <Ionicons
            name={tab === "direct" ? "person-add" : "shuffle"}
            size={16}
            color={theme.colors.primary}
          />
          <Text style={styles.explainer}>
            {tab === "direct"
              ? "Toutes les personnes qui se sont inscrites via votre lien de parrainage direct."
              : "Utilisateurs placés dans votre équipe par le système Spillover (ne sont pas vos filleuls directs)."}
          </Text>
        </View>

        {/* LIST */}
        {loading && !currentBucket ? (
          <View style={{ padding: 30, alignItems: "center" }}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
          </View>
        ) : !currentBucket || currentBucket.total === 0 ? (
          <Card style={{ marginTop: 12 }}>
            <View style={{ alignItems: "center", padding: 20 }}>
              <Ionicons
                name={tab === "direct" ? "person-add-outline" : "shuffle-outline"}
                size={48}
                color={theme.colors.textSecondary}
              />
              <Text style={styles.emptyText}>
                {tab === "direct"
                  ? "Aucun filleul direct pour le moment."
                  : "Aucun membre spillover dans votre équipe."}
              </Text>
              <Text style={styles.emptyHint}>
                {tab === "direct"
                  ? "Partagez votre lien de parrainage pour commencer à construire votre équipe."
                  : "Les nouveaux membres apparaîtront ici automatiquement quand ils vous seront attribués."}
              </Text>
            </View>
          </Card>
        ) : (
          currentBucket.members.map((m, idx) => (
            <Card key={m.id} style={{ marginTop: 10 }} testID={`team-member-${m.id}`}>
              <View style={styles.memberHead}>
                <View style={styles.memberAvatar}>
                  <Text style={styles.memberAvatarT}>{(m.username || "?").slice(0, 2).toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.memberName}>@{m.username || "—"}</Text>
                  <Text style={styles.memberSub}>#{idx + 1}</Text>
                </View>
                <View style={[styles.statusPill, isActive(m) ? styles.pillActive : styles.pillInactive]}>
                  <Text style={styles.pillT}>{isActive(m) ? "🟢 Actif" : "🔴 Inactif"}</Text>
                </View>
              </View>

              <View style={styles.kvBox}>
                <KV label="🆔 Identifiant" value={m.id.slice(0, 8) + "…"} mono />
                {tab === "direct" && m.phone ? <KV label="📱 Téléphone" value={m.phone} /> : null}
                <KV label="📅 Inscrit le" value={fmtDate(m.created_at)} />
                <KV label="✅ Activé le" value={getActivationDate(m)} />
                {isActive(m) && (m.max_level || 0) > 0 ? (
                  <KV label="🏅 Niveau" value={`N${m.max_level}`} />
                ) : null}
              </View>
            </Card>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function KV({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.kvRow}>
      <Text style={styles.kvL}>{label}</Text>
      <Text style={[styles.kvV, mono && { fontFamily: "monospace" }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { paddingTop: 30, paddingBottom: 22, paddingHorizontal: 16 },
  headerTopRow: { flexDirection: "row", alignItems: "center", marginBottom: 8 },
  backBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, backgroundColor: "rgba(255,255,255,0.15)" },
  backTxt: { color: "#fff", fontWeight: "700", fontSize: 13 },
  headerTitle: { color: "#fff", fontSize: 22, fontWeight: "900" },
  headerSub: { color: "rgba(255,255,255,0.85)", fontSize: 13, marginTop: 4 },

  tabRow: { flexDirection: "row", gap: 6, marginBottom: 10 },
  tab: {
    flex: 1, padding: 10, borderRadius: 10, backgroundColor: theme.colors.surface,
    alignItems: "center", justifyContent: "center",
    flexDirection: "row", gap: 6, borderWidth: 1, borderColor: theme.colors.border,
  },
  tabOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  tabT: { fontSize: 12, fontWeight: "700", color: theme.colors.textPrimary },

  statsRow: { flexDirection: "row", gap: 6, marginBottom: 10 },
  statBox: { flex: 1, padding: 12, borderRadius: 10, backgroundColor: theme.colors.surface, alignItems: "center" },
  statN: { fontSize: 22, fontWeight: "900", color: theme.colors.textPrimary },
  statL: { fontSize: 11, color: theme.colors.textSecondary, marginTop: 2 },

  explainerBox: {
    flexDirection: "row", alignItems: "center", gap: 8, padding: 10, borderRadius: 8,
    backgroundColor: theme.colors.surfaceSecondary, marginBottom: 10,
  },
  explainer: { flex: 1, fontSize: 11, color: theme.colors.textSecondary, lineHeight: 15 },

  emptyText: { fontSize: 14, fontWeight: "700", color: theme.colors.textPrimary, marginTop: 12, textAlign: "center" },
  emptyHint: { fontSize: 12, color: theme.colors.textSecondary, marginTop: 6, textAlign: "center", fontStyle: "italic" },

  memberHead: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 8 },
  memberAvatar: {
    width: 42, height: 42, borderRadius: 21, backgroundColor: theme.colors.primary,
    alignItems: "center", justifyContent: "center",
  },
  memberAvatarT: { color: "#fff", fontWeight: "900", fontSize: 14 },
  memberName: { fontSize: 14, fontWeight: "800", color: theme.colors.textPrimary },
  memberSub: { fontSize: 10, color: theme.colors.textSecondary },
  statusPill: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  pillActive: { backgroundColor: "#D1FAE5" },
  pillInactive: { backgroundColor: "#FEE2E2" },
  pillT: { fontSize: 10, fontWeight: "800", color: "#1F2937" },

  kvBox: { gap: 4, paddingTop: 4, borderTopWidth: 1, borderTopColor: theme.colors.border },
  kvRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 },
  kvL: { fontSize: 11, color: theme.colors.textSecondary },
  kvV: { fontSize: 11, color: theme.colors.textPrimary, fontWeight: "700" },
});
