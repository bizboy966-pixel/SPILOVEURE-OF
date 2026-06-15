import React, { useCallback, useEffect, useState } from "react";
import {
  Alert, FlatList, RefreshControl, ScrollView, StyleSheet, Text, View, TextInput, TouchableOpacity,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { Card } from "@/src/components/Card";
import { Button } from "@/src/components/Button";
import { Input } from "@/src/components/Input";
import { api } from "@/src/api";
import { useAuth } from "@/src/auth";
import { theme } from "@/src/theme";
import { formatFCFA, formatDateTime } from "@/src/utils/format";

type Tab = "dashboard" | "users" | "activations" | "withdrawals" | "announcements" | "channels" | "payment";

export default function AdminHome() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const [tab, setTab] = useState<Tab>("dashboard");
  const [refreshing, setRefreshing] = useState(false);

  const [stats, setStats] = useState<any>(null);
  const [serverIp, setServerIp] = useState<string | null>(null);
  const [ipLoading, setIpLoading] = useState(false);
  const [ipError, setIpError] = useState<string | null>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [usersQ, setUsersQ] = useState("");
  const [activations, setActivations] = useState<any[]>([]);
  const [actQ, setActQ] = useState("");
  const [withdrawals, setWithdrawals] = useState<any[]>([]);
  const [wdQ, setWdQ] = useState("");
  const [announcements, setAnnouncements] = useState<any[]>([]);
  const [channels, setChannels] = useState<any[]>([]);

  // New announcement / channel forms
  const [annTitle, setAnnTitle] = useState("");
  const [annMsg, setAnnMsg] = useState("");
  const [annPriority, setAnnPriority] = useState<"normale" | "importante" | "urgente">("normale");
  const [chName, setChName] = useState("");
  const [chUrl, setChUrl] = useState("");
  const [chPlatform, setChPlatform] = useState("telegram");
  const [chDesc, setChDesc] = useState("");

  // Sub-tab filters for activations / withdrawals
  const [actFilter, setActFilter] = useState<"pending" | "validated" | "rejected">("pending");
  const [wdFilter, setWdFilter] = useState<"pending" | "validated" | "rejected">("pending");

  // Manual payment settings
  const [mpEnabled, setMpEnabled] = useState(false);  const [mpTitle, setMpTitle] = useState("Paiement manuel");
  const [mpInstructions, setMpInstructions] = useState("");
  const [mpPaymentUrl, setMpPaymentUrl] = useState("");
  const [mpPhone, setMpPhone] = useState("");
  const [mpOperator, setMpOperator] = useState("");
  const [mpAllowedCountries, setMpAllowedCountries] = useState<string[]>([]);
  const [mpSaving, setMpSaving] = useState(false);

  // Crypto payment (USDT BEP20) settings
  const [cryptoEnabled, setCryptoEnabled] = useState(false);
  const [cryptoNetwork, setCryptoNetwork] = useState("USDT BEP20");
  const [cryptoWallet, setCryptoWallet] = useState("");
  const [cryptoAmount, setCryptoAmount] = useState("5");
  const [cryptoInstructions, setCryptoInstructions] = useState("");
  const [cryptoSaving, setCryptoSaving] = useState(false);

  // Country catalog loaded from /api/config (drives the allowed-countries grid)
  const [cfgCountries, setCfgCountries] = useState<{ code: string; name: string; flag: string }[]>([]);

  // Withdrawal fee settings
  const [wdEnabled, setWdEnabled] = useState(true);
  const [wdFeePercent, setWdFeePercent] = useState("0");
  const [wdFeeFlat, setWdFeeFlat] = useState("0");
  const [wdMinAmount, setWdMinAmount] = useState("0");
  const [wdMaxAmount, setWdMaxAmount] = useState("");
  const [wdAllowedDays, setWdAllowedDays] = useState<number[]>([0,1,2,3,4,5,6]);
  const [wdOpenTime, setWdOpenTime] = useState("07:00");
  const [wdCloseTime, setWdCloseTime] = useState("20:00");
  const [wdSaving, setWdSaving] = useState(false);

  // Support / social links
  const [supTelegram, setSupTelegram] = useState("");
  const [supWhatsapp, setSupWhatsapp] = useState("");
  const [supFacebook, setSupFacebook] = useState("");
  const [supYoutube, setSupYoutube] = useState("");
  const [supInstagram, setSupInstagram] = useState("");
  const [supTwitter, setSupTwitter] = useState("");
  const [supDiscord, setSupDiscord] = useState("");
  const [supEmail, setSupEmail] = useState("");
  const [supPhone, setSupPhone] = useState("");
  const [supWebsite, setSupWebsite] = useState("");
  const [supSaving, setSupSaving] = useState(false);

  // Community popup
  const [cpEnabled, setCpEnabled] = useState(true);
  const [cpTitle, setCpTitle] = useState("📢 COMMUNAUTÉ OFFICIELLE SPILOVEURE");
  const [cpDesc, setCpDesc] = useState("");
  const [cpImage, setCpImage] = useState("");
  const [cpTelegram, setCpTelegram] = useState("");
  const [cpButton, setCpButton] = useState("🚀 REJOINDRE MAINTENANT");
  const [cpSeconds, setCpSeconds] = useState("5");
  const [cpSaving, setCpSaving] = useState(false);

  // Stuck payments (paid but failed to activate)
  const [stuck, setStuck] = useState<any[]>([]);
  const [stuckReprocessing, setStuckReprocessing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      if (tab === "dashboard") {
        setStats(await api.get("/admin/stats"));
        try {
          const sp = await api.get<{ items: any[] }>("/admin/payments/stuck");
          setStuck(sp?.items || []);
        } catch {}
      }
      if (tab === "users") setUsers(await api.get(`/admin/users${usersQ ? `?q=${encodeURIComponent(usersQ)}` : ""}`));
      if (tab === "activations") setActivations(await api.get("/admin/activations"));
      if (tab === "withdrawals") setWithdrawals(await api.get("/admin/withdrawals"));
      if (tab === "announcements") setAnnouncements(await api.get("/admin/announcements"));
      if (tab === "channels") setChannels(await api.get("/admin/channels"));
      if (tab === "payment") {
        try {
          const conf = await api.get<{ countries: any[] }>("/config", { auth: false });
          if (Array.isArray(conf?.countries)) setCfgCountries(conf.countries as any);
        } catch {}
        const cfg = await api.get<any>("/admin/settings/manual-payment");
        setMpEnabled(!!cfg.enabled);
        setMpTitle(cfg.title || "Paiement manuel");
        setMpInstructions(cfg.instructions || "");
        setMpPaymentUrl(cfg.payment_url || "");
        setMpPhone(cfg.phone_to_pay || "");
        setMpOperator(cfg.operator_name || "");
        setMpAllowedCountries(Array.isArray(cfg.allowed_countries) ? cfg.allowed_countries : []);

        const cp = await api.get<any>("/admin/settings/crypto-payment");
        setCryptoEnabled(!!cp.enabled);
        setCryptoNetwork(cp.network || "USDT BEP20");
        setCryptoWallet(cp.wallet_address || "");
        setCryptoAmount(String(cp.amount_usdt ?? 5));
        setCryptoInstructions(cp.instructions || "");

        const wd = await api.get<any>("/admin/settings/withdrawal");
        setWdEnabled(wd.enabled !== false);
        setWdFeePercent(String(wd.fee_percent ?? 0));
        setWdFeeFlat(String(wd.fee_flat ?? 0));
        setWdMinAmount(String(wd.min_amount ?? 0));
        setWdMaxAmount(wd.max_amount ? String(wd.max_amount) : "");

        const sup = await api.get<any>("/admin/settings/support");
        setSupTelegram(sup.telegram_url || "");
        setSupWhatsapp(sup.whatsapp_url || "");
        setSupFacebook(sup.facebook_url || "");
        setSupYoutube(sup.youtube_url || "");
        setSupInstagram(sup.instagram_url || "");
        setSupTwitter(sup.twitter_url || "");
        setSupDiscord(sup.discord_url || "");
        setSupEmail(sup.email || "");
        setSupPhone(sup.phone || "");
        setSupWebsite(sup.website_url || "");

        const cpop = await api.get<any>("/admin/settings/community-popup");
        setCpEnabled(cpop.enabled !== false);
        setCpTitle(cpop.title || "📢 COMMUNAUTÉ OFFICIELLE SPILOVEURE");
        setCpDesc(cpop.description || "");
        setCpImage(cpop.image_url || "");
        setCpTelegram(cpop.telegram_url || "");
        setCpButton(cpop.button_label || "🚀 REJOINDRE MAINTENANT");
        setCpSeconds(String(cpop.auto_close_seconds ?? 5));
      }
    } catch (e: any) {
      console.log("admin load err", e?.detail);
    }
  }, [tab, usersQ]);

  useEffect(() => { load(); }, [load]);

  const fetchServerIp = useCallback(async () => {
    setIpLoading(true);
    setIpError(null);
    try {
      const data = await api.get("/admin/outbound-ip");
      const ip = data?.outbound_ip || (Array.isArray(data?.all_detected) && data.all_detected[0]) || null;
      setServerIp(ip);
      if (!ip) setIpError("IP non détectée");
    } catch (e: any) {
      setIpError(e?.detail || "Impossible de récupérer l'IP");
    } finally {
      setIpLoading(false);
    }
  }, []);

  const copyIp = useCallback(async () => {
    if (!serverIp) return;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(serverIp);
        Alert.alert("Copié", `IP ${serverIp} copiée dans le presse-papiers.`);
      } else {
        Alert.alert("IP serveur", serverIp);
      }
    } catch {
      Alert.alert("IP serveur", serverIp);
    }
  }, [serverIp]);

  const action = async (fn: () => Promise<any>, ok = "✅ Opération réussie") => {
    try {
      await fn();
      Alert.alert("Succès", ok);
      await load();
    } catch (e: any) {
      Alert.alert("Erreur", e?.detail || "Erreur");
    }
  };

  const TABS: { key: Tab; label: string; icon: any }[] = [
    { key: "dashboard", label: "Dashboard", icon: "stats-chart" },
    { key: "users", label: "Utilisateurs", icon: "people" },
    { key: "activations", label: "Activations", icon: "checkmark-circle" },
    { key: "withdrawals", label: "Retraits", icon: "cash" },
    { key: "announcements", label: "Annonces", icon: "megaphone" },
    { key: "channels", label: "Canaux", icon: "link" },
    { key: "payment", label: "Réglages", icon: "settings" },
  ];

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1 }}>
            <TouchableOpacity
              onPress={() => {
                if (tab !== "dashboard") { setTab("dashboard"); return; }
                try {
                  // @ts-ignore canGoBack exists in expo-router web
                  if (router.canGoBack && router.canGoBack()) router.back();
                  else router.replace("/services" as any);
                } catch { router.replace("/services" as any); }
              }}
              style={styles.backBtn}
              testID="admin-back-btn"
            >
              <Ionicons name="chevron-back" size={22} color="#fff" />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Ionicons name="shield-checkmark" size={22} color="#fff" />
                <Text style={styles.title}>Panel Admin Spiloveure</Text>
              </View>
              <Text style={styles.sub}>Connecté en tant que {user?.username}</Text>
            </View>
          </View>
          <TouchableOpacity onPress={async () => { await signOut(); router.replace("/(auth)/login"); }} style={styles.logoutBtn} testID="admin-logout">
            <Ionicons name="log-out-outline" size={20} color="#fff" />
          </TouchableOpacity>
        </View>
      </LinearGradient>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
        {TABS.map((t) => (
          <TouchableOpacity
            key={t.key}
            style={[styles.tab, tab === t.key && styles.tabOn]}
            onPress={() => setTab(t.key)}
            testID={`admin-tab-${t.key}`}
          >
            <Ionicons name={t.icon} size={14} color={tab === t.key ? "#fff" : theme.colors.primary} />
            <Text style={[styles.tabT, tab === t.key && { color: "#fff" }]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
      >
        {tab === "dashboard" && stats && (
          <>
            <View style={styles.statGrid}>
              <StatCard icon="people" color="#3B82F6" label="Utilisateurs" value={stats.users_total} />
              <StatCard icon="checkmark-circle" color={theme.colors.success} label="Actifs" value={stats.users_active} />
              <StatCard icon="hourglass" color={theme.colors.warning} label="Activations à valider" value={stats.activations_pending} />
              <StatCard icon="cash" color={theme.colors.secondary} label="Retraits en attente" value={stats.withdrawals_pending} />
              <StatCard icon="trending-up" color="#0EA5E9" label="Total activations" value={formatFCFA(stats.total_activations_amount)} small />
              <StatCard icon="arrow-down-circle" color={theme.colors.danger} label="Total retraits" value={formatFCFA(stats.total_withdrawals_amount)} small />
            </View>

            <TouchableOpacity
              style={styles.contentMgmtCta}
              onPress={() => router.push("/(admin)/content" as any)}
              testID="admin-open-content-mgmt"
            >
              <View style={styles.contentMgmtIcon}>
                <Ionicons name="library" size={24} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.contentMgmtTitle}>Gestion des contenus</Text>
                <Text style={styles.contentMgmtSub}>
                  Formations • E-Books • Apps Premium • Trading
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={22} color="#fff" />
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.contentMgmtCta, { marginTop: 10, backgroundColor: theme.colors.success }]}
              onPress={() => router.push("/(admin)/missions" as any)}
              testID="admin-open-missions-mgmt"
            >
              <View style={styles.contentMgmtIcon}>
                <Ionicons name="videocam" size={24} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.contentMgmtTitle}>🎥 Gestion des Missions</Text>
                <Text style={styles.contentMgmtSub}>
                  YouTube • TikTok • Instagram • Facebook • Questionnaires
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={22} color="#fff" />
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.contentMgmtCta, { marginTop: 10, backgroundColor: theme.colors.warning }]}
              onPress={() => router.push("/(admin)/payments" as any)}
              testID="admin-open-payments-mgmt"
            >
              <View style={styles.contentMgmtIcon}>
                <Ionicons name="card" size={24} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.contentMgmtTitle}>💳 Paiements SendavaPay</Text>
                <Text style={styles.contentMgmtSub}>
                  Tous les paiements • Bloqués • Forcer l'activation
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={22} color="#fff" />
            </TouchableOpacity>

            {stuck.length > 0 && (
              <Card style={{ marginTop: 14, borderWidth: 2, borderColor: theme.colors.danger }} testID="admin-stuck-card">
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <View style={{ width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.danger + "22" }}>
                    <Ionicons name="warning" size={20} color={theme.colors.danger} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: theme.colors.textPrimary, fontWeight: "800", fontSize: 15 }}>
                      ⚠️ Paiements en échec d'activation ({stuck.length})
                    </Text>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 12, marginTop: 2 }}>
                      Paiements confirmés (paid) mais dont l'activation a échoué. Cliquez sur "Relancer" pour réessayer.
                    </Text>
                  </View>
                </View>
                {stuck.map((p) => (
                  <View key={p.reference} style={styles.stuckRow} testID={`stuck-${p.reference}`}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.stuckRef}>{p.reference}</Text>
                      <Text style={styles.stuckMeta}>
                        {p.username || p.user_id} • Niveau {p.level} • {formatFCFA(p.amount)} {p.currency} • {(p.provider || "").toUpperCase()}
                      </Text>
                      {p.activation_error ? (
                        <Text style={styles.stuckErr} numberOfLines={2}>❌ {p.activation_error}</Text>
                      ) : null}
                    </View>
                    <TouchableOpacity
                      style={[styles.stuckBtn, stuckReprocessing === p.reference && { opacity: 0.55 }]}
                      disabled={stuckReprocessing === p.reference}
                      onPress={async () => {
                        setStuckReprocessing(p.reference);
                        try {
                          const r = await api.post<any>(`/admin/payments/${encodeURIComponent(p.reference)}/reprocess`);
                          if (typeof window !== "undefined") window.alert(`✅ Activation réussie — niveau ${r.level}`);
                          setStuck((cur) => cur.filter((x) => x.reference !== p.reference));
                        } catch (e: any) {
                          if (typeof window !== "undefined") window.alert(`❌ ${e?.detail || "Échec"}`);
                          load();
                        } finally {
                          setStuckReprocessing(null);
                        }
                      }}
                      testID={`stuck-reprocess-${p.reference}`}
                    >
                      <Ionicons name="refresh" size={14} color="#fff" />
                      <Text style={styles.stuckBtnTxt}>{stuckReprocessing === p.reference ? "..." : "Relancer"}</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </Card>
            )}

            <Card style={{ marginTop: 14 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <View style={{ width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: "#0EA5E922" }}>
                  <Ionicons name="globe-outline" size={20} color="#0EA5E9" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: theme.colors.text, fontWeight: "700", fontSize: 15 }}>IP du serveur de production</Text>
                  <Text style={{ color: theme.colors.textSecondary, fontSize: 12, marginTop: 2 }}>
                    À whitelister chez votre passerelle de paiement (Money Fusion, etc.).
                  </Text>
                </View>
              </View>

              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                <View style={{
                  flex: 1, minWidth: 180, paddingVertical: 12, paddingHorizontal: 14,
                  backgroundColor: theme.colors.background, borderRadius: 10,
                  borderWidth: 1, borderColor: theme.colors.border,
                }}>
                  <Text style={{
                    fontFamily: "monospace", fontSize: 16, fontWeight: "700",
                    color: serverIp ? theme.colors.text : theme.colors.textSecondary,
                    letterSpacing: 0.5,
                  }} selectable testID="admin-server-ip-value">
                    {ipLoading ? "Détection en cours…" : (serverIp || ipError || "Cliquez sur Actualiser")}
                  </Text>
                </View>

                <TouchableOpacity
                  onPress={fetchServerIp}
                  disabled={ipLoading}
                  style={{
                    backgroundColor: theme.colors.primary, paddingVertical: 12, paddingHorizontal: 14,
                    borderRadius: 10, flexDirection: "row", alignItems: "center", gap: 6,
                    opacity: ipLoading ? 0.6 : 1,
                  }}
                  testID="admin-server-ip-refresh"
                >
                  <Ionicons name="refresh" size={16} color="#fff" />
                  <Text style={{ color: "#fff", fontWeight: "700", fontSize: 13 }}>Actualiser</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={copyIp}
                  disabled={!serverIp}
                  style={{
                    backgroundColor: serverIp ? theme.colors.success : theme.colors.border,
                    paddingVertical: 12, paddingHorizontal: 14,
                    borderRadius: 10, flexDirection: "row", alignItems: "center", gap: 6,
                  }}
                  testID="admin-server-ip-copy"
                >
                  <Ionicons name="copy-outline" size={16} color="#fff" />
                  <Text style={{ color: "#fff", fontWeight: "700", fontSize: 13 }}>Copier</Text>
                </TouchableOpacity>
              </View>

              {ipError && !ipLoading && (
                <Text style={{ color: theme.colors.danger, fontSize: 12, marginTop: 8 }}>{ipError}</Text>
              )}
            </Card>
          </>
        )}

        {tab === "users" && (
          <>
            <View style={styles.searchRow}>
              <View style={styles.searchBox}>
                <Ionicons name="search" size={16} color={theme.colors.textSecondary} />
                <TextInput
                  placeholder="Rechercher username, email, téléphone..."
                  placeholderTextColor={theme.colors.textSecondary}
                  style={styles.searchI}
                  value={usersQ}
                  onChangeText={setUsersQ}
                  onSubmitEditing={load}
                  testID="admin-users-search"
                />
              </View>
              <TouchableOpacity onPress={load} style={styles.refreshBtn}><Ionicons name="refresh" size={18} color="#fff" /></TouchableOpacity>
            </View>
            {users.map((u) => (
              <Card key={u.id} style={{ marginBottom: 8 }}>
                <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
                  <View style={[styles.avatar, { backgroundColor: u.status === "active" ? theme.colors.success : u.status === "banned" ? theme.colors.danger : theme.colors.warning }]}>
                    <Ionicons name="person" size={16} color="#fff" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <Text style={styles.userName}>{u.username}</Text>
                      {u.role === "admin" && <View style={[styles.tag, { backgroundColor: "#F59E0B22" }]}><Text style={[styles.tagT, { color: "#F59E0B" }]}>ADMIN</Text></View>}
                      {u.is_promoter && <View style={[styles.tag, { backgroundColor: "#A855F722" }]}><Text style={[styles.tagT, { color: "#A855F7" }]}>PROMOTEUR</Text></View>}
                      <View style={[styles.tag, { backgroundColor: "#DBEAFE" }]}><Text style={[styles.tagT, { color: theme.colors.primary }]}>Niv. {u.max_level}</Text></View>
                    </View>
                    <Text style={styles.userMeta}>ID: {String(u.id).substring(0, 13)}…</Text>
                    <Text style={styles.userMeta}>{u.email} • {u.phone}</Text>
                    <Text style={styles.userMeta}>Parrain: {u.sponsor_username || "—"} • Pays: {u.country}</Text>
                    <Text style={styles.userMeta}>Inscrit le: {formatDateTime(u.created_at)}</Text>
                    <Text style={styles.userMeta}>Statut: <Text style={{ fontWeight: "700", color: u.status === "active" ? theme.colors.success : u.status === "banned" ? theme.colors.danger : theme.colors.warning }}>{u.status?.toUpperCase()}</Text> • Solde profit: {formatFCFA(u.balance_profit)}</Text>
                  </View>
                </View>
                <View style={styles.actRow}>
                  <TouchableOpacity style={[styles.actBtn, { backgroundColor: theme.colors.primary, flex: 1 }]} onPress={() => router.push(`/(admin)/user/${u.id}`)} testID={`admin-manage-${u.id}`}>
                    <Ionicons name="settings" size={14} color="#fff" />
                    <Text style={styles.actT}>Gérer</Text>
                  </TouchableOpacity>
                </View>
              </Card>
            ))}
          </>
        )}

        {tab === "activations" && (
          <>
            <View style={styles.searchRow}>
              <View style={styles.searchBox}>
                <Ionicons name="search" size={16} color={theme.colors.textSecondary} />
                <TextInput
                  placeholder="Rechercher: nom, ID, téléphone, référence..."
                  placeholderTextColor={theme.colors.textSecondary}
                  style={styles.searchI}
                  value={actQ}
                  onChangeText={setActQ}
                  testID="admin-activations-search"
                />
                {actQ ? (
                  <TouchableOpacity onPress={() => setActQ("")} testID="admin-activations-search-clear">
                    <Ionicons name="close-circle" size={16} color={theme.colors.textSecondary} />
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
            <SubTabs
              tabs={[
                { key: "pending", label: "En attente", color: theme.colors.warning, count: activations.filter((a) => a.status === "pending").length },
                { key: "validated", label: "Activées", color: theme.colors.success, count: activations.filter((a) => a.status === "validated" || a.status === "active").length },
                { key: "rejected", label: "Rejetées", color: theme.colors.danger, count: activations.filter((a) => a.status === "rejected").length },
              ]}
              active={actFilter}
              onChange={(k) => setActFilter(k as any)}
              testIdPrefix="activations-filter"
            />
            {(() => {
              const q = actQ.trim().toLowerCase();
              const filtered = activations.filter((a) => {
                const statusOk = actFilter === "pending"
                  ? a.status === "pending"
                  : actFilter === "validated"
                    ? (a.status === "validated" || a.status === "active")
                    : a.status === "rejected";
                if (!statusOk) return false;
                if (!q) return true;
                const haystack = [
                  a.username, a.email, a.user_id, a.id,
                  a.payment_phone, a.transaction_ref, a.tx_hash, a.operator, a.payer_country,
                ].filter(Boolean).join(" ").toLowerCase();
                return haystack.includes(q);
              });
              if (filtered.length === 0) {
                return <Card><Text style={styles.empty}>{q ? `Aucun résultat pour "${actQ}".` : `Aucune activation ${actFilter === "pending" ? "en attente" : actFilter === "validated" ? "validée" : "rejetée"}.`}</Text></Card>;
              }
              return filtered.map((a) => (
              <Card key={a.id} style={{ marginBottom: 8 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <Text style={styles.userName}>{a.username}</Text>
                  <PillStatus status={a.status} />
                </View>
                <View style={styles.kvBox}>
                  <KvRow k="Niveau" v={`Niveau ${a.level}`} />
                  <KvRow k="E-mail" v={a.email} />
                  <KvRow k="Mode de paiement" v={a.payment_method?.replace("_", " ") || "—"} />
                  {a.payer_country ? <KvRow k="Pays" v={a.payer_country} /> : null}
                  {a.operator ? <KvRow k="Opérateur" v={a.operator} /> : null}
                  <KvRow k="Numéro paiement" v={a.payment_phone || "—"} />
                  {a.network ? <KvRow k="Réseau crypto" v={a.network} /> : null}
                  {a.amount_usdt ? <KvRow k="Montant USDT" v={`${a.amount_usdt} USDT`} /> : null}
                  {a.tx_hash ? (
                    <View style={{ marginTop: 4 }}>
                      <Text style={{ color: theme.colors.textSecondary, fontSize: 11, fontWeight: "700" }}>Hash TXID (cliquer pour copier)</Text>
                      <TouchableOpacity
                        onPress={() => {
                          if (typeof navigator !== "undefined" && (navigator as any).clipboard) {
                            (navigator as any).clipboard.writeText(a.tx_hash);
                            if (typeof window !== "undefined") window.alert("Hash copié ✅");
                          }
                        }}
                        testID={`admin-copy-tx-${a.id}`}
                      >
                        <Text selectable style={{ color: theme.colors.primary, fontFamily: "monospace", fontSize: 11, marginTop: 2 }}>
                          {a.tx_hash}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  ) : null}
                  <KvRow k="Montant" v={formatFCFA(a.amount)} />
                  <KvRow k="Date/Heure" v={formatDateTime(a.created_at)} />
                  {a.transaction_ref ? <KvRow k="Réf. transaction" v={a.transaction_ref} /> : null}
                  {a.validated_at ? <KvRow k="Validé le" v={formatDateTime(a.validated_at)} /> : null}
                  {a.rejected_at ? <KvRow k="Rejeté le" v={formatDateTime(a.rejected_at)} /> : null}
                </View>
                {a.status === "pending" && (
                  <View style={styles.actRow}>
                    <TouchableOpacity style={[styles.actBtn, { backgroundColor: theme.colors.success }]} onPress={() => action(() => api.post(`/admin/activations/${a.id}/validate`))} testID={`admin-validate-act-${a.id}`}>
                      <Ionicons name="checkmark" size={14} color="#fff" />
                      <Text style={styles.actT}>Valider</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.actBtn} onPress={() => action(() => api.post(`/admin/activations/${a.id}/reject`))} testID={`admin-reject-act-${a.id}`}>
                      <Ionicons name="close" size={14} color="#fff" />
                      <Text style={styles.actT}>Rejeter</Text>
                    </TouchableOpacity>
                  </View>
                )}
                <View style={styles.actRow}>
                  <TouchableOpacity style={[styles.actBtn, { backgroundColor: "#0EA5E9" }]} onPress={() => Alert.alert("Preuve de paiement", a.transaction_ref ? `Référence: ${a.transaction_ref}\n\nNuméro: ${a.payment_phone || "—"}\nOpérateur: ${a.operator || "—"}` : "Aucune preuve fournie par l'utilisateur (à demander manuellement).")} testID={`admin-proof-${a.id}`}>
                    <Ionicons name="document-text" size={14} color="#fff" />
                    <Text style={styles.actT}>Voir preuve</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.actBtn, { backgroundColor: "#25D366" }]} onPress={() => Linking.openURL(`https://wa.me/${(a.payment_phone || "").replace(/[^0-9]/g, "")}`)} testID={`admin-wa-${a.id}`}>
                    <Ionicons name="logo-whatsapp" size={14} color="#fff" />
                    <Text style={styles.actT}>WhatsApp</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.actBtn, { backgroundColor: theme.colors.primary }]} onPress={() => Linking.openURL(`mailto:${a.email}`)} testID={`admin-mail-${a.id}`}>
                    <Ionicons name="mail" size={14} color="#fff" />
                    <Text style={styles.actT}>E-mail</Text>
                  </TouchableOpacity>
                </View>
              </Card>
              ));
            })()}
          </>
        )}

        {tab === "withdrawals" && (
          <>
            <View style={styles.searchRow}>
              <View style={styles.searchBox}>
                <Ionicons name="search" size={16} color={theme.colors.textSecondary} />
                <TextInput
                  placeholder="Rechercher: nom, ID, téléphone, référence..."
                  placeholderTextColor={theme.colors.textSecondary}
                  style={styles.searchI}
                  value={wdQ}
                  onChangeText={setWdQ}
                  testID="admin-withdrawals-search"
                />
                {wdQ ? (
                  <TouchableOpacity onPress={() => setWdQ("")} testID="admin-withdrawals-search-clear">
                    <Ionicons name="close-circle" size={16} color={theme.colors.textSecondary} />
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
            <SubTabs
              tabs={[
                { key: "pending", label: "En attente", color: theme.colors.warning, count: withdrawals.filter((w) => w.status === "pending").length },
                { key: "validated", label: "Validés", color: theme.colors.success, count: withdrawals.filter((w) => w.status === "validated" || w.status === "completed").length },
                { key: "rejected", label: "Rejetés", color: theme.colors.danger, count: withdrawals.filter((w) => w.status === "rejected").length },
              ]}
              active={wdFilter}
              onChange={(k) => setWdFilter(k as any)}
              testIdPrefix="withdrawals-filter"
            />
            {(() => {
              const q = wdQ.trim().toLowerCase();
              const filtered = withdrawals.filter((w) => {
                const statusOk = wdFilter === "pending"
                  ? w.status === "pending"
                  : wdFilter === "validated"
                    ? (w.status === "validated" || w.status === "completed")
                    : w.status === "rejected";
                if (!statusOk) return false;
                if (!q) return true;
                const haystack = [
                  w.username, w.user_id, w.id, w.full_name,
                  w.phone, w.wallet_address, w.operator, w.country,
                ].filter(Boolean).join(" ").toLowerCase();
                return haystack.includes(q);
              });
              if (filtered.length === 0) {
                return <Card><Text style={styles.empty}>{q ? `Aucun résultat pour "${wdQ}".` : `Aucun retrait ${wdFilter === "pending" ? "en attente" : wdFilter === "validated" ? "validé" : "rejeté"}.`}</Text></Card>;
              }
              return filtered.map((w) => (
              <Card key={w.id} style={{ marginBottom: 8 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Text style={styles.userName}>{w.username}</Text>
                  <PillStatus status={w.status} />
                </View>
                <View style={styles.kvBox}>
                  <KvRow k="Montant demandé" v={formatFCFA(w.amount)} />
                  {w.fee != null ? <KvRow k="Frais de retrait" v={formatFCFA(w.fee)} /> : null}
                  {w.net_payout != null ? <KvRow k="Montant net" v={formatFCFA(w.net_payout)} /> : null}
                  <KvRow k="Bénéficiaire" v={w.full_name || "—"} />
                  {w.method === "crypto" ? (
                    <>
                      <KvRow k="Mode de retrait" v="Crypto USDT BEP20" />
                      <KvRow k="Réseau" v={w.network || "USDT BEP20"} />
                      {w.wallet_address ? (
                        <View style={{ marginTop: 4 }}>
                          <Text style={{ color: theme.colors.textSecondary, fontSize: 11, fontWeight: "700" }}>Adresse wallet (cliquer pour copier)</Text>
                          <TouchableOpacity onPress={() => {
                            if (typeof navigator !== "undefined" && (navigator as any).clipboard) {
                              (navigator as any).clipboard.writeText(w.wallet_address);
                              if (typeof window !== "undefined") window.alert("Adresse copiée ✅");
                            }
                          }}>
                            <Text selectable style={{ color: theme.colors.primary, fontFamily: "monospace", fontSize: 11, marginTop: 2 }}>
                              {w.wallet_address}
                            </Text>
                          </TouchableOpacity>
                        </View>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <KvRow k="Mode de retrait" v="Mobile Money" />
                      <KvRow k="Opérateur" v={w.operator || "—"} />
                      <KvRow k="Numéro" v={w.phone || "—"} />
                    </>
                  )}
                  <KvRow k="Pays" v={w.country || "—"} />
                  <KvRow k="Date" v={formatDateTime(w.created_at)} />
                  {w.validated_at ? <KvRow k="Validé le" v={formatDateTime(w.validated_at)} /> : null}
                  {w.rejected_at ? <KvRow k="Rejeté le" v={formatDateTime(w.rejected_at)} /> : null}
                </View>
                {w.status === "pending" && (
                  <View style={styles.actRow}>
                    <TouchableOpacity style={[styles.actBtn, { backgroundColor: theme.colors.success }]} onPress={() => action(() => api.post(`/admin/withdrawals/${w.id}/validate`))} testID={`admin-validate-wd-${w.id}`}>
                      <Ionicons name="checkmark" size={14} color="#fff" />
                      <Text style={styles.actT}>Valider</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.actBtn} onPress={() => action(() => api.post(`/admin/withdrawals/${w.id}/reject`))} testID={`admin-reject-wd-${w.id}`}>
                      <Ionicons name="close" size={14} color="#fff" />
                      <Text style={styles.actT}>Rejeter</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </Card>
              ));
            })()}
          </>
        )}

        {tab === "announcements" && (
          <>
            <Card>
              <Text style={styles.section}>Nouvelle annonce</Text>
              <Input label="Titre" value={annTitle} onChangeText={setAnnTitle} testID="ann-title" />
              <Input label="Message" value={annMsg} onChangeText={setAnnMsg} multiline numberOfLines={3} testID="ann-msg" />
              <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
                {(["normale", "importante", "urgente"] as const).map((p) => (
                  <TouchableOpacity key={p} style={[styles.priChip, annPriority === p && styles.priChipOn]} onPress={() => setAnnPriority(p)}>
                    <Text style={[styles.priChipT, annPriority === p && { color: "#fff" }]}>{p}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Button title="Publier" onPress={() => action(async () => {
                await api.post("/admin/announcements", { title: annTitle, message: annMsg, priority: annPriority });
                setAnnTitle(""); setAnnMsg("");
              })} testID="ann-create" />
            </Card>
            <View style={{ height: 12 }} />
            {announcements.map((a) => (
              <Card key={a.id} style={{ marginBottom: 8 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Text style={styles.userName}>{a.title}</Text>
                  <Text style={{ color: a.active ? theme.colors.success : theme.colors.danger, fontWeight: "700", fontSize: 11 }}>{a.active ? "ACTIVE" : "INACTIVE"}</Text>
                </View>
                <Text style={styles.userMeta}>{a.message}</Text>
                <Text style={styles.userMeta}>Priorité: {a.priority}</Text>
                <View style={styles.actRow}>
                  <TouchableOpacity style={[styles.actBtn, { backgroundColor: theme.colors.warning }]} onPress={() => action(() => api.post(`/admin/announcements/${a.id}/toggle`))}>
                    <Text style={styles.actT}>{a.active ? "Désactiver" : "Activer"}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.actBtn} onPress={() => action(() => api.delete(`/admin/announcements/${a.id}`))}>
                    <Text style={styles.actT}>Supprimer</Text>
                  </TouchableOpacity>
                </View>
              </Card>
            ))}
          </>
        )}

        {tab === "channels" && (
          <>
            <Card>
              <Text style={styles.section}>Nouveau canal / groupe</Text>
              <Input label="Nom" value={chName} onChangeText={setChName} testID="ch-name" />
              <Input label="URL" value={chUrl} onChangeText={setChUrl} autoCapitalize="none" keyboardType="url" testID="ch-url" />
              <Input label="Description (optionnel)" value={chDesc} onChangeText={setChDesc} />
              <Text style={styles.lbl}>Plateforme</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                {["telegram","whatsapp","facebook","tiktok","instagram","youtube","x"].map((p) => (
                  <TouchableOpacity key={p} style={[styles.priChip, chPlatform === p && styles.priChipOn]} onPress={() => setChPlatform(p)}>
                    <Text style={[styles.priChipT, chPlatform === p && { color: "#fff" }]}>{p}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Button title="Ajouter" onPress={() => action(async () => {
                await api.post("/admin/channels", { name: chName, url: chUrl, description: chDesc, platform: chPlatform, active: true });
                setChName(""); setChUrl(""); setChDesc("");
              })} testID="ch-create" />
            </Card>
            <View style={{ height: 12 }} />
            {channels.map((c) => (
              <Card key={c.id} style={{ marginBottom: 8 }}>
                <Text style={styles.userName}>{c.name}</Text>
                <Text style={styles.userMeta}>{c.platform.toUpperCase()} • {c.url}</Text>
                {c.description ? <Text style={styles.userMeta}>{c.description}</Text> : null}
                <View style={styles.actRow}>
                  <TouchableOpacity style={styles.actBtn} onPress={() => action(() => api.delete(`/admin/channels/${c.id}`))}>
                    <Text style={styles.actT}>Supprimer</Text>
                  </TouchableOpacity>
                </View>
              </Card>
            ))}
          </>
        )}

        {tab === "payment" && (
          <>
            <Card style={{ marginTop: 12 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Ionicons name="logo-bitcoin" size={22} color="#F59E0B" />
                <Text style={styles.section}>Paiement manuel Crypto (USDT BEP20)</Text>
              </View>
              <Text style={styles.helperTxt}>
                L'utilisateur envoie l'équivalent du montant d'activation en USDT (réseau BEP20)
                à l'adresse wallet ci-dessous, puis colle le hash de transaction (TXID). L'admin valide manuellement.
              </Text>
              <TouchableOpacity
                style={[styles.toggleRow, cryptoEnabled ? styles.toggleOn : styles.toggleOff]}
                onPress={() => setCryptoEnabled((v) => !v)}
                testID="crypto-toggle-enabled"
              >
                <Ionicons
                  name={cryptoEnabled ? "checkmark-circle" : "close-circle-outline"}
                  size={20}
                  color={cryptoEnabled ? "#fff" : theme.colors.textSecondary}
                />
                <Text style={[styles.toggleTxt, cryptoEnabled && { color: "#fff" }]}>
                  {cryptoEnabled ? "Activé — paiement crypto disponible" : "Désactivé — paiement crypto masqué"}
                </Text>
              </TouchableOpacity>

              <Input
                label="Réseau"
                value={cryptoNetwork}
                onChangeText={setCryptoNetwork}
                placeholder="USDT BEP20"
                testID="crypto-network"
              />
              <Input
                label="Adresse wallet"
                value={cryptoWallet}
                onChangeText={setCryptoWallet}
                placeholder="0x..."
                autoCapitalize="none"
                testID="crypto-wallet"
              />
              <Input
                label="Montant à envoyer (USDT)"
                value={cryptoAmount}
                onChangeText={setCryptoAmount}
                placeholder="5"
                keyboardType="decimal-pad"
                testID="crypto-amount"
              />
              <Input
                label="Instructions affichées à l'utilisateur"
                value={cryptoInstructions}
                onChangeText={setCryptoInstructions}
                placeholder="Envoyez 5 USDT (BEP20)..."
                multiline
                testID="crypto-instructions"
              />
              <View style={{ marginTop: 12 }}>
                <Button
                  title={cryptoSaving ? "Enregistrement..." : "Enregistrer la configuration crypto"}
                  icon={<Ionicons name="save" size={16} color="#fff" />}
                  loading={cryptoSaving}
                  disabled={cryptoSaving}
                  onPress={async () => {
                    setCryptoSaving(true);
                    try {
                      await api.put("/admin/settings/crypto-payment", {
                        enabled: cryptoEnabled,
                        network: cryptoNetwork.trim(),
                        wallet_address: cryptoWallet.trim(),
                        amount_usdt: parseFloat(cryptoAmount) || 5,
                        instructions: cryptoInstructions,
                      });
                      if (typeof window !== "undefined") window.alert("Configuration crypto enregistrée ✅");
                    } catch (e: any) {
                      if (typeof window !== "undefined") window.alert(e?.detail || "Erreur lors de l'enregistrement");
                    } finally { setCryptoSaving(false); }
                  }}
                  testID="crypto-save-btn"
                />
              </View>
            </Card>

            <Card style={{ marginTop: 12 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Ionicons name="card" size={22} color={theme.colors.primary} />
                <Text style={styles.section}>Configuration paiement manuel</Text>
              </View>
              <Text style={styles.helperTxt}>
                Cette section permet aux utilisateurs d'effectuer un paiement en dehors du flux automatique.
                Ils verront le titre, les instructions, le bouton vers le lien de paiement et les coordonnées que vous renseignez ici.
              </Text>

              <TouchableOpacity
                style={[styles.toggleRow, mpEnabled ? styles.toggleOn : styles.toggleOff]}
                onPress={() => setMpEnabled((v) => !v)}
                testID="mp-toggle-enabled"
              >
                <Ionicons
                  name={mpEnabled ? "checkmark-circle" : "close-circle-outline"}
                  size={20}
                  color={mpEnabled ? "#fff" : theme.colors.textSecondary}
                />
                <Text style={[styles.toggleTxt, mpEnabled && { color: "#fff" }]}>
                  {mpEnabled ? "Activé — visible aux utilisateurs" : "Désactivé — masqué"}
                </Text>
              </TouchableOpacity>

              <Input
                label="Titre affiché"
                value={mpTitle}
                onChangeText={setMpTitle}
                placeholder="Ex: Paiement manuel"
                testID="mp-title"
              />
              <Input
                label="Lien de paiement (URL)"
                value={mpPaymentUrl}
                onChangeText={setMpPaymentUrl}
                placeholder="https://..."
                autoCapitalize="none"
                keyboardType="url"
                testID="mp-payment-url"
              />

              <Text style={[styles.lbl, { marginTop: 8 }]}>Pays autorisés pour le paiement manuel</Text>
              <Text style={styles.helperTxt}>
                Cochez les pays où les utilisateurs verront cette méthode de paiement. Si aucun pays n'est coché, le paiement manuel reste désactivé pour tous.
              </Text>
              <View style={styles.countryGrid}>
                {(cfgCountries.length > 0 ? cfgCountries : [
                  { code: "TG", name: "Togo", flag: "🇹🇬" },
                  { code: "BJ", name: "Bénin", flag: "🇧🇯" },
                  { code: "CI", name: "Côte d'Ivoire", flag: "🇨🇮" },
                  { code: "BF", name: "Burkina Faso", flag: "🇧🇫" },
                ]).map((c) => {
                  const on = mpAllowedCountries.includes(c.code);
                  return (
                    <TouchableOpacity
                      key={c.code}
                      style={[styles.countryChip, on && styles.countryChipOn]}
                      onPress={() => {
                        setMpAllowedCountries((prev) =>
                          prev.includes(c.code)
                            ? prev.filter((x) => x !== c.code)
                            : [...prev, c.code],
                        );
                      }}
                      testID={`mp-country-${c.code}`}
                    >
                      <Ionicons
                        name={on ? "checkbox" : "square-outline"}
                        size={18}
                        color={on ? "#fff" : theme.colors.textSecondary}
                      />
                      <Text style={[styles.countryChipTxt, on && { color: "#fff" }]}>
                        {c.flag} {c.name}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <Text style={styles.lbl}>Instructions</Text>
              <TextInput
                style={styles.textarea}
                value={mpInstructions}
                onChangeText={setMpInstructions}
                placeholder="Ex: Effectuez un dépôt Mobile Money sur le numéro ci-dessous puis cliquez sur le lien pour confirmer..."
                placeholderTextColor={theme.colors.textSecondary}
                multiline
                numberOfLines={5}
                testID="mp-instructions"
              />
              <Input
                label="Opérateur Mobile Money"
                value={mpOperator}
                onChangeText={setMpOperator}
                placeholder="Ex: T-Money, MTN MoMo, Orange Money..."
                testID="mp-operator"
              />
              <Input
                label="Numéro Mobile Money à payer"
                value={mpPhone}
                onChangeText={setMpPhone}
                placeholder="Ex: 22890000000"
                keyboardType="phone-pad"
                testID="mp-phone"
              />

              <View style={{ height: 8 }} />
              <Button
                title="ENREGISTRER LA CONFIGURATION"
                icon={<Ionicons name="save" size={18} color="#fff" />}
                loading={mpSaving}
                onPress={async () => {
                  setMpSaving(true);
                  try {
                    await api.put("/admin/settings/manual-payment", {
                      enabled: mpEnabled,
                      title: mpTitle,
                      instructions: mpInstructions,
                      payment_url: mpPaymentUrl,
                      phone_to_pay: mpPhone,
                      operator_name: mpOperator,
                      allowed_countries: mpAllowedCountries,
                    });
                    Alert.alert("Configuration sauvegardée", "Les utilisateurs verront immédiatement les changements.");
                  } catch (e: any) {
                    Alert.alert("Erreur", e?.detail || "Impossible de sauvegarder.");
                  } finally {
                    setMpSaving(false);
                  }
                }}
                testID="mp-save"
              />
            </Card>

            <Card style={{ marginTop: 12 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Ionicons name="eye" size={20} color={theme.colors.primary} />
                <Text style={styles.section}>Aperçu côté utilisateur</Text>
              </View>
              <Text style={styles.helperTxt}>
                Voici ce que verront les utilisateurs sur l'écran d'activation si la section est activée :
              </Text>
              <View style={styles.previewBox}>
                <Text style={styles.previewTitle}>{mpTitle || "Paiement manuel"}</Text>
                {!!mpInstructions && (
                  <Text style={styles.previewInstr}>{mpInstructions}</Text>
                )}
                {(!!mpOperator || !!mpPhone) && (
                  <View style={styles.previewKv}>
                    {!!mpOperator && (
                      <Text style={styles.previewLine}>
                        <Text style={{ fontWeight: "700" }}>Opérateur : </Text>{mpOperator}
                      </Text>
                    )}
                    {!!mpPhone && (
                      <Text style={styles.previewLine}>
                        <Text style={{ fontWeight: "700" }}>Numéro à payer : </Text>{mpPhone}
                      </Text>
                    )}
                  </View>
                )}
                {!!mpPaymentUrl && (
                  <View style={[styles.previewBtn]}>
                    <Ionicons name="open" size={14} color="#fff" />
                    <Text style={styles.previewBtnTxt}>OUVRIR LE LIEN DE PAIEMENT</Text>
                  </View>
                )}
              </View>
            </Card>

            {/* ----- Withdrawal fee settings ----- */}
            <Card style={{ marginTop: 12 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Ionicons name="cash" size={22} color={theme.colors.primary} />
                <Text style={styles.section}>Frais de retrait</Text>
              </View>
              <Text style={styles.helperTxt}>
                Configure les frais appliqués lorsque les utilisateurs demandent un retrait.
                Frais total = (montant × pourcentage) + frais fixes. Le minimum bloque les demandes inférieures.
              </Text>

              <TouchableOpacity
                style={[styles.toggleRow, wdEnabled ? styles.toggleOn : styles.toggleOff]}
                onPress={() => setWdEnabled((v) => !v)}
                testID="wd-toggle-enabled"
              >
                <Ionicons
                  name={wdEnabled ? "checkmark-circle" : "close-circle-outline"}
                  size={20}
                  color={wdEnabled ? "#fff" : theme.colors.textSecondary}
                />
                <Text style={[styles.toggleTxt, wdEnabled && { color: "#fff" }]}>
                  {wdEnabled ? "Retraits activés pour les utilisateurs" : "Retraits désactivés"}
                </Text>
              </TouchableOpacity>

              <Input
                label="Frais en pourcentage (%)"
                value={wdFeePercent}
                onChangeText={setWdFeePercent}
                keyboardType="numeric"
                placeholder="Ex: 5 (pour 5%)"
                testID="wd-fee-percent"
              />
              <Input
                label="Frais fixes (FCFA)"
                value={wdFeeFlat}
                onChangeText={setWdFeeFlat}
                keyboardType="numeric"
                placeholder="Ex: 100"
                testID="wd-fee-flat"
              />
              <Input
                label="Montant minimum de retrait (FCFA)"
                value={wdMinAmount}
                onChangeText={setWdMinAmount}
                keyboardType="numeric"
                placeholder="Ex: 1000"
                testID="wd-min-amount"
              />
              <Input
                label="Montant maximum de retrait (FCFA) — optionnel"
                value={wdMaxAmount}
                onChangeText={setWdMaxAmount}
                keyboardType="numeric"
                placeholder="Laissez vide pour aucun plafond"
                testID="wd-max-amount"
              />

              <View style={{ height: 12, borderBottomWidth: 1, borderBottomColor: theme.colors.border, marginBottom: 12 }} />

              <Text style={[styles.lbl, { fontSize: 14, marginBottom: 8 }]}>📅 Jours autorisés pour les retraits</Text>
              <View style={styles.daysRow}>
                {[
                  { idx: 0, label: "Lun" },
                  { idx: 1, label: "Mar" },
                  { idx: 2, label: "Mer" },
                  { idx: 3, label: "Jeu" },
                  { idx: 4, label: "Ven" },
                  { idx: 5, label: "Sam" },
                  { idx: 6, label: "Dim" },
                ].map((d) => {
                  const on = wdAllowedDays.includes(d.idx);
                  return (
                    <TouchableOpacity
                      key={d.idx}
                      style={[styles.dayChip, on && styles.dayChipOn]}
                      onPress={() => setWdAllowedDays((prev) => on ? prev.filter((x) => x !== d.idx) : [...prev, d.idx].sort())}
                      testID={`wd-day-${d.idx}`}
                    >
                      <Ionicons
                        name={on ? "checkmark-circle" : "ellipse-outline"}
                        size={14}
                        color={on ? "#fff" : theme.colors.textSecondary}
                      />
                      <Text style={[styles.dayChipTxt, on && { color: "#fff" }]}>{d.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <View style={{ flexDirection: "row", gap: 10, marginTop: 12 }}>
                <View style={{ flex: 1 }}>
                  <Input
                    label="🕖 Heure d'ouverture (HH:MM)"
                    value={wdOpenTime}
                    onChangeText={setWdOpenTime}
                    placeholder="07:00"
                    testID="wd-open-time"
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Input
                    label="🕗 Heure de fermeture (HH:MM)"
                    value={wdCloseTime}
                    onChangeText={setWdCloseTime}
                    placeholder="20:00"
                    testID="wd-close-time"
                  />
                </View>
              </View>
              <Text style={{ color: theme.colors.textSecondary, fontSize: 11, marginBottom: 8 }}>
                Fuseau : Africa/Lomé (UTC+0). En dehors de la plage horaire, les retraits sont bloqués automatiquement.
              </Text>

              <View style={styles.previewBox}>
                <Text style={styles.previewTitle}>Exemple sur un retrait de 10 000 FCFA</Text>
                {(() => {
                  const amt = 10000;
                  const pct = Number(wdFeePercent || 0);
                  const flat = Number(wdFeeFlat || 0);
                  const fee = Math.min(amt, Math.round(amt * pct / 100 + flat));
                  const net = Math.max(0, amt - fee);
                  return (
                    <>
                      <Text style={styles.previewLine}>Frais : <Text style={{ fontWeight: "700", color: theme.colors.danger }}>{fee.toLocaleString("fr-FR")} FCFA</Text></Text>
                      <Text style={styles.previewLine}>L'utilisateur reçoit : <Text style={{ fontWeight: "800", color: theme.colors.success || "#10B981" }}>{net.toLocaleString("fr-FR")} FCFA</Text></Text>
                    </>
                  );
                })()}
              </View>

              <View style={{ height: 8 }} />
              <Button
                title="ENREGISTRER LES FRAIS"
                icon={<Ionicons name="save" size={18} color="#fff" />}
                loading={wdSaving}
                onPress={async () => {
                  setWdSaving(true);
                  try {
                    await api.put("/admin/settings/withdrawal", {
                      enabled: wdEnabled,
                      fee_percent: Number(wdFeePercent || 0),
                      fee_flat: Number(wdFeeFlat || 0),
                      min_amount: Number(wdMinAmount || 0),
                      max_amount: wdMaxAmount ? Number(wdMaxAmount) : null,
                      allowed_days: wdAllowedDays,
                      open_time: wdOpenTime,
                      close_time: wdCloseTime,
                    });
                    Alert.alert("✅ Sauvegardé", "Les frais de retrait sont appliqués immédiatement.");
                  } catch (e: any) {
                    Alert.alert("Erreur", e?.detail || "Impossible de sauvegarder.");
                  } finally {
                    setWdSaving(false);
                  }
                }}
                testID="wd-save"
              />
            </Card>

            {/* ----- Support / Social links ----- */}
            <Card style={{ marginTop: 12 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Ionicons name="headset" size={22} color={theme.colors.primary} />
                <Text style={styles.section}>Liens de support & réseaux sociaux</Text>
              </View>
              <Text style={styles.helperTxt}>
                Ces liens apparaissent dans la page "Support" de l'application utilisateur.
                Laissez vide les canaux que vous ne souhaitez pas afficher.
              </Text>

              <Input label="WhatsApp (URL)" value={supWhatsapp} onChangeText={setSupWhatsapp} placeholder="https://wa.me/22890000000" autoCapitalize="none" testID="sup-whatsapp" />
              <Input label="Telegram (URL)" value={supTelegram} onChangeText={setSupTelegram} placeholder="https://t.me/spiloveure" autoCapitalize="none" testID="sup-telegram" />
              <Input label="E-mail support" value={supEmail} onChangeText={setSupEmail} placeholder="support@spiloveure.com" autoCapitalize="none" keyboardType="email-address" testID="sup-email" />
              <Input label="Téléphone support" value={supPhone} onChangeText={setSupPhone} placeholder="+22890000000" keyboardType="phone-pad" testID="sup-phone" />
              <Input label="Facebook (URL)" value={supFacebook} onChangeText={setSupFacebook} placeholder="https://facebook.com/spiloveure" autoCapitalize="none" testID="sup-facebook" />
              <Input label="YouTube (URL)" value={supYoutube} onChangeText={setSupYoutube} placeholder="https://youtube.com/@spiloveure" autoCapitalize="none" testID="sup-youtube" />
              <Input label="Instagram (URL)" value={supInstagram} onChangeText={setSupInstagram} placeholder="https://instagram.com/spiloveure" autoCapitalize="none" testID="sup-instagram" />
              <Input label="Twitter / X (URL)" value={supTwitter} onChangeText={setSupTwitter} placeholder="https://twitter.com/spiloveure" autoCapitalize="none" testID="sup-twitter" />
              <Input label="Discord (URL)" value={supDiscord} onChangeText={setSupDiscord} placeholder="https://discord.gg/..." autoCapitalize="none" testID="sup-discord" />
              <Input label="Site web (URL)" value={supWebsite} onChangeText={setSupWebsite} placeholder="https://spiloveure.com" autoCapitalize="none" testID="sup-website" />

              <View style={{ height: 8 }} />
              <Button
                title="ENREGISTRER LES LIENS"
                icon={<Ionicons name="save" size={18} color="#fff" />}
                loading={supSaving}
                onPress={async () => {
                  setSupSaving(true);
                  try {
                    await api.put("/admin/settings/support", {
                      telegram_url: supTelegram,
                      whatsapp_url: supWhatsapp,
                      facebook_url: supFacebook,
                      youtube_url: supYoutube,
                      instagram_url: supInstagram,
                      twitter_url: supTwitter,
                      discord_url: supDiscord,
                      email: supEmail,
                      phone: supPhone,
                      website_url: supWebsite,
                    });
                    Alert.alert("✅ Sauvegardé", "Les liens de support sont mis à jour.");
                  } catch (e: any) {
                    Alert.alert("Erreur", e?.detail || "Impossible de sauvegarder.");
                  } finally {
                    setSupSaving(false);
                  }
                }}
                testID="sup-save"
              />
            </Card>

            <Card style={{ marginTop: 12 }} testID="admin-community-popup-card">
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <Ionicons name="megaphone" size={18} color={theme.colors.primary} />
                <Text style={styles.h3}>📢 Popup Communauté Officielle</Text>
              </View>
              <Text style={styles.help}>
                Affiché automatiquement au centre de l'écran juste après la connexion utilisateur.
                Se ferme tout seul après {cpSeconds || 0}s ou via le bouton ✕.
              </Text>

              <TouchableOpacity
                style={[styles.toggleRow, cpEnabled ? styles.toggleOn : styles.toggleOff]}
                onPress={() => setCpEnabled(!cpEnabled)}
                testID="cp-enabled"
              >
                <Ionicons name={cpEnabled ? "checkmark-circle" : "close-circle"} size={18} color="#fff" />
                <Text style={styles.toggleTxt}>
                  {cpEnabled ? "Activé — popup visible après connexion" : "Désactivé — aucun popup"}
                </Text>
              </TouchableOpacity>

              <Input label="Titre" value={cpTitle} onChangeText={setCpTitle} placeholder="📢 COMMUNAUTÉ OFFICIELLE SPILOVEURE" testID="cp-title" />
              <Input
                label="Description"
                value={cpDesc}
                onChangeText={setCpDesc}
                placeholder="Texte affiché sous le titre…"
                multiline
                numberOfLines={3}
                style={{ minHeight: 70, textAlignVertical: "top" }}
                testID="cp-desc"
              />
              <Input
                label="Image / Bannière (URL)"
                value={cpImage}
                onChangeText={setCpImage}
                placeholder="https://… (optionnel)"
                autoCapitalize="none"
                testID="cp-image"
              />
              <Input
                label="Lien Telegram"
                value={cpTelegram}
                onChangeText={setCpTelegram}
                placeholder="https://t.me/spiloveure_officiel"
                autoCapitalize="none"
                testID="cp-telegram"
              />
              <Input
                label="Libellé du bouton"
                value={cpButton}
                onChangeText={setCpButton}
                placeholder="🚀 REJOINDRE MAINTENANT"
                testID="cp-button"
              />
              <Input
                label="Durée d'affichage (secondes) — 0 = pas de fermeture auto"
                value={cpSeconds}
                onChangeText={setCpSeconds}
                placeholder="5"
                keyboardType="numeric"
                testID="cp-seconds"
              />

              <View style={{ height: 8 }} />
              <Button
                title="ENREGISTRER LE POPUP"
                icon={<Ionicons name="save" size={18} color="#fff" />}
                loading={cpSaving}
                onPress={async () => {
                  setCpSaving(true);
                  try {
                    await api.put("/admin/settings/community-popup", {
                      enabled: cpEnabled,
                      title: cpTitle,
                      description: cpDesc,
                      image_url: cpImage,
                      telegram_url: cpTelegram,
                      button_label: cpButton,
                      auto_close_seconds: Math.max(0, Math.min(60, Number(cpSeconds) || 0)),
                    });
                    if (typeof window !== "undefined") window.alert("Popup Communauté enregistré ✅");
                  } catch (e: any) {
                    Alert.alert("Erreur", e?.detail || "Impossible de sauvegarder.");
                  } finally {
                    setCpSaving(false);
                  }
                }}
                testID="cp-save"
              />
            </Card>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function SubTabs({
  tabs, active, onChange, testIdPrefix,
}: {
  tabs: { key: string; label: string; color: string; count: number }[];
  active: string;
  onChange: (key: string) => void;
  testIdPrefix?: string;
}) {
  return (
    <View style={styles.subTabsRow}>
      {tabs.map((t) => {
        const on = active === t.key;
        return (
          <TouchableOpacity
            key={t.key}
            style={[styles.subTab, on ? { backgroundColor: t.color, borderColor: t.color } : { borderColor: theme.colors.border }]}
            onPress={() => onChange(t.key)}
            testID={testIdPrefix ? `${testIdPrefix}-${t.key}` : undefined}
          >
            <View style={[styles.subTabDot, { backgroundColor: t.color }]} />
            <Text style={[styles.subTabLbl, on && { color: "#fff" }]}>{t.label}</Text>
            <View style={[styles.subTabBadge, on ? { backgroundColor: "rgba(255,255,255,0.25)" } : { backgroundColor: theme.colors.surfaceSecondary }]}>
              <Text style={[styles.subTabBadgeT, on && { color: "#fff" }]}>{t.count}</Text>
            </View>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}


function StatCard({ icon, color, label, value, small }: { icon: any; color: string; label: string; value: any; small?: boolean }) {  return (
    <View style={styles.statCard}>
      <View style={[styles.statIcon, { backgroundColor: `${color}22` }]}>
        <Ionicons name={icon} size={20} color={color} />
      </View>
      <Text style={styles.statLbl}>{label}</Text>
      <Text style={[styles.statVal, small && { fontSize: 16 }]}>{value}</Text>
    </View>
  );
}

function PillStatus({ status }: { status: string }) {
  const cfg: any = {
    pending: { bg: theme.colors.warningBg, color: theme.colors.warning, label: "En attente" },
    validated: { bg: theme.colors.successBg, color: theme.colors.success, label: "Validé" },
    rejected: { bg: theme.colors.dangerBg, color: theme.colors.danger, label: "Rejeté" },
  }[status] || { bg: "#eee", color: "#666", label: status };
  return (
    <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: cfg.bg }}>
      <Text style={{ color: cfg.color, fontWeight: "700", fontSize: 11 }}>{cfg.label}</Text>
    </View>
  );
}

function KvRow({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.kvRow}>
      <Text style={styles.kvK}>{k}</Text>
      <Text style={styles.kvV} numberOfLines={2}>{v}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: { padding: 16, paddingTop: 24, paddingBottom: 16 },
  title: { color: "#fff", fontSize: 20, fontWeight: "800" },
  sub: { color: "#C7D9FF", fontSize: 12, marginTop: 2 },
  logoutBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center" },
  backBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center" },
  tabs: { padding: 12, gap: 6 },
  tab: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: "#fff", borderRadius: 20, borderWidth: 1, borderColor: theme.colors.border },
  tabOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  tabT: { fontWeight: "700", color: theme.colors.primary, fontSize: 12 },

  statGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  statCard: { width: "47%", backgroundColor: "#fff", padding: 14, borderRadius: 16, ...theme.shadow.card },
  statIcon: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center", marginBottom: 8 },
  statLbl: { color: theme.colors.textSecondary, fontSize: 11 },
  statVal: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 22, marginTop: 2 },

  searchRow: { flexDirection: "row", gap: 8, marginBottom: 12 },
  searchBox: { flex: 1, backgroundColor: "#fff", borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10 },
  searchI: { flex: 1, paddingVertical: 10, color: theme.colors.textPrimary },
  refreshBtn: { width: 44, height: 44, borderRadius: 12, backgroundColor: theme.colors.primary, alignItems: "center", justifyContent: "center" },

  avatar: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  userName: { fontWeight: "700", color: theme.colors.textPrimary },
  userMeta: { color: theme.colors.textSecondary, fontSize: 12, marginTop: 1 },
  actRow: { flexDirection: "row", gap: 8, marginTop: 10, flexWrap: "wrap" },
  actBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: theme.colors.danger },
  actT: { color: "#fff", fontWeight: "700", fontSize: 12 },

  empty: { textAlign: "center", color: theme.colors.textSecondary, padding: 24 },
  section: { fontWeight: "800", color: theme.colors.textPrimary, marginBottom: 12, fontSize: 16 },
  lbl: { color: theme.colors.textPrimary, fontWeight: "600", marginBottom: 6 },
  priChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12, backgroundColor: theme.colors.surfaceSecondary, borderWidth: 1, borderColor: theme.colors.border },
  priChipOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  priChipT: { fontWeight: "700", color: theme.colors.textPrimary, fontSize: 12, textTransform: "capitalize" },
  kvBox: { backgroundColor: theme.colors.surfaceSecondary, padding: 10, borderRadius: 10, gap: 4 },
  kvRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  kvK: { color: theme.colors.textSecondary, fontSize: 12, flexShrink: 0 },
  kvV: { color: theme.colors.textPrimary, fontWeight: "600", fontSize: 12, flex: 1, textAlign: "right" },
  tag: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  tagT: { fontSize: 9, fontWeight: "800" },

  helperTxt: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18, marginTop: 6, marginBottom: 12 },
  toggleRow: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderRadius: 12, marginBottom: 14 },
  toggleOn: { backgroundColor: theme.colors.success || "#10B981" },
  toggleOff: { backgroundColor: theme.colors.surfaceSecondary, borderWidth: 1, borderColor: theme.colors.border },
  toggleTxt: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 13 },
  textarea: { backgroundColor: theme.colors.surfaceSecondary, borderRadius: 12, padding: 12, minHeight: 96, color: theme.colors.textPrimary, fontSize: 14, marginBottom: 12, textAlignVertical: "top" },

  previewBox: { padding: 16, borderRadius: 14, backgroundColor: theme.colors.surfaceSecondary, borderWidth: 1, borderColor: theme.colors.border, marginTop: 8 },
  previewTitle: { fontWeight: "800", color: theme.colors.textPrimary, fontSize: 15, marginBottom: 8 },
  previewInstr: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18 },
  previewKv: { marginTop: 10, padding: 10, backgroundColor: "#fff", borderRadius: 10 },
  previewLine: { color: theme.colors.textPrimary, fontSize: 13, marginTop: 2 },
  previewBtn: { marginTop: 12, alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, backgroundColor: theme.colors.primary },
  previewBtnTxt: { color: "#fff", fontWeight: "800", fontSize: 12, letterSpacing: 0.4 },

  subTabsRow: { flexDirection: "row", gap: 8, marginBottom: 12, flexWrap: "wrap" },
  subTab: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, backgroundColor: theme.colors.surfaceSecondary },
  subTabDot: { width: 8, height: 8, borderRadius: 4 },
  subTabLbl: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 12 },
  subTabBadge: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, minWidth: 20, alignItems: "center" },
  subTabBadgeT: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 10 },

  countryGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  countryChip: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10,
    backgroundColor: theme.colors.surfaceSecondary,
    borderWidth: 1, borderColor: theme.colors.border,
  },
  countryChipOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  countryChipTxt: { color: theme.colors.textPrimary, fontWeight: "600", fontSize: 13 },

  daysRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  dayChip: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 10, paddingVertical: 7, borderRadius: 18,
    backgroundColor: theme.colors.surfaceSecondary,
    borderWidth: 1, borderColor: theme.colors.border,
  },
  dayChipOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  dayChipTxt: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 12 },

  stuckRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingVertical: 10, borderTopWidth: 1, borderTopColor: theme.colors.border,
  },
  stuckRef: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 13 },
  stuckMeta: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 2 },
  stuckErr: { color: theme.colors.danger, fontSize: 11, marginTop: 3, fontStyle: "italic" },
  stuckBtn: {
    flexDirection: "row", alignItems: "center", gap: 5,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 18,
    backgroundColor: theme.colors.danger,
  },
  stuckBtnTxt: { color: "#fff", fontWeight: "700", fontSize: 12 },

  contentMgmtCta: {
    flexDirection: "row", alignItems: "center", gap: 12,
    marginTop: 12, padding: 14, borderRadius: 16,
    backgroundColor: "#FF7A00",
    ...theme.shadow.card,
  },
  contentMgmtIcon: {
    width: 44, height: 44, borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignItems: "center", justifyContent: "center",
  },
  contentMgmtTitle: { color: "#fff", fontWeight: "800", fontSize: 15 },
  contentMgmtSub: { color: "rgba(255,255,255,0.85)", fontSize: 11, marginTop: 2 },
});
