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
import { useAuth } from "@/src/auth";
import { api } from "@/src/api";
import { theme } from "@/src/theme";
import { formatFCFA, formatDate } from "@/src/utils/format";

export default function Dashboard() {
  const { user, refresh } = useAuth();
  const router = useRouter();
  const [stats, setStats] = useState<any>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Block access if the user has not activated their account yet (admins exempt).
  useEffect(() => {
    if (user && user.role !== "admin" && (user.max_level || 0) < 1) {
      router.replace("/(app)/activation");
    }
  }, [user?.max_level, user?.role]);

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
                style={{ width: 40, height: 40 }} resizeMode="contain"
              />
              <View>
                <Text style={styles.brand}>Spiloveure</Text>
                <Text style={styles.brandSub}>AFFILIATE SYSTEM</Text>
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
              <Ionicons name="person" size={28} color="#fff" />
            </View>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Text style={styles.username}>{user?.username}</Text>
                <Ionicons name="checkmark-circle" size={18} color="#22D3EE" />
              </View>
              <View style={styles.lvlPill}>
                <Ionicons name="ribbon" size={12} color="#F59E0B" />
                <Text style={styles.lvlText}>Niveau {user?.max_level ?? 0}</Text>
              </View>
              <Text style={styles.memberSince}>
                <Ionicons name="calendar-outline" size={12} color="#C7D9FF" /> Membre depuis : {formatDate(user?.created_at)}
              </Text>
            </View>
          </View>
        </SafeAreaView>
      </LinearGradient>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {/* Balance */}
        <TouchableOpacity onPress={() => router.push("/(app)/withdrawal")} activeOpacity={0.9} testID="dashboard-balance-card">
          <LinearGradient colors={theme.colors.primaryGradient} style={styles.balanceCard}>
            <View style={{ flex: 1 }}>
              <Text style={styles.balanceLabel}>Solde total du compte</Text>
              <Text style={styles.balanceValue}>{formatFCFA(stats?.balance_total)}</Text>
              <Text style={styles.balanceHint}>Cliquez pour gérer votre retrait.</Text>
            </View>
            <View style={styles.walletIcon}>
              <Ionicons name="wallet" size={32} color="#fff" />
            </View>
          </LinearGradient>
        </TouchableOpacity>

        {/* Profit Total + Retrait Total — lifetime stats */}
        <View style={styles.statsRow}>
          <View style={[styles.statCard, { backgroundColor: "#7C3AED" }]}>
            <View style={styles.statIconBox}>
              <Ionicons name="diamond" size={20} color="#fff" />
            </View>
            <Text style={styles.statLabel}>Profit Total</Text>
            <Text style={styles.statValue} testID="dashboard-total-profit">
              {formatFCFA(stats?.total_profit)}
            </Text>
            <Text style={styles.statHint}>cumul historique</Text>
          </View>
          <View style={[styles.statCard, { backgroundColor: "#1B5BFF" }]}>
            <View style={styles.statIconBox}>
              <Ionicons name="arrow-up-circle" size={20} color="#fff" />
            </View>
            <Text style={styles.statLabel}>Retrait Total</Text>
            <Text style={styles.statValue} testID="dashboard-total-withdrawn">
              {formatFCFA(stats?.total_withdrawn)}
            </Text>
            <Text style={styles.statHint}>retraits validés</Text>
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
              <Text style={styles.detailLabel}>💎 Profit retirable</Text>
              <Text style={[styles.detailValue, { color: theme.colors.success }]}>{formatFCFA(stats?.balance_profit)}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.detailLabel}>🔒 Réserve mise à niveau</Text>
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: { paddingBottom: 16, paddingHorizontal: 16 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 8 },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  brand: { color: "#fff", fontSize: 18, fontWeight: "800", letterSpacing: 2 },
  brandSub: { color: "#A5C2FF", fontSize: 9, letterSpacing: 2 },
  menuBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignItems: "center", justifyContent: "center",
  },
  profileCard: {
    flexDirection: "row", alignItems: "center", gap: 12, marginTop: 16,
    backgroundColor: "rgba(255,255,255,0.12)", padding: 12, borderRadius: 16,
  },
  avatar: { width: 56, height: 56, borderRadius: 28, backgroundColor: theme.colors.secondary, alignItems: "center", justifyContent: "center" },
  username: { color: "#fff", fontSize: 18, fontWeight: "800" },
  lvlPill: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: "rgba(255,255,255,0.2)",
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, alignSelf: "flex-start", marginTop: 4,
  },
  lvlText: { color: "#fff", fontWeight: "700", fontSize: 12 },
  memberSince: { color: "#C7D9FF", fontSize: 11, marginTop: 4 },

  balanceCard: { borderRadius: 24, padding: 20, flexDirection: "row", alignItems: "center", ...theme.shadow.button },
  balanceLabel: { color: "#C7D9FF", fontSize: 13 },
  balanceValue: { color: "#fff", fontSize: 32, fontWeight: "800", marginTop: 4 },
  balanceHint: { color: "#C7D9FF", fontSize: 11, marginTop: 4 },
  statsRow: { flexDirection: "row", gap: 10, marginTop: 12 },
  statCard: { flex: 1, padding: 14, borderRadius: 16, alignItems: "flex-start", shadowColor: "#000", shadowOpacity: 0.06, shadowOffset: { width: 0, height: 4 }, shadowRadius: 8, elevation: 3 },
  statIconBox: { width: 36, height: 36, borderRadius: 10, backgroundColor: "rgba(255,255,255,0.18)", alignItems: "center", justifyContent: "center", marginBottom: 8 },
  statLabel: { color: "rgba(255,255,255,0.85)", fontSize: 11, letterSpacing: 0.5, textTransform: "uppercase", fontWeight: "700" },
  statValue: { color: "#fff", fontSize: 18, fontWeight: "800", marginTop: 4 },
  statHint: { color: "rgba(255,255,255,0.7)", fontSize: 10, marginTop: 4 },
  walletIcon: { width: 64, height: 64, borderRadius: 16, backgroundColor: "rgba(255,255,255,0.18)", alignItems: "center", justifyContent: "center" },

  row: { flexDirection: "row", gap: 12, marginTop: 12 },
  commCard: { flex: 1, borderRadius: 16, padding: 14, flexDirection: "row", alignItems: "center", gap: 10 },
  commIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center" },
  commLabel: { color: "rgba(255,255,255,0.85)", fontSize: 11 },
  commValue: { color: "#fff", fontSize: 16, fontWeight: "800", marginTop: 2 },

  sectionTitle: { fontWeight: "800", color: theme.colors.textPrimary, fontSize: 16 },
  detailRow: { flexDirection: "row", marginTop: 8, gap: 12 },
  detailLabel: { color: theme.colors.textSecondary, fontSize: 12 },
  detailValue: { fontSize: 16, fontWeight: "800", marginTop: 2 },

  linkBox: { backgroundColor: theme.colors.surfaceSecondary, padding: 12, borderRadius: 12 },
  linkText: { color: theme.colors.textPrimary, fontSize: 12 },
  copyBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    backgroundColor: theme.colors.secondary, paddingVertical: 10, borderRadius: 12,
  },
  copyBtnText: { color: "#fff", fontWeight: "700" },

  teamTitle: { fontWeight: "700", color: theme.colors.textPrimary },
  teamRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 8 },
  teamLabel: { fontWeight: "600" },
  teamValue: { fontWeight: "800" },

  quickBtn: {
    flex: 1, backgroundColor: "#fff", borderRadius: 16, paddingVertical: 16,
    alignItems: "center", gap: 6, ...theme.shadow.card,
  },
  quickLabel: { fontWeight: "700", color: theme.colors.textPrimary, fontSize: 12 },
});
