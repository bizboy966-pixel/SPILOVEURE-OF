import React, { useEffect, useState } from "react";
import {
  ScrollView, StyleSheet, Text, View, TouchableOpacity, Image, RefreshControl, Alert, Share,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";

import { Card } from "@/src/components/Card";
import { SideMenu } from "@/src/components/SideMenu";
import { BottomNav } from "@/src/components/BottomNav";
import ProfilePhotoManager from "@/src/components/ProfilePhotoManager";
import { DashboardHero } from "@/src/components/DashboardHero";
import { useAuth } from "@/src/auth";
import { api } from "@/src/api";
import { theme } from "@/src/theme";
import { formatFCFA } from "@/src/utils/format";
import { useServiceBadges } from "@/src/hooks/useServiceBadges";
import { useActivationGuard } from "@/src/components/ActivationGuard";

/* -------------------------------------------------------------
 * Quick action pills — Depot / Retrait / Envoyer / Echanger.
 * ----------------------------------------------------------- */
const QUICK_ACTIONS: Array<{
  key: string; label: string; icon: any; color: string; bg: string; route?: string;
}> = [
  { key: "deposit",  label: "Dépôt",    icon: "arrow-down-circle", color: "#10B981", bg: "#D1FAE5", route: "/(app)/depot" },
  { key: "withdraw", label: "Retrait",  icon: "arrow-up-circle",   color: "#EF4444", bg: "#FEE2E2" },
  { key: "send",     label: "Envoyer",  icon: "paper-plane",       color: "#1B5BFF", bg: "#DBEAFE", route: "/(app)/envoyer" },
  { key: "exchange", label: "Échanger", icon: "swap-horizontal",   color: "#F59E0B", bg: "#FEF3C7", route: "/(app)/echanger" },
];

/* -------------------------------------------------------------
 * Nos services — 8 cartes strictes (2 lignes × 4). Chaque carte
 * pointe vers la fonctionnalité existante correspondante. Voir
 * `/(app)/services-all.tsx` pour le catalogue complet.
 * ----------------------------------------------------------- */
const SERVICE_CARDS: Array<{
  key: string; label: string; icon: any; color: string; bg: string; route: string;
}> = [
  // Ligne 1
  { key: "marketplace", label: "Marketplace", icon: "cart",      color: "#F59E0B", bg: "#FEF3C7", route: "/(app)/marketplace" },
  { key: "ads",         label: "Publicité",   icon: "megaphone", color: "#EC4899", bg: "#FCE7F3", route: "/(app)/ads" },
  { key: "formations",  label: "Formation",   icon: "school",    color: "#0EA5E9", bg: "#E0F2FE", route: "/(app)/formations" },
  { key: "ebooks",      label: "E-book",      icon: "book",      color: "#8B5CF6", bg: "#F3E8FF", route: "/(app)/ebooks" },
  // Ligne 2
  { key: "emploi",      label: "Emploi",      icon: "briefcase", color: "#7B61FF", bg: "#EDE9FE", route: "/(app)/emploi" },
  { key: "premium",     label: "Application Premium", icon: "diamond", color: "#7B61FF", bg: "#EDE9FE", route: "/(app)/premium-apps" },
  { key: "publish",     label: "Publier un article", icon: "create", color: "#1B5BFF", bg: "#DBEAFE", route: "/(app)/marketplace-create" },
  { key: "advertising", label: "Espace publicitaire", icon: "tv", color: "#10B981", bg: "#D1FAE5", route: "/(app)/advertising" },
];

export default function Dashboard() {
  const { user, refresh } = useAuth();
  const router = useRouter();
  const [stats, setStats] = useState<any>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [photoModal, setPhotoModal] = useState(false);
  const [balanceHidden, setBalanceHidden] = useState(false);
  const badges = useServiceBadges();
  const { guardAction } = useActivationGuard();

  // NOTE: activation guard is centralised in `(app)/_layout.tsx`.
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
    const id = setInterval(() => { refresh().catch(() => {}); }, 500);
    const stop = setTimeout(() => clearInterval(id), 60_000 - (Date.now() - flag.ts));
    return () => { clearInterval(id); clearTimeout(stop); };
  }, []);

  const load = async () => {
    try {
      const d = await api.get("/dashboard");
      setStats(d);
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
    } catch { Alert.alert("Erreur", "Impossible de copier le lien."); }
  };

  const share = async () => {
    try {
      await Share.share({ message: `Rejoignez-moi sur Spiloveure : ${inviteLink}` });
    } catch {}
  };

  const soon = () => {
    if (typeof window !== "undefined") window.alert("🚧 Bientôt disponible");
  };

  return (
    <View style={styles.container}>
      {/* Header — gradient + brand + action buttons */}
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <SafeAreaView edges={["top"]}>
          <View style={styles.headerRow}>
            <View style={styles.brandRow}>
              <Image
                source={require("@/assets/images/spiloveure-logo.png")}
                style={styles.brandLogo} resizeMode="contain"
              />
              <View>
                <Text style={styles.brand}>SPILOVEURE</Text>
                <Text style={styles.brandSub}>Affiliate System</Text>
              </View>
            </View>
            <View style={{ flexDirection: "row" }}>
              <TouchableOpacity
                style={styles.headerIconBtn}
                onPress={() => router.push("/(app)/notifications" as any)}
                testID="dashboard-notifications-btn"
              >
                <Ionicons name="notifications" size={18} color="#fff" />
                {stats?.unread_notifications ? (
                  <View style={styles.notifBadge}>
                    <Text style={styles.notifBadgeTxt}>{Math.min(stats.unread_notifications, 99)}</Text>
                  </View>
                ) : null}
              </TouchableOpacity>
              <TouchableOpacity style={styles.headerIconBtn} onPress={() => setMenuOpen(true)} testID="dashboard-menu-btn">
                <Ionicons name="ellipsis-vertical" size={18} color="#fff" />
              </TouchableOpacity>
            </View>
          </View>
        </SafeAreaView>
      </LinearGradient>

      <ScrollView
        contentContainerStyle={{ padding: 14, paddingBottom: 140 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        showsVerticalScrollIndicator={false}
      >
        {/* ─── HERO CARD (v14) ─── */}
        <DashboardHero
          user={user}
          stats={stats}
          balanceHidden={balanceHidden}
          onToggleHidden={() => setBalanceHidden((v) => !v)}
          onAvatarPress={() => setPhotoModal(true)}
          onBalancePress={() => router.push("/(app)/withdrawal" as any)}
        />

        {/* ─── Quick Actions ─── */}
        <View style={styles.quickActionsRow} testID="dashboard-quick-actions">
          {QUICK_ACTIONS.map((a) => {
            // Per spec v16 : Dépôt / Envoyer / Échanger are accessible
            // to pending users; Retrait is protected (activation modal).
            const isProtected = a.key === "withdraw";
            const handle = () => {
              const run = () => (a.route ? router.push(a.route as any) : soon());
              if (isProtected) guardAction(run);
              else run();
            };
            return (
              <TouchableOpacity
                key={a.key}
                style={styles.quickAction}
                onPress={handle}
                activeOpacity={0.85}
                testID={`quick-action-${a.key}`}
              >
                <View style={[styles.quickActionIcon, { backgroundColor: a.bg }]}>
                  <Ionicons name={a.icon} size={22} color={a.color} />
                </View>
                <Text style={styles.quickActionLabel}>{a.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* ─── Nos services (8 raccourcis stricts) ─── */}
        <View style={styles.sectionHead}>
          <Text style={styles.sectionTitle}>Nos services</Text>
          <TouchableOpacity onPress={() => router.push("/(app)/services-all" as any)} testID="dashboard-services-see-all">
            <Text style={styles.sectionLink}>Voir tout</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.servicesGrid} testID="dashboard-services-grid">
          {SERVICE_CARDS.map((s) => {
            const unread =
              s.key === "marketplace" ? badges.marketplace :
              s.key === "ads"         ? badges.ads :
              s.key === "emploi"      ? badges.jobs :
              0;
            return (
              <TouchableOpacity
                key={s.key}
                style={styles.serviceCard}
                onPress={() => router.push(s.route as any)}
                activeOpacity={0.85}
                testID={`service-${s.key}`}
              >
                <View style={styles.serviceIconWrap}>
                  <View style={[styles.serviceIcon, { backgroundColor: s.bg }]}>
                    <Ionicons name={s.icon} size={22} color={s.color} />
                  </View>
                  {unread > 0 ? (
                    <View style={styles.serviceBadge} testID={`service-${s.key}-badge`}>
                      <Text style={styles.serviceBadgeTxt}>{unread > 9 ? "9+" : unread}</Text>
                    </View>
                  ) : null}
                </View>
                <Text style={styles.serviceLabel} numberOfLines={2}>{s.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* ─── Commissions duo card (v19) ─── */}
        <View style={styles.commissionsDuo} testID="dashboard-commissions-duo">
          <LinearGradient
            colors={["#0E1F4F", "#1B5BFF"] as any}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            style={styles.commissionCard}
          >
            <View style={styles.commissionHead}>
              <View style={[styles.commissionIcon, { backgroundColor: "rgba(255,255,255,0.18)" }]}>
                <Ionicons name="git-branch" size={20} color="#93C5FD" />
              </View>
              <View style={styles.commissionMeta}>
                <Text style={styles.commissionLabel}>Commissions</Text>
                <Text style={styles.commissionSubLabel}>Directes</Text>
              </View>
            </View>
            <Text
              style={styles.commissionValue}
              numberOfLines={1}
              adjustsFontSizeToFit
              testID="dashboard-commission-direct"
            >
              {balanceHidden ? "••••••" : formatFCFA(stats?.commission_direct)}
            </Text>
            <View style={styles.commissionFoot}>
              <Ionicons name="person" size={11} color="#93C5FD" />
              <Text style={styles.commissionFootTxt}>Filleuls directs</Text>
            </View>
          </LinearGradient>

          <LinearGradient
            colors={["#7B61FF", "#A855F7"] as any}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            style={styles.commissionCard}
          >
            <View style={styles.commissionHead}>
              <View style={[styles.commissionIcon, { backgroundColor: "rgba(255,255,255,0.22)" }]}>
                <Ionicons name="git-network" size={20} color="#F5F3FF" />
              </View>
              <View style={styles.commissionMeta}>
                <Text style={styles.commissionLabel}>Commissions</Text>
                <Text style={styles.commissionSubLabel}>Spillover</Text>
              </View>
            </View>
            <Text
              style={styles.commissionValue}
              numberOfLines={1}
              adjustsFontSizeToFit
              testID="dashboard-commission-spillover"
            >
              {balanceHidden ? "••••••" : formatFCFA(stats?.commission_spillover)}
            </Text>
            <View style={styles.commissionFoot}>
              <Ionicons name="people" size={11} color="#F5F3FF" />
              <Text style={styles.commissionFootTxt}>Réseau indirect</Text>
            </View>
          </LinearGradient>
        </View>
      </ScrollView>

      <SideMenu visible={menuOpen} onClose={() => setMenuOpen(false)} />
      <ProfilePhotoManager visible={photoModal} onClose={() => setPhotoModal(false)} />
      {user && (user.role === "admin" || (user.max_level || 0) >= 1) ? <BottomNav /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: { paddingBottom: 12, paddingHorizontal: 16 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 6 },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  brand: { color: "#fff", fontSize: 17, fontWeight: "800", letterSpacing: 1.5 },
  brandSub: { color: "#A5C2FF", fontSize: 9, letterSpacing: 1.5 },
  brandLogo: { width: 40, height: 40, borderRadius: 20 },
  headerIconBtn: {
    width: 38, height: 38, borderRadius: 19, marginLeft: 8,
    backgroundColor: "rgba(255,255,255,0.16)",
    alignItems: "center", justifyContent: "center",
    position: "relative",
  },
  notifBadge: {
    position: "absolute", top: -2, right: -2, minWidth: 18, height: 18,
    borderRadius: 9, backgroundColor: "#EF4444", paddingHorizontal: 4,
    alignItems: "center", justifyContent: "center",
    borderWidth: 1.5, borderColor: theme.colors.primary,
  },
  notifBadgeTxt: { color: "#fff", fontSize: 10, fontWeight: "800" },

  quickActionsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 14,
    gap: 8,
  },
  quickAction: {
    flex: 1,
    alignItems: "center",
    backgroundColor: theme.colors.surface,
    borderRadius: 18,
    paddingVertical: 12,
    paddingHorizontal: 6,
    borderWidth: 1,
    borderColor: theme.colors.border,
    ...theme.shadow.card,
  },
  quickActionIcon: {
    width: 42, height: 42, borderRadius: 21,
    alignItems: "center", justifyContent: "center",
    marginBottom: 6,
  },
  quickActionLabel: {
    fontSize: 11,
    fontWeight: "800",
    color: theme.colors.textPrimary,
  },

  sectionHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 18,
    marginBottom: 10,
  },
  sectionTitle: { fontWeight: "900", color: theme.colors.textPrimary, fontSize: 16, letterSpacing: -0.3 },
  sectionLink: { color: theme.colors.primary, fontWeight: "800", fontSize: 12 },

  servicesGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
  },
  serviceCard: {
    width: "23%",
    aspectRatio: 0.9,
    marginBottom: 10,
    backgroundColor: theme.colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
    paddingVertical: 8,
    ...theme.shadow.card,
  },
  serviceIconWrap: {
    position: "relative",
    marginBottom: 6,
  },
  serviceIcon: {
    width: 42, height: 42, borderRadius: 21,
    alignItems: "center", justifyContent: "center",
  },
  serviceBadge: {
    position: "absolute", top: -4, right: -6,
    minWidth: 18, height: 18, borderRadius: 10,
    backgroundColor: "#EF4444",
    alignItems: "center", justifyContent: "center",
    borderWidth: 1.5, borderColor: theme.colors.surface,
    paddingHorizontal: 4,
  },
  serviceBadgeTxt: { color: "#fff", fontWeight: "900", fontSize: 9 },
  serviceLabel: {
    fontSize: 10,
    fontWeight: "800",
    color: theme.colors.textPrimary,
    textAlign: "center",
  },

  commissionsDuo: {
    flexDirection: "row",
    gap: 10,
    marginTop: 18,
  },
  commissionCard: {
    flex: 1,
    borderRadius: 20,
    padding: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    shadowColor: "#0B2D6F",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.22,
    shadowRadius: 20,
    elevation: 6,
    overflow: "hidden",
  },
  commissionHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 8,
  },
  commissionIcon: {
    width: 38, height: 38, borderRadius: 12,
    alignItems: "center", justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
  },
  commissionMeta: { flex: 1 },
  commissionLabel: {
    color: "rgba(255,255,255,0.75)",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  commissionSubLabel: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "900",
    letterSpacing: -0.1,
    marginTop: 1,
  },
  commissionValue: {
    color: "#fff",
    fontSize: 20,
    fontWeight: "900",
    letterSpacing: -0.5,
    marginTop: 2,
  },
  commissionFoot: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.14)",
  },
  commissionFootTxt: {
    color: "rgba(255,255,255,0.9)",
    fontSize: 10,
    fontWeight: "700",
  },

  linkBox: { backgroundColor: theme.colors.surfaceMuted, padding: 14, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.colors.border },
  linkText: { color: theme.colors.textPrimary, fontSize: 12, fontWeight: "500" },
  copyBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    backgroundColor: theme.colors.secondary, paddingVertical: 12, borderRadius: theme.radius.md,
  },
  copyBtnText: { color: "#fff", fontWeight: "800", letterSpacing: 0.2 },

  teamRow: { flexDirection: "row", gap: 10, marginTop: 14 },
  teamCard: {
    flex: 1,
    backgroundColor: theme.colors.surface,
    borderRadius: 18,
    padding: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    ...theme.shadow.card,
  },
  teamHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  teamTitle: { fontWeight: "800", color: theme.colors.textPrimary, fontSize: 12, letterSpacing: -0.2 },
  teamStatRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 8 },
  teamLabel: { fontWeight: "600", fontSize: 12 },
  teamValue: { fontWeight: "900", fontSize: 14 },
});
