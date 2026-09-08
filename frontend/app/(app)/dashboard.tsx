import React, { useEffect, useState } from "react";
import {
  ScrollView, StyleSheet, Text, View, TouchableOpacity, Image, RefreshControl, Alert, Platform, Share,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";

import { Card } from "@/src/components/Card";
import { SideMenu } from "@/src/components/SideMenu";
import { BottomNav } from "@/src/components/BottomNav";
import { useAuth } from "@/src/auth";
import { api } from "@/src/api";
import { theme } from "@/src/theme";
import { formatFCFA, formatDate } from "@/src/utils/format";

export default function Dashboard() {
  const { user, refresh } = useAuth();
  const router = useRouter();
  const [stats, setStats] = useState<any>(null);
  const [missionWallets, setMissionWallets] = useState<any>({ wallets: [], total: 0 });
  const [challenge, setChallenge] = useState<any>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // NOTE: activation guard is centralised in `(app)/_layout.tsx` which
  // routes pending users to `/(app)/pay`. We MUST NOT duplicate a guard
  // here — a duplicate can fire on a briefly-stale `user` right after a
  // successful activation + hard reload, bouncing the freshly-activated
  // user back to the old `/(app)/activation` page (bug reported
  // 2026-09-07). Trust the layout.

  // Force a fresh `/auth/me` on every Dashboard mount so the account
  // status/max_level shown to the user is always current. Also, when
  // the `just_activated` localStorage flag is present (posted by the
  // payment flow right before its hard-reload), keep re-polling until
  // /auth/me reports max_level ≥ 1 — this converges even on Mongo
  // replication lag and eliminates the "compte s'active puis se
  // désactive" bug (2026-09-07 v3).
  useEffect(() => {
    refresh().catch(() => {});
    if (typeof window === "undefined") return;
    let raw: string | null = null;
    try { raw = window.localStorage.getItem("just_activated"); } catch {}
    if (!raw) return;
    let flag: any = null;
    try { flag = JSON.parse(raw); } catch { flag = null; }
    if (!flag || typeof flag.ts !== "number" || Date.now() - flag.ts > 60_000) {
      try { window.localStorage.removeItem("just_activated"); } catch {}
      return;
    }
    const id = setInterval(() => {
      refresh().catch(() => {});
    }, 500);
    // Stop after the grace window even if refresh never converges.
    const stop = setTimeout(() => clearInterval(id), 60_000 - (Date.now() - flag.ts));
    return () => { clearInterval(id); clearTimeout(stop); };
  }, []);

  const load = async () => {
    try {
      const d = await api.get("/dashboard");
      setStats(d);
      try {
        const mw = await api.get<any>("/me/mission-wallets");
        setMissionWallets(mw);
      } catch {}
      try {
        const ch = await api.get<any>("/challenges/current");
        setChallenge(ch);
      } catch {}
    } catch (e: any) {
      console.log("dashboard error", e);
    }
  };

  useEffect(() => { load(); }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await refresh();
    await load();
    setRefreshing(false);
  };

  const inviteLink = `https://spiloveure.com/u/${user?.username || "admin"}`;

  const copy = async () => {
    try {
      await Clipboard.setStringAsync(inviteLink);
      Alert.alert("Copié ✅", "Le lien d'invitation a été copié.");
    } catch {
      Alert.alert("Erreur", "Impossible de copier le lien.");
    }
  };

  const share = async () => {
    try {
      await Share.share({ message: `Rejoignez-moi sur Spiloveure : ${inviteLink}` });
    } catch {}
  };

  return (
    <View style={styles.container}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <SafeAreaView edges={["top"]}>
          <View style={styles.headerRow}>
            <View style={styles.brandRow}>
              <Image
                source={require("@/assets/images/spiloveure-logo.png")}
                style={{ width: 34, height: 34 }} resizeMode="contain"
              />
              <View>
                <Text style={styles.brand}>SPILOVEURE</Text>
                <Text style={styles.brandSub}>affiliate system</Text>
              </View>
            </View>
            <TouchableOpacity
              style={[styles.menuBtn, { marginRight: 8 }]}
              onPress={() => router.push("/(app)/services")}
              testID="dashboard-services-btn"
            >
              <Ionicons name="apps" size={20} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.menuBtn, { marginRight: 8 }]}
              onPress={onRefresh}
              disabled={refreshing}
              testID="dashboard-refresh-btn"
            >
              <Ionicons
                name={refreshing ? "sync" : "refresh"}
                size={20}
                color="#fff"
              />
            </TouchableOpacity>
            <TouchableOpacity style={styles.menuBtn} onPress={() => setMenuOpen(true)} testID="dashboard-menu-btn">
              <Ionicons name="ellipsis-vertical" size={22} color="#fff" />
            </TouchableOpacity>
          </View>

          <View style={styles.profileCard}>
            <View style={styles.avatar}>
              <Ionicons name="person" size={22} color="#fff" />
            </View>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Text style={styles.username}>{user?.username}</Text>
                <Ionicons name="checkmark-circle" size={15} color="#22D3EE" />
              </View>
              <View style={styles.lvlPill}>
                <Ionicons name="ribbon" size={11} color="#F59E0B" />
                <Text style={styles.lvlText}>Niveau {user?.max_level ?? 0}</Text>
              </View>
              <Text style={styles.memberSince}>
                <Ionicons name="calendar-outline" size={11} color="#C7D9FF" /> Membre depuis : {formatDate(user?.created_at)}
              </Text>
            </View>
          </View>
        </SafeAreaView>
      </LinearGradient>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 120 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {/* ─── Hero split : Profit Total | Activation ─── */}
        <LinearGradient colors={theme.colors.primaryGradient} style={styles.heroCard} testID="dashboard-hero-card">
          <View style={styles.heroSide}>
            <View style={styles.heroHeaderRow}>
              <Ionicons name="diamond" size={13} color="#C7D9FF" />
              <Text style={styles.heroLabel}>Profit Total</Text>
            </View>
            <Text style={styles.heroValue} numberOfLines={1} adjustsFontSizeToFit testID="dashboard-total-profit">
              {formatFCFA(stats?.total_profit)}
            </Text>
            <Text style={styles.heroHint}>cumul historique</Text>
          </View>
          <View style={styles.heroDivider} />
          <View style={styles.heroSide}>
            <View style={styles.heroHeaderRow}>
              <Ionicons name="shield-checkmark" size={13} color="#C7D9FF" />
              <Text style={styles.heroLabel}>Activation</Text>
            </View>
            <Text style={styles.heroValue} numberOfLines={1} adjustsFontSizeToFit testID="dashboard-activation-amount">
              2 500 FCFA
            </Text>
            <Text style={styles.heroHint}>Niveau 1 activé</Text>
          </View>
        </LinearGradient>

        {/* 🏆 Active Challenge — 100 direct invites campaign */}
        {challenge?.challenge ? (
          <ChallengeCard
            data={challenge}
            onContactSupport={async () => {
              try {
                const sup = await api.get<any>("/settings/support", { auth: false } as any);
                const url = sup?.whatsapp_url || sup?.telegram_url;
                if (url && typeof window !== "undefined") {
                  window.open(url, "_blank");
                } else {
                  Alert.alert(
                    "Contactez le service client",
                    "Utilisez le bouton flottant 💬 en bas à droite pour joindre notre équipe."
                  );
                }
              } catch {
                Alert.alert(
                  "Contactez le service client",
                  "Utilisez le bouton flottant 💬 en bas à droite pour joindre notre équipe."
                );
              }
            }}
          />
        ) : null}

        {/* ─── Bloc unifié split : Solde Disponible | Retrait Total ─── */}
        <View style={styles.splitCard} testID="dashboard-balance-split">
          <TouchableOpacity
            style={[styles.splitSide, styles.splitSideLeft, { backgroundColor: "#10B981" }]}
            onPress={() => router.push("/(app)/withdrawal")}
            activeOpacity={0.85}
            testID="dashboard-balance-card"
          >
            <View style={styles.splitIconBox}>
              <Ionicons name="wallet" size={16} color="#fff" />
            </View>
            <Text style={styles.splitLabel}>Solde Disponible</Text>
            <Text style={styles.splitValue} numberOfLines={1} adjustsFontSizeToFit testID="dashboard-balance-profit">
              {formatFCFA(stats?.balance_profit)}
            </Text>
            <Text style={styles.splitHint}>disponible au retrait</Text>
          </TouchableOpacity>
          <View style={styles.splitDivider} />
          <View style={[styles.splitSide, styles.splitSideRight, { backgroundColor: "#1B5BFF" }]}>
            <View style={styles.splitIconBox}>
              <Ionicons name="arrow-up-circle" size={16} color="#fff" />
            </View>
            <Text style={styles.splitLabel}>Retrait Total</Text>
            <Text style={styles.splitValue} numberOfLines={1} adjustsFontSizeToFit testID="dashboard-total-withdrawn">
              {formatFCFA(stats?.total_withdrawn)}
            </Text>
            <Text style={styles.splitHint}>retraits validés</Text>
          </View>
        </View>

        {/* Commissions */}
        <View style={styles.row}>
          <View style={[styles.commCard, { backgroundColor: theme.colors.secondary }]}>
            <View style={styles.commIcon}><Ionicons name="cash" size={20} color="#fff" /></View>
            <View>
              <Text style={styles.commLabel}>Commission Spillover</Text>
              <Text style={styles.commValue}>{formatFCFA(stats?.commission_spillover)}</Text>
            </View>
          </View>
          <View style={[styles.commCard, { backgroundColor: theme.colors.success }]}>
            <View style={styles.commIcon}><Ionicons name="people" size={20} color="#fff" /></View>
            <View>
              <Text style={styles.commLabel}>Parrainage direct</Text>
              <Text style={styles.commValue}>{formatFCFA(stats?.commission_direct)}</Text>
            </View>
          </View>
        </View>

        {/* Profit / reserve detail */}
        <Card style={{ marginTop: 12 }}>
          <Text style={styles.sectionTitle}>Détail du solde</Text>
          <View style={styles.detailRow}>
            <View style={{ flex: 1 }}>
              <View style={styles.detailLabelRow}>
                <Ionicons name="diamond-outline" size={13} color={theme.colors.textSecondary} />
                <Text style={styles.detailLabel}>Profit retirable</Text>
              </View>
              <Text style={[styles.detailValue, { color: theme.colors.success }]}>{formatFCFA(stats?.balance_profit)}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <View style={styles.detailLabelRow}>
                <Ionicons name="lock-closed-outline" size={13} color={theme.colors.textSecondary} />
                <Text style={styles.detailLabel}>Réserve mise à niveau</Text>
              </View>
              <Text style={[styles.detailValue, { color: theme.colors.warning }]}>{formatFCFA(stats?.balance_upgrade)}</Text>
            </View>
          </View>
        </Card>

        {/* Invite link */}
        <Card style={{ marginTop: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <Ionicons name="link" size={18} color={theme.colors.secondary} />
            <Text style={styles.sectionTitle}>Lien d'inscription</Text>
          </View>
          <View style={styles.linkBox}>
            <Text style={styles.linkText} numberOfLines={1}>{inviteLink}</Text>
          </View>
          <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
            <TouchableOpacity style={[styles.copyBtn, { flex: 1 }]} onPress={copy} testID="copy-invite-link">
              <Ionicons name="copy" size={16} color="#fff" />
              <Text style={styles.copyBtnText}>Copier</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.copyBtn, { flex: 1, backgroundColor: theme.colors.primary }]} onPress={share} testID="share-invite-link">
              <Ionicons name="share-social" size={16} color="#fff" />
              <Text style={styles.copyBtnText}>Partager</Text>
            </TouchableOpacity>
          </View>
        </Card>

        {/* Teams */}
        <View style={styles.row}>
          <Card style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Ionicons name="people-circle" size={20} color={theme.colors.primary} />
              <Text style={styles.teamTitle}>Équipe directe</Text>
            </View>
            <View style={styles.teamRow}>
              <Text style={[styles.teamLabel, { color: theme.colors.success }]}>Actifs</Text>
              <Text style={[styles.teamValue, { color: theme.colors.success }]}>{stats?.direct_active ?? 0}</Text>
            </View>
            <View style={styles.teamRow}>
              <Text style={[styles.teamLabel, { color: theme.colors.danger }]}>Inactifs</Text>
              <Text style={[styles.teamValue, { color: theme.colors.danger }]}>{stats?.direct_inactive ?? 0}</Text>
            </View>
          </Card>
          <Card style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Ionicons name="git-network" size={20} color={theme.colors.secondary} />
              <Text style={styles.teamTitle}>Équipe Spillover</Text>
            </View>
            <View style={styles.teamRow}>
              <Text style={[styles.teamLabel, { color: theme.colors.success }]}>Actifs</Text>
              <Text style={[styles.teamValue, { color: theme.colors.success }]}>{stats?.spillover_active ?? 0}</Text>
            </View>
            <View style={styles.teamRow}>
              <Text style={[styles.teamLabel, { color: theme.colors.danger }]}>Inactifs</Text>
              <Text style={[styles.teamValue, { color: theme.colors.danger }]}>{stats?.spillover_inactive ?? 0}</Text>
            </View>
          </Card>
        </View>

        {/* Quick actions */}
        <View style={[styles.row, { marginTop: 4 }]}>
          <TouchableOpacity style={styles.quickBtn} onPress={() => router.push("/(app)/matrices")} testID="quick-matrices">
            <Ionicons name="grid" size={22} color={theme.colors.secondary} />
            <Text style={styles.quickLabel}>Matrices</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.quickBtn} onPress={() => router.push("/(app)/team-direct")} testID="quick-team">
            <Ionicons name="people" size={22} color={theme.colors.success} />
            <Text style={styles.quickLabel}>Mon équipe</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.quickBtn} onPress={() => router.push("/(app)/community")} testID="quick-community">
            <Ionicons name="megaphone" size={22} color={theme.colors.warning} />
            <Text style={styles.quickLabel}>Communauté</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      <SideMenu visible={menuOpen} onClose={() => setMenuOpen(false)} />
      {/* Bottom navigation — home dashboard, all activated users (incl. admin). */}
      {user && (user.role === "admin" || (user.max_level || 0) >= 1) ? <BottomNav /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: { paddingBottom: 12, paddingHorizontal: 16 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 6 },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  brand: { color: "#fff", fontSize: 17, fontWeight: "700", letterSpacing: 1.5 },
  brandSub: { color: "#A5C2FF", fontSize: 9, letterSpacing: 1.5 },
  menuBtn: {
    width: 36, height: 36, borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignItems: "center", justifyContent: "center",
  },
  profileCard: {
    flexDirection: "row", alignItems: "center", gap: 10, marginTop: 10,
    backgroundColor: "rgba(255,255,255,0.12)", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16,
  },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: theme.colors.secondary, alignItems: "center", justifyContent: "center" },
  username: { color: "#fff", fontSize: 15, fontWeight: "700", letterSpacing: -0.1 },
  lvlPill: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: "rgba(255,255,255,0.2)",
    paddingHorizontal: 7, paddingVertical: 2, borderRadius: 9, alignSelf: "flex-start", marginTop: 2,
  },
  lvlText: { color: "#fff", fontWeight: "700", fontSize: 11 },
  memberSince: { color: "#C7D9FF", fontSize: 10, marginTop: 2 },

  balanceCard: { borderRadius: theme.radius.xl, padding: theme.spacing.lg, flexDirection: "row", alignItems: "center", ...theme.shadow.lifted },
  balanceLabel: { color: "#C7D9FF", fontSize: 12, fontWeight: "600", letterSpacing: 0.3, textTransform: "uppercase" },
  balanceValue: { color: "#fff", fontSize: 22, fontWeight: "800", marginTop: 6, letterSpacing: -0.5 },
  // Compact hero card (Profit Total | Activation) — v9 spec.
  heroCard: {
    borderRadius: 20, paddingVertical: 14, paddingHorizontal: 14,
    flexDirection: "row", alignItems: "stretch", ...theme.shadow.lifted,
  },
  heroSide: { flex: 1, justifyContent: "center" },
  heroHeaderRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 },
  heroLabel: {
    color: "#C7D9FF", fontSize: 11, fontWeight: "600",
    letterSpacing: 0.4, textTransform: "uppercase",
  },
  heroValue: {
    color: "#fff", fontSize: 20, fontWeight: "800",
    marginTop: 2, letterSpacing: -0.4,
  },
  heroHint: { color: "#C7D9FF", fontSize: 10, marginTop: 3 },
  heroDivider: { width: 1, alignSelf: "stretch", backgroundColor: "rgba(255,255,255,0.25)", marginHorizontal: 12 },
  balanceHint: { color: "#C7D9FF", fontSize: 11, marginTop: 4 },
  reserveRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 },
  reserveText: { color: "#FDE68A", fontSize: 12, fontWeight: "700" },
  statsRow: { flexDirection: "row", gap: 12, marginTop: 14 },
  statCard: { flex: 1, padding: theme.spacing.md, borderRadius: theme.radius.lg, alignItems: "flex-start", ...theme.shadow.card },
  statIconBox: { width: 38, height: 38, borderRadius: 14, backgroundColor: "rgba(255,255,255,0.18)", alignItems: "center", justifyContent: "center", marginBottom: 10 },
  statLabel: { color: "rgba(255,255,255,0.85)", fontSize: 10, letterSpacing: 1, textTransform: "uppercase", fontWeight: "600" },
  statValue: { color: "#fff", fontSize: 18, fontWeight: "800", marginTop: 4, letterSpacing: -0.3 },
  statHint: { color: "rgba(255,255,255,0.7)", fontSize: 10, marginTop: 4 },
  walletIcon: { width: 64, height: 64, borderRadius: theme.radius.lg, backgroundColor: "rgba(255,255,255,0.18)", alignItems: "center", justifyContent: "center" },

  // Unified split card (Solde | Retrait) — collé avec divider vertical.
  splitCard: {
    flexDirection: "row", marginTop: 12, borderRadius: 20,
    overflow: "hidden", ...theme.shadow.card,
  },
  splitSide: { flex: 1, paddingVertical: 14, paddingHorizontal: 12 },
  splitSideLeft: {},
  splitSideRight: {},
  splitDivider: { width: 1, backgroundColor: "rgba(255,255,255,0.35)" },
  splitIconBox: {
    width: 32, height: 32, borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.22)",
    alignItems: "center", justifyContent: "center", marginBottom: 8,
  },
  splitLabel: {
    color: "rgba(255,255,255,0.9)", fontSize: 10.5, fontWeight: "600",
    letterSpacing: 0.4, textTransform: "uppercase",
  },
  splitValue: {
    color: "#fff", fontSize: 17, fontWeight: "800",
    marginTop: 3, letterSpacing: -0.3,
  },
  splitHint: { color: "rgba(255,255,255,0.78)", fontSize: 10, marginTop: 3 },

  row: { flexDirection: "row", gap: 12, marginTop: 14 },
  commCard: { flex: 1, borderRadius: theme.radius.lg, padding: theme.spacing.md, flexDirection: "row", alignItems: "center", gap: 10 },
  commIcon: { width: 38, height: 38, borderRadius: 19, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center" },
  commLabel: { color: "rgba(255,255,255,0.85)", fontSize: 11, fontWeight: "500" },
  commValue: { color: "#fff", fontSize: 16, fontWeight: "800", marginTop: 2, letterSpacing: -0.3 },

  sectionTitle: { fontWeight: "800", color: theme.colors.textPrimary, fontSize: 16, letterSpacing: -0.3 },
  detailRow: { flexDirection: "row", marginTop: 10, gap: 12 },
  detailLabelRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  detailLabel: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: "500" },
  detailValue: { fontSize: 15, fontWeight: "700", marginTop: 2, letterSpacing: -0.2 },

  linkBox: { backgroundColor: theme.colors.surfaceMuted, padding: 14, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.colors.border },
  linkText: { color: theme.colors.textPrimary, fontSize: 12, fontWeight: "500" },
  copyBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    backgroundColor: theme.colors.secondary, paddingVertical: 12, borderRadius: theme.radius.md,
  },
  copyBtnText: { color: "#fff", fontWeight: "700", letterSpacing: 0.2 },

  teamTitle: { fontWeight: "800", color: theme.colors.textPrimary, letterSpacing: -0.2 },
  teamRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 10 },
  teamLabel: { fontWeight: "500", color: theme.colors.textSecondary, fontSize: 13 },
  teamValue: { fontWeight: "800", letterSpacing: -0.2 },

  quickBtn: {
    flex: 1, backgroundColor: "#fff", borderRadius: theme.radius.lg, paddingVertical: 18,
    alignItems: "center", gap: 8, borderWidth: 1, borderColor: theme.colors.border, ...theme.shadow.card,
  },
  quickLabel: { fontWeight: "700", color: theme.colors.textPrimary, fontSize: 12, letterSpacing: -0.1 },

  chCard: {
    marginTop: 14, borderRadius: theme.radius.lg, padding: theme.spacing.lg, overflow: "hidden",
    backgroundColor: "#F59E0B", ...theme.shadow.card,
  },
  chHeadRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 8 },
  chIconBox: {
    width: 40, height: 40, borderRadius: 24, backgroundColor: "rgba(255,255,255,0.25)",
    alignItems: "center", justifyContent: "center",
  },
  chTitle: { color: "#fff", fontSize: 15, fontWeight: "700", letterSpacing: -0.1 },
  chSubtitle: { color: "rgba(255,255,255,0.9)", fontSize: 11, marginTop: 2 },
  chStatsRow: { flexDirection: "row", gap: 8, marginTop: 6 },
  chStatBox: {
    flex: 1, backgroundColor: "rgba(255,255,255,0.15)", padding: 8, borderRadius: 12,
  },
  chStatLabel: { color: "rgba(255,255,255,0.85)", fontSize: 10, fontWeight: "600" },
  chStatValue: { color: "#fff", fontSize: 15, fontWeight: "700", marginTop: 2, letterSpacing: -0.2 },
  chProgressTrack: {
    height: 10, backgroundColor: "rgba(255,255,255,0.25)", borderRadius: 5,
    marginTop: 10, overflow: "hidden",
  },
  chProgressFill: { height: 10, backgroundColor: "#fff", borderRadius: 5 },
  chProgressText: { color: "#fff", fontWeight: "700", fontSize: 12, marginTop: 6, textAlign: "right" },
  chBadgeWin: {
    marginTop: 10, backgroundColor: "#065F46", padding: 10, borderRadius: 12,
    flexDirection: "row", alignItems: "center", gap: 8,
  },
  chBadgeWinText: { color: "#D1FAE5", fontSize: 12, fontWeight: "700", flex: 1 },
  chBadgeWinBtn: {
    backgroundColor: "#fff", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10,
  },
  chBadgeWinBtnText: { color: "#065F46", fontWeight: "700", fontSize: 12 },
});

// ============================================================
// Challenge card (100 direct invites campaign) — dashboard.
// ============================================================
function ChallengeCard({
  data,
  onContactSupport,
}: {
  data: { challenge: any; progress: number; completed: boolean };
  onContactSupport: () => void;
}) {
  const { challenge, progress, completed } = data;
  const target: number = challenge.target || 100;
  const percent = Math.max(0, Math.min(100, (progress / target) * 100));
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const endMs = new Date(challenge.end_at).getTime();
  const remaining = Math.max(0, endMs - now);
  const remainingLabel = formatCountdown(remaining);

  return (
    <View style={styles.chCard} testID="dashboard-challenge-card">
      <View style={styles.chHeadRow}>
        <View style={styles.chIconBox}>
          <Ionicons name="trophy" size={22} color="#fff" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.chTitle}>🏆 {challenge.name}</Text>
          <Text style={styles.chSubtitle}>
            Objectif : {target} invitations directes actives
          </Text>
        </View>
      </View>

      <View style={styles.chStatsRow}>
        <View style={styles.chStatBox}>
          <Text style={styles.chStatLabel}>🎁 Récompense</Text>
          <Text style={styles.chStatValue}>
            {formatFCFA(challenge.reward_amount)}
          </Text>
        </View>
        <View style={styles.chStatBox}>
          <Text style={styles.chStatLabel}>⏳ Temps restant</Text>
          <Text style={styles.chStatValue} testID="dashboard-challenge-countdown">
            {remainingLabel}
          </Text>
        </View>
      </View>

      <View style={styles.chProgressTrack}>
        <View style={[styles.chProgressFill, { width: `${percent}%` }]} />
      </View>
      <Text style={styles.chProgressText} testID="dashboard-challenge-progress">
        {progress} / {target}
      </Text>

      {completed ? (
        <View style={styles.chBadgeWin} testID="dashboard-challenge-completed">
          <Ionicons name="checkmark-circle" size={20} color="#D1FAE5" />
          <Text style={styles.chBadgeWinText}>
            🎉 Objectif atteint ! Contactez le service client pour récupérer votre récompense.
          </Text>
          <TouchableOpacity onPress={onContactSupport} style={styles.chBadgeWinBtn} testID="dashboard-challenge-contact">
            <Text style={styles.chBadgeWinBtnText}>Contacter</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return "Terminé";
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (d > 0) return `${d}j ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}
