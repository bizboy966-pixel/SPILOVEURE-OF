import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator, Alert, FlatList, Linking, Modal, Platform, RefreshControl, ScrollView, StyleSheet, Text, View, TextInput, TouchableOpacity,
} from "react-native";

/**
 * Cross-platform alert helper.
 *
 * React Native's `Alert.alert()` is a no-op on `react-native-web`, which
 * caused a silent-success bug in the admin panel: clicking "Valider" on
 * pending activations actually validated them on the backend but the admin
 * never saw the confirmation dialog (and errors were invisible too). We wrap
 * both platforms so the same call surfaces feedback on every device.
 */
function notify(title: string, message: string): void {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    // Prefix with the title so the admin instantly knows whether it succeeded.
    window.alert(`${title}\n\n${message}`);
    return;
  }
  Alert.alert(title, message);
}
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { Card } from "@/src/components/Card";
import { Button } from "@/src/components/Button";
import { Input } from "@/src/components/Input";
import { MediaViewer } from "@/src/components/MediaViewer";
import { api } from "@/src/api";
import { useAuth } from "@/src/auth";
import { theme } from "@/src/theme";
import { formatFCFA, formatDateTime } from "@/src/utils/format";
import AdminSupportTab from "@/src/components/AdminSupportTab";
import SupportAgentsCard from "@/src/components/SupportAgentsCard";

type Tab = "dashboard" | "users" | "admins" | "activations" | "withdrawals" | "announcements" | "channels" | "payment" | "providers" | "challenges" | "ads" | "special_tasks" | "marketplace" | "features" | "support";

export default function AdminHome() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const [tab, setTab] = useState<Tab>("dashboard");
  const [refreshing, setRefreshing] = useState(false);
  // v27q — dropdown "3 dots" menu that lists all tabs vertically
  const [menuOpen, setMenuOpen] = useState(false);

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
  const [challenges, setChallenges] = useState<any[]>([]);
  // Challenge form state (create only — edits go through inline actions).
  const [chgName, setChgName] = useState("");
  const [chgTarget, setChgTarget] = useState("100");
  const [chgReward, setChgReward] = useState("30000");
  const [chgCurrency, setChgCurrency] = useState("FCFA");
  const [chgStartDate, setChgStartDate] = useState("");
  const [chgStartTime, setChgStartTime] = useState("00:00");
  const [chgEndDate, setChgEndDate] = useState("");
  const [chgEndTime, setChgEndTime] = useState("23:59");
  const [chgActive, setChgActive] = useState(true);
  const [chgBusy, setChgBusy] = useState(false);
  const [chgParticipants, setChgParticipants] = useState<{ challenge: any; participants: any[]; winners_count: number } | null>(null);
  const [chgParticipantsLoading, setChgParticipantsLoading] = useState(false);
  // Edit challenge state — allows non-destructive updates on existing challenges.
  const [chgEdit, setChgEdit] = useState<any | null>(null);
  const [chgEditName, setChgEditName] = useState("");
  const [chgEditTarget, setChgEditTarget] = useState("");
  const [chgEditReward, setChgEditReward] = useState("");
  const [chgEditCurrency, setChgEditCurrency] = useState("");
  const [chgEditStartDate, setChgEditStartDate] = useState("");
  const [chgEditStartTime, setChgEditStartTime] = useState("");
  const [chgEditEndDate, setChgEditEndDate] = useState("");
  const [chgEditEndTime, setChgEditEndTime] = useState("");
  const [chgEditActive, setChgEditActive] = useState(true);
  const [chgEditBusy, setChgEditBusy] = useState(false);
  // Ads state
  const [adsPricing, setAdsPricing] = useState<any>(null);
  const [adsList, setAdsList] = useState<any[]>([]);
  const [adPricePerDay, setAdPricePerDay] = useState("");
  const [adDurations, setAdDurations] = useState("");
  const [adFilter, setAdFilter] = useState<"pending_admin_review" | "published" | "rejected" | "all">("pending_admin_review");
  // Special tasks admin state
  const [stCfg, setStCfg] = useState<any>({});
  const [stList, setStList] = useState<any[]>([]);
  const [stFilter, setStFilter] = useState<"pending_payment" | "active" | "completed" | "cancelled" | "all">("pending_payment");
  const [stDistPct, setStDistPct] = useState<number>(70);
  const [adsReactor, setAdsReactor] = useState<any>({
    distribution_percentage: 70,
    like_reward: 25,
    comment_reward: 50,
    max_likes: 100,
    max_comments: 50,
  });
  // Marketplace admin state
  const [mkCfg, setMkCfg] = useState<any>({});
  const [mkList, setMkList] = useState<any[]>([]);
  const [mkFilter, setMkFilter] = useState<"pending_admin_review" | "approved" | "expired" | "rejected" | "all">("pending_admin_review");
  // Feature flags admin state
  const [flags, setFlags] = useState<any[]>([]);
  const [flagBusy, setFlagBusy] = useState<string | null>(null);
  // Admins tab state
  const [admins, setAdmins] = useState<any[]>([]);
  const [adminQ, setAdminQ] = useState("");
  const openChallengeParticipants = useCallback(async (challengeId: string) => {
    setChgParticipantsLoading(true);
    try {
      const r = await api.get<any>(`/admin/challenges/${challengeId}/participants`);
      setChgParticipants(r);
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert(`❌ ${e?.detail || "Impossible de charger les participants."}`);
    } finally {
      setChgParticipantsLoading(false);
    }
  }, []);

  const openChallengeEdit = useCallback((c: any) => {
    // Pre-fill the edit form with the existing challenge values. This is a
    // pure UI operation — no participants, scores or progress are touched.
    const pad = (n: number) => n.toString().padStart(2, "0");
    const toParts = (iso: string) => {
      if (!iso) return { date: "", time: "00:00" };
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return { date: "", time: "00:00" };
      return {
        date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
        time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
      };
    };
    const s = toParts(c.start_at);
    const e = toParts(c.end_at);
    setChgEditName(c.name || "");
    setChgEditTarget(String(c.target ?? ""));
    setChgEditReward(String(c.reward_amount ?? ""));
    setChgEditCurrency(c.reward_currency || "FCFA");
    setChgEditStartDate(s.date);
    setChgEditStartTime(s.time);
    setChgEditEndDate(e.date);
    setChgEditEndTime(e.time);
    setChgEditActive(!!c.active);
    setChgEdit(c);
  }, []);

  const submitChallengeEdit = useCallback(async () => {
    if (!chgEdit) return;
    const errs: string[] = [];
    if (!chgEditName.trim()) errs.push("• Le nom du challenge est requis.");
    const targetN = Number(chgEditTarget);
    if (!targetN || targetN < 1) errs.push("• L'objectif doit être ≥ 1.");
    const rewardN = Number(chgEditReward);
    if (Number.isNaN(rewardN) || rewardN < 0) errs.push("• La récompense doit être ≥ 0.");
    if (!chgEditStartDate) errs.push("• La date de début est requise.");
    if (!chgEditEndDate) errs.push("• La date de fin est requise.");
    if (errs.length) {
      if (typeof window !== "undefined") window.alert(`❌ Formulaire incomplet :\n\n${errs.join("\n")}`);
      return;
    }
    const startISO = new Date(`${chgEditStartDate}T${chgEditStartTime || "00:00"}:00`);
    const endISO = new Date(`${chgEditEndDate}T${chgEditEndTime || "23:59"}:00`);
    if (Number.isNaN(startISO.getTime()) || Number.isNaN(endISO.getTime())) {
      if (typeof window !== "undefined") window.alert("❌ Dates ou heures invalides.");
      return;
    }
    if (endISO <= startISO) {
      if (typeof window !== "undefined") window.alert("❌ La date/heure de fin doit être postérieure au début.");
      return;
    }
    setChgEditBusy(true);
    try {
      await api.put(`/admin/challenges/${chgEdit.id}`, {
        name: chgEditName.trim(),
        target: targetN,
        reward_amount: rewardN,
        reward_currency: (chgEditCurrency || "FCFA").trim(),
        start_at: startISO.toISOString(),
        end_at: endISO.toISOString(),
        active: chgEditActive,
      });
      if (typeof window !== "undefined") window.alert("✅ Challenge mis à jour. Les participants et leur progression restent inchangés.");
      setChgEdit(null);
      await load();
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert(`❌ ${e?.detail || "Échec de la mise à jour du challenge."}`);
    } finally {
      setChgEditBusy(false);
    }
  }, [chgEdit, chgEditName, chgEditTarget, chgEditReward, chgEditCurrency, chgEditStartDate, chgEditStartTime, chgEditEndDate, chgEditEndTime, chgEditActive]);

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

  // Transaction history modal (opened from a withdrawal row).
  const [historyUser, setHistoryUser] = useState<{ id: string; username: string } | null>(null);
  const [historyTx, setHistoryTx] = useState<any[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const openUserHistory = useCallback(async (userId: string, username: string) => {
    setHistoryUser({ id: userId, username });
    setHistoryTx(null);
    setHistoryLoading(true);
    try {
      const tx = await api.get<any[]>(`/admin/users/${userId}/transactions`);
      setHistoryTx(tx || []);
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert(`❌ ${e?.detail || "Impossible de charger l'historique."}`);
      setHistoryTx([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);
  const closeUserHistory = useCallback(() => {
    setHistoryUser(null);
    setHistoryTx(null);
    setHistoryLoading(false);
  }, []);

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

  // Trading Telegram channel (v26)
  const [trEnabled, setTrEnabled] = useState(true);
  const [trTelegram, setTrTelegram] = useState("");
  const [trTitle, setTrTitle] = useState("TRADING");
  const [trDesc, setTrDesc] = useState("");
  const [trButton, setTrButton] = useState("Accéder au canal Telegram");
  const [trSaving, setTrSaving] = useState(false);

  // Activation Videos (v27f) — admin uploads guide videos shown on /pay.
  const [avVideos, setAvVideos] = useState<any[]>([]);
  const [avTitle, setAvTitle] = useState("");
  const [avDesc, setAvDesc] = useState("");
  const [avUploading, setAvUploading] = useState(false);
  const [avProgress, setAvProgress] = useState(0);
  const [avErr, setAvErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      if (tab === "dashboard") {
        setStats(await api.get("/admin/stats"));
      }
      if (tab === "users") setUsers(await api.get(`/admin/users${usersQ ? `?q=${encodeURIComponent(usersQ)}` : ""}`));
      if (tab === "activations") setActivations(await api.get(`/admin/activations?status=${actFilter}`));
      if (tab === "withdrawals") setWithdrawals(await api.get("/admin/withdrawals"));
      if (tab === "announcements") setAnnouncements(await api.get("/admin/announcements"));
      if (tab === "channels") setChannels(await api.get("/admin/channels"));
      if (tab === "challenges") {
        const r = await api.get<any>("/admin/challenges");
        setChallenges(r?.items || []);
      }
      if (tab === "ads") {
        const [pr, ls, rc] = await Promise.all([
          api.get<any>("/admin/ads/pricing"),
          api.get<any>("/admin/ads"),
          api.get<any>("/admin/ads-reactor-config"),
        ]);
        setAdsPricing(pr);
        setAdsList(ls?.items || []);
        setAdsReactor(rc || {
          distribution_percentage: 70, like_reward: 25, comment_reward: 50,
          max_likes: 100, max_comments: 50,
        });
      }
      if (tab === "special_tasks") {
        const cfg = await api.get<any>("/admin/special-tasks/config");
        setStCfg(cfg?.action_types || {});
        setStDistPct(Number(cfg?.distribution_percentage) || 70);
        // List all campaigns so the admin can review their content in full.
        try {
          const tl = await api.get<any>("/admin/special-tasks");
          setStList(tl?.items || []);
        } catch { setStList([]); }
      }
      if (tab === "marketplace") {
        const [c, ls] = await Promise.all([
          api.get<any>("/admin/marketplace/config"),
          api.get<any>("/admin/marketplace"),
        ]);
        setMkCfg(c || {}); setMkList(ls?.items || []);
      }
      if (tab === "features") {
        const r = await api.get<any>("/admin/feature-flags");
        setFlags(r?.items || []);
      }
      if (tab === "admins") {
        const url = adminQ ? `/admin/admins?q=${encodeURIComponent(adminQ)}` : "/admin/admins";
        const r = await api.get<any>(url);
        setAdmins(r?.items || []);
      }
      if (tab === "activation_videos") {
        try {
          const r = await api.get<{ items: any[] }>("/admin/activation-videos");
          setAvVideos(r?.items || []);
        } catch { setAvVideos([]); }
      }
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
        // Time-window (days + open/close hours) — previously not hydrated,
        // which made the form silently reset to defaults on every reload
        // and made saved values look "not persisted".
        if (Array.isArray(wd.allowed_days)) {
          setWdAllowedDays(wd.allowed_days.map((d: any) => Number(d)).filter((d: number) => d >= 0 && d <= 6));
        }
        if (typeof wd.open_time === "string" && wd.open_time) setWdOpenTime(wd.open_time);
        if (typeof wd.close_time === "string" && wd.close_time) setWdCloseTime(wd.close_time);

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

        const tr = await api.get<any>("/admin/settings/trading");
        setTrEnabled(tr.enabled !== false);
        setTrTelegram(tr.telegram_url || "");
        setTrTitle(tr.title || "TRADING");
        setTrDesc(tr.description || "");
        setTrButton(tr.button_label || "Accéder au canal Telegram");
      }
    } catch (e: any) {
      console.log("admin load err", e?.detail);
    }
  }, [tab, usersQ, actFilter]);

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
        notify("Copié", `IP ${serverIp} copiée dans le presse-papiers.`);
      } else {
        notify("IP serveur", serverIp);
      }
    } catch {
      notify("IP serveur", serverIp);
    }
  }, [serverIp]);

  const action = async (fn: () => Promise<any>, ok = "✅ Opération réussie") => {
    try {
      await fn();
      notify("Succès", ok);
      await load();
    } catch (e: any) {
      const msg = e?.detail || e?.message || "Une erreur est survenue.";
      // Log the raw error for diagnostics — spec §3 requires visible admin
      // errors AND server logs.
      console.error("[admin action] failed:", e);
      notify("Erreur", msg);
    }
  };

  const TABS: { key: Tab; label: string; icon: any }[] = [
    { key: "dashboard", label: "Dashboard", icon: "stats-chart" },
    { key: "users", label: "Utilisateurs", icon: "people" },
    { key: "admins", label: "Administrateurs", icon: "shield-checkmark" },
    { key: "activations", label: "Activations", icon: "checkmark-circle" },
    { key: "withdrawals", label: "Retraits", icon: "cash" },
    { key: "challenges", label: "Challenges", icon: "trophy" },
    { key: "ads", label: "Publicités", icon: "megaphone" },
    { key: "special_tasks", label: "Tâches spé.", icon: "flash" },
    { key: "marketplace", label: "Marketplace", icon: "cart" },
    { key: "features", label: "Fonctionnalités", icon: "toggle" },
    { key: "announcements", label: "Annonces", icon: "megaphone" },
    { key: "channels", label: "Canaux", icon: "link" },
    { key: "activation_videos", label: "Vidéos activation", icon: "videocam" },
    { key: "support", label: "Support 💬", icon: "chatbubbles" },
    { key: "providers", label: "Prestataires paiement", icon: "card" },
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
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <TouchableOpacity
              onPress={async () => { setRefreshing(true); await load(); setRefreshing(false); }}
              style={styles.logoutBtn}
              testID="admin-refresh"
              disabled={refreshing}
            >
              <Ionicons name={refreshing ? "hourglass" : "refresh"} size={20} color="#fff" />
            </TouchableOpacity>
            {/* v27r — 3-dots menu (seul moyen de naviguer entre onglets).
                Affiche le nom de l'onglet actif à côté pour repérage. */}
            <TouchableOpacity
              onPress={() => setMenuOpen((v) => !v)}
              style={{ height: 40, borderRadius: 24, backgroundColor: "rgba(255,255,255,0.2)", flexDirection: "row", alignItems: "center", justifyContent: "center", paddingHorizontal: 12, gap: 6 }}
              testID="admin-tabs-menu"
            >
              <Text style={{ color: "#fff", fontWeight: "700", fontSize: 12, maxWidth: 120 }} numberOfLines={1}>
                {(TABS.find((t) => t.key === tab)?.label) || ""}
              </Text>
              <Ionicons name="ellipsis-vertical" size={20} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity onPress={async () => { await signOut(); router.replace("/(auth)/login"); }} style={styles.logoutBtn} testID="admin-logout">
              <Ionicons name="log-out-outline" size={20} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>
      </LinearGradient>

      {/* v27r — dropdown vertical listant tous les onglets. Se ferme au clic
          sur un item OU sur l'overlay. La barre horizontale a été supprimée
          car ce menu est désormais l'unique moyen de navigation. */}
      {menuOpen && (
        <>
          <TouchableOpacity
            onPress={() => setMenuOpen(false)}
            activeOpacity={1}
            style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 40, backgroundColor: "rgba(0,0,0,0.35)" }}
            testID="admin-tabs-menu-overlay"
          />
          <View style={{ position: "absolute", top: 90, right: 12, zIndex: 41, minWidth: 240, maxHeight: 520, backgroundColor: theme.colors.background, borderRadius: 14, borderWidth: 1, borderColor: theme.colors.border, shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 14, shadowOffset: { width: 0, height: 8 }, elevation: 12, overflow: "hidden" }}>
            <ScrollView style={{ maxHeight: 520 }}>
              {TABS.map((t) => (
                <TouchableOpacity
                  key={`menu-${t.key}`}
                  onPress={() => { setTab(t.key); setMenuOpen(false); }}
                  style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 14, backgroundColor: tab === t.key ? theme.colors.primary : "transparent", borderBottomWidth: 1, borderBottomColor: theme.colors.border }}
                  testID={`admin-menu-tab-${t.key}`}
                >
                  <Ionicons name={t.icon} size={18} color={tab === t.key ? "#fff" : theme.colors.primary} />
                  <Text style={{ fontSize: 13, fontWeight: "700", color: tab === t.key ? "#fff" : theme.colors.textPrimary }}>{t.label}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </>
      )}

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
              style={[styles.contentMgmtCta, { marginTop: 10, backgroundColor: "#0EA5E9" }]}
              onPress={() => router.push("/(admin)/emploi" as any)}
              testID="admin-open-emploi-mgmt"
            >
              <View style={styles.contentMgmtIcon}>
                <Ionicons name="briefcase" size={24} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.contentMgmtTitle}>💼 Gestion des offres d'emploi</Text>
                <Text style={styles.contentMgmtSub}>
                  Publier, modifier, activer/désactiver et supprimer les offres
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={22} color="#fff" />
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.contentMgmtCta, { marginTop: 10, backgroundColor: "#F59E0B" }]}
              onPress={() => router.push("/(admin)/lottery" as any)}
              testID="admin-open-lottery-mgmt"
            >
              <View style={styles.contentMgmtIcon}>
                <Ionicons name="ticket" size={24} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.contentMgmtTitle}>🎰 Lottery Jackpot</Text>
                <Text style={styles.contentMgmtSub}>
                  Tirages, gagnants, paiements et statistiques
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={22} color="#fff" />
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.contentMgmtCta, { marginTop: 10, backgroundColor: "#10B981" }]}
              onPress={() => router.push("/(admin)/recharges" as any)}
              testID="admin-open-recharges-mgmt"
            >
              <View style={styles.contentMgmtIcon}>
                <Ionicons name="wallet" size={24} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.contentMgmtTitle}>💳 Demandes de Recharge</Text>
                <Text style={styles.contentMgmtSub}>
                  Valider/rejeter les rechargements manuels
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
                <Text style={styles.contentMgmtTitle}>💳 Paiements SoleasPay</Text>
                <Text style={styles.contentMgmtSub}>
                  Tous les paiements • Bloqués • Forcer l'activation
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={22} color="#fff" />
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.contentMgmtCta, { marginTop: 10, backgroundColor: theme.colors.danger }]}
              onPress={() => router.push("/(admin)/audit" as any)}
              testID="admin-open-audit"
            >
              <View style={styles.contentMgmtIcon}>
                <Ionicons name="shield-checkmark" size={24} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.contentMgmtTitle}>🔎 Audit d'intégrité</Text>
                <Text style={styles.contentMgmtSub}>
                  Activations sans paiement • Commissions orphelines • Tracer un utilisateur
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={22} color="#fff" />
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.contentMgmtCta, { marginTop: 10, backgroundColor: "#7C3AED" }]}
              onPress={() => router.push("/(admin)/push" as any)}
              testID="admin-open-push"
            >
              <View style={styles.contentMgmtIcon}>
                <Ionicons name="notifications" size={24} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.contentMgmtTitle}>🔔 Notifications Push</Text>
                <Text style={styles.contentMgmtSub}>
                  Envoyer une notification à tous, à un utilisateur ou à un groupe filtré
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={22} color="#fff" />
            </TouchableOpacity>

            <Card style={{ marginTop: 14 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <View style={{ width: 36, height: 36, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "#0EA5E922" }}>
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
                  backgroundColor: theme.colors.background, borderRadius: 12,
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
                    borderRadius: 12, flexDirection: "row", alignItems: "center", gap: 6,
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
                    borderRadius: 12, flexDirection: "row", alignItems: "center", gap: 6,
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
                {
                  key: "pending",
                  label: "En attente",
                  color: theme.colors.warning,
                  // Always show the server-side authoritative count so
                  // the badge is guaranteed to match the dashboard.
                  count: actFilter === "pending"
                    ? activations.length
                    : (stats?.activations_pending ?? 0),
                },
                {
                  key: "validated",
                  label: "Activées",
                  color: theme.colors.success,
                  // Only accurate while the tab is active (server filter).
                  count: actFilter === "validated" ? activations.length : undefined,
                },
                {
                  key: "rejected",
                  label: "Rejetées",
                  color: theme.colors.danger,
                  count: actFilter === "rejected" ? activations.length : undefined,
                },
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
                  a.reference, a.payment_method, a.easychange_transaction_id,
                ].filter(Boolean).join(" ").toLowerCase();
                return haystack.includes(q);
              });
              if (filtered.length === 0) {
                return <Card><Text style={styles.empty}>{q ? `Aucun résultat pour "${actQ}".` : `Aucune activation ${actFilter === "pending" ? "en attente" : actFilter === "validated" ? "validée" : "rejetée"}.`}</Text></Card>;
              }
              return filtered.map((a) => {
                const isAuto = a.payment_method === "automatic";
                const isStuck = !!a.is_stuck;
                return (
                <Card key={a.id} style={{ marginBottom: 8, ...(isStuck ? { borderLeftWidth: 4, borderLeftColor: theme.colors.warning } : {}) }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1 }}>
                    <Text style={styles.userName}>{a.username}</Text>
                    <MethodBadge method={a.payment_method} stuck={isStuck} />
                  </View>
                  <PillStatus status={a.status} />
                </View>
                <View style={styles.kvBox}>
                  <KvRow k="Niveau" v={`Niveau ${a.level}`} />
                  {a.email ? <KvRow k="E-mail" v={a.email} /> : null}
                  <KvRow k="Mode de paiement" v={
                    isAuto ? "Automatique (SoleasPay)" :
                    a.payment_method === "crypto_auto" ? "Automatique (Crypto USDT BEP20)" :
                    (a.payment_method?.replace("_", " ") || "—")
                  } />
                  {a.payer_country ? <KvRow k="Pays" v={a.payer_country} /> : null}
                  {a.operator ? <KvRow k="Opérateur" v={a.operator} /> : null}
                  <KvRow k="Numéro paiement" v={a.payment_phone || "—"} />
                  {a.network ? <KvRow k="Réseau crypto" v={a.network} /> : null}
                  {a.deposit_address ? (
                    <View style={{ marginTop: 4 }}>
                      <Text style={{ color: theme.colors.textSecondary, fontSize: 11, fontWeight: "700" }}>Adresse USDT générée (cliquer pour copier)</Text>
                      <TouchableOpacity
                        onPress={() => {
                          if (typeof navigator !== "undefined" && (navigator as any).clipboard) {
                            (navigator as any).clipboard.writeText(a.deposit_address);
                            if (typeof window !== "undefined") window.alert("Adresse copiée ✅");
                          }
                        }}
                        testID={`admin-copy-addr-${a.id}`}
                      >
                        <Text selectable style={{ color: theme.colors.primary, fontFamily: "monospace", fontSize: 11, marginTop: 2 }}>
                          {a.deposit_address}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  ) : null}
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
                  {a.easychange_transaction_id ? (
                    <View style={{ marginTop: 4 }}>
                      <Text style={{ color: theme.colors.textSecondary, fontSize: 11, fontWeight: "700" }}>ID Transaction EasyChange (cliquer pour copier)</Text>
                      <TouchableOpacity
                        onPress={() => {
                          if (typeof navigator !== "undefined" && (navigator as any).clipboard) {
                            (navigator as any).clipboard.writeText(a.easychange_transaction_id);
                            if (typeof window !== "undefined") window.alert("ID EasyChange copié ✅");
                          }
                        }}
                        testID={`admin-copy-easychange-${a.id}`}
                      >
                        <Text selectable style={{ color: theme.colors.primary, fontFamily: "monospace", fontSize: 11, marginTop: 2 }}>
                          {a.easychange_transaction_id}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  ) : null}
                  <KvRow k="Montant" v={
                    a.currency === "USDT" ? (
                      // Crypto activation — show USDT for the user + FCFA equivalent
                      // (business rate: 5 USDT = 2 500 FCFA) for stats context.
                      `${Number(a.amount) || 0} USDT (BEP20)  ≈  ${formatFCFA((Number(a.amount) || 0) * 500)}`
                    ) : isAuto && a.currency ? (
                      `${Math.round(Number(a.amount) || 0).toLocaleString("fr-FR")} ${a.currency}`
                    ) : (
                      formatFCFA(a.amount)
                    )
                  } />
                  <KvRow k="Date/Heure" v={formatDateTime(a.created_at)} />
                  {a.transaction_ref ? <KvRow k="Réf. transaction" v={a.transaction_ref} /> : null}
                  {a.reference && isAuto ? <KvRow k="Référence interne" v={a.reference} /> : null}
                  {a.validated_at ? <KvRow k="Validé le" v={formatDateTime(a.validated_at)} /> : null}
                  {a.rejected_at ? <KvRow k="Rejeté le" v={formatDateTime(a.rejected_at)} /> : null}
                  {a.activation_error ? (
                    <View style={{ marginTop: 4, padding: 6, backgroundColor: "#FEE2E2", borderRadius: 8 }}>
                      <Text style={{ color: theme.colors.danger, fontSize: 10, fontWeight: "700" }}>⚠️ Erreur :</Text>
                      <Text style={{ color: theme.colors.danger, fontSize: 10, marginTop: 2 }} numberOfLines={3}>{a.activation_error}</Text>
                    </View>
                  ) : null}
                </View>
                {a.status === "pending" && !isAuto && (
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
                {a.status === "pending" && isAuto && isStuck && (
                  <View style={styles.actRow}>
                    <TouchableOpacity
                      style={[styles.actBtn, { backgroundColor: theme.colors.warning, flex: 2 }]}
                      onPress={() => {
                        if (typeof window !== "undefined" && !window.confirm(
                          `Forcer l'activation du niveau ${a.level} pour ${a.username} ?\n\nRéférence: ${a.reference}\nMontant: ${a.amount} ${a.currency || "XOF"}`
                        )) return;
                        action(() => api.post(`/admin/payments/${a.reference}/reprocess`, {}));
                      }}
                      testID={`admin-force-activate-${a.id}`}
                    >
                      <Ionicons name="flash" size={14} color="#fff" />
                      <Text style={styles.actT}>🚨 FORCER L'ACTIVATION</Text>
                    </TouchableOpacity>
                  </View>
                )}
                {a.status === "pending" && isAuto && !isStuck && (
                  <View style={{ marginTop: 8, padding: 8, backgroundColor: "#EFF6FF", borderRadius: 10, flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Ionicons name="phone-portrait" size={14} color={theme.colors.primary} />
                    <Text style={{ color: theme.colors.primary, fontSize: 11, fontWeight: "700", flex: 1 }}>
                      En attente de confirmation sur le téléphone du client…
                    </Text>
                  </View>
                )}
                {a.status === "pending" && isAuto && (
                  <View style={styles.actRow}>
                    <TouchableOpacity
                      style={[styles.actBtn, { backgroundColor: theme.colors.success }]}
                      onPress={() => {
                        if (typeof window !== "undefined" && !window.confirm(
                          `Valider manuellement le paiement automatique ?\n\nUtilisateur: ${a.username}\nNiveau: ${a.level}\nRéférence: ${a.reference}\nMontant: ${a.amount} ${a.currency || "XOF"}`
                        )) return;
                        action(() => api.post(`/admin/activations/${a.id}/validate`));
                      }}
                      testID={`admin-validate-act-${a.id}`}
                    >
                      <Ionicons name="checkmark" size={14} color="#fff" />
                      <Text style={styles.actT}>Valider</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.actBtn}
                      onPress={() => {
                        if (typeof window !== "undefined" && !window.confirm(
                          `Rejeter le paiement automatique ?\n\nUtilisateur: ${a.username}\nRéférence: ${a.reference}`
                        )) return;
                        action(() => api.post(`/admin/activations/${a.id}/reject`));
                      }}
                      testID={`admin-reject-act-${a.id}`}
                    >
                      <Ionicons name="close" size={14} color="#fff" />
                      <Text style={styles.actT}>Rejeter</Text>
                    </TouchableOpacity>
                  </View>
                )}
                <View style={styles.actRow}>
                  <TouchableOpacity style={[styles.actBtn, { backgroundColor: "#0EA5E9" }]} onPress={() => notify("Preuve de paiement", a.transaction_ref ? `Référence: ${a.transaction_ref}\n\nNuméro: ${a.payment_phone || "—"}\nOpérateur: ${a.operator || "—"}` : "Aucune preuve fournie par l'utilisateur (à demander manuellement).")} testID={`admin-proof-${a.id}`}>
                    <Ionicons name="document-text" size={14} color="#fff" />
                    <Text style={styles.actT}>Voir preuve</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.actBtn, { backgroundColor: "#25D366" }]} onPress={() => Linking.openURL(`https://wa.me/${(a.payment_phone || "").replace(/[^0-9]/g, "")}`)} testID={`admin-wa-${a.id}`}>
                    <Ionicons name="logo-whatsapp" size={14} color="#fff" />
                    <Text style={styles.actT}>WhatsApp</Text>
                  </TouchableOpacity>
                  {a.email ? (
                    <TouchableOpacity style={[styles.actBtn, { backgroundColor: theme.colors.primary }]} onPress={() => Linking.openURL(`mailto:${a.email}`)} testID={`admin-mail-${a.id}`}>
                      <Ionicons name="mail" size={14} color="#fff" />
                      <Text style={styles.actT}>E-mail</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              </Card>
              );
              });
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
              return filtered.map((w) => {
                const isMission = w.withdrawal_type === "mission";
                return (
                <Card key={w.id} style={{ marginBottom: 8, ...(isMission ? { borderLeftWidth: 4, borderLeftColor: theme.colors.warning } : {}) }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1 }}>
                    <Text style={styles.userName}>{w.username}</Text>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, backgroundColor: isMission ? "#FEF3C7" : "#D1FAE5" }}>
                      <Ionicons name={isMission ? "trophy" : "cash"} size={11} color={isMission ? "#92400E" : "#065F46"} />
                      <Text style={{ color: isMission ? "#92400E" : "#065F46", fontWeight: "800", fontSize: 10, letterSpacing: 0.5 }}>
                        {isMission ? "MISSION" : "COMMISSIONS"}
                      </Text>
                    </View>
                  </View>
                  <PillStatus status={w.status} />
                </View>
                <View style={styles.kvBox}>
                  <KvRow k="Type de retrait" v={isMission ? `🎥 Retrait Mission (${w.wallet || "—"})` : "🤝 Retrait Commissions"} />
                  <KvRow k="Montant demandé" v={formatFCFA(w.amount)} />
                  {w.fee != null ? <KvRow k="Frais de retrait" v={`${formatFCFA(w.fee)}${w.fee_percent != null ? ` (${w.fee_percent}%)` : ""}`} /> : null}
                  {w.net_payout != null ? <KvRow k="Montant net" v={formatFCFA(w.net_payout)} /> : null}
                  {!isMission ? <KvRow k="Bénéficiaire" v={w.full_name || "—"} copyable testID={`admin-copy-name-${w.id}`} /> : null}
                  {!isMission && w.method === "crypto" ? (
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
                  ) : !isMission ? (
                    <>
                      <KvRow k="Mode de retrait" v="Mobile Money" />
                      <KvRow k="Opérateur" v={w.operator || "—"} />
                      <KvRow k="Numéro" v={w.phone || "—"} copyable testID={`admin-copy-phone-${w.id}`} />
                    </>
                  ) : null}
                  {!isMission ? <KvRow k="Pays" v={w.country || "—"} /> : null}
                  <KvRow k="Date" v={formatDateTime(w.created_at)} />
                  {w.validated_at ? <KvRow k="Validé le" v={formatDateTime(w.validated_at)} /> : null}
                  {w.rejected_at ? <KvRow k="Rejeté le" v={formatDateTime(w.rejected_at)} /> : null}
                  {w.decided_at && !w.validated_at && !w.rejected_at ? <KvRow k="Traité le" v={formatDateTime(w.decided_at)} /> : null}
                  {w.reject_reason ? <KvRow k="Motif de rejet" v={w.reject_reason} /> : null}
                </View>
                <View style={styles.actRow}>
                  <TouchableOpacity
                    style={[styles.actBtn, { backgroundColor: theme.colors.primary }]}
                    onPress={() => openUserHistory(w.user_id, w.username || "—")}
                    testID={`admin-history-wd-${w.id}`}
                  >
                    <Ionicons name="time" size={14} color="#fff" />
                    <Text style={styles.actT}>📜 Historique</Text>
                  </TouchableOpacity>
                  {w.status === "pending" && (
                    <>
                      <TouchableOpacity style={[styles.actBtn, { backgroundColor: theme.colors.success }]} onPress={() => action(() => api.post(`/admin/withdrawals/${w.id}/validate`))} testID={`admin-validate-wd-${w.id}`}>
                        <Ionicons name="checkmark" size={14} color="#fff" />
                        <Text style={styles.actT}>Valider</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.actBtn} onPress={() => action(() => api.post(`/admin/withdrawals/${w.id}/reject`))} testID={`admin-reject-wd-${w.id}`}>
                        <Ionicons name="close" size={14} color="#fff" />
                        <Text style={styles.actT}>Rejeter</Text>
                      </TouchableOpacity>
                    </>
                  )}
                </View>
              </Card>
              );
              });
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

        {tab === "challenges" && (
          <>
            <Card>
              <Text style={styles.section}>🏆 Nouveau challenge</Text>
              <Input label="Nom du challenge" value={chgName} onChangeText={setChgName} testID="chg-name" />
              <View style={{ flexDirection: "row", gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Input label="Objectif (nb invit.)" value={chgTarget} onChangeText={setChgTarget} keyboardType="numeric" testID="chg-target" />
                </View>
                <View style={{ flex: 1 }}>
                  <Input label="Récompense" value={chgReward} onChangeText={setChgReward} keyboardType="numeric" testID="chg-reward" />
                </View>
                <View style={{ flex: 1 }}>
                  <Input label="Devise" value={chgCurrency} onChangeText={setChgCurrency} testID="chg-currency" />
                </View>
              </View>
              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                <View style={{ flex: 1, minWidth: 180 }}>
                  <Text style={styles.lbl}>Date de début *</Text>
                  {/* @ts-ignore RN Web accepts raw HTML inputs */}
                  <input
                    type="date"
                    value={chgStartDate}
                    onChange={(e: any) => setChgStartDate(e.target.value)}
                    data-testid="chg-start-date"
                    style={{ padding: 10, borderRadius: 10, border: `1px solid ${theme.colors.border}`, fontSize: 13, width: "100%", boxSizing: "border-box" }}
                  />
                </View>
                <View style={{ flex: 1, minWidth: 140 }}>
                  <Text style={styles.lbl}>Heure de début *</Text>
                  {/* @ts-ignore RN Web accepts raw HTML inputs */}
                  <input
                    type="time"
                    value={chgStartTime}
                    onChange={(e: any) => setChgStartTime(e.target.value)}
                    data-testid="chg-start-time"
                    style={{ padding: 10, borderRadius: 10, border: `1px solid ${theme.colors.border}`, fontSize: 13, width: "100%", boxSizing: "border-box" }}
                  />
                </View>
              </View>
              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                <View style={{ flex: 1, minWidth: 180 }}>
                  <Text style={styles.lbl}>Date de fin *</Text>
                  {/* @ts-ignore RN Web accepts raw HTML inputs */}
                  <input
                    type="date"
                    value={chgEndDate}
                    onChange={(e: any) => setChgEndDate(e.target.value)}
                    data-testid="chg-end-date"
                    style={{ padding: 10, borderRadius: 10, border: `1px solid ${theme.colors.border}`, fontSize: 13, width: "100%", boxSizing: "border-box" }}
                  />
                </View>
                <View style={{ flex: 1, minWidth: 140 }}>
                  <Text style={styles.lbl}>Heure de fin *</Text>
                  {/* @ts-ignore RN Web accepts raw HTML inputs */}
                  <input
                    type="time"
                    value={chgEndTime}
                    onChange={(e: any) => setChgEndTime(e.target.value)}
                    data-testid="chg-end-time"
                    style={{ padding: 10, borderRadius: 10, border: `1px solid ${theme.colors.border}`, fontSize: 13, width: "100%", boxSizing: "border-box" }}
                  />
                </View>
              </View>
              <View style={{ height: 12 }} />
              <TouchableOpacity
                onPress={() => setChgActive(!chgActive)}
                style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 }}
                testID="chg-active-toggle"
              >
                <Ionicons
                  name={chgActive ? "checkbox" : "square-outline"}
                  size={22}
                  color={chgActive ? theme.colors.success : theme.colors.textSecondary}
                />
                <Text style={{ color: theme.colors.textPrimary, fontWeight: "700" }}>
                  Activer immédiatement (désactive les autres challenges actifs)
                </Text>
              </TouchableOpacity>
              <Button
                title={chgBusy ? "Création en cours…" : "Créer le challenge"}
                disabled={chgBusy}
                onPress={async () => {
                  // ── Validation client-side ─────────────────────────────
                  const errs: string[] = [];
                  if (!chgName.trim()) errs.push("• Le nom du challenge est requis.");
                  const targetN = Number(chgTarget);
                  if (!targetN || targetN < 1) errs.push("• L'objectif doit être ≥ 1.");
                  const rewardN = Number(chgReward);
                  if (Number.isNaN(rewardN) || rewardN < 0) errs.push("• La récompense doit être ≥ 0.");
                  if (!chgStartDate) errs.push("• La date de début est requise.");
                  if (!chgEndDate) errs.push("• La date de fin est requise.");
                  if (!chgStartTime) errs.push("• L'heure de début est requise.");
                  if (!chgEndTime) errs.push("• L'heure de fin est requise.");
                  if (errs.length) {
                    if (typeof window !== "undefined") window.alert(`❌ Formulaire incomplet :\n\n${errs.join("\n")}`);
                    return;
                  }
                  // ── Build ISO strings from the pickers ─────────────────
                  const startISO = new Date(`${chgStartDate}T${chgStartTime}:00`);
                  const endISO = new Date(`${chgEndDate}T${chgEndTime}:00`);
                  if (Number.isNaN(startISO.getTime()) || Number.isNaN(endISO.getTime())) {
                    if (typeof window !== "undefined") window.alert("❌ Dates ou heures invalides.");
                    return;
                  }
                  if (endISO <= startISO) {
                    if (typeof window !== "undefined") window.alert("❌ La date/heure de fin doit être postérieure au début.");
                    return;
                  }
                  setChgBusy(true);
                  try {
                    await api.post("/admin/challenges", {
                      name: chgName.trim(),
                      target: targetN,
                      reward_amount: rewardN,
                      reward_currency: chgCurrency.trim() || "FCFA",
                      start_at: startISO.toISOString(),
                      end_at: endISO.toISOString(),
                      active: chgActive,
                    });
                    if (typeof window !== "undefined") window.alert("✅ Challenge créé avec succès.");
                    setChgName(""); setChgStartDate(""); setChgEndDate("");
                    setChgStartTime("00:00"); setChgEndTime("23:59");
                    await load();
                  } catch (e: any) {
                    if (typeof window !== "undefined") window.alert(`❌ ${e?.detail || "Échec de la création du challenge."}`);
                  } finally {
                    setChgBusy(false);
                  }
                }}
                testID="chg-create"
              />
            </Card>

            <View style={{ height: 12 }} />

            {challenges.length === 0 ? (
              <Card><Text style={styles.empty}>Aucun challenge créé pour l'instant.</Text></Card>
            ) : challenges.map((c) => (
              <Card key={c.id} style={{ marginBottom: 8 }} testID={`chg-item-${c.id}`}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.userName}>🏆 {c.name}</Text>
                    <Text style={styles.userMeta}>
                      Objectif : {c.target} • Récompense : {formatFCFA(c.reward_amount)}
                    </Text>
                  </View>
                  <View style={{
                    backgroundColor: c.active ? theme.colors.success : theme.colors.textSecondary,
                    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8,
                  }}>
                    <Text style={{ color: "#fff", fontWeight: "800", fontSize: 10 }}>{c.active ? "ACTIF" : "INACTIF"}</Text>
                  </View>
                </View>
                <View style={styles.kvBox}>
                  <KvRow k="Début" v={formatDateTime(c.start_at)} />
                  <KvRow k="Fin" v={formatDateTime(c.end_at)} />
                </View>
                <View style={styles.actRow}>
                  <TouchableOpacity
                    style={[styles.actBtn, { backgroundColor: theme.colors.primary }]}
                    onPress={() => openChallengeParticipants(c.id)}
                    testID={`chg-participants-${c.id}`}
                  >
                    <Ionicons name="people" size={14} color="#fff" />
                    <Text style={styles.actT}>Participants</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.actBtn, { backgroundColor: theme.colors.info || "#2563eb" }]}
                    onPress={() => openChallengeEdit(c)}
                    testID={`chg-edit-${c.id}`}
                  >
                    <Ionicons name="create-outline" size={14} color="#fff" />
                    <Text style={styles.actT}>Modifier</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.actBtn, { backgroundColor: c.active ? theme.colors.warning : theme.colors.success }]}
                    onPress={() => action(async () => {
                      await api.put(`/admin/challenges/${c.id}`, { active: !c.active });
                    })}
                    testID={`chg-toggle-${c.id}`}
                  >
                    <Ionicons name={c.active ? "pause" : "play"} size={14} color="#fff" />
                    <Text style={styles.actT}>{c.active ? "Désactiver" : "Activer"}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.actBtn}
                    onPress={() => action(async () => {
                      if (typeof window !== "undefined" && !window.confirm(`Supprimer "${c.name}" ?`)) return;
                      await api.delete(`/admin/challenges/${c.id}`);
                    })}
                    testID={`chg-delete-${c.id}`}
                  >
                    <Ionicons name="trash" size={14} color="#fff" />
                    <Text style={styles.actT}>Supprimer</Text>
                  </TouchableOpacity>
                </View>
              </Card>
            ))}
          </>
        )}

        {tab === "ads" && (
          <>
            <Card>
              <Text style={styles.section}>💰 Tarification des publicités</Text>
              <Text style={{ fontSize: 11, color: theme.colors.textSecondary, marginBottom: 8 }}>
                Prix par jour × durée choisie = montant total à payer par le créateur.
              </Text>
              <Input
                label="Prix par jour (FCFA)"
                value={adPricePerDay || String(adsPricing?.price_per_day || "")}
                onChangeText={setAdPricePerDay}
                keyboardType="numeric"
                placeholder="Ex : 500"
                testID="ads-price-per-day"
              />
              <Input
                label="Durées disponibles (séparées par des virgules)"
                value={adDurations || (adsPricing?.available_durations || []).join(",")}
                onChangeText={setAdDurations}
                placeholder="1,3,7,15,30"
                testID="ads-durations"
              />
              <Button
                title="Enregistrer la tarification"
                onPress={() => action(async () => {
                  const price = Number(adPricePerDay || adsPricing?.price_per_day || 0);
                  const durs = (adDurations || (adsPricing?.available_durations || []).join(","))
                    .toString()
                    .split(",").map((x: string) => parseInt(x.trim(), 10)).filter((n: number) => !isNaN(n) && n > 0);
                  if (!price || durs.length === 0) {
                    if (typeof window !== "undefined") window.alert("Renseignez prix + durées.");
                    return;
                  }
                  const r = await api.put<any>("/admin/ads/pricing", {
                    price_per_day: price, currency: "FCFA", available_durations: durs,
                  });
                  setAdsPricing(r);
                  setAdPricePerDay(""); setAdDurations("");
                })}
                testID="ads-pricing-save"
              />
              {adsPricing?.configured ? (
                <View style={{ marginTop: 8, padding: 8, backgroundColor: theme.colors.background, borderRadius: 10 }}>
                  <Text style={{ fontSize: 12 }}>✅ {adsPricing.price_per_day} {adsPricing.currency} / jour • Durées : {adsPricing.available_durations.join(", ")}</Text>
                </View>
              ) : (
                <Text style={{ fontSize: 11, color: theme.colors.warning, marginTop: 8 }}>⚠️ Tarification non configurée — les utilisateurs ne peuvent pas publier.</Text>
              )}
            </Card>

            <View style={{ height: 12 }} />

            <Card>
              <Text style={styles.section}>🎯 Récompenses des réacteurs (Like + Commentaire uniquement)</Text>
              <Text style={{ fontSize: 11, color: theme.colors.textSecondary, marginBottom: 8 }}>
                Seuls les <Text style={{ fontWeight: "800" }}>Likes 👍</Text> et
                <Text style={{ fontWeight: "800" }}> Commentaires 💬</Text> sont rémunérés.
                Les vues et partages restent gratuits. Une seule récompense par utilisateur et par action.
              </Text>

              <View style={{ backgroundColor: "#FEF3C7", borderRadius: 12, padding: 10, marginBottom: 12 }}>
                <Text style={{ fontWeight: "800", fontSize: 12, color: "#92400E", marginBottom: 6 }}>
                  💰 Répartition globale (doivent totaliser 100 %)
                </Text>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Input
                      label="% distribué aux réacteurs"
                      value={String(adsReactor.distribution_percentage)}
                      onChangeText={(v: string) => setAdsReactor((s: any) => ({
                        ...s,
                        distribution_percentage: Math.max(0, Math.min(100, Number(v) || 0)),
                      }))}
                      keyboardType="numeric"
                      testID="ads-reactor-pct"
                    />
                  </View>
                  <View style={{ flex: 1, backgroundColor: "#FFFBEB", borderRadius: 10, padding: 8, marginBottom: 4 }}>
                    <Text style={{ fontSize: 10, color: "#78350F", fontWeight: "700" }}>% plateforme (auto)</Text>
                    <Text style={{ fontSize: 16, fontWeight: "900", color: "#78350F" }} testID="ads-reactor-platform-pct">
                      {(100 - Number(adsReactor.distribution_percentage || 0)).toFixed(0)} %
                    </Text>
                  </View>
                </View>
              </View>

              <Text style={{ fontWeight: "800", fontSize: 12, marginTop: 4, marginBottom: 6 }}>
                👍 Configuration Like
              </Text>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Input
                    label="Récompense / Like (FCFA)"
                    value={String(adsReactor.like_reward)}
                    onChangeText={(v: string) => setAdsReactor((s: any) => ({ ...s, like_reward: Number(v) || 0 }))}
                    keyboardType="numeric"
                    testID="ads-reactor-like-reward"
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Input
                    label="Max Likes / campagne"
                    value={String(adsReactor.max_likes)}
                    onChangeText={(v: string) => setAdsReactor((s: any) => ({ ...s, max_likes: Number(v) || 1 }))}
                    keyboardType="numeric"
                    testID="ads-reactor-max-likes"
                  />
                </View>
              </View>

              <Text style={{ fontWeight: "800", fontSize: 12, marginTop: 8, marginBottom: 6 }}>
                💬 Configuration Commentaire
              </Text>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Input
                    label="Récompense / Comment (FCFA)"
                    value={String(adsReactor.comment_reward)}
                    onChangeText={(v: string) => setAdsReactor((s: any) => ({ ...s, comment_reward: Number(v) || 0 }))}
                    keyboardType="numeric"
                    testID="ads-reactor-comment-reward"
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Input
                    label="Max Comments / campagne"
                    value={String(adsReactor.max_comments)}
                    onChangeText={(v: string) => setAdsReactor((s: any) => ({ ...s, max_comments: Number(v) || 1 }))}
                    keyboardType="numeric"
                    testID="ads-reactor-max-comments"
                  />
                </View>
              </View>

              <Button
                title="💾 Enregistrer récompenses réacteurs"
                onPress={() => action(async () => {
                  const r = await api.put<any>("/admin/ads-reactor-config", {
                    distribution_percentage: Number(adsReactor.distribution_percentage) || 0,
                    like_reward: Number(adsReactor.like_reward) || 0,
                    comment_reward: Number(adsReactor.comment_reward) || 0,
                    max_likes: Number(adsReactor.max_likes) || 1,
                    max_comments: Number(adsReactor.max_comments) || 1,
                  });
                  setAdsReactor(r);
                })}
                testID="ads-reactor-save"
              />
              <View style={{ marginTop: 8, padding: 8, backgroundColor: theme.colors.background, borderRadius: 10 }}>
                <Text style={{ fontSize: 11 }}>
                  📊 Exemple : Pub à 10 000 FCFA →
                  pool réacteurs = {(10000 * (Number(adsReactor.distribution_percentage) || 0) / 100).toFixed(0)} FCFA
                  {"\n"}Coût max théorique :
                  {" "}{(Number(adsReactor.like_reward) * Number(adsReactor.max_likes)).toFixed(0)} FCFA (likes)
                  {" + "}{(Number(adsReactor.comment_reward) * Number(adsReactor.max_comments)).toFixed(0)} FCFA (comments)
                </Text>
              </View>
            </Card>

            <View style={{ height: 12 }} />

            <Card>
              <Text style={styles.section}>📣 Publicités soumises</Text>
              <View style={{ flexDirection: "row", gap: 6, marginTop: 8 }}>
                {(["pending_admin_review", "published", "rejected", "all"] as const).map((k) => (
                  <TouchableOpacity
                    key={k}
                    style={{
                      paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8,
                      backgroundColor: adFilter === k ? theme.colors.primary : theme.colors.background,
                    }}
                    onPress={() => setAdFilter(k)}
                    testID={`ads-filter-${k}`}
                  >
                    <Text style={{
                      fontSize: 11, fontWeight: "700",
                      color: adFilter === k ? "#fff" : theme.colors.textPrimary,
                    }}>{k === "pending_admin_review" ? "En attente" : k === "published" ? "Publiées" : k === "rejected" ? "Rejetées" : "Toutes"}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </Card>

            <View style={{ height: 8 }} />

            {adsList.filter((a) => adFilter === "all" || a.status === adFilter).length === 0 ? (
              <Card><Text style={styles.empty}>Aucune publicité dans cette catégorie.</Text></Card>
            ) : adsList.filter((a) => adFilter === "all" || a.status === adFilter).map((a) => (
              <Card key={a.id} style={{ marginBottom: 8 }} testID={`admin-ad-item-${a.id}`}>
                <Text style={styles.userName}>🎥 @{a.username}</Text>
                <View style={styles.kvBox}>
                  <KvRow k="Durée" v={`${a.duration_days || "?"} jour(s)`} />
                  <KvRow k="Prix payé" v={`${a.price_amount || 0} ${a.currency || "FCFA"}`} />
                  {/* v27g — Numéro qui a effectué le paiement (Mobile Money).
                      Affiché en priorité pour les publicités en attente de
                      validation admin afin de pouvoir vérifier le paiement
                      auprès de l'opérateur. */}
                  {a.payment_method === "mobile_money" && a.payer_phone ? (
                    <KvRow
                      k="📞 N° payeur"
                      v={`${a.payer_phone}${a.payer_operator ? ` — ${a.payer_operator}` : ""}${a.payer_country ? ` (${a.payer_country})` : ""}`}
                    />
                  ) : a.payment_method === "crypto" ? (
                    <KvRow k="💳 Paiement" v="Crypto USDT (BEP20)" />
                  ) : null}
                  <KvRow k="Pays" v={(a.target_countries || []).join(", ") || "—"} />
                  <KvRow k="Âge" v={`${a.target_age_min || "?"} – ${a.target_age_max || "?"}`} />
                  <KvRow k="Genre" v={a.target_gender || "—"} />
                  <KvRow k="Statut" v={a.status} />
                </View>
                {/* Full-preview media viewer — admin can zoom images,
                    scrub video, and read the full description before
                    approving. */}
                <MediaViewer
                  images={a.cover_image_url ? [a.cover_image_url] : []}
                  videos={a.video_url ? [a.video_url] : []}
                  title={a.title || `Publicité de @${a.username}`}
                  description={a.description}
                  testID={`admin-ad-media-${a.id}`}
                />
                {a.status === "pending_admin_review" && (
                  <View style={styles.actRow}>
                    <TouchableOpacity
                      style={[styles.actBtn, { backgroundColor: theme.colors.success }]}
                      onPress={() => action(() => api.post(`/admin/ads/${a.id}/approve`))}
                      testID={`admin-ad-approve-${a.id}`}
                    >
                      <Ionicons name="checkmark" size={14} color="#fff" />
                      <Text style={styles.actT}>Approuver</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.actBtn}
                      onPress={() => action(async () => {
                        const reason = typeof window !== "undefined" ? window.prompt("Motif du rejet :") || "" : "";
                        await api.post(`/admin/ads/${a.id}/reject`, { reason });
                      })}
                      testID={`admin-ad-reject-${a.id}`}
                    >
                      <Ionicons name="close" size={14} color="#fff" />
                      <Text style={styles.actT}>Rejeter</Text>
                    </TouchableOpacity>
                  </View>
                )}
                {/* Delete — always available regardless of status. Uses a
                    confirmation prompt on web so a mistaken tap doesn't
                    wipe an ad accidentally. */}
                <View style={[styles.actRow, { marginTop: 6 }]}>
                  <TouchableOpacity
                    style={[styles.actBtn, { backgroundColor: theme.colors.danger }]}
                    onPress={() => {
                      if (typeof window !== "undefined" && !window.confirm(`Supprimer définitivement la publicité de @${a.username} ?`)) return;
                      action(async () => {
                        await api.delete(`/admin/ads/${a.id}`);
                        setAdsList((prev) => prev.filter((x) => x.id !== a.id));
                      });
                    }}
                    testID={`admin-ad-delete-${a.id}`}
                  >
                    <Ionicons name="trash" size={14} color="#fff" />
                    <Text style={styles.actT}>Supprimer</Text>
                  </TouchableOpacity>
                </View>
              </Card>
            ))}
          </>
        )}

        {tab === "special_tasks" && (
          <Card>
            <Text style={styles.section}>🎯 Config des tâches spéciales</Text>
            <Text style={{ fontSize: 11, color: theme.colors.textSecondary, marginBottom: 8 }}>
              L'administrateur fixe le <Text style={{ fontWeight: "800" }}>prix payé par le créateur</Text> pour chaque type
              d'action et les deux pourcentages globaux. Le système répartit automatiquement.
            </Text>

            <View style={{ backgroundColor: "#FEF3C7", borderRadius: 12, padding: 10, marginBottom: 12 }}>
              <Text style={{ fontWeight: "800", fontSize: 12, color: "#92400E", marginBottom: 6 }}>
                💰 Répartition globale (doivent totaliser 100 %)
              </Text>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Input
                    label="% à distribuer aux users"
                    value={String(stDistPct)}
                    onChangeText={(v: string) => {
                      const n = Math.max(1, Math.min(100, Number(v) || 0));
                      setStDistPct(n);
                    }}
                    keyboardType="numeric"
                    testID="st-distribution-pct"
                  />
                </View>
                <View style={{ flex: 1, backgroundColor: "#FFFBEB", borderRadius: 10, padding: 8, marginBottom: 4 }}>
                  <Text style={{ fontSize: 10, color: "#78350F", fontWeight: "700" }}>% plateforme (auto)</Text>
                  <Text style={{ fontSize: 16, fontWeight: "900", color: "#78350F" }} testID="st-platform-pct">
                    {(100 - stDistPct).toFixed(0)} %
                  </Text>
                </View>
              </View>
              <Text style={{ fontSize: 10, color: "#78350F", marginTop: 4 }}>
                Exemple : si le créateur paie 1 000 FCFA, {stDistPct}% ({(1000 * stDistPct / 100).toFixed(0)} FCFA) sont
                répartis équitablement entre les utilisateurs, {(100 - stDistPct)}% ({(1000 * (100 - stDistPct) / 100).toFixed(0)} FCFA)
                reviennent à la plateforme.
              </Text>
            </View>

            {["video", "subscribe", "share", "like", "comment", "group"].map((at) => {
              const c = stCfg[at] || { enabled: false, price_per_action: 0, reward_per_action: 0, min_qty: 10, max_qty: 1000 };
              const labels: any = { video: "▶️ Regarder", subscribe: "➕ S'abonner", share: "📤 Partager", like: "❤️ Aimer", comment: "💬 Commenter", group: "👥 Rejoindre un groupe" };
              const computedReward = (Number(c.price_per_action) * stDistPct / 100).toFixed(2);
              return (
                <View key={at} style={{ borderBottomWidth: 1, borderColor: theme.colors.border, paddingVertical: 8 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                    <Text style={{ fontWeight: "900", fontSize: 13 }}>{labels[at]}</Text>
                    <TouchableOpacity
                      onPress={() => setStCfg((v: any) => ({ ...v, [at]: { ...c, enabled: !c.enabled } }))}
                      style={{ backgroundColor: c.enabled ? theme.colors.success : theme.colors.textSecondary, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 }}
                      testID={`st-toggle-${at}`}
                    >
                      <Text style={{ color: "#fff", fontSize: 10, fontWeight: "800" }}>{c.enabled ? "ACTIF" : "INACTIF"}</Text>
                    </TouchableOpacity>
                  </View>
                  <View style={{ flexDirection: "row", gap: 6, alignItems: "flex-end" }}>
                    <View style={{ flex: 1 }}>
                      <Input label="Prix / action (FCFA)" value={String(c.price_per_action || 0)}
                        onChangeText={(v: string) => setStCfg((s: any) => ({ ...s, [at]: { ...c, price_per_action: Number(v) || 0, reward_per_action: undefined } }))}
                        keyboardType="numeric" testID={`st-price-${at}`} />
                    </View>
                    <View style={{ flex: 1, backgroundColor: "#F1F5F9", borderRadius: 10, padding: 8, marginBottom: 4 }}>
                      <Text style={{ fontSize: 10, color: theme.colors.textSecondary, fontWeight: "700" }}>Récompense / user (auto)</Text>
                      <Text style={{ fontSize: 14, fontWeight: "900", color: "#0F172A" }} testID={`st-reward-computed-${at}`}>
                        {computedReward} FCFA
                      </Text>
                    </View>
                  </View>
                  <View style={{ flexDirection: "row", gap: 6, marginTop: 6 }}>
                    <View style={{ flex: 1 }}><Input label="Min qty" value={String(c.min_qty)} onChangeText={(v: string) => setStCfg((s: any) => ({ ...s, [at]: { ...c, min_qty: Number(v) || 1 } }))} keyboardType="numeric" testID={`st-min-${at}`} /></View>
                    <View style={{ flex: 1 }}><Input label="Max qty" value={String(c.max_qty)} onChangeText={(v: string) => setStCfg((s: any) => ({ ...s, [at]: { ...c, max_qty: Number(v) || 10000 } }))} keyboardType="numeric" testID={`st-max-${at}`} /></View>
                  </View>
                </View>
              );
            })}
            <Button title="Enregistrer la configuration" onPress={() => action(async () => {
              await api.put("/admin/special-tasks/config", {
                action_types: stCfg,
                distribution_percentage: stDistPct,
              });
            })} testID="st-save" />
          </Card>
        )}

        {tab === "special_tasks" && (
          <>
            <View style={{ height: 12 }} />
            <Card>
              <Text style={styles.section}>📋 Campagnes de tâches spéciales</Text>
              <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", marginTop: 8, marginBottom: 6 }}>
                {(["pending_payment", "active", "completed", "cancelled", "all"] as const).map((k) => (
                  <TouchableOpacity
                    key={k}
                    style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: stFilter === k ? theme.colors.primary : theme.colors.background }}
                    onPress={() => setStFilter(k)}
                    testID={`st-filter-${k}`}
                  >
                    <Text style={{ fontSize: 10, fontWeight: "700", color: stFilter === k ? "#fff" : theme.colors.textPrimary }}>
                      {{"pending_payment": "Paiement", "active": "Actives", "completed": "Terminées", "cancelled": "Annulées", "all": "Toutes"}[k]}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </Card>
            <View style={{ height: 8 }} />
            {stList.filter((t) => stFilter === "all" || t.status === stFilter).length === 0 ? (
              <Card><Text style={styles.empty}>Aucune campagne dans cette catégorie.</Text></Card>
            ) : stList.filter((t) => stFilter === "all" || t.status === stFilter).map((t) => {
              const label: Record<string, string> = {
                video: "▶️ Regarder", subscribe: "➕ Abonnement", like: "❤️ Like",
                comment: "💬 Commentaire", share: "📤 Partage", group: "👥 Rejoindre",
              };
              return (
                <Card key={t.id} style={{ marginBottom: 8 }} testID={`admin-st-item-${t.id}`}>
                  <Text style={styles.userName}>{label[t.action_type] || t.action_type} • {t.network}</Text>
                  <Text style={styles.userMeta}>@{t.username || t.user_id?.slice(0, 8)}</Text>
                  <View style={styles.kvBox}>
                    <KvRow k="Objectif" v={`${t.quantity_completed || 0} / ${t.quantity_target}`} />
                    <KvRow k="Récompense" v={`${t.reward_per_action} ${t.currency || "FCFA"} / action`} />
                    <KvRow k="Prix payé" v={`${t.price_total || (t.quantity_target * (t.price_per_action || 0))} ${t.currency || "FCFA"}`} />
                    <KvRow k="Statut" v={t.status} />
                  </View>
                  {/* Full-preview — description complète + lien cible cliquable. */}
                  <MediaViewer
                    title={`Cible : ${t.network}`}
                    description={t.description || ""}
                    extraInfo={t.link ? (
                      <TouchableOpacity
                        onPress={() => { if (typeof window !== "undefined") window.open(t.link, "_blank"); }}
                        style={{ marginTop: 8, flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: theme.colors.primary, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, alignSelf: "flex-start" }}
                        testID={`admin-st-open-link-${t.id}`}
                      >
                        <Ionicons name="open-outline" size={14} color="#fff" />
                        <Text style={{ color: "#fff", fontWeight: "800", fontSize: 12 }}>Ouvrir le lien cible</Text>
                      </TouchableOpacity>
                    ) : null}
                    testID={`admin-st-media-${t.id}`}
                  />
                  {t.status === "pending_payment" && (
                    <View style={styles.actRow}>
                      <TouchableOpacity
                        style={[styles.actBtn, { backgroundColor: theme.colors.success }]}
                        onPress={() => action(async () => {
                          await api.post(`/admin/special-tasks/${t.id}/force-activate`);
                          const tl = await api.get<any>("/admin/special-tasks");
                          setStList(tl?.items || []);
                        })}
                        testID={`admin-st-force-${t.id}`}
                      >
                        <Ionicons name="rocket" size={14} color="#fff" />
                        <Text style={styles.actT}>Forcer l'activation</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                  {/* Delete — always available regardless of status. */}
                  <View style={[styles.actRow, { marginTop: 6 }]}>
                    <TouchableOpacity
                      style={[styles.actBtn, { backgroundColor: theme.colors.danger }]}
                      onPress={() => {
                        if (typeof window !== "undefined" && !window.confirm(`Supprimer définitivement cette tâche spéciale ?`)) return;
                        action(async () => {
                          await api.delete(`/admin/special-tasks/${t.id}`);
                          setStList((prev) => prev.filter((x) => x.id !== t.id));
                        });
                      }}
                      testID={`admin-st-delete-${t.id}`}
                    >
                      <Ionicons name="trash" size={14} color="#fff" />
                      <Text style={styles.actT}>Supprimer</Text>
                    </TouchableOpacity>
                  </View>
                </Card>
              );
            })}
          </>
        )}

        {tab === "marketplace" && (
          <>
            <Card>
              <Text style={styles.section}>⚙️ Config Marketplace</Text>
              <Input label="Durée par annonce (jours)" value={String(mkCfg.duration_days || 14)} onChangeText={(v: string) => setMkCfg((s: any) => ({ ...s, duration_days: parseInt(v, 10) || 14 }))} keyboardType="numeric" testID="mk-duration" />
              <TouchableOpacity
                onPress={() => setMkCfg((s: any) => ({ ...s, enabled: !s.enabled }))}
                style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 }}
                testID="mk-enabled-toggle"
              >
                <Ionicons name={mkCfg.enabled ? "checkbox" : "square-outline"} size={22} color={mkCfg.enabled ? theme.colors.success : theme.colors.textSecondary} />
                <Text style={{ fontWeight: "700" }}>Publication ouverte aux utilisateurs</Text>
              </TouchableOpacity>
              <Button title="Enregistrer" onPress={() => action(async () => {
                await api.put("/admin/marketplace/config", { duration_days: mkCfg.duration_days || 14, enabled: !!mkCfg.enabled });
              })} testID="mk-save-cfg" />
            </Card>

            <View style={{ height: 12 }} />
            <Card>
              <Text style={styles.section}>📋 Annonces</Text>
              <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                {(["pending_admin_review", "approved", "expired", "rejected", "all"] as const).map((k) => (
                  <TouchableOpacity key={k} style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: mkFilter === k ? theme.colors.primary : theme.colors.background }} onPress={() => setMkFilter(k)} testID={`mk-filter-${k}`}>
                    <Text style={{ fontSize: 10, fontWeight: "700", color: mkFilter === k ? "#fff" : theme.colors.textPrimary }}>
                      {{"pending_admin_review": "En attente", "approved": "Approuvées", "expired": "Expirées", "rejected": "Rejetées", "all": "Toutes"}[k]}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </Card>
            <View style={{ height: 8 }} />
            {mkList.filter((l) => mkFilter === "all" || l.status === mkFilter).length === 0 ? (
              <Card><Text style={styles.empty}>Aucune annonce dans cette catégorie.</Text></Card>
            ) : mkList.filter((l) => mkFilter === "all" || l.status === mkFilter).map((l) => (
              <Card key={l.id} style={{ marginBottom: 8 }} testID={`admin-mk-item-${l.id}`}>
                <Text style={styles.userName}>🛒 {l.name}</Text>
                <Text style={styles.userMeta}>@{l.seller_username} • {l.category} • {l.city}</Text>
                <View style={styles.kvBox}>
                  <KvRow k="Prix" v={`${l.promo_price ? l.promo_price + " (promo) / " : ""}${l.price} ${l.currency}`} />
                  <KvRow k="Contact WA" v={l.whatsapp} />
                  <KvRow k="Photos" v={String((l.images || []).length)} />
                  <KvRow k="Vidéos" v={String((l.videos || []).length)} />
                  <KvRow k="Musique" v={l.audio ? "🎵 oui" : "—"} />
                  <KvRow k="Statut" v={l.status} />
                </View>

                {/* Full-preview media viewer — click any thumbnail to zoom
                    an image or open a video with full playback controls. */}
                <MediaViewer
                  images={l.images || []}
                  videos={l.videos || []}
                  audio={l.audio || null}
                  title={l.name}
                  description={l.description}
                  testID={`admin-mk-media-${l.id}`}
                />

                {l.status === "pending_admin_review" && (
                  <View style={styles.actRow}>
                    <TouchableOpacity style={[styles.actBtn, { backgroundColor: theme.colors.success }]} onPress={() => action(() => api.post(`/admin/marketplace/${l.id}/approve`))} testID={`admin-mk-approve-${l.id}`}>
                      <Ionicons name="checkmark" size={14} color="#fff" /><Text style={styles.actT}>Approuver</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.actBtn} onPress={() => action(() => api.post(`/admin/marketplace/${l.id}/reject`))} testID={`admin-mk-reject-${l.id}`}>
                      <Ionicons name="close" size={14} color="#fff" /><Text style={styles.actT}>Rejeter</Text>
                    </TouchableOpacity>
                  </View>
                )}
                {l.status !== "pending_admin_review" && (
                  <TouchableOpacity style={[styles.actBtn, { marginTop: 6 }]} onPress={() => action(async () => {
                    if (typeof window !== "undefined" && !window.confirm(`Supprimer "${l.name}" ?`)) return;
                    await api.delete(`/admin/marketplace/${l.id}`);
                  })} testID={`admin-mk-delete-${l.id}`}>
                    <Ionicons name="trash" size={14} color="#fff" /><Text style={styles.actT}>Supprimer</Text>
                  </TouchableOpacity>
                )}
              </Card>
            ))}
          </>
        )}

        {tab === "admins" && (
          <>
            <Card>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Ionicons name="shield-checkmark" size={22} color={theme.colors.primary} />
                <Text style={styles.section}>Administrateurs</Text>
                <View style={{ marginLeft: "auto", backgroundColor: theme.colors.primary, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 }}>
                  <Text style={{ color: "#fff", fontWeight: "900", fontSize: 12 }}>{admins.length}</Text>
                </View>
              </View>
              <Text style={{ color: theme.colors.textSecondary, fontSize: 12, marginTop: 4 }}>
                Seuls les comptes possédant le rôle Administrateur sont listés ici.
              </Text>
              <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
                <View style={styles.searchBox}>
                  <Ionicons name="search" size={16} color={theme.colors.textSecondary} />
                  <TextInput
                    value={adminQ}
                    onChangeText={setAdminQ}
                    onSubmitEditing={load}
                    placeholder="Rechercher un admin (username, email, téléphone)…"
                    placeholderTextColor={theme.colors.textSecondary}
                    style={styles.searchI}
                    testID="admins-search"
                  />
                </View>
                <TouchableOpacity onPress={load} style={styles.refreshBtn} testID="admins-search-btn">
                  <Ionicons name="search" size={18} color="#fff" />
                </TouchableOpacity>
              </View>
            </Card>

            {admins.length === 0 ? (
              <Card style={{ marginTop: 10 }}>
                <Text style={{ color: theme.colors.textSecondary }}>Aucun administrateur trouvé.</Text>
              </Card>
            ) : (
              admins.map((a: any) => (
                <Card key={a.id} style={{ marginTop: 10 }} testID={`admin-row-${a.id}`}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                    <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: theme.colors.primary, alignItems: "center", justifyContent: "center" }}>
                      <Ionicons name="shield" size={20} color="#fff" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 15, fontWeight: "900", color: theme.colors.textPrimary }}>
                        @{a.username}
                      </Text>
                      <Text style={{ fontSize: 11, color: theme.colors.textSecondary }}>
                        {a.email}
                      </Text>
                    </View>
                    <View style={{
                      paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999,
                      backgroundColor: a.status === "active" ? theme.colors.success : theme.colors.warning,
                    }}>
                      <Text style={{ color: "#fff", fontWeight: "800", fontSize: 11 }}>{a.status}</Text>
                    </View>
                  </View>
                  <View style={styles.kvBox}>
                    <KvRow k="Nom d'utilisateur" v={a.username} />
                    <KvRow k="Email" v={a.email} />
                    <KvRow k="Téléphone" v={a.phone || "—"} />
                    <KvRow k="Pays" v={a.country || "—"} />
                    <KvRow k="Niveau d'accès" v={`L${a.max_level ?? 0}`} />
                    <KvRow k="Statut" v={a.status} />
                    <KvRow k="Promoteur" v={a.is_promoter ? "Oui" : "Non"} />
                    <KvRow k="Retraits" v={a.withdrawals_disabled ? "Désactivés" : "Autorisés"} />
                    <KvRow k="Créé le" v={a.created_at ? new Date(a.created_at).toLocaleString("fr-FR") : "—"} />
                  </View>
                </Card>
              ))
            )}
          </>
        )}

        {tab === "features" && (
          <>
            <Card>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Ionicons name="toggle" size={22} color={theme.colors.primary} />
                <Text style={styles.section}>Gestion des fonctionnalités</Text>
              </View>
              <Text style={{ color: theme.colors.textSecondary, fontSize: 12, marginTop: 6 }}>
                Activez ou désactivez chaque module. Une fonctionnalité désactivée devient
                immédiatement inaccessible côté utilisateur (menu masqué + endpoints bloqués).
                L'état est conservé après redéploiement.
              </Text>
            </Card>

            {flags.length === 0 ? (
              <Card style={{ marginTop: 12 }}>
                <Text style={{ color: theme.colors.textSecondary }}>Chargement…</Text>
              </Card>
            ) : (
              Object.entries(
                flags.reduce((acc: any, f: any) => {
                  (acc[f.category] = acc[f.category] || []).push(f);
                  return acc;
                }, {} as Record<string, any[]>)
              ).map(([cat, list]: any) => (
                <Card key={cat} style={{ marginTop: 12 }}>
                  <Text style={[styles.section, { textTransform: "capitalize", marginBottom: 8 }]}>
                    {cat}
                  </Text>
                  {(list as any[]).map((f) => (
                    <View
                      key={f.key}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        paddingVertical: 12,
                        borderTopWidth: 1,
                        borderColor: theme.colors.border,
                      }}
                      testID={`feature-row-${f.key}`}
                    >
                      <View style={{ flex: 1, paddingRight: 12 }}>
                        <Text style={{ fontWeight: "800", color: theme.colors.textPrimary, fontSize: 14 }}>
                          {f.label}
                        </Text>
                        <Text style={{ color: theme.colors.textSecondary, fontSize: 11, marginTop: 2 }}>
                          {f.key}
                        </Text>
                      </View>
                      <TouchableOpacity
                        disabled={flagBusy === f.key}
                        onPress={async () => {
                          setFlagBusy(f.key);
                          try {
                            await api.put(`/admin/feature-flags/${f.key}`, { enabled: !f.enabled });
                            setFlags((prev) =>
                              prev.map((x: any) =>
                                x.key === f.key ? { ...x, enabled: !x.enabled } : x
                              )
                            );
                          } catch (e: any) {
                            if (typeof window !== "undefined")
                              window.alert(`❌ ${e?.detail || "Impossible de mettre à jour."}`);
                          } finally {
                            setFlagBusy(null);
                          }
                        }}
                        style={{
                          minWidth: 116,
                          paddingVertical: 10,
                          paddingHorizontal: 14,
                          borderRadius: 999,
                          backgroundColor: f.enabled ? theme.colors.success : "#E2E8F0",
                          alignItems: "center",
                          justifyContent: "center",
                          flexDirection: "row",
                          gap: 6,
                          opacity: flagBusy === f.key ? 0.6 : 1,
                        }}
                        testID={`feature-toggle-${f.key}`}
                      >
                        <Ionicons
                          name={f.enabled ? "checkmark-circle" : "close-circle"}
                          size={16}
                          color={f.enabled ? "#fff" : theme.colors.textSecondary}
                        />
                        <Text
                          style={{
                            color: f.enabled ? "#fff" : theme.colors.textSecondary,
                            fontWeight: "900",
                            fontSize: 12,
                          }}
                        >
                          {f.enabled ? "Activée" : "Désactivée"}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  ))}
                </Card>
              ))
            )}
          </>
        )}

        {tab === "support" && (
          <>
            <SupportAgentsCard />
            <AdminSupportTab />
          </>
        )}

        {tab === "providers" && (
          <>
            <View style={{ padding: 12, borderRadius: 14, backgroundColor: "#EEF2FF", borderWidth: 1, borderColor: "#C7D2FE", marginBottom: 12 }}>
              <Text style={{ fontSize: 15, fontWeight: "900", color: "#1E1B4B" }}>💳 Prestataires de paiement</Text>
              <Text style={{ fontSize: 11, color: "#312E81", marginTop: 4, lineHeight: 15 }}>
                Vue unifiée : chaque prestataire → statut, dépôt/retrait auto, priorité, pays et opérateurs. Le router central choisit dynamiquement le prestataire selon le pays, l'opérateur et la priorité.
              </Text>
            </View>
            <PaymentProvidersRouterCard />
            <View style={{ padding: 12, borderRadius: 12, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, marginTop: 8, marginBottom: 12 }}>
              <Text style={{ fontSize: 13, fontWeight: "900", color: theme.colors.textPrimary, marginBottom: 8 }}>🔑 Configuration des clés (par prestataire)</Text>
              <Text style={{ fontSize: 11, color: theme.colors.textSecondary, marginBottom: 10 }}>
                Les clés API/secrets restent sécurisées côté serveur (masquées). Modifiez uniquement pour remplacer une clé existante.
              </Text>
              <BizTransPayCard />
              <SolesPaySettingsCard />
              <PaymentGatewaysCard />
            </View>
            <PaymentRouterLogsCard />
          </>
        )}

        {tab === "payment" && (
          <>
            <SolesPaySettingsCard />
            <PaymentGatewaysCard />
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
                    notify("Configuration sauvegardée", "Les utilisateurs verront immédiatement les changements.");
                  } catch (e: any) {
                    notify("Erreur", e?.detail || "Impossible de sauvegarder.");
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
                title="ENREGISTRER LES PARAMÈTRES"
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
                    notify("✅ Sauvegardé", "Frais, jours et heures de retrait appliqués immédiatement.");
                  } catch (e: any) {
                    notify("Erreur", e?.detail || "Impossible de sauvegarder.");
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
                    notify("✅ Sauvegardé", "Les liens de support sont mis à jour.");
                  } catch (e: any) {
                    notify("Erreur", e?.detail || "Impossible de sauvegarder.");
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
                    notify("Erreur", e?.detail || "Impossible de sauvegarder.");
                  } finally {
                    setCpSaving(false);
                  }
                }}
                testID="cp-save"
              />
            </Card>
            <Card style={{ marginTop: 12 }} testID="admin-trading-card">
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <Ionicons name="trending-up" size={18} color={theme.colors.primary} />
                <Text style={styles.h3}>📈 Trading — Canal Telegram</Text>
              </View>
              <Text style={styles.help}>
                Ce lien pilote la carte Trading affichée sur le Dashboard des utilisateurs.
                Un clic sur la carte redirige vers ce canal Telegram.
              </Text>

              <TouchableOpacity
                style={[styles.toggleRow, trEnabled ? styles.toggleOn : styles.toggleOff]}
                onPress={() => setTrEnabled(!trEnabled)}
                testID="tr-enabled"
              >
                <Ionicons name={trEnabled ? "checkmark-circle" : "close-circle"} size={18} color="#fff" />
                <Text style={styles.toggleTxt}>
                  {trEnabled ? "Activé — carte Trading visible sur le Dashboard" : "Désactivé — carte masquée"}
                </Text>
              </TouchableOpacity>

              <Input
                label="Lien du canal Telegram Trading"
                value={trTelegram}
                onChangeText={setTrTelegram}
                placeholder="https://t.me/spiloveure_trading"
                autoCapitalize="none"
                testID="tr-telegram"
              />
              <Input label="Titre" value={trTitle} onChangeText={setTrTitle} placeholder="TRADING" testID="tr-title" />
              <Input
                label="Description"
                value={trDesc}
                onChangeText={setTrDesc}
                placeholder="Texte affiché sur la carte…"
                multiline
                numberOfLines={2}
                style={{ minHeight: 60, textAlignVertical: "top" }}
                testID="tr-desc"
              />
              <Input
                label="Libellé du bouton"
                value={trButton}
                onChangeText={setTrButton}
                placeholder="Accéder au canal Telegram"
                testID="tr-button"
              />

              <View style={{ height: 8 }} />
              <Button
                title="ENREGISTRER LE CANAL TRADING"
                icon={<Ionicons name="save" size={18} color="#fff" />}
                loading={trSaving}
                onPress={async () => {
                  setTrSaving(true);
                  try {
                    await api.put("/admin/settings/trading", {
                      enabled: trEnabled,
                      telegram_url: trTelegram,
                      title: trTitle,
                      description: trDesc,
                      button_label: trButton,
                    });
                    if (typeof window !== "undefined") window.alert("Canal Trading enregistré ✅");
                  } catch (e: any) {
                    notify("Erreur", e?.detail || "Impossible de sauvegarder.");
                  } finally {
                    setTrSaving(false);
                  }
                }}
                testID="tr-save"
              />
            </Card>
          </>
        )}

        {tab === "activation_videos" && (
          <>
            <Card testID="admin-av-card">
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <Ionicons name="videocam" size={20} color={theme.colors.primary} />
                <Text style={styles.section}>🎥 Vidéos d'activation</Text>
              </View>
              <Text style={styles.helperTxt}>
                Ces vidéos apparaissent sur la page de paiement des nouveaux
                utilisateurs. Elles sont affichées dans l'ordre d'import (la
                première ajoutée apparaît en tête). Formats acceptés :
                MP4, MOV, WEBM, M4V — taille max 300 MB.
              </Text>

              <View style={{ height: 10 }} />
              <Input
                label="Titre de la vidéo *"
                value={avTitle}
                onChangeText={setAvTitle}
                placeholder="Ex : Comment activer votre compte"
                testID="av-title"
              />
              <Input
                label="Description (facultatif)"
                value={avDesc}
                onChangeText={setAvDesc}
                placeholder="Ex : Guide rapide pour effectuer votre activation"
                multiline
                numberOfLines={2}
                style={{ minHeight: 60, textAlignVertical: "top" }}
                testID="av-desc"
              />

              {Platform.OS === "web" ? (
                // @ts-ignore native file input for reliable multipart on web
                <input
                  type="file"
                  accept="video/mp4,video/quicktime,video/webm,video/x-m4v"
                  data-testid="av-file-input"
                  style={{ marginTop: 8, marginBottom: 4 }}
                  onChange={async (e: any) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    if (!avTitle.trim()) {
                      setAvErr("Le titre est obligatoire.");
                      return;
                    }
                    setAvErr(null);
                    setAvUploading(true);
                    setAvProgress(0);
                    try {
                      const form = new FormData();
                      form.append("title", avTitle.trim());
                      form.append("description", avDesc.trim());
                      form.append("file", f);
                      const base = process.env.EXPO_PUBLIC_BACKEND_URL || "";
                      const token = (typeof window !== "undefined")
                        ? JSON.parse(window.localStorage.getItem("auth_token") || '""')
                        : "";
                      // Use XHR for upload progress support.
                      await new Promise<void>((resolve, reject) => {
                        const xhr = new XMLHttpRequest();
                        xhr.open("POST", `${base}/api/admin/activation-videos`);
                        xhr.setRequestHeader("Authorization", `Bearer ${token}`);
                        xhr.upload.onprogress = (evt) => {
                          if (evt.lengthComputable) {
                            setAvProgress(Math.round((evt.loaded / evt.total) * 100));
                          }
                        };
                        xhr.onload = () => {
                          if (xhr.status >= 200 && xhr.status < 300) resolve();
                          else {
                            let msg = `Erreur ${xhr.status}`;
                            try { msg = JSON.parse(xhr.responseText).detail || msg; } catch {}
                            reject(new Error(msg));
                          }
                        };
                        xhr.onerror = () => reject(new Error("Erreur réseau"));
                        xhr.send(form);
                      });
                      // Reload list + reset form
                      const r = await api.get<any>("/admin/activation-videos");
                      setAvVideos(r?.items || []);
                      setAvTitle("");
                      setAvDesc("");
                      (e.target as HTMLInputElement).value = "";
                      window.alert("Vidéo enregistrée ✅");
                    } catch (err: any) {
                      setAvErr(err?.message || "Import échoué.");
                    } finally {
                      setAvUploading(false);
                      setAvProgress(0);
                    }
                  }}
                />
              ) : (
                <Text style={styles.helperTxt}>
                  L'upload de vidéos est disponible uniquement depuis un
                  navigateur web.
                </Text>
              )}
              {avUploading && (
                <View style={{ marginTop: 6, gap: 4 }}>
                  <ActivityIndicator color={theme.colors.primary} />
                  <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>
                    Import en cours… {avProgress}%
                  </Text>
                </View>
              )}
              {avErr && (
                <Text style={{ color: theme.colors.danger, fontSize: 12, marginTop: 6 }}>
                  {avErr}
                </Text>
              )}
            </Card>

            <Card style={{ marginTop: 12 }} testID="admin-av-list-card">
              <Text style={styles.section}>
                Vidéos enregistrées ({avVideos.length})
              </Text>
              {avVideos.length === 0 ? (
                <Text style={styles.empty}>Aucune vidéo. Importez la première ci-dessus.</Text>
              ) : (
                avVideos.map((v, i) => (
                  <View
                    key={v.id}
                    style={{
                      padding: 10,
                      borderRadius: 12,
                      backgroundColor: theme.colors.surfaceSecondary,
                      borderWidth: 1,
                      borderColor: theme.colors.border,
                      marginBottom: 8,
                    }}
                    data-testid={`av-item-${v.id}`}
                  >
                    <Text style={{ color: theme.colors.textPrimary, fontWeight: "800" }}>
                      {i + 1}. {v.title}
                    </Text>
                    {!!v.description && (
                      <Text style={{ color: theme.colors.textSecondary, fontSize: 12, marginTop: 2 }}>
                        {v.description}
                      </Text>
                    )}
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 11, marginTop: 4 }}>
                      {v.filename} • {Math.round((v.size_bytes || 0) / 1024 / 1024)} MB • {v.active ? "actif" : "masqué"}
                    </Text>
                    <View style={{ flexDirection: "row", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                      <TouchableOpacity
                        style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: v.active ? theme.colors.warning : theme.colors.success }}
                        onPress={async () => {
                          try {
                            await api.put(`/admin/activation-videos/${v.id}`, { active: !v.active });
                            const r = await api.get<any>("/admin/activation-videos");
                            setAvVideos(r?.items || []);
                          } catch (e: any) { notify("Erreur", e?.detail || "Échec"); }
                        }}
                        data-testid={`av-toggle-${v.id}`}
                      >
                        <Text style={{ color: "#fff", fontWeight: "800", fontSize: 12 }}>
                          {v.active ? "Masquer" : "Activer"}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: theme.colors.danger }}
                        onPress={async () => {
                          if (typeof window !== "undefined" && !window.confirm(`Supprimer définitivement « ${v.title} » ?`)) return;
                          try {
                            await api.delete(`/admin/activation-videos/${v.id}`);
                            const r = await api.get<any>("/admin/activation-videos");
                            setAvVideos(r?.items || []);
                          } catch (e: any) { notify("Erreur", e?.detail || "Échec"); }
                        }}
                        data-testid={`av-delete-${v.id}`}
                      >
                        <Text style={{ color: "#fff", fontWeight: "800", fontSize: 12 }}>Supprimer</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ))
              )}
            </Card>
          </>
        )}
      </ScrollView>

      {/* Challenge EDIT modal — non-destructive update of an existing challenge.
          Only the fields in the form are sent; participants, scores, progress
          and ranking are never touched by this endpoint (backend PUT is a
          partial update). */}
      <Modal
        visible={chgEdit !== null}
        transparent
        animationType="fade"
        onRequestClose={() => (chgEditBusy ? null : setChgEdit(null))}
      >
        <View style={styles.historyOverlay}>
          <View style={styles.historyCard} testID="admin-chg-edit-modal">
            <View style={styles.historyHead}>
              <View style={{ flex: 1 }}>
                <Text style={styles.historyTitle}>✏️ Modifier le challenge</Text>
                <Text style={styles.historySub}>
                  Les participants et leur progression restent inchangés.
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => (chgEditBusy ? null : setChgEdit(null))}
                style={styles.historyClose}
                testID="admin-chg-edit-close"
              >
                <Ionicons name="close" size={22} color="#fff" />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 520 }} contentContainerStyle={{ padding: 12 }}>
              <Input label="Nom du challenge" value={chgEditName} onChangeText={setChgEditName} testID="chg-edit-name" />
              <View style={{ flexDirection: "row", gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Input label="Objectif (nb invit.)" value={chgEditTarget} onChangeText={setChgEditTarget} keyboardType="numeric" testID="chg-edit-target" />
                </View>
                <View style={{ flex: 1 }}>
                  <Input label="Récompense" value={chgEditReward} onChangeText={setChgEditReward} keyboardType="numeric" testID="chg-edit-reward" />
                </View>
                <View style={{ flex: 1 }}>
                  <Input label="Devise" value={chgEditCurrency} onChangeText={setChgEditCurrency} testID="chg-edit-currency" />
                </View>
              </View>
              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                <View style={{ flex: 1, minWidth: 180 }}>
                  <Text style={styles.lbl}>Date de début</Text>
                  {/* @ts-ignore RN Web accepts raw HTML inputs */}
                  <input
                    type="date"
                    value={chgEditStartDate}
                    onChange={(e: any) => setChgEditStartDate(e.target.value)}
                    data-testid="chg-edit-start-date"
                    style={{ padding: 10, borderRadius: 10, border: `1px solid ${theme.colors.border}`, fontSize: 13, width: "100%", boxSizing: "border-box" }}
                  />
                </View>
                <View style={{ flex: 1, minWidth: 140 }}>
                  <Text style={styles.lbl}>Heure de début</Text>
                  {/* @ts-ignore RN Web accepts raw HTML inputs */}
                  <input
                    type="time"
                    value={chgEditStartTime}
                    onChange={(e: any) => setChgEditStartTime(e.target.value)}
                    data-testid="chg-edit-start-time"
                    style={{ padding: 10, borderRadius: 10, border: `1px solid ${theme.colors.border}`, fontSize: 13, width: "100%", boxSizing: "border-box" }}
                  />
                </View>
              </View>
              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                <View style={{ flex: 1, minWidth: 180 }}>
                  <Text style={styles.lbl}>Date de fin</Text>
                  {/* @ts-ignore RN Web accepts raw HTML inputs */}
                  <input
                    type="date"
                    value={chgEditEndDate}
                    onChange={(e: any) => setChgEditEndDate(e.target.value)}
                    data-testid="chg-edit-end-date"
                    style={{ padding: 10, borderRadius: 10, border: `1px solid ${theme.colors.border}`, fontSize: 13, width: "100%", boxSizing: "border-box" }}
                  />
                </View>
                <View style={{ flex: 1, minWidth: 140 }}>
                  <Text style={styles.lbl}>Heure de fin</Text>
                  {/* @ts-ignore RN Web accepts raw HTML inputs */}
                  <input
                    type="time"
                    value={chgEditEndTime}
                    onChange={(e: any) => setChgEditEndTime(e.target.value)}
                    data-testid="chg-edit-end-time"
                    style={{ padding: 10, borderRadius: 10, border: `1px solid ${theme.colors.border}`, fontSize: 13, width: "100%", boxSizing: "border-box" }}
                  />
                </View>
              </View>
              <View style={{ height: 12 }} />
              <TouchableOpacity
                onPress={() => setChgEditActive(!chgEditActive)}
                style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 }}
                testID="chg-edit-active-toggle"
              >
                <Ionicons
                  name={chgEditActive ? "checkbox" : "square-outline"}
                  size={22}
                  color={chgEditActive ? theme.colors.success : theme.colors.textSecondary}
                />
                <Text style={{ color: theme.colors.textPrimary, fontWeight: "700" }}>
                  Actif (désactive les autres challenges actifs)
                </Text>
              </TouchableOpacity>
              <Button
                title={chgEditBusy ? "Enregistrement…" : "💾 Enregistrer les modifications"}
                disabled={chgEditBusy}
                onPress={submitChallengeEdit}
                testID="chg-edit-submit"
              />
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Challenge participants modal — opened from the challenges list. */}
      <Modal
        visible={chgParticipants !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setChgParticipants(null)}
      >
        <View style={styles.historyOverlay}>
          <View style={styles.historyCard} testID="admin-chg-participants-modal">
            <View style={styles.historyHead}>
              <View style={{ flex: 1 }}>
                <Text style={styles.historyTitle}>🏆 Participants — {chgParticipants?.challenge?.name}</Text>
                <Text style={styles.historySub}>
                  {chgParticipantsLoading
                    ? "Chargement…"
                    : `${(chgParticipants?.participants || []).length} participant${(chgParticipants?.participants || []).length > 1 ? "s" : ""} • ${chgParticipants?.winners_count || 0} 🎉 gagnant${(chgParticipants?.winners_count || 0) > 1 ? "s" : ""}`}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setChgParticipants(null)} style={styles.historyClose} testID="admin-chg-participants-close">
                <Ionicons name="close" size={22} color="#fff" />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 500 }} contentContainerStyle={{ padding: 12 }}>
              {chgParticipantsLoading ? (
                <Text style={styles.historyEmpty}>Chargement en cours…</Text>
              ) : (chgParticipants?.participants || []).length === 0 ? (
                <Text style={styles.historyEmpty}>Aucun participant ayant validé une invitation pour l'instant.</Text>
              ) : (
                (chgParticipants?.participants || []).map((p: any, idx: number) => (
                  <View key={p.user_id} style={styles.historyRow} testID={`admin-chg-part-${p.user_id}`}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.historyRowLabel}>
                        {p.completed ? "🎉 " : ""}@{p.username}
                      </Text>
                      <Text style={styles.historyRowMeta}>
                        {p.country || "—"}{p.phone ? ` • ${p.phone}` : ""}
                      </Text>
                    </View>
                    <Text style={[styles.historyRowAmount, { color: p.completed ? theme.colors.success : theme.colors.textPrimary }]}>
                      {p.progress} / {p.target}
                    </Text>
                  </View>
                ))
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Transaction history modal — opened from the withdrawals list. */}
      <Modal
        visible={historyUser !== null}
        transparent
        animationType="fade"
        onRequestClose={closeUserHistory}
      >
        <View style={styles.historyOverlay}>
          <View style={styles.historyCard} testID="admin-wd-history-modal">
            <View style={styles.historyHead}>
              <View style={{ flex: 1 }}>
                <Text style={styles.historyTitle}>📜 Historique — @{historyUser?.username}</Text>
                <Text style={styles.historySub}>
                  {historyLoading
                    ? "Chargement…"
                    : `${(historyTx || []).length} transaction${(historyTx || []).length > 1 ? "s" : ""}`}
                </Text>
              </View>
              <TouchableOpacity onPress={closeUserHistory} style={styles.historyClose} testID="admin-wd-history-close">
                <Ionicons name="close" size={22} color="#fff" />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 500 }} contentContainerStyle={{ padding: 12 }}>
              {historyLoading ? (
                <Text style={styles.historyEmpty}>Chargement en cours…</Text>
              ) : (historyTx || []).length === 0 ? (
                <Text style={styles.historyEmpty}>Aucune transaction pour cet utilisateur.</Text>
              ) : (
                (historyTx || []).map((t: any, idx: number) => (
                  <View key={idx} style={styles.historyRow} testID={`admin-wd-history-row-${idx}`}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.historyRowLabel}>{t.label || t.type}</Text>
                      <Text style={styles.historyRowMeta}>
                        {formatDateTime(t.date)}
                        {t.status ? ` • ${t.status}` : ""}
                        {t.from_username ? ` • de @${t.from_username}` : ""}
                      </Text>
                    </View>
                    <Text
                      style={[
                        styles.historyRowAmount,
                        { color: (t.amount || 0) >= 0 ? theme.colors.success : theme.colors.danger },
                      ]}
                    >
                      {(t.amount || 0) >= 0 ? "+ " : ""}
                      {formatFCFA(t.amount || 0)}
                    </Text>
                  </View>
                ))
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function SubTabs({
  tabs, active, onChange, testIdPrefix,
}: {
  tabs: { key: string; label: string; color: string; count?: number }[];
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
            {typeof t.count === "number" && (
              <View style={[styles.subTabBadge, on ? { backgroundColor: "rgba(255,255,255,0.25)" } : { backgroundColor: theme.colors.surfaceSecondary }]}>
                <Text style={[styles.subTabBadgeT, on && { color: "#fff" }]}>{t.count}</Text>
              </View>
            )}
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
    <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, backgroundColor: cfg.bg }}>
      <Text style={{ color: cfg.color, fontWeight: "700", fontSize: 11 }}>{cfg.label}</Text>
    </View>
  );
}

function MethodBadge({ method, stuck }: { method?: string; stuck?: boolean }) {
  const cfg: any = ({
    automatic: { bg: "#DBEAFE", color: "#1E40AF", icon: "flash", label: "AUTO" },
    manual: { bg: "#D1FAE5", color: "#065F46", icon: "card", label: "MANUEL" },
    crypto: { bg: "#FEF3C7", color: "#92400E", icon: "logo-bitcoin", label: "CRYPTO" },
    crypto_auto: { bg: "#FEF3C7", color: "#92400E", icon: "logo-bitcoin", label: "CRYPTO AUTO" },
  } as any)[method || "manual"] || { bg: "#E5E7EB", color: "#374151", icon: "help-circle", label: (method || "—").toUpperCase() };
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, backgroundColor: cfg.bg }}>
      <Ionicons name={cfg.icon as any} size={11} color={cfg.color} />
      <Text style={{ color: cfg.color, fontWeight: "800", fontSize: 10, letterSpacing: 0.5 }}>{cfg.label}</Text>
      {stuck ? (
        <Text style={{ color: theme.colors.danger, fontWeight: "800", fontSize: 9, marginLeft: 2 }}>🚨</Text>
      ) : null}
    </View>
  );
}

function KvRow({ k, v, copyable = false, testID }: { k: string; v: string; copyable?: boolean; testID?: string }) {
  const doCopy = () => {
    if (!v || v === "—") return;
    if (typeof navigator !== "undefined" && (navigator as any).clipboard) {
      (navigator as any).clipboard.writeText(v);
      if (typeof window !== "undefined") window.alert(`✅ Copié : ${v}`);
    }
  };
  return (
    <View style={styles.kvRow}>
      <Text style={styles.kvK}>{k}</Text>
      <View style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
        <Text style={styles.kvV} numberOfLines={2}>{v}</Text>
        {copyable && v && v !== "—" ? (
          <TouchableOpacity
            onPress={doCopy}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={{
              paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8,
              backgroundColor: theme.colors.primary + "15",
              flexDirection: "row", alignItems: "center", gap: 4,
            }}
            testID={testID}
          >
            <Ionicons name="copy-outline" size={13} color={theme.colors.primary} />
            <Text style={{ color: theme.colors.primary, fontSize: 10, fontWeight: "800", letterSpacing: 0.3 }}>COPIER</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: { padding: 16, paddingTop: 24, paddingBottom: 16 },
  title: { color: "#fff", fontSize: 18, fontWeight: "700", letterSpacing: -0.3 },
  sub: { color: "#C7D9FF", fontSize: 12, marginTop: 2 },
  logoutBtn: { width: 40, height: 40, borderRadius: 24, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center" },
  backBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center" },
  tabs: { padding: 12, gap: 6 },
  tab: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: "#fff", borderRadius: 24, borderWidth: 1, borderColor: theme.colors.border },
  tabOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  tabT: { fontWeight: "700", color: theme.colors.primary, fontSize: 12 },

  statGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  statCard: { width: "47%", backgroundColor: "#fff", padding: 14, borderRadius: 20, ...theme.shadow.card },
  statIcon: { width: 36, height: 36, borderRadius: 12, alignItems: "center", justifyContent: "center", marginBottom: 8 },
  statLbl: { color: theme.colors.textSecondary, fontSize: 11 },
  statVal: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 20, marginTop: 2, letterSpacing: -0.3 },

  searchRow: { flexDirection: "row", gap: 8, marginBottom: 12 },
  searchBox: { flex: 1, backgroundColor: "#fff", borderRadius: 14, borderWidth: 1, borderColor: theme.colors.border, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10 },
  searchI: { flex: 1, paddingVertical: 10, color: theme.colors.textPrimary },
  refreshBtn: { width: 44, height: 44, borderRadius: 14, backgroundColor: theme.colors.primary, alignItems: "center", justifyContent: "center" },

  avatar: { width: 32, height: 32, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  userName: { fontWeight: "700", color: theme.colors.textPrimary },
  userMeta: { color: theme.colors.textSecondary, fontSize: 12, marginTop: 1 },
  actRow: { flexDirection: "row", gap: 8, marginTop: 10, flexWrap: "wrap" },
  actBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, backgroundColor: theme.colors.danger },
  actT: { color: "#fff", fontWeight: "700", fontSize: 12 },

  empty: { textAlign: "center", color: theme.colors.textSecondary, padding: 24 },
  section: { fontWeight: "700", color: theme.colors.textPrimary, marginBottom: 12, fontSize: 15, letterSpacing: -0.1 },
  lbl: { color: theme.colors.textPrimary, fontWeight: "600", marginBottom: 6 },
  priChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: theme.colors.surfaceSecondary, borderWidth: 1, borderColor: theme.colors.border },
  priChipOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  priChipT: { fontWeight: "700", color: theme.colors.textPrimary, fontSize: 12, textTransform: "capitalize" },
  kvBox: { backgroundColor: theme.colors.surfaceSecondary, padding: 10, borderRadius: 12, gap: 4 },
  kvRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  kvK: { color: theme.colors.textSecondary, fontSize: 12, flexShrink: 0 },
  kvV: { color: theme.colors.textPrimary, fontWeight: "600", fontSize: 12, flex: 1, textAlign: "right" },
  tag: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8 },
  tagT: { fontSize: 9, fontWeight: "800" },

  helperTxt: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18, marginTop: 6, marginBottom: 12 },
  input: { backgroundColor: theme.colors.surfaceSecondary, borderRadius: 10, padding: 10, color: theme.colors.textPrimary, fontSize: 13, borderWidth: 1, borderColor: theme.colors.border },
  toggleRow: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderRadius: 14, marginBottom: 14 },
  toggleOn: { backgroundColor: theme.colors.success || "#10B981" },
  toggleOff: { backgroundColor: theme.colors.surfaceSecondary, borderWidth: 1, borderColor: theme.colors.border },
  toggleTxt: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 13 },
  textarea: { backgroundColor: theme.colors.surfaceSecondary, borderRadius: 14, padding: 12, minHeight: 96, color: theme.colors.textPrimary, fontSize: 14, marginBottom: 12, textAlignVertical: "top" },

  previewBox: { padding: 16, borderRadius: 16, backgroundColor: theme.colors.surfaceSecondary, borderWidth: 1, borderColor: theme.colors.border, marginTop: 8 },
  previewTitle: { fontWeight: "700", color: theme.colors.textPrimary, fontSize: 14, marginBottom: 8, letterSpacing: -0.1 },
  previewInstr: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18 },
  previewKv: { marginTop: 10, padding: 10, backgroundColor: "#fff", borderRadius: 12 },
  previewLine: { color: theme.colors.textPrimary, fontSize: 13, marginTop: 2 },
  previewBtn: { marginTop: 12, alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14, backgroundColor: theme.colors.primary },
  previewBtnTxt: { color: "#fff", fontWeight: "800", fontSize: 12, letterSpacing: 0.4 },

  subTabsRow: { flexDirection: "row", gap: 8, marginBottom: 12, flexWrap: "wrap" },
  subTab: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1, backgroundColor: theme.colors.surfaceSecondary },
  subTabDot: { width: 8, height: 8, borderRadius: 6 },
  subTabLbl: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 12 },
  subTabBadge: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 8, minWidth: 20, alignItems: "center" },
  subTabBadgeT: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 10 },

  countryGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  countryChip: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12,
    backgroundColor: theme.colors.surfaceSecondary,
    borderWidth: 1, borderColor: theme.colors.border,
  },
  countryChipOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  countryChipTxt: { color: theme.colors.textPrimary, fontWeight: "600", fontSize: 13 },

  daysRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  dayChip: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 10, paddingVertical: 7, borderRadius: 22,
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
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 22,
    backgroundColor: theme.colors.danger,
  },
  stuckBtnTxt: { color: "#fff", fontWeight: "700", fontSize: 12 },

  contentMgmtCta: {
    flexDirection: "row", alignItems: "center", gap: 12,
    marginTop: 12, padding: 14, borderRadius: 20,
    backgroundColor: "#FF7A00",
    ...theme.shadow.card,
  },
  contentMgmtIcon: {
    width: 44, height: 44, borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignItems: "center", justifyContent: "center",
  },
  contentMgmtTitle: { color: "#fff", fontWeight: "800", fontSize: 15 },
  contentMgmtSub: { color: "rgba(255,255,255,0.85)", fontSize: 11, marginTop: 2 },

  historyOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: 16,
  },
  historyCard: {
    width: "100%",
    maxWidth: 640,
    backgroundColor: "#fff",
    borderRadius: 16,
    overflow: "hidden",
    shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 20, shadowOffset: { width: 0, height: 12 },
    elevation: 20,
  },
  historyHead: {
    flexDirection: "row", alignItems: "center", gap: 10,
    padding: 14, backgroundColor: theme.colors.primary,
  },
  historyTitle: { color: "#fff", fontWeight: "900", fontSize: 15 },
  historySub: { color: "rgba(255,255,255,0.85)", fontSize: 11, marginTop: 2 },
  historyClose: {
    width: 32, height: 32, borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignItems: "center", justifyContent: "center",
  },
  historyEmpty: { color: theme.colors.textSecondary, textAlign: "center", padding: 20, fontStyle: "italic" },
  historyRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.border,
  },
  historyRowLabel: { fontSize: 13, fontWeight: "800", color: theme.colors.textPrimary },
  historyRowMeta: { fontSize: 11, color: theme.colors.textSecondary, marginTop: 2 },
  historyRowAmount: { fontSize: 13, fontWeight: "900" },
});


/**
 * SolesPaySettingsCard — ⚙️ Réglages → SolesPay
 *
 * Fully ISOLATED admin surface for SoleasPay. Handles: master enable,
 * public/secret keys, notification hash (verif-hash), HMAC webhook secret,
 * per-country pay-in toggles, live connection test, P-Out master.
 * Never touches Ashtec / BizTransPay config.
 */
function SolesPaySettingsCard() {
  const [cfg, setCfg] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<any>(null);
  const [testing, setTesting] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [pk, setPk] = useState(""); const [sk, setSk] = useState("");
  const [wh, setWh] = useState(""); const [ws, setWs] = useState("");

  const load = async () => {
    try { setCfg(await api.get<any>("/admin/soleaspay/config")); } catch {}
  };
  useEffect(() => { load(); }, []);

  const patch = async (body: any) => {
    setSaving(true);
    try {
      const r = await api.put<any>("/admin/soleaspay/config", body);
      setCfg(r);
      setPk(""); setSk(""); setWh(""); setWs("");
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert("❌ " + (e?.detail || "Impossible d'enregistrer."));
    } finally { setSaving(false); }
  };

  const toggleCountry = async (code: string, next: boolean) => {
    // Build a full matrix from the current resolved list, flip only `code`.
    const matrix: Record<string, boolean> = {};
    (cfg?.countries || []).forEach((c: any) => {
      matrix[c.code] = c.code === code ? next : c.enabled;
    });
    try {
      await api.put<any>("/admin/soleaspay/country-matrix", { matrix });
      load();
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert("❌ " + (e?.detail || "Erreur matrice pays."));
    }
  };

  const runTest = async () => {
    setTesting(true);
    try { setTest(await api.post<any>("/admin/soleaspay/test", {})); }
    catch (e: any) { setTest({ ok: false, detail: e?.detail || "Erreur réseau." }); }
    finally { setTesting(false); }
  };

  if (!cfg) return (
    <Card style={{ padding: 12 }}><ActivityIndicator color={theme.colors.primary} /></Card>
  );

  const enabled = !!cfg.enabled;
  return (
    <Card style={{ marginBottom: 12, borderWidth: 2, borderColor: enabled ? "#10B981" : theme.colors.border }} testID="solespay-settings-card">
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <Ionicons name="settings" size={22} color="#10B981" />
        <Text style={styles.section}>⚙️ Réglages → SolesPay</Text>
      </View>
      <Text style={styles.helperTxt}>
        Configuration isolée de la passerelle SolesPay. Ces réglages n'affectent aucune autre passerelle.
      </Text>

      {/* Master switch */}
      <TouchableOpacity
        onPress={() => patch({ enabled: !enabled })}
        disabled={saving}
        style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 12, borderRadius: 12, backgroundColor: enabled ? "#D1FAE5" : "#FEE2E2", marginTop: 10 }}
        testID="solespay-master-toggle"
      >
        <View>
          <Text style={{ fontWeight: "900", color: enabled ? "#065F46" : "#991B1B" }}>
            SolesPay {enabled ? "🟢 Activé" : "🔴 Désactivé"}
          </Text>
          <Text style={{ fontSize: 11, color: enabled ? "#065F46" : "#991B1B", marginTop: 2 }}>
            {enabled
              ? "Nouvelles transactions autorisées via SolesPay."
              : "Aucune nouvelle transaction ne sera envoyée à SolesPay."}
          </Text>
        </View>
        <Ionicons name={enabled ? "toggle" : "toggle-outline"} size={38} color={enabled ? "#10B981" : "#9CA3AF"} />
      </TouchableOpacity>

      {/* API credentials */}
      <View style={{ marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <Text style={{ fontSize: 13, fontWeight: "800", color: theme.colors.textPrimary }}>🔑 Informations API</Text>
          <TouchableOpacity onPress={() => setShowKeys((v) => !v)} testID="solespay-toggle-keys">
            <Text style={{ color: theme.colors.primary, fontSize: 12, fontWeight: "700" }}>
              {showKeys ? "Masquer" : "Modifier"}
            </Text>
          </TouchableOpacity>
        </View>
        <Text style={{ fontSize: 12, color: theme.colors.textSecondary, marginTop: 4 }}>Clé publique : <Text style={{ fontFamily: "monospace", color: theme.colors.textPrimary }}>{cfg.public_key || "— non configurée —"}</Text></Text>
        <Text style={{ fontSize: 12, color: theme.colors.textSecondary, marginTop: 4 }}>Clé secrète : <Text style={{ fontFamily: "monospace", color: theme.colors.textPrimary }}>{cfg.secret_key || "— non configurée —"}</Text></Text>
        <Text style={{ fontSize: 12, color: theme.colors.textSecondary, marginTop: 4 }}>Hash de notification : <Text style={{ fontFamily: "monospace", color: theme.colors.textPrimary }}>{cfg.webhook_hash || "— non configuré —"}</Text></Text>
        <Text style={{ fontSize: 12, color: theme.colors.textSecondary, marginTop: 4 }}>Secret HMAC webhook : <Text style={{ fontFamily: "monospace", color: theme.colors.textPrimary }}>{cfg.webhook_secret || "— non configuré —"}</Text></Text>
        {showKeys && (
          <View style={{ marginTop: 10, gap: 8 }}>
            <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
              <TextInput value={pk} onChangeText={setPk} placeholder="Nouvelle clé publique"
                         placeholderTextColor={theme.colors.textSecondary}
                         style={[styles.input, { flex: 1 }]} testID="solespay-input-pk" />
              <TouchableOpacity style={{ paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, backgroundColor: theme.colors.primary }} onPress={() => patch({ public_key: pk })} disabled={saving || !pk.trim()}>
                <Text style={{ color: "#fff", fontWeight: "800", fontSize: 11 }}>Enreg.</Text>
              </TouchableOpacity>
              <TouchableOpacity style={{ paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, backgroundColor: "#EF4444" }} onPress={() => patch({ public_key: "DELETE" })} disabled={saving}>
                <Text style={{ color: "#fff", fontWeight: "800", fontSize: 11 }}>✕</Text>
              </TouchableOpacity>
            </View>
            <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
              <TextInput value={sk} onChangeText={setSk} placeholder="Nouvelle clé secrète"
                         placeholderTextColor={theme.colors.textSecondary}
                         style={[styles.input, { flex: 1 }]} testID="solespay-input-sk" />
              <TouchableOpacity style={{ paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, backgroundColor: theme.colors.primary }} onPress={() => patch({ secret_key: sk })} disabled={saving || !sk.trim()}>
                <Text style={{ color: "#fff", fontWeight: "800", fontSize: 11 }}>Enreg.</Text>
              </TouchableOpacity>
              <TouchableOpacity style={{ paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, backgroundColor: "#EF4444" }} onPress={() => patch({ secret_key: "DELETE" })} disabled={saving}>
                <Text style={{ color: "#fff", fontWeight: "800", fontSize: 11 }}>✕</Text>
              </TouchableOpacity>
            </View>
            <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
              <TextInput value={wh} onChangeText={setWh} placeholder="Nouveau hash de notification"
                         placeholderTextColor={theme.colors.textSecondary}
                         style={[styles.input, { flex: 1 }]} testID="solespay-input-wh" />
              <TouchableOpacity style={{ paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, backgroundColor: theme.colors.primary }} onPress={() => patch({ webhook_hash: wh })} disabled={saving || !wh.trim()}>
                <Text style={{ color: "#fff", fontWeight: "800", fontSize: 11 }}>Enreg.</Text>
              </TouchableOpacity>
              <TouchableOpacity style={{ paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, backgroundColor: "#EF4444" }} onPress={() => patch({ webhook_hash: "DELETE" })} disabled={saving}>
                <Text style={{ color: "#fff", fontWeight: "800", fontSize: 11 }}>✕</Text>
              </TouchableOpacity>
            </View>
            <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
              <TextInput value={ws} onChangeText={setWs} placeholder="Nouveau secret HMAC (optionnel)"
                         placeholderTextColor={theme.colors.textSecondary}
                         style={[styles.input, { flex: 1 }]} testID="solespay-input-ws" />
              <TouchableOpacity style={{ paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, backgroundColor: theme.colors.primary }} onPress={() => patch({ webhook_secret: ws })} disabled={saving || !ws.trim()}>
                <Text style={{ color: "#fff", fontWeight: "800", fontSize: 11 }}>Enreg.</Text>
              </TouchableOpacity>
              <TouchableOpacity style={{ paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, backgroundColor: "#EF4444" }} onPress={() => patch({ webhook_secret: "DELETE" })} disabled={saving}>
                <Text style={{ color: "#fff", fontWeight: "800", fontSize: 11 }}>✕</Text>
              </TouchableOpacity>
            </View>
            <Text style={{ fontSize: 10, color: theme.colors.textSecondary, marginTop: 4 }}>
              Astuce : configurez soit le hash de notification (embarqué dans le webhook), soit le secret HMAC (header x-signature). Les deux sont acceptés par le vérificateur.
            </Text>
          </View>
        )}
      </View>

      {/* Live test */}
      <View style={{ marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <Text style={{ fontSize: 13, fontWeight: "800", color: theme.colors.textPrimary }}>🧪 Tester la connexion</Text>
          <TouchableOpacity onPress={runTest} disabled={testing}
            style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, backgroundColor: theme.colors.primary }}
            testID="solespay-test-btn">
            <Text style={{ color: "#fff", fontWeight: "800", fontSize: 12 }}>
              {testing ? "..." : "Tester"}
            </Text>
          </TouchableOpacity>
        </View>
        {test && (
          <View style={{ padding: 8, borderRadius: 8, backgroundColor: test.ok ? "#D1FAE5" : "#FEE2E2" }}>
            <Text style={{ fontSize: 12, fontWeight: "700", color: test.ok ? "#065F46" : "#991B1B" }}>
              {test.ok ? "✅ Connexion OK" : "❌ Échec"}
            </Text>
            <Text style={{ fontSize: 11, color: test.ok ? "#065F46" : "#991B1B", marginTop: 2 }}>
              {test.detail || test.error || "—"}
            </Text>
          </View>
        )}
      </View>

      {/* Country matrix */}
      <View style={{ marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border }} testID="solespay-country-matrix">
        <Text style={{ fontSize: 13, fontWeight: "800", color: theme.colors.textPrimary, marginBottom: 4 }}>🌍 Pays autorisés (Pay-In)</Text>
        <Text style={{ fontSize: 11, color: theme.colors.textSecondary, marginBottom: 8 }}>
          Un pays désactivé ne pourra plus recevoir de paiements via SolesPay. Le système routera automatiquement vers une autre passerelle si disponible.
        </Text>
        {(cfg.countries || []).map((c: any) => (
          <View key={c.code} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 8, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, fontWeight: "700", color: theme.colors.textPrimary }}>{c.code}</Text>
              <Text style={{ fontSize: 10, color: theme.colors.textSecondary }}>
                {c.operators.map((o: any) => o.label).join(" · ")}
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => toggleCountry(c.code, !c.enabled)}
              style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12, backgroundColor: c.enabled ? "#D1FAE5" : "#FEE2E2" }}
              testID={`solespay-country-${c.code}`}
            >
              <Text style={{ color: c.enabled ? "#065F46" : "#991B1B", fontWeight: "800", fontSize: 11 }}>
                {c.enabled ? "🟢 Activé" : "🔴 Désactivé"}
              </Text>
            </TouchableOpacity>
          </View>
        ))}
      </View>

      {/* P-Out toggle (kept in same section per doc: SolesPay owns both P-In and P-Out) */}
      <View style={{ marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: "#FEF3C7", borderWidth: 1, borderColor: "#F59E0B" }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View style={{ flex: 1, paddingRight: 10 }}>
            <Text style={{ fontSize: 13, fontWeight: "800", color: "#92400E" }}>💸 P-Out (Retraits auto)</Text>
            <Text style={{ fontSize: 11, color: "#78350F", marginTop: 2 }}>
              Envoie automatiquement les retraits Mobile Money via SolesPay. Sur échec, fallback silencieux.
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => patch({ pout_enabled: !cfg.pout_enabled })}
            disabled={saving}
            style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: cfg.pout_enabled ? "#10B981" : "#9CA3AF" }}
            testID="solespay-pout-toggle"
          >
            <Text style={{ color: "#FFF", fontWeight: "800", fontSize: 12 }}>
              {cfg.pout_enabled ? "🟢 ACTIVÉ" : "⚫ OFF"}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Card>
  );
}


function PaymentGatewaysCard() {
  const [cfg, setCfg] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [secretInput, setSecretInput] = useState("");
  const [health, setHealth] = useState<any>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  // SoleasPay live connection test + editable per-country matrix.
  const [soleasTest, setSoleasTest] = useState<any>(null);
  const [soleasTesting, setSoleasTesting] = useState(false);
  const [matrix, setMatrix] = useState<any>({});
  const [poutEnabled, setPoutEnabled] = useState<boolean>(false);
  const [poutMatrix, setPoutMatrix] = useState<Record<string, boolean>>({});
  const [poutSaving, setPoutSaving] = useState(false);

  const runSoleasTest = async () => {
    setSoleasTesting(true);
    try {
      const r = await api.post<any>("/admin/payment-gateways/soleaspay/test", {});
      setSoleasTest(r);
    } catch (e: any) {
      setSoleasTest({ ok: false, detail: e?.detail || "Erreur réseau." });
    } finally { setSoleasTesting(false); }
  };
  const toggleCountry = async (gw: "soleas" | "ashtec", code: string) => {
    const cur = matrix[gw] || {};
    const next = { ...matrix, [gw]: { ...cur, [code]: !cur[code] } };
    setMatrix(next);
    try { await api.put("/admin/payment-gateways/country-matrix", { country_matrix: next }); }
    catch { /* silent */ }
  };

  const load = async () => {
    try {
      const r = await api.get<any>("/admin/payment-gateways");
      setCfg(r);
      setMatrix(r.country_matrix || {});
      setPoutEnabled(!!r.soleaspay_pout_enabled);
      setPoutMatrix(r.soleaspay_pout_country_matrix || {});
    } catch {}
  };

  const togglePoutMaster = async () => {
    setPoutSaving(true);
    const next = !poutEnabled;
    setPoutEnabled(next);
    try {
      await api.put<any>("/admin/payment-gateways", { soleaspay_pout_enabled: next });
    } catch {
      setPoutEnabled(!next);
      if (typeof window !== "undefined") window.alert("❌ Impossible d'enregistrer.");
    } finally { setPoutSaving(false); }
  };

  const togglePoutCountry = async (code: string) => {
    const cur = poutMatrix[code];
    const next = { ...poutMatrix, [code]: cur === false ? true : false };
    setPoutMatrix(next);
    try {
      await api.put<any>("/admin/payment-gateways/soleaspay/pout-country-matrix", { matrix: next });
    } catch { /* silent */ }
  };

  const runHealth = async () => {
    setHealthLoading(true);
    try {
      const r = await api.get<any>("/admin/payments/ashtec/health");
      setHealth(r);
    } catch (e: any) {
      setHealth({ ok: false, step: "network", error: e?.detail || "Impossible de contacter le serveur." });
    } finally {
      setHealthLoading(false);
    }
  };

  useEffect(() => { load(); runHealth(); }, []);

  const save = async (patch: any) => {
    setSaving(true);
    try {
      const r = await api.put<any>("/admin/payment-gateways", patch);
      setCfg(r);
      setKeyInput("");
      if (typeof window !== "undefined") window.alert("✅ Configuration sauvegardée");
      // Immediately re-run health so admin sees the effect.
      runHealth();
    } catch (e: any) {
      const msg = e?.detail ? (typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail)) : "Échec";
      if (typeof window !== "undefined") window.alert(`❌ ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  if (!cfg) {
    return (
      <Card style={{ marginTop: 12 }}>
        <Text style={{ color: theme.colors.textSecondary }}>Chargement des passerelles…</Text>
      </Card>
    );
  }

  const renderGw = (gwKey: "soleas" | "ashtec") => {
    const meta = cfg[gwKey] || {};
    const isActive = cfg.active === gwKey;
    const label =
      gwKey === "soleas"  ? "🔹 Soles Pay"
                          : "🔹 AshtecPay (Htech Pay)";
    const enabledKey =
      gwKey === "soleas"  ? "soleas_enabled"
                          : "ashtec_enabled";
    return (
      <View key={gwKey} style={{ padding: 12, borderRadius: 12, backgroundColor: theme.colors.surface, borderWidth: 2, borderColor: isActive ? theme.colors.success : theme.colors.border, marginBottom: 10 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={{ fontSize: 15, fontWeight: "800", color: theme.colors.textPrimary }}>{label}</Text>
          {isActive ? (
            <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, backgroundColor: theme.colors.success }}>
              <Text style={{ color: "#fff", fontWeight: "800", fontSize: 10 }}>✓ PASSERELLE ACTIVE</Text>
            </View>
          ) : null}
        </View>

        <View style={{ flexDirection: "row", gap: 6, marginTop: 8 }}>
          <View style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10, backgroundColor: meta.enabled ? "#D1FAE5" : "#FEE2E2" }}>
            <Text style={{ color: meta.enabled ? "#065F46" : "#991B1B", fontWeight: "700", fontSize: 11 }}>
              {meta.enabled ? "🟢 Activé" : "🔴 Désactivé"}
            </Text>
          </View>
          <View style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10, backgroundColor: meta.configured ? "#DBEAFE" : "#FEF3C7" }}>
            <Text style={{ color: meta.configured ? "#1E40AF" : "#92400E", fontWeight: "700", fontSize: 11 }}>
              {meta.configured ? "⚙️ Configuré" : "⚙️ À configurer"}
            </Text>
          </View>
        </View>

        {gwKey === "ashtec" ? (
          <View style={{ marginTop: 10 }}>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 11, marginBottom: 4 }}>
              Clé API actuelle : <Text style={{ fontFamily: "monospace", color: theme.colors.textPrimary }}>{meta.api_key_masked || "—"}</Text>
            </Text>
            <TextInput
              style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, padding: 8, color: theme.colors.textPrimary, fontSize: 12 }}
              placeholder="Nouvelle clé API (ak_…) — laisser vide pour conserver"
              placeholderTextColor={theme.colors.textSecondary}
              value={keyInput}
              onChangeText={setKeyInput}
              autoCapitalize="none"
              testID="ashtec-key-input"
            />
            {keyInput ? (
              <TouchableOpacity
                style={{ marginTop: 6, padding: 8, borderRadius: 10, backgroundColor: theme.colors.primary, alignItems: "center" }}
                onPress={() => save({ ashtec_api_key: keyInput })}
                disabled={saving}
                testID="ashtec-key-save"
              >
                <Text style={{ color: "#fff", fontWeight: "800", fontSize: 12 }}>💾 Enregistrer la clé</Text>
              </TouchableOpacity>
            ) : null}

            {/* Ashtech Pay Direct v1.2 — HMAC-SHA256 webhook secret */}
            <View style={{ marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: theme.colors.border }}>
              <Text style={{ color: theme.colors.textSecondary, fontSize: 11, marginBottom: 4 }}>
                Secret webhook (HMAC-SHA256) : <Text style={{ fontFamily: "monospace", color: theme.colors.textPrimary }}>
                  {meta.webhook_secret_set ? (meta.webhook_secret_masked || "•••• configuré ••••") : "— non configuré —"}
                </Text>
              </Text>
              <TextInput
                style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, padding: 8, color: theme.colors.textPrimary, fontSize: 12 }}
                placeholder="whsec_… — laisser vide pour conserver"
                placeholderTextColor={theme.colors.textSecondary}
                value={secretInput}
                onChangeText={setSecretInput}
                autoCapitalize="none"
                secureTextEntry
                testID="ashtec-webhook-secret-input"
              />
              <View style={{ flexDirection: "row", gap: 6, marginTop: 6 }}>
                {secretInput ? (
                  <TouchableOpacity
                    style={{ flex: 1, padding: 8, borderRadius: 10, backgroundColor: theme.colors.primary, alignItems: "center" }}
                    onPress={() => { save({ ashtec_webhook_secret: secretInput }); setSecretInput(""); }}
                    disabled={saving}
                    testID="ashtec-webhook-secret-save"
                  >
                    <Text style={{ color: "#fff", fontWeight: "800", fontSize: 12 }}>💾 Enregistrer le secret</Text>
                  </TouchableOpacity>
                ) : null}
                {meta.webhook_secret_set ? (
                  <TouchableOpacity
                    style={{ flex: 1, padding: 8, borderRadius: 10, backgroundColor: theme.colors.danger, alignItems: "center" }}
                    onPress={() => save({ ashtec_webhook_secret: "DELETE" })}
                    disabled={saving}
                    testID="ashtec-webhook-secret-clear"
                  >
                    <Text style={{ color: "#fff", fontWeight: "800", fontSize: 12 }}>🗑️ Supprimer</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
              <Text style={{ color: theme.colors.textSecondary, fontSize: 10, marginTop: 4, fontStyle: "italic" }}>
                Copiez le secret exact fourni par Ashtech Pay dans votre dashboard marchand. Sans ce secret, les webhooks ne seront pas authentifiés.
              </Text>
            </View>
          </View>
        ) : null}

        <View style={{ flexDirection: "row", gap: 6, marginTop: 10 }}>
          <TouchableOpacity
            style={{ flex: 1, padding: 8, borderRadius: 10, backgroundColor: meta.enabled ? theme.colors.danger : theme.colors.success, alignItems: "center" }}
            onPress={() => save({ [enabledKey]: !meta.enabled })}
            disabled={saving}
            testID={`gw-toggle-${gwKey}`}
          >
            <Text style={{ color: "#fff", fontWeight: "800", fontSize: 12 }}>
              {meta.enabled ? "🔴 Désactiver" : "🟢 Activer"}
            </Text>
          </TouchableOpacity>
          {!isActive && meta.enabled ? (
            <TouchableOpacity
              style={{ flex: 1, padding: 8, borderRadius: 10, backgroundColor: theme.colors.primary, alignItems: "center" }}
              onPress={() => save({ active: gwKey })}
              disabled={saving}
              testID={`gw-set-active-${gwKey}`}
            >
              <Text style={{ color: "#fff", fontWeight: "800", fontSize: 12 }}>⭐ Rendre active</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    );
  };

  return (
    <Card style={{ marginTop: 12 }} testID="payment-gateways-card">
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Ionicons name="card" size={22} color={theme.colors.primary} />
        <Text style={{ fontSize: 16, fontWeight: "800", color: theme.colors.textPrimary }}>💳 Gestion des Passerelles de Paiement</Text>
      </View>
      <Text style={{ color: theme.colors.textSecondary, fontSize: 11, marginTop: 4, marginBottom: 12 }}>
        L'utilisateur ne voit que "Paiement Automatique". Le système utilise la passerelle marquée comme ACTIVE ci-dessous.
      </Text>

      {/* Auto-diagnostic banner — surfaces the "AshtecPay a refusé la
          requête" root cause without the admin having to open the
          separate /(admin)/ashtec-diag screen. */}
      {health && (
        <View
          style={{
            flexDirection: "row", alignItems: "flex-start", gap: 10,
            padding: 12, borderRadius: 12, marginBottom: 12,
            borderWidth: 2,
            borderColor: health.ok ? theme.colors.success : theme.colors.danger,
            backgroundColor: health.ok ? "#D1FAE5" : "#FEE2E2",
          }}
          testID="ashtec-health-banner"
        >
          <Ionicons
            name={health.ok ? "checkmark-circle" : "alert-circle"}
            size={24}
            color={health.ok ? "#065F46" : "#991B1B"}
          />
          <View style={{ flex: 1 }}>
            <Text style={{ fontWeight: "800", fontSize: 13, color: health.ok ? "#065F46" : "#991B1B" }}>
              {health.ok ? "✅ AshtecPay répond correctement" : "❌ AshtecPay ne répond pas correctement"}
            </Text>
            <Text style={{ fontSize: 11, color: health.ok ? "#065F46" : "#991B1B", marginTop: 4, lineHeight: 15 }}>
              {health.conclusion || health.error || "Diagnostic indisponible."}
            </Text>
            {!!health.api_key_source && (
              <Text style={{ fontSize: 10, color: health.ok ? "#065F46" : "#991B1B", marginTop: 4 }}>
                Source de la clé : <Text style={{ fontWeight: "800" }}>
                  {health.api_key_source === "env" ? "variable d'environnement (env)" : "base de données (fallback)"}
                </Text>
                {health.api_key_prefix ? `  •  Préfixe : ${health.api_key_prefix}` : ""}
              </Text>
            )}
          </View>
          <TouchableOpacity
            onPress={runHealth}
            disabled={healthLoading}
            style={{ paddingHorizontal: 8, paddingVertical: 6, borderRadius: 10, backgroundColor: "rgba(255,255,255,0.6)" }}
            testID="ashtec-health-refresh"
          >
            <Ionicons name={healthLoading ? "reload" : "refresh"} size={16} color="#111827" />
          </TouchableOpacity>
        </View>
      )}

      {/* Prominent rescue prompt — shows only when there's NO usable key.
          Guides the admin straight to the input below without needing to
          understand env vs DB fallback. */}
      {health && !health.ok && (health.step === "config" || health.api_key_source === "db" || !health.api_key_source) && (
        <View style={{ padding: 12, backgroundColor: "#FEF3C7", borderRadius: 12, borderWidth: 2, borderStyle: "dashed", borderColor: "#F59E0B", marginBottom: 12 }} testID="ashtec-rescue-callout">
          <Text style={{ fontWeight: "800", fontSize: 12, color: "#92400E" }}>
            🔑 Solution rapide — collez votre clé Ashtech ci-dessous
          </Text>
          <Text style={{ fontSize: 11, color: "#78350F", marginTop: 4, lineHeight: 15 }}>
            La clé est probablement absente du serveur (env `ASHTECPAY_API_KEY`) après le redéploiement.
            En attendant que l'infra restaure la variable d'env, vous pouvez coller votre clé Ashtech ci-dessous.
            Le serveur l'utilisera automatiquement en fallback jusqu'à ce que la variable d'env soit re-injectée.
          </Text>
        </View>
      )}

      {renderGw("soleas")}
      {renderGw("ashtec")}

      {/* SolesPay-specific controls (test, matrix, P-Out) have been moved to
          the dedicated SolesPaySettingsCard above for true isolation. */}
    </Card>
  );
}


/**
 * PaymentProvidersRouterCard (v27k, Phase 3) — vue unifiée alimentée par le
 * PaymentProviderRouter (`/api/admin/payment-providers`).
 *
 * Affiche pour chaque prestataire :
 *   • en-tête : nom, statut, ↑/↓ priorité
 *   • capacités : dépôt automatique, retrait automatique (info uniquement)
 *   • pays imbriqués → opérateurs, chacun activable/désactivable
 */
function PaymentProvidersRouterCard() {
  const [providers, setProviders] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const load = async () => {
    try {
      const r = await api.get<any>("/admin/payment-providers");
      setProviders(r.providers || []);
    } catch { setProviders([]); }
  };
  useEffect(() => { load(); }, []);

  const bump = async (pid: string, delta: number, currentPrio: number) => {
    setLoading(true);
    try {
      await api.put<any>(`/admin/payment-providers/${pid}/priority`, { priority: Math.max(1, currentPrio + delta) });
      await load();
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert("Erreur: " + (e?.detail || e?.message));
    } finally { setLoading(false); }
  };

  const toggleCountry = async (pid: string, cc: string, next: boolean) => {
    setLoading(true);
    try {
      await api.put<any>(`/admin/payment-providers/${pid}/countries/${cc}`, { enabled: next });
      await load();
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert("Erreur: " + (e?.detail || e?.message));
    } finally { setLoading(false); }
  };

  const toggleOp = async (pid: string, cc: string, code: string, next: boolean) => {
    setLoading(true);
    try {
      await api.put<any>(`/admin/payment-providers/${pid}/countries/${cc}/operators/${encodeURIComponent(code)}`, { enabled: next });
      await load();
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert("Erreur: " + (e?.detail || e?.message));
    } finally { setLoading(false); }
  };

  if (providers === null) {
    return <Card style={{ padding: 12 }}><ActivityIndicator color={theme.colors.primary} /></Card>;
  }

  return (
    <View testID="providers-router-card">
      {providers.map((p, idx) => {
        const isActive = p.status === "active";
        const isExpanded = expanded[p.id] !== false; // default true
        return (
          <Card key={p.id} style={{ marginBottom: 12, borderWidth: 2, borderColor: isActive ? "#2563EB" : theme.colors.border, padding: 0, overflow: "hidden" }}>
            {/* Header */}
            <TouchableOpacity
              onPress={() => setExpanded({ ...expanded, [p.id]: !isExpanded })}
              style={{ padding: 12, backgroundColor: isActive ? "#DBEAFE" : "#FEE2E2", flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
              testID={`provider-${p.id}-header`}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 15, fontWeight: "900", color: isActive ? "#1E3A8A" : "#991B1B" }}>
                  {isActive ? "🟢" : "🔴"} {p.name}
                  <Text style={{ fontSize: 11, fontWeight: "600" }}>  •  Priorité {p.priority}</Text>
                </Text>
                <Text style={{ fontSize: 11, color: isActive ? "#1E3A8A" : "#991B1B", marginTop: 3 }}>
                  {p.type === "crypto" ? "Crypto" : "Mobile Money"} • Dépôt {p.auto_deposit ? "✅" : "❌"} • Retrait {p.auto_withdrawal ? "✅" : "❌"} • {p.countries?.length || 0} pays
                </Text>
              </View>
              <View style={{ flexDirection: "row", gap: 4, alignItems: "center" }}>
                <TouchableOpacity
                  onPress={(e: any) => { e?.stopPropagation?.(); bump(p.id, -1, p.priority); }}
                  disabled={loading || p.priority <= 1}
                  style={{ padding: 6, borderRadius: 6, backgroundColor: p.priority <= 1 ? "#E5E7EB" : "#2563EB" }}
                  testID={`provider-${p.id}-prio-up`}
                >
                  <Ionicons name="chevron-up" size={16} color={p.priority <= 1 ? "#9CA3AF" : "#fff"} />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={(e: any) => { e?.stopPropagation?.(); bump(p.id, +1, p.priority); }}
                  disabled={loading}
                  style={{ padding: 6, borderRadius: 6, backgroundColor: "#2563EB" }}
                  testID={`provider-${p.id}-prio-down`}
                >
                  <Ionicons name="chevron-down" size={16} color="#fff" />
                </TouchableOpacity>
                <Ionicons name={isExpanded ? "chevron-up" : "chevron-down"} size={20} color={isActive ? "#1E3A8A" : "#991B1B"} style={{ marginLeft: 6 }} />
              </View>
            </TouchableOpacity>

            {isExpanded && (
              <View style={{ padding: 10 }}>
                {(!p.countries || p.countries.length === 0) && (
                  <Text style={{ fontSize: 11, color: theme.colors.textSecondary, fontStyle: "italic" }}>
                    Aucun pays configuré pour ce prestataire.
                  </Text>
                )}
                {(p.countries || []).map((c: any) => {
                  const cActive = c.status === "active";
                  const isManual = (c.mode || "automatic") === "manual";
                  return (
                    <View key={`${p.id}-${c.country_code}`} style={{ marginBottom: 8, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, overflow: "hidden" }}>
                      <View style={{ flexDirection: "row", backgroundColor: cActive ? "#DCFCE7" : "#FEE2E2" }}>
                        <TouchableOpacity
                          onPress={() => toggleCountry(p.id, c.country_code, !cActive)}
                          disabled={loading}
                          style={{ flex: 1, padding: 8, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
                          testID={`provider-${p.id}-country-${c.country_code}`}
                        >
                          <Text style={{ fontWeight: "800", color: cActive ? "#065F46" : "#991B1B", fontSize: 12 }}>
                            {c.country_code === "*" ? "🌍 Universel" : `🌍 ${c.country_code}`}  •  {c.currency}
                          </Text>
                          <Text style={{ fontSize: 11, fontWeight: "700", color: cActive ? "#065F46" : "#991B1B" }}>
                            {cActive ? "🟢 Activé" : "🔴 Désactivé"}
                          </Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={async () => {
                            const next = isManual ? "automatic" : "manual";
                            setLoading(true);
                            try {
                              await api.put<any>(`/admin/payment-providers/${p.id}/countries/${c.country_code}/mode`, { mode: next });
                              await load();
                            } catch (e: any) {
                              if (typeof window !== "undefined") window.alert("Erreur: " + (e?.detail || e?.message));
                            } finally { setLoading(false); }
                          }}
                          disabled={loading}
                          style={{ paddingHorizontal: 10, justifyContent: "center", backgroundColor: isManual ? "#FDE68A" : "#BFDBFE" }}
                          testID={`provider-${p.id}-mode-${c.country_code}`}
                        >
                          <Text style={{ fontSize: 10, fontWeight: "900", color: isManual ? "#92400E" : "#1E3A8A" }}>
                            {isManual ? "✋ MANUEL" : "⚡ AUTO"}
                          </Text>
                        </TouchableOpacity>
                      </View>
                      <View style={{ padding: 6, backgroundColor: theme.colors.surface }}>
                        {(c.operators || []).map((o: any) => {
                          const oActive = o.status === "active";
                          return (
                            <TouchableOpacity
                              key={`${p.id}-${c.country_code}-${o.operator_code}`}
                              onPress={() => toggleOp(p.id, c.country_code, o.operator_code, !oActive)}
                              disabled={loading}
                              style={{ padding: 6, borderRadius: 6, backgroundColor: oActive ? "#D1FAE5" : "#FEF3C7", flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}
                              testID={`provider-${p.id}-op-${c.country_code}-${o.operator_code}`}
                            >
                              <View>
                                <Text style={{ fontSize: 11, fontWeight: "700", color: oActive ? "#065F46" : "#92400E" }}>
                                  └─ {o.operator_label || o.operator_code}
                                </Text>
                                <Text style={{ fontSize: 9, color: oActive ? "#047857" : "#B45309", fontFamily: "monospace" }}>
                                  {o.operator_code}
                                </Text>
                              </View>
                              <Ionicons name={oActive ? "checkmark-circle" : "close-circle-outline"} size={20} color={oActive ? "#10B981" : "#F59E0B"} />
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
          </Card>
        );
      })}
    </View>
  );
}


/**
 * PaymentRouterLogsCard (v27k) — visualise les 20 dernières décisions
 * du PaymentProviderRouter pour audit rapide.
 */
function PaymentRouterLogsCard() {
  const [logs, setLogs] = useState<any[] | null>(null);
  const [expanded, setExpanded] = useState(false);

  const load = async () => {
    try {
      const r = await api.get<any>("/admin/payment-router/logs?limit=20");
      setLogs(r.items || []);
    } catch { setLogs([]); }
  };
  useEffect(() => { if (expanded && logs === null) load(); }, [expanded]);

  return (
    <Card style={{ marginTop: 6 }}>
      <TouchableOpacity
        onPress={() => setExpanded(!expanded)}
        style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
        testID="router-logs-toggle"
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Ionicons name="analytics" size={20} color={theme.colors.primary} />
          <Text style={styles.section}>📊 Journal du router (20 dernières décisions)</Text>
        </View>
        <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={20} color={theme.colors.textSecondary} />
      </TouchableOpacity>
      {expanded && (
        <View style={{ marginTop: 10 }}>
          <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
            <TouchableOpacity onPress={load} style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, backgroundColor: theme.colors.primary }}>
              <Text style={{ color: "#fff", fontSize: 11, fontWeight: "700" }}>🔄 Rafraîchir</Text>
            </TouchableOpacity>
          </View>
          {logs === null && <ActivityIndicator color={theme.colors.primary} />}
          {logs !== null && logs.length === 0 && (
            <Text style={{ fontSize: 11, color: theme.colors.textSecondary, fontStyle: "italic" }}>
              Aucune décision de routage enregistrée pour le moment.
            </Text>
          )}
          {(logs || []).map((l: any, i: number) => (
            <View key={l.id || i} style={{ padding: 8, borderRadius: 8, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, marginBottom: 6 }}>
              <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.textPrimary }}>
                {String(l.created_at || "").slice(0, 19).replace("T", " ")} • {l.kind} • {l.country}
                {l.operator ? ` / ${l.operator}` : ""}
              </Text>
              <Text style={{ fontSize: 11, marginTop: 2, color: l.selected_provider ? "#065F46" : "#991B1B" }}>
                → {l.selected_provider || "aucun prestataire disponible"}
              </Text>
              {(l.attempts || []).length > 1 && (
                <Text style={{ fontSize: 10, color: theme.colors.textSecondary, marginTop: 2, fontFamily: "monospace" }}>
                  {l.attempts.map((a: any) => `${a.provider_id}${a.ready ? "✓" : `✗(${a.reason})`}`).join(" → ")}
                </Text>
              )}
            </View>
          ))}
        </View>
      )}
    </Card>
  );
}


/**
 * BizTransPayCard — ⚙️ Prestataires → Biz-transPay (SoftPay)
 *
 * Gestion complète de la passerelle Biz-transPay (Togo uniquement) :
 *   • master switch, PayIn/PayOut toggles indépendants
 *   • clé API + secret webhook (masqués côté serveur)
 *   • toggles par pays + opérateur (TG : T-Money, Flooz Moov)
 */
function BizTransPayCard() {
  const [cfg, setCfg] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [webhookInput, setWebhookInput] = useState("");

  const load = async () => {
    try {
      const r = await api.get<any>("/admin/payment-gateways");
      setCfg(r.biztranspay || null);
    } catch { /* silent */ }
  };
  useEffect(() => { load(); }, []);

  const patch = async (body: any) => {
    setSaving(true);
    try {
      await api.put<any>("/admin/payment-gateways", body);
      await load();
      setApiKeyInput(""); setWebhookInput("");
      if (typeof window !== "undefined") window.alert("✅ Enregistré");
    } catch (e: any) {
      const msg = e?.detail ? (typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail)) : "Échec";
      if (typeof window !== "undefined") window.alert("❌ " + msg);
    } finally { setSaving(false); }
  };

  const toggleOperator = async (cc: string, code: string) => {
    if (!cfg) return;
    const current: Record<string, Record<string, boolean>> = { ...(cfg.countries || {}) };
    const inner: Record<string, boolean> = { ...(current[cc] || {}) };
    // Default true if unset — flipping means becoming false.
    const nowVal = inner[code] === false ? true : false;
    inner[code] = nowVal;
    current[cc] = inner;
    await patch({ biztranspay_countries: current });
  };

  if (!cfg) return (
    <Card style={{ padding: 12, marginBottom: 12 }}>
      <ActivityIndicator color={theme.colors.primary} />
    </Card>
  );

  const enabled = !!cfg.enabled;
  const payinEnabled = cfg.payin_enabled !== false;   // default true
  const payoutEnabled = !!cfg.payout_enabled;
  const catalog = cfg.catalog || {};

  const StatusRow = ({ label, on, onPress, hintOn, hintOff }: { label: string; on: boolean; onPress: () => void; hintOn: string; hintOff: string }) => (
    <TouchableOpacity
      onPress={onPress}
      disabled={saving}
      style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 12, borderRadius: 12, backgroundColor: on ? "#DBEAFE" : "#FEE2E2", marginTop: 8 }}
      testID={`btp-toggle-${label.replace(/\s+/g,'-').toLowerCase()}`}
    >
      <View style={{ flex: 1 }}>
        <Text style={{ fontWeight: "900", color: on ? "#1E3A8A" : "#991B1B" }}>
          {label} : {on ? "🟢 Activé" : "🔴 Désactivé"}
        </Text>
        <Text style={{ fontSize: 11, color: on ? "#1E3A8A" : "#991B1B", marginTop: 2 }}>
          {on ? hintOn : hintOff}
        </Text>
      </View>
      <Ionicons name={on ? "toggle" : "toggle-outline"} size={38} color={on ? "#2563EB" : "#9CA3AF"} />
    </TouchableOpacity>
  );

  return (
    <Card style={{ marginBottom: 12, borderWidth: 2, borderColor: enabled ? "#2563EB" : theme.colors.border }} testID="biztranspay-card">
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Ionicons name="flash" size={22} color="#2563EB" />
        <Text style={styles.section}>⚡ Biz-transPay <Text style={{ fontSize: 12, color: theme.colors.textSecondary }}>(SoftPay • Togo)</Text></Text>
      </View>
      <Text style={styles.helperTxt}>
        Passerelle Biz-transPay — activation par SoftPay & retrait automatique via BizPUSH. Portée : Togo (T-Money, Flooz Moov).
      </Text>

      {/* Master switch */}
      <StatusRow
        label="Prestataire"
        on={enabled}
        onPress={() => patch({ biztranspay_enabled: !enabled })}
        hintOn="Le prestataire est utilisable — PayIn/PayOut selon les switches ci-dessous."
        hintOff="Aucune transaction ne sera envoyée à Biz-transPay."
      />
      {/* PayIn / PayOut */}
      <StatusRow
        label="Dépôt (PayIn — activation)"
        on={payinEnabled && enabled}
        onPress={() => patch({ biztranspay_payin_enabled: !payinEnabled })}
        hintOn="Les utilisateurs togolais activent leur compte via Biz-transPay."
        hintOff="Les utilisateurs ne verront pas Biz-transPay sur la page d'activation."
      />
      <StatusRow
        label="Retrait (PayOut — automatique)"
        on={payoutEnabled && enabled}
        onPress={() => patch({ biztranspay_payout_enabled: !payoutEnabled })}
        hintOn="Retraits togolais dispatchés automatiquement via BizPUSH."
        hintOff="Retraits togolais restent en attente pour validation manuelle admin."
      />

      {/* API credentials */}
      <View style={{ marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <Text style={{ fontSize: 13, fontWeight: "800", color: theme.colors.textPrimary }}>🔑 Informations API</Text>
          <TouchableOpacity onPress={() => setShowKeys((v) => !v)} testID="btp-toggle-keys">
            <Text style={{ color: theme.colors.primary, fontSize: 12, fontWeight: "700" }}>
              {showKeys ? "Masquer" : "Modifier"}
            </Text>
          </TouchableOpacity>
        </View>
        <Text style={{ fontSize: 12, color: theme.colors.textSecondary }}>
          Clé API (Bearer) : <Text style={{ fontFamily: "monospace", color: theme.colors.textPrimary }}>{cfg.api_key_masked || "— non configurée —"}</Text>
        </Text>
        <Text style={{ fontSize: 12, color: theme.colors.textSecondary, marginTop: 4 }}>
          Secret webhook HMAC : <Text style={{ fontFamily: "monospace", color: theme.colors.textPrimary }}>{cfg.webhook_secret_masked || "— non configuré —"}</Text>
        </Text>

        {showKeys && (
          <View style={{ marginTop: 10, gap: 8 }}>
            <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
              <TextInput
                value={apiKeyInput}
                onChangeText={setApiKeyInput}
                placeholder="sk_test_… ou sk_live_…"
                placeholderTextColor={theme.colors.textSecondary}
                style={[styles.input, { flex: 1 }]}
                testID="btp-input-api-key"
                autoCapitalize="none"
              />
              <TouchableOpacity style={{ paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, backgroundColor: theme.colors.primary }} onPress={() => patch({ biztranspay_api_key: apiKeyInput })} disabled={saving || !apiKeyInput.trim()}>
                <Text style={{ color: "#fff", fontWeight: "800", fontSize: 11 }}>Enreg.</Text>
              </TouchableOpacity>
              <TouchableOpacity style={{ paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, backgroundColor: "#EF4444" }} onPress={() => patch({ biztranspay_api_key: "DELETE" })} disabled={saving}>
                <Text style={{ color: "#fff", fontWeight: "800", fontSize: 11 }}>✕</Text>
              </TouchableOpacity>
            </View>
            <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
              <TextInput
                value={webhookInput}
                onChangeText={setWebhookInput}
                placeholder="Secret HMAC webhook"
                placeholderTextColor={theme.colors.textSecondary}
                style={[styles.input, { flex: 1 }]}
                testID="btp-input-webhook"
                autoCapitalize="none"
              />
              <TouchableOpacity style={{ paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, backgroundColor: theme.colors.primary }} onPress={() => patch({ biztranspay_webhook_secret: webhookInput })} disabled={saving || !webhookInput.trim()}>
                <Text style={{ color: "#fff", fontWeight: "800", fontSize: 11 }}>Enreg.</Text>
              </TouchableOpacity>
              <TouchableOpacity style={{ paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, backgroundColor: "#EF4444" }} onPress={() => patch({ biztranspay_webhook_secret: "DELETE" })} disabled={saving}>
                <Text style={{ color: "#fff", fontWeight: "800", fontSize: 11 }}>✕</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>

      {/* Countries / operators toggles */}
      <View style={{ marginTop: 12 }}>
        <Text style={{ fontSize: 13, fontWeight: "800", color: theme.colors.textPrimary, marginBottom: 6 }}>🌍 Pays & opérateurs</Text>
        {Object.entries(catalog).map(([cc, info]: [string, any]) => (
          <View key={cc} style={{ marginBottom: 10, padding: 10, borderRadius: 10, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border }}>
            <Text style={{ fontWeight: "800", fontSize: 13, color: theme.colors.textPrimary }}>{info.name} ({cc}) — {info.currency}</Text>
            {(info.operators || []).map((op: any) => {
              const on = ((cfg.countries || {})[cc] || {})[op.code] !== false;
              return (
                <TouchableOpacity
                  key={op.code}
                  onPress={() => toggleOperator(cc, op.code)}
                  disabled={saving}
                  style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 10, borderRadius: 8, backgroundColor: on ? "#D1FAE5" : "#FEE2E2", marginTop: 6 }}
                  testID={`btp-op-${cc}-${op.code}`}
                >
                  <View>
                    <Text style={{ fontWeight: "800", color: on ? "#065F46" : "#991B1B" }}>{op.label}</Text>
                    <Text style={{ fontSize: 10, color: on ? "#065F46" : "#991B1B", marginTop: 2 }}>
                      Code : <Text style={{ fontFamily: "monospace" }}>{op.code}</Text>
                    </Text>
                  </View>
                  <Ionicons name={on ? "checkmark-circle" : "close-circle-outline"} size={26} color={on ? "#10B981" : "#EF4444"} />
                </TouchableOpacity>
              );
            })}
          </View>
        ))}
      </View>
    </Card>
  );
}


/**
 * BizTransPayCard REMOVED 2026-09-02 — crypto activation is now handled by
 * IziChangePay (via feature flag `crypto_auto` + IZIPAY_SECRET_KEY env), and
 * mobile activation by SolesPay/Ashtec via the SolesPay + PaymentGateways
 * cards above. The old BizTransPay admin card has been deleted.
 */
