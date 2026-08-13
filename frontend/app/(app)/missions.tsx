/**
 * Paid Missions — user page.
 *
 * Sections:
 *   1) Total + per-wallet summary (5 isolated balances)
 *   2) Withdrawal: pick a specific mission wallet (YouTube / TikTok / IG / FB / Questionnaire)
 *      and request a withdrawal from that wallet only.
 *   3) Available missions (time-window restricted, with timer and optional question)
 *   4) History (completions + withdrawals)
 */
import React, { useEffect, useState, useCallback } from "react";
import {
  Linking, Modal, Platform, RefreshControl, ScrollView, StyleSheet, Text, TextInput,
  TouchableOpacity, View, Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { api, resolveMediaUrl } from "@/src/api";
import { theme } from "@/src/theme";

const TYPE_META: Record<string, { label: string; icon: any; color: string; emoji: string }> = {
  youtube:       { label: "YouTube",       icon: "logo-youtube",   color: "#FF0000", emoji: "📺" },
  tiktok:        { label: "TikTok",        icon: "musical-notes",  color: "#000000", emoji: "🎵" },
  instagram:     { label: "Instagram",     icon: "logo-instagram", color: "#E1306C", emoji: "📸" },
  facebook:      { label: "Facebook",      icon: "logo-facebook",  color: "#1877F2", emoji: "📘" },
  questionnaire: { label: "Questionnaire", icon: "help-circle",    color: "#7B61FF", emoji: "📝" },
};

/** Extract a YouTube video ID from any YouTube URL shape. */
function ytId(url: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1).split("/")[0] || null;
    if (u.hostname.includes("youtube.com")) {
      if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2] || null;
      if (u.pathname.startsWith("/embed/")) return u.pathname.split("/")[2] || null;
      return u.searchParams.get("v");
    }
  } catch {}
  return null;
}

/** Build an embed URL suitable for an <iframe>. Returns null when the URL
 * cannot be embedded — the caller falls back to a native video element or
 * a "Open in new tab" affordance. */
function embedUrl(kind: string, url: string): string | null {
  const yid = ytId(url);
  if (yid) return `https://www.youtube.com/embed/${yid}?autoplay=1&modestbranding=1&rel=0&playsinline=1`;
  if (!url) return null;
  if (kind === "facebook" && /facebook\.com|fb\.watch/.test(url)) {
    return `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(url)}&show_text=false&autoplay=true`;
  }
  if (kind === "instagram" && /instagram\.com\/(p|reel|tv)\//.test(url)) {
    const clean = url.split("?")[0].replace(/\/$/, "");
    return `${clean}/embed`;
  }
  if (kind === "tiktok" && /tiktok\.com/.test(url)) {
    // TikTok direct iframe embed by video id (best-effort).
    const m = url.match(/\/video\/(\d+)/);
    if (m) return `https://www.tiktok.com/embed/v2/${m[1]}`;
  }
  if (/\.mp4($|\?)/i.test(url)) return url; // raw MP4 will be rendered by <video>
  return null;
}

/** YouTube thumbnail URL for a card. Falls back to a neutral gradient in CSS. */
function ytThumb(url: string): string | null {
  const id = ytId(url);
  return id ? `https://img.youtube.com/vi/${id}/hqdefault.jpg` : null;
}

function fmt(n: number) { return `${Math.round(n)} FCFA`; }

/** Modal that embeds the video, tracks watch time server-side via heartbeats
 * and auto-completes the mission when the required duration is reached.
 * NO manual validation button — everything is automatic. */
function WatchModal({ m, visible, onClose, onDone }: any) {
  const meta = TYPE_META[m.type] || { label: m.type, icon: "play", color: theme.colors.primary, emoji: "🎬" };
  const required = Number(m.duration_seconds || 0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [answer, setAnswer] = useState("");
  const embed = embedUrl(m.type, m.url || "");

  // Open a watch session as soon as the modal is shown (for video missions).
  useEffect(() => {
    if (!visible || m.type === "questionnaire") return;
    let alive = true;
    (async () => {
      try {
        setError(""); setDone(false); setElapsed(0);
        const r = await api.post<any>(`/missions/${m.id}/watch/start`, {});
        if (alive) setSessionId(r.session_id);
      } catch (e: any) {
        if (alive) setError(e?.detail || "Impossible d'ouvrir la session de visionnage.");
      }
    })();
    return () => { alive = false; };
  }, [visible, m.id]);

  // Local ticker + periodic heartbeat while the modal is open.
  useEffect(() => {
    if (!visible || !sessionId || done) return;
    const tick = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(tick);
  }, [visible, sessionId, done]);

  useEffect(() => {
    if (!sessionId || done) return;
    const beat = async () => {
      try {
        await api.post(`/missions/${m.id}/watch/heartbeat`, { session_id: sessionId, elapsed_seconds: elapsed });
      } catch {}
    };
    // Beat every 5s and immediately at each 10s milestone.
    const id = setInterval(beat, 5000);
    return () => clearInterval(id);
  }, [sessionId, elapsed, done, m.id]);

  // Auto-complete when required duration is reached.
  useEffect(() => {
    if (m.type === "questionnaire") return;
    if (!sessionId || done || completing) return;
    if (elapsed < required) return;
    (async () => {
      setCompleting(true);
      try {
        // Send a final heartbeat first to ensure the server sees max_elapsed ≥ required.
        try {
          await api.post(`/missions/${m.id}/watch/heartbeat`, { session_id: sessionId, elapsed_seconds: elapsed });
        } catch {}
        const r = await api.post<any>(`/missions/${m.id}/complete`, { session_id: sessionId });
        setDone(true);
        if (typeof window !== "undefined") window.alert(`✅ Mission validée avec succès\n💰 +${r.reward} FCFA crédités sur votre solde ${meta.label}`);
        onDone?.();
      } catch (e: any) {
        setError(e?.detail || "Impossible de valider automatiquement.");
      } finally {
        setCompleting(false);
      }
    })();
  }, [elapsed, required, sessionId, done, m.id, m.type]);

  const submitQuestionnaire = async () => {
    if (!answer.trim()) { setError("Veuillez saisir votre réponse."); return; }
    setCompleting(true); setError("");
    try {
      const r = await api.post<any>(`/missions/${m.id}/complete`, { answer: answer.trim() });
      setDone(true);
      if (typeof window !== "undefined") window.alert(`✅ Mission validée avec succès\n💰 +${r.reward} FCFA crédités sur votre solde ${meta.label}`);
      onDone?.();
    } catch (e: any) {
      setError(e?.detail || "Réponse incorrecte.");
    } finally {
      setCompleting(false);
    }
  };

  const progress = Math.min(100, Math.round((elapsed / Math.max(1, required)) * 100));

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBg}>
        <View style={[styles.modalCard, { maxWidth: 640 }]} testID={`watch-modal-${m.id}`}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View style={[styles.typePill, { backgroundColor: meta.color }]}>
                <Ionicons name={meta.icon} size={12} color="#fff" />
                <Text style={styles.typeTxt}>{meta.label}</Text>
              </View>
              <Text style={{ color: theme.colors.success, fontWeight: "800" }}>+{fmt(m.reward)}</Text>
            </View>
            <TouchableOpacity onPress={onClose} testID={`watch-close-${m.id}`}>
              <Ionicons name="close" size={22} color={theme.colors.textPrimary} />
            </TouchableOpacity>
          </View>
          <Text style={styles.modalTitle}>{m.title}</Text>
          {m.description ? <Text style={styles.modalSub}>{m.description}</Text> : null}

          {m.type !== "questionnaire" ? (
            <>
              <View style={styles.playerBox}>
                {Platform.OS === "web" && embed ? (
                  // @ts-ignore RN Web accepts raw iframes
                  <iframe
                    src={embed}
                    style={{ width: "100%", height: 340, border: 0, borderRadius: 10, background: "#000" }}
                    allow="autoplay; encrypted-media; picture-in-picture"
                    allowFullScreen
                    data-testid={`watch-iframe-${m.id}`}
                  />
                ) : Platform.OS === "web" && /\.mp4($|\?)/i.test(m.url || "") ? (
                  // @ts-ignore RN Web accepts raw <video>
                  <video src={m.url} controls autoPlay playsInline style={{ width: "100%", maxHeight: 340, borderRadius: 10, background: "#000" }} />
                ) : (
                  <View style={styles.fallbackBox}>
                    <Ionicons name="warning" size={22} color={theme.colors.warning} />
                    <Text style={{ color: theme.colors.textSecondary, textAlign: "center", marginTop: 6, fontSize: 12 }}>
                      Impossible d'intégrer cette vidéo. Ouvrez-la dans un onglet séparé — la session de visionnage reste active tant que cette fenêtre est ouverte.
                    </Text>
                    <TouchableOpacity
                      style={styles.openBtn}
                      onPress={() => Platform.OS === "web" ? window.open(m.url, "_blank") : Linking.openURL(m.url)}
                      testID={`watch-open-external-${m.id}`}
                    >
                      <Ionicons name="open-outline" size={14} color="#fff" />
                      <Text style={styles.openTxt}>Ouvrir la vidéo</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>

              {/* Progress bar */}
              <View style={styles.progressWrap}>
                <View style={[styles.progressBar, { width: `${progress}%` }]} />
              </View>
              <Text style={styles.timer} testID={`watch-timer-${m.id}`}>
                ⏱ {elapsed}s / {required}s {done ? "✅" : completing ? "⏳" : elapsed >= required ? "🎉" : ""}
              </Text>
              <Text style={{ color: theme.colors.textSecondary, fontSize: 11, marginTop: 4, fontStyle: "italic" }}>
                La validation est automatique dès que le visionnage complet est confirmé côté serveur.
              </Text>
            </>
          ) : (
            <View style={{ marginTop: 12 }}>
              {m.question ? <Text style={styles.q}>❓ {m.question}</Text> : null}
              <TextInput
                style={styles.input}
                value={answer}
                onChangeText={setAnswer}
                placeholder="Votre réponse"
                placeholderTextColor={theme.colors.textSecondary}
                testID={`watch-answer-${m.id}`}
              />
              <TouchableOpacity
                style={[styles.validateBtn, completing && { opacity: 0.6 }]}
                onPress={submitQuestionnaire}
                disabled={completing}
                testID={`watch-answer-submit-${m.id}`}
              >
                <Text style={styles.validateTxt}>{completing ? "Validation…" : "✅ Valider ma réponse"}</Text>
              </TouchableOpacity>
            </View>
          )}

          {error ? (
            <Text style={{ color: theme.colors.danger, fontSize: 12, marginTop: 8 }} testID={`watch-error-${m.id}`}>❌ {error}</Text>
          ) : null}
          {done ? (
            <View style={{ marginTop: 10, padding: 10, borderRadius: 10, backgroundColor: "#ECFDF5", borderWidth: 1, borderColor: theme.colors.success }} testID={`watch-done-${m.id}`}>
              <Text style={{ color: theme.colors.success, fontWeight: "800", fontSize: 13 }}>🎉 Mission validée — récompense créditée.</Text>
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

function MissionCard({ m, onDone }: any) {
  const meta = TYPE_META[m.type] || { label: m.type, icon: "play", color: theme.colors.primary, emoji: "🎬" };
  const [open, setOpen] = useState(false);
  const thumb = ytThumb(m.url || "");

  if (m.completed_by_user) {
    return (
      <View style={[styles.card, { opacity: 0.55 }]} testID={`mission-${m.id}`}>
        <Text style={styles.title}>{m.title}</Text>
        <Text style={styles.done}>✅ Mission déjà validée</Text>
      </View>
    );
  }

  return (
    <>
      <TouchableOpacity
        activeOpacity={0.85}
        style={styles.card}
        onPress={() => setOpen(true)}
        testID={`mission-${m.id}`}
      >
        {thumb ? (
          <View style={{ position: "relative", marginHorizontal: -14, marginTop: -14, marginBottom: 10 }}>
            {/* @ts-ignore RN Web accepts <img> */}
            <img
              src={thumb}
              alt={m.title}
              style={{ width: "100%", height: 180, objectFit: "cover", borderTopLeftRadius: 14, borderTopRightRadius: 14, display: "block" }}
              data-testid={`mission-thumb-${m.id}`}
            />
            <View style={styles.playOverlay}>
              <Ionicons name="play-circle" size={48} color="#fff" />
            </View>
          </View>
        ) : null}

        <View style={styles.head}>
          <View style={[styles.typePill, { backgroundColor: meta.color }]}>
            <Ionicons name={meta.icon} size={12} color="#fff" />
            <Text style={styles.typeTxt}>{meta.label}</Text>
          </View>
          <Text style={styles.reward}>+{fmt(m.reward)}</Text>
        </View>
        <Text style={styles.title}>{m.title}</Text>
        {m.description ? <Text style={styles.desc} numberOfLines={2}>{m.description}</Text> : null}

        <View style={styles.metaRow}>
          <View style={styles.metaChip}>
            <Ionicons name="time-outline" size={12} color={theme.colors.textSecondary} />
            <Text style={styles.metaTxt}>{m.duration_seconds}s</Text>
          </View>
          {typeof m.participants_count === "number" ? (
            <View style={styles.metaChip}>
              <Ionicons name="people-outline" size={12} color={theme.colors.textSecondary} />
              <Text style={styles.metaTxt}>{m.participants_count} participant{m.participants_count > 1 ? "s" : ""}</Text>
            </View>
          ) : null}
          <View style={[styles.metaChip, { backgroundColor: theme.colors.successBg || "#DCFCE7" }]}>
            <Ionicons name="checkmark-circle" size={12} color={theme.colors.success} />
            <Text style={[styles.metaTxt, { color: theme.colors.success, fontWeight: "700" }]}>Disponible</Text>
          </View>
        </View>

        <View style={styles.watchCta}>
          <Ionicons name="play-circle" size={16} color="#fff" />
          <Text style={styles.watchCtaTxt}>
            {m.type === "questionnaire" ? "Répondre au questionnaire" : "Regarder la vidéo"}
          </Text>
        </View>
      </TouchableOpacity>

      <WatchModal m={m} visible={open} onClose={() => setOpen(false)} onDone={() => { setOpen(false); onDone?.(); }} />
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cfg: any = {
    pending:   { bg: theme.colors.warningBg, color: theme.colors.warning, label: "En attente" },
    validated: { bg: theme.colors.successBg, color: theme.colors.success, label: "Validé" },
    rejected:  { bg: theme.colors.dangerBg,  color: theme.colors.danger,  label: "Rejeté" },
  }[status] || { bg: "#eee", color: "#666", label: status };
  return (
    <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10, backgroundColor: cfg.bg }}>
      <Text style={{ color: cfg.color, fontWeight: "700", fontSize: 11 }}>{cfg.label}</Text>
    </View>
  );
}

function WithdrawModal({
  visible, wallet, balance, onClose, onSubmitted,
}: {
  visible: boolean;
  wallet: string;
  balance: number;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [payoutCfg, setPayoutCfg] = useState<{ min_withdrawal: number; fee_percent: number } | null>(null);
  const meta = TYPE_META[wallet] || { label: wallet, color: theme.colors.primary, emoji: "🎁", icon: "wallet" };
  useEffect(() => {
    if (!visible) { setAmount(""); return; }
    api.get<any>("/me/mission-payout-config").then(setPayoutCfg).catch(() => {});
  }, [visible]);

  const amt = parseInt(amount, 10) || 0;
  const minOk = payoutCfg ? amt >= payoutCfg.min_withdrawal : true;
  const fee = payoutCfg ? Math.round((amt * payoutCfg.fee_percent) / 100) : 0;
  const net = amt - fee;

  const submit = async () => {
    if (amt <= 0) {
      if (typeof window !== "undefined") window.alert("Montant invalide.");
      return;
    }
    if (payoutCfg && amt < payoutCfg.min_withdrawal) {
      if (typeof window !== "undefined") window.alert(`Montant minimum requis : ${payoutCfg.min_withdrawal} FCFA.`);
      return;
    }
    if (amt > balance) {
      if (typeof window !== "undefined") window.alert(`Solde insuffisant. Disponible: ${fmt(balance)}.`);
      return;
    }
    setSubmitting(true);
    try {
      await api.post(`/me/mission-withdrawals`, { wallet, amount: amt });
      if (typeof window !== "undefined") window.alert(`✅ Demande de retrait envoyée\nMontant : ${fmt(amt)}\nFrais : ${fmt(fee)}\nMontant net : ${fmt(net)}`);
      onSubmitted();
      onClose();
    } catch (e: any) {
      const msg = e?.detail || "Échec de la demande.";
      if (typeof window !== "undefined") window.alert(`❌ ${msg}`);
      else Alert.alert("Erreur", msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBg}>
        <View style={styles.modalCard} testID="mission-withdraw-modal">
          <Text style={styles.modalTitle}>{meta.emoji} Retrait — {meta.label}</Text>
          <Text style={styles.modalSub}>Solde disponible : <Text style={{ color: theme.colors.success, fontWeight: "800" }}>{fmt(balance)}</Text></Text>
          {payoutCfg ? (
            <View style={{ marginTop: 6, padding: 8, backgroundColor: "#F1F5F9", borderRadius: 8 }}>
              <Text style={{ color: theme.colors.textSecondary, fontSize: 11 }}>
                💰 Minimum : <Text style={{ fontWeight: "700", color: theme.colors.textPrimary }}>{payoutCfg.min_withdrawal} FCFA</Text>
                {"  •  "}
                💸 Frais : <Text style={{ fontWeight: "700", color: theme.colors.textPrimary }}>{payoutCfg.fee_percent}%</Text>
              </Text>
            </View>
          ) : null}
          <Text style={styles.lbl}>Montant à retirer (FCFA)</Text>
          <TextInput
            style={styles.input}
            keyboardType="numeric"
            value={amount}
            onChangeText={setAmount}
            placeholder={payoutCfg ? `Min : ${payoutCfg.min_withdrawal}` : "Ex: 1000"}
            placeholderTextColor={theme.colors.textSecondary}
            testID="mission-withdraw-amount"
          />
          {amt > 0 && payoutCfg ? (
            <View style={{ marginTop: 8, padding: 10, backgroundColor: "#EFF6FF", borderRadius: 8, borderWidth: 1, borderColor: "#BFDBFE" }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>Montant demandé</Text>
                <Text style={{ color: theme.colors.textPrimary, fontWeight: "700", fontSize: 12 }}>{fmt(amt)}</Text>
              </View>
              <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>Frais ({payoutCfg.fee_percent}%)</Text>
                <Text style={{ color: theme.colors.danger, fontWeight: "700", fontSize: 12 }}>− {fmt(fee)}</Text>
              </View>
              <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: "#BFDBFE" }}>
                <Text style={{ color: theme.colors.textPrimary, fontSize: 13, fontWeight: "800" }}>Montant net</Text>
                <Text style={{ color: theme.colors.success, fontWeight: "800", fontSize: 13 }}>{fmt(net)}</Text>
              </View>
              {!minOk ? (
                <Text style={{ color: theme.colors.danger, fontSize: 11, marginTop: 4 }}>⚠️ Minimum requis : {payoutCfg.min_withdrawal} FCFA</Text>
              ) : null}
            </View>
          ) : null}
          <Text style={styles.warnTxt}>
            ℹ️ Ce retrait sera traité par un administrateur. Les fonds sont réservés immédiatement et restitués en cas de rejet.
          </Text>
          <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: theme.colors.surfaceSecondary }]}
              onPress={onClose}
              testID="mission-withdraw-cancel"
            >
              <Text style={[styles.btnTxt, { color: theme.colors.textPrimary }]}>Annuler</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: theme.colors.success }, (submitting || !minOk) && { opacity: 0.6 }]}
              onPress={submit}
              disabled={submitting || balance <= 0 || !minOk}
              testID="mission-withdraw-submit"
            >
              <Text style={styles.btnTxt}>{submitting ? "Envoi…" : "💸 Demander le retrait"}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function MissionsPageInner() {
  const router = useRouter();
  const [items, setItems] = useState<any[]>([]);
  const [windowOpen, setWindowOpen] = useState(true);
  const [message, setMessage] = useState("");
  const [todayLabel, setTodayLabel] = useState<string>("");
  const [refreshing, setRefreshing] = useState(false);
  const [wallets, setWallets] = useState<any>({ wallets: [], total: 0 });
  const [withdrawals, setWithdrawals] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [selectedWallet, setSelectedWallet] = useState<string | null>(null);
  const [tab, setTab] = useState<"missions" | "history">("missions");

  const load = useCallback(async () => {
    try {
      const [m, w, wd, h] = await Promise.all([
        api.get<any>("/missions"),
        api.get<any>("/me/mission-wallets"),
        api.get<any>("/me/mission-withdrawals"),
        api.get<any>("/me/mission-history"),
      ]);
      setItems(m.items || []);
      setWindowOpen(!!m.window_open);
      setMessage(m.message || "");
      setTodayLabel(m.today_label || "");
      setWallets(w);
      setWithdrawals(wd.items || []);
      setHistory(h.items || []);
    } catch {}
  }, []);

  useEffect(() => { load(); }, [load]);

  const selectedBalance = selectedWallet
    ? (wallets.wallets || []).find((x: any) => x.type === selectedWallet)?.balance || 0
    : 0;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} testID="missions-back">
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.hTitle}>🎥 Missions Rémunérées</Text>
        <View style={{ width: 22 }} />
      </LinearGradient>

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
        contentContainerStyle={{ padding: 12, paddingBottom: 80 }}
      >
        {/* Total */}
        <View style={styles.totalCard}>
          <Text style={styles.totalLbl}>💰 Solde total Missions</Text>
          <Text style={styles.totalVal}>{fmt(wallets.total || 0)}</Text>
          <Text style={styles.totalHint}>Vos gains de missions sont totalement séparés de vos commissions MLM.</Text>
        </View>

        {/* Per-wallet cards with "Retirer" buttons */}
        <Text style={styles.sectionTitle}>💼 Mes Portefeuilles Missions</Text>
        <View style={styles.walletsGrid}>
          {(wallets.wallets || []).map((w: any) => {
            const meta = TYPE_META[w.type] || { label: w.type, color: theme.colors.primary, emoji: "🎁" };
            return (
              <View key={w.type} style={styles.walletCard} testID={`wallet-${w.type}`}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Text style={styles.walletEmoji}>{meta.emoji}</Text>
                  <Text style={styles.walletLabel}>{meta.label}</Text>
                </View>
                <Text style={styles.walletBal} testID={`wallet-${w.type}-balance`}>{fmt(w.balance)}</Text>
                <Text style={styles.walletCount}>{w.completed} tâches</Text>
                <TouchableOpacity
                  style={[styles.walletBtn, (w.balance <= 0) && { backgroundColor: theme.colors.surfaceSecondary }]}
                  onPress={() => setSelectedWallet(w.type)}
                  disabled={w.balance <= 0}
                  testID={`wallet-${w.type}-withdraw`}
                >
                  <Ionicons name="cash-outline" size={12} color={w.balance > 0 ? "#fff" : theme.colors.textSecondary} />
                  <Text style={[styles.walletBtnTxt, w.balance <= 0 && { color: theme.colors.textSecondary }]}>
                    Retirer
                  </Text>
                </TouchableOpacity>
              </View>
            );
          })}
        </View>

        {/* Tabs */}
        <View style={styles.tabRow}>
          <TouchableOpacity
            style={[styles.tab, tab === "missions" && styles.tabOn]}
            onPress={() => setTab("missions")}
            testID="tab-missions"
          >
            <Text style={[styles.tabTxt, tab === "missions" && { color: "#fff" }]}>🎬 Missions disponibles</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tab, tab === "history" && styles.tabOn]}
            onPress={() => setTab("history")}
            testID="tab-history"
          >
            <Text style={[styles.tabTxt, tab === "history" && { color: "#fff" }]}>📜 Historique</Text>
          </TouchableOpacity>
        </View>

        {tab === "missions" ? (
          !windowOpen ? (
            <View style={styles.closed} testID="missions-closed-banner">
              <Text style={styles.closedTxt}>{message || "🚫 Missions actuellement indisponibles.\n📅 Lundi à Vendredi de 08h00 à 16h00."}</Text>
            </View>
          ) : (
            <>
              {todayLabel ? (
                <View style={{ padding: 10, borderRadius: 10, backgroundColor: "#DBEAFE", borderWidth: 1, borderColor: "#93C5FD", marginBottom: 10 }}>
                  <Text style={{ color: "#1E40AF", fontWeight: "800", fontSize: 13 }} testID="today-label">📍 Aujourd'hui : {todayLabel}</Text>
                </View>
              ) : null}
              {items.length === 0 ? (
                <Text style={styles.empty} testID="no-mission-today">{message || "Aucune mission disponible pour vous aujourd'hui."}</Text>
              ) : (
                items.map((m) => <MissionCard key={m.id} m={m} onDone={load} />)
              )}
            </>
          )
        ) : (
          <>
            <Text style={[styles.sectionTitle, { marginTop: 4 }]}>💸 Demandes de retrait</Text>
            {withdrawals.length === 0 ? (
              <Text style={styles.empty}>Aucune demande de retrait pour le moment.</Text>
            ) : (
              withdrawals.map((w: any) => {
                const meta = TYPE_META[w.wallet] || { label: w.wallet, emoji: "🎁" };
                return (
                  <View key={w.id} style={styles.row} testID={`mwd-${w.id}`}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle}>{meta.emoji} {meta.label}</Text>
                      <Text style={styles.rowSub}>{new Date(w.created_at).toLocaleString("fr-FR")}</Text>
                    </View>
                    <View style={{ alignItems: "flex-end" }}>
                      <Text style={styles.rowAmt}>{fmt(w.amount)}</Text>
                      <View style={{ marginTop: 4 }}><StatusBadge status={w.status} /></View>
                    </View>
                  </View>
                );
              })
            )}

            <Text style={[styles.sectionTitle, { marginTop: 16 }]}>🏆 Missions validées</Text>
            {history.length === 0 ? (
              <Text style={styles.empty}>Aucune mission validée pour le moment.</Text>
            ) : (
              history.map((h: any) => {
                const meta = TYPE_META[h.mission_type] || { label: h.mission_type, emoji: "🎬" };
                return (
                  <View key={h.id} style={styles.row} testID={`mh-${h.id}`}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle}>{meta.emoji} {meta.label}</Text>
                      <Text style={styles.rowSub}>{new Date(h.completed_at).toLocaleString("fr-FR")}</Text>
                    </View>
                    <Text style={[styles.rowAmt, { color: theme.colors.success }]}>+{fmt(h.reward)}</Text>
                  </View>
                );
              })
            )}
          </>
        )}
      </ScrollView>

      <WithdrawModal
        visible={!!selectedWallet}
        wallet={selectedWallet || "youtube"}
        balance={selectedBalance}
        onClose={() => setSelectedWallet(null)}
        onSubmitted={load}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 12 },
  hTitle: { color: "#fff", fontWeight: "800", fontSize: 16 },
  totalCard: { padding: 14, borderRadius: 14, backgroundColor: theme.colors.surface, marginBottom: 10, borderWidth: 1, borderColor: theme.colors.border },
  totalLbl: { color: theme.colors.textSecondary, fontSize: 12 },
  totalVal: { color: theme.colors.primary, fontWeight: "800", fontSize: 22, marginTop: 4 },
  totalHint: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 6, fontStyle: "italic" },
  sectionTitle: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 13, marginTop: 6, marginBottom: 8 },
  walletsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 8 },
  walletCard: { flexBasis: "48%", flexGrow: 1, padding: 10, borderRadius: 12, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border },
  walletEmoji: { fontSize: 14 },
  walletLabel: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 12 },
  walletBal: { color: theme.colors.success, fontWeight: "800", fontSize: 16, marginTop: 4 },
  walletCount: { color: theme.colors.textSecondary, fontSize: 10, marginTop: 2 },
  walletBtn: { marginTop: 8, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, paddingVertical: 7, borderRadius: 14, backgroundColor: theme.colors.primary },
  walletBtnTxt: { color: "#fff", fontWeight: "700", fontSize: 11 },
  tabRow: { flexDirection: "row", gap: 6, marginTop: 8, marginBottom: 10 },
  tab: { flex: 1, paddingVertical: 9, borderRadius: 18, backgroundColor: theme.colors.surfaceSecondary, alignItems: "center", borderWidth: 1, borderColor: theme.colors.border },
  tabOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  tabTxt: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 12 },
  closed: { padding: 18, borderRadius: 14, backgroundColor: "#FEF2F2", borderWidth: 1, borderColor: theme.colors.danger },
  closedTxt: { color: theme.colors.danger, fontWeight: "700", textAlign: "center" },
  empty: { color: theme.colors.textSecondary, textAlign: "center", marginTop: 18, marginBottom: 8 },
  card: { padding: theme.spacing.lg, borderRadius: theme.radius.lg, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, marginBottom: 14, overflow: "hidden", ...theme.shadow.card },
  playOverlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.15)" },
  metaRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 10 },
  metaChip: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12, backgroundColor: theme.colors.surfaceSecondary },
  metaTxt: { color: theme.colors.textSecondary, fontSize: 11, fontWeight: "600" },
  watchCta: { marginTop: 12, alignSelf: "stretch", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, borderRadius: 18, backgroundColor: theme.colors.primary },
  watchCtaTxt: { color: "#fff", fontWeight: "800", fontSize: 13 },
  playerBox: { marginTop: 10, borderRadius: 10, overflow: "hidden", backgroundColor: "#000" },
  fallbackBox: { padding: 16, alignItems: "center", backgroundColor: theme.colors.surfaceSecondary, borderRadius: 10 },
  progressWrap: { marginTop: 10, height: 6, borderRadius: 3, backgroundColor: theme.colors.surfaceSecondary, overflow: "hidden" },
  progressBar: { height: 6, backgroundColor: theme.colors.success },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  typePill: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  typeTxt: { color: "#fff", fontSize: 10, fontWeight: "700" },
  reward: { color: theme.colors.success, fontWeight: "800" },
  title: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 14, marginTop: 8 },
  desc: { color: theme.colors.textSecondary, fontSize: 12, marginTop: 4 },
  openBtn: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", marginTop: 10, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 18, backgroundColor: theme.colors.primary },
  openTxt: { color: "#fff", fontWeight: "700", fontSize: 12 },
  timer: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 8 },
  q: { color: theme.colors.textPrimary, fontWeight: "600", fontSize: 12 },
  input: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, marginTop: 4, color: theme.colors.textPrimary, backgroundColor: theme.colors.background },
  validateBtn: { marginTop: 12, paddingVertical: 11, borderRadius: 18, backgroundColor: theme.colors.success, alignItems: "center" },
  validateTxt: { color: "#fff", fontWeight: "800", fontSize: 13 },
  done: { color: theme.colors.success, fontWeight: "700", marginTop: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, marginBottom: 6 },
  rowTitle: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 13 },
  rowSub: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 2 },
  rowAmt: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 14 },
  modalBg: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center", padding: 16 },
  modalCard: { width: "100%", maxWidth: 420, padding: 18, borderRadius: 16, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border },
  modalTitle: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 16 },
  modalSub: { color: theme.colors.textSecondary, fontSize: 12, marginTop: 4 },
  lbl: { color: theme.colors.textPrimary, fontSize: 12, fontWeight: "600", marginTop: 12, marginBottom: 3 },
  warnTxt: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 8, fontStyle: "italic" },
  btn: { flex: 1, paddingVertical: 11, borderRadius: 18, alignItems: "center" },
  btnTxt: { color: "#fff", fontWeight: "800", fontSize: 13 },
});


import { FeatureGuard } from "@/src/components/FeatureGuard";

export default function MissionsPage() {
  return (
    <FeatureGuard featureKey="paid_tasks" title="Tâches rémunérées désactivées">
      <MissionsPageInner />
    </FeatureGuard>
  );
}
