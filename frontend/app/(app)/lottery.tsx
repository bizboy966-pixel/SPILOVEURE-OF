import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { theme } from "@/src/theme";
import { api } from "@/src/api";
import { Card } from "@/src/components/Card";
import { useAuth } from "@/src/auth";

const fmt = (v: number) => `${Math.round(Number(v) || 0).toLocaleString("fr-FR")} FCFA`;

function useCountdown(endsAtISO: string | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!endsAtISO) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [endsAtISO]);
  if (!endsAtISO) return { d: 0, h: 0, m: 0, s: 0, done: true };
  const target = new Date(endsAtISO).getTime();
  const diff = Math.max(0, target - now);
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  return { d, h, m, s, done: diff <= 0 };
}

export default function LotteryPage() {
  const router = useRouter();
  const { user, refresh } = useAuth() as any;
  const [enabled, setEnabled] = useState(true);
  const [active, setActive] = useState<any>(null);
  const [announced, setAnnounced] = useState<any>(null);
  const [joining, setJoining] = useState(false);
  const cd = useCountdown(active?.ends_at || null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<any>("/lottery/active");
      setEnabled(!!r.enabled);
      setActive(r.active || null);
      setAnnounced(r.announced || null);
    } catch {}
  }, []);

  useEffect(() => { load(); refresh?.(); }, [load, refresh]);
  useEffect(() => {
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  const myBalance = Number(user?.balance_profit) || 0;
  const balanceRecharge = Number(user?.balance_recharge) || 0;
  const entry = Number(active?.entry_amount) || 0;
  const canAfford = (myBalance + balanceRecharge) >= entry;
  const isFull = !!(active?.max_participants && active?.participants_count >= active?.max_participants);
  const isOpen = active?.status === "open";
  const isRunning = active?.status === "running";

  const onJoin = async () => {
    if (!active) return;
    if (!isOpen) {
      if (typeof window !== "undefined") window.alert("❌ Ce tirage n'accepte plus de participation.");
      return;
    }
    if (isFull) {
      if (typeof window !== "undefined") window.alert("❌ Nombre maximal de participants atteint.");
      return;
    }
    if (!canAfford) {
      if (typeof window !== "undefined") {
        const go = window.confirm(`❌ Solde insuffisant\n\nSolde retirable : ${fmt(myBalance)}\nSolde recharge : ${fmt(balanceRecharge)}\nMontant requis : ${fmt(entry)}\n\nSouhaitez-vous recharger 500 FCFA maintenant via Ashtech Pay pour participer ?`);
        if (go) {
          router.push({
            pathname: "/(app)/pay-ashtec",
            params: {
              kind: "recharge",
              amount: "500",
              title: "Recharge 500 FCFA — Jackpot",
              return_to: "/(app)/lottery",
            },
          } as any);
        }
      }
      return;
    }
    if (typeof window !== "undefined" && !window.confirm(
      `Confirmer la participation au tirage « ${active.name} » ?\n\nMontant débité : ${fmt(entry)} (depuis votre solde retirable, ou recharge en complément)`
    )) return;
    setJoining(true);
    try {
      await api.post(`/lottery/draws/${active.id}/join`, {});
      await load();
      await refresh?.();
      if (typeof window !== "undefined") window.alert("🎉 Vous participez maintenant au tirage ! Bonne chance.");
    } catch (e: any) {
      const msg = e?.detail || "Échec";
      if (typeof window !== "undefined") window.alert(`❌ ${msg}`);
    } finally {
      setJoining(false);
    }
  };

  const sortedWinners = useMemo(() => {
    return [...(announced?.winners || [])].sort((a: any, b: any) => a.rank - b.rank);
  }, [announced]);

  if (!enabled) {
    return (
      <View style={[styles.screen, { padding: 16 }]}>
        <View style={styles.disabledBox} testID="lottery-disabled">
          <Ionicons name="close-circle" size={36} color={theme.colors.danger} />
          <Text style={styles.disabledTxt}>Le module Lottery Jackpot est actuellement désactivé par l'administration.</Text>
        </View>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 16 }} testID="lottery-page">
      <LinearGradient colors={["#F59E0B", "#DC2626"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.heroCard}>
        <Text style={styles.heroEmoji}>🎰</Text>
        <Text style={styles.heroTitle}>Lottery Jackpot</Text>
        <Text style={styles.heroSub}>SPILOVEURE</Text>
      </LinearGradient>

      {announced ? (
        <Card style={styles.cardAnnounced}>
          <Text style={styles.sectionTitle}>🏆 Derniers résultats — {announced.name}</Text>
          {sortedWinners.map((w: any, idx: number) => (
            <View key={`w-${idx}`} style={styles.winnerRow} testID={`winner-${w.rank}`}>
              <Text style={styles.winnerRank}>
                {w.rank === 1 ? "🥇" : w.rank === 2 ? "🥈" : w.rank === 3 ? "🥉" : "🏅"} {w.rank}
              </Text>
              <Text style={styles.winnerName}>{w.username || "—"}</Text>
              <Text style={styles.winnerPrize}>{fmt(w.prize)}</Text>
            </View>
          ))}
          <Text style={styles.thanks}>Merci à tous les participants. Rendez-vous au prochain tirage !</Text>
        </Card>
      ) : null}

      {active ? (
        <Card style={styles.cardActive} testID="lottery-active-card">
          <Text style={styles.activeName}>{active.name}</Text>
          {active.description ? <Text style={styles.activeDesc}>{active.description}</Text> : null}

          {isRunning ? (
            <>
              <Text style={styles.runningLabel}>⏱ Compte à rebours en cours</Text>
              <View style={styles.cdRow}>
                <View style={styles.cdBox}><Text style={styles.cdN}>{cd.d}</Text><Text style={styles.cdL}>jours</Text></View>
                <View style={styles.cdBox}><Text style={styles.cdN}>{String(cd.h).padStart(2, "0")}</Text><Text style={styles.cdL}>heures</Text></View>
                <View style={styles.cdBox}><Text style={styles.cdN}>{String(cd.m).padStart(2, "0")}</Text><Text style={styles.cdL}>min</Text></View>
                <View style={styles.cdBox}><Text style={styles.cdN}>{String(cd.s).padStart(2, "0")}</Text><Text style={styles.cdL}>sec</Text></View>
              </View>
            </>
          ) : (
            <View style={styles.openBadge}>
              <Ionicons name="checkmark-circle" size={16} color="#fff" />
              <Text style={styles.openBadgeTxt}>🟢 Inscriptions ouvertes — En attente du lancement par l'administration</Text>
            </View>
          )}

          <View style={styles.kv}>
            <Text style={styles.kvL}>👥 Participants</Text>
            <Text style={styles.kvV}>{active.participants_count}{active.max_participants ? ` / ${active.max_participants}` : ""}{isFull ? "  (COMPLET)" : ""}</Text>
          </View>
          <View style={styles.kv}>
            <Text style={styles.kvL}>🏆 Gagnants prévus</Text>
            <Text style={styles.kvV}>{active.winners_count}</Text>
          </View>
          <View style={styles.kv}>
            <Text style={styles.kvL}>💰 Participation</Text>
            <Text style={styles.kvV}>{fmt(entry)}</Text>
          </View>
          {(active.prizes && active.prizes.length > 0) ? (
            <View style={{ marginTop: 10 }}>
              <Text style={styles.prizeTitle}>🎁 Cagnotte</Text>
              {[...active.prizes].sort((a: any, b: any) => a.rank - b.rank).map((p: any, idx: number) => (
                <View key={`p-${idx}`} style={styles.prizeRow}>
                  <Text style={styles.prizeRank}>
                    {p.rank === 1 ? "🥇" : p.rank === 2 ? "🥈" : p.rank === 3 ? "🥉" : "🏅"} {p.rank}
                  </Text>
                  <Text style={styles.prizeAmt}>{fmt(p.amount)}</Text>
                </View>
              ))}
            </View>
          ) : null}
          <View style={styles.balanceBox}>
            <Text style={styles.balanceL}>Votre solde retirable</Text>
            <Text style={[styles.balanceV, { color: canAfford ? theme.colors.success : theme.colors.danger }]}>{fmt(myBalance)}</Text>
          </View>
          {active.already_joined ? (
            <View style={styles.joinedBadge} testID="lottery-already-joined">
              <Ionicons name="checkmark-circle" size={18} color="#fff" />
              <Text style={styles.joinedTxt}>✓ Vous participez à ce tirage</Text>
            </View>
          ) : isOpen && !isFull ? (
            <TouchableOpacity
              style={[styles.joinBtn, !canAfford && styles.joinBtnDisabled]}
              onPress={onJoin}
              disabled={joining}
              testID="lottery-join-btn"
            >
              <Ionicons name="ticket" size={18} color="#fff" />
              <Text style={styles.joinBtnTxt}>{joining ? "Inscription…" : `🎰 Rejoindre le Jackpot (${fmt(entry)})`}</Text>
            </TouchableOpacity>
          ) : isOpen && isFull ? (
            <View style={[styles.joinedBadge, { backgroundColor: theme.colors.danger }]} testID="lottery-full">
              <Ionicons name="close-circle" size={18} color="#fff" />
              <Text style={styles.joinedTxt}>Nombre maximal de participants atteint</Text>
            </View>
          ) : isRunning ? (
            <View style={[styles.joinedBadge, { backgroundColor: theme.colors.warning }]} testID="lottery-running">
              <Ionicons name="time" size={18} color="#fff" />
              <Text style={styles.joinedTxt}>⏱ Tirage en cours — En attente des résultats</Text>
            </View>
          ) : null}
        </Card>
      ) : !announced ? (
        <Card style={{ marginTop: 12 }}>
          <Text style={styles.emptyTxt}>🕒 Aucun tirage en cours pour le moment. Revenez bientôt !</Text>
        </Card>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  heroCard: { padding: 24, borderRadius: 16, alignItems: "center" },
  heroEmoji: { fontSize: 48 },
  heroTitle: { color: "#fff", fontWeight: "900", fontSize: 28, marginTop: 6 },
  heroSub: { color: "rgba(255,255,255,0.9)", fontWeight: "700", fontSize: 13, marginTop: 2 },
  cardActive: { marginTop: 14 },
  cardAnnounced: { marginTop: 14, borderWidth: 2, borderColor: "#F59E0B", backgroundColor: "#FFFBEB" },
  sectionTitle: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 15 },
  activeName: { color: theme.colors.textPrimary, fontWeight: "900", fontSize: 18, marginBottom: 4 },
  activeDesc: { color: theme.colors.textSecondary, fontSize: 12, marginBottom: 10, fontStyle: "italic" },
  runningLabel: { color: "#92400E", fontWeight: "800", fontSize: 12, marginBottom: 6 },
  openBadge: { padding: 10, borderRadius: 10, backgroundColor: theme.colors.success, flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 10 },
  openBadgeTxt: { color: "#fff", fontWeight: "700", fontSize: 11, flex: 1 },
  cdRow: { flexDirection: "row", gap: 6, justifyContent: "space-between", marginBottom: 12 },
  cdBox: { flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: 10, backgroundColor: theme.colors.surfaceSecondary },
  cdN: { fontSize: 22, fontWeight: "900", color: theme.colors.primary },
  cdL: { fontSize: 10, color: theme.colors.textSecondary, marginTop: 2 },
  kv: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 5 },
  kvL: { color: theme.colors.textSecondary, fontSize: 12 },
  kvV: { color: theme.colors.textPrimary, fontSize: 13, fontWeight: "700" },
  prizeTitle: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 13, marginBottom: 6 },
  prizeRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4, paddingHorizontal: 8, borderRadius: 6, backgroundColor: "#FEF3C7", marginBottom: 4 },
  prizeRank: { color: "#92400E", fontWeight: "800", fontSize: 12 },
  prizeAmt: { color: "#92400E", fontWeight: "800", fontSize: 12 },
  balanceBox: { marginTop: 12, padding: 10, borderRadius: 10, backgroundColor: theme.colors.surfaceSecondary, flexDirection: "row", justifyContent: "space-between" },
  balanceL: { color: theme.colors.textSecondary, fontSize: 12 },
  balanceV: { fontSize: 13, fontWeight: "800" },
  joinBtn: { marginTop: 14, padding: 14, borderRadius: 12, backgroundColor: "#F59E0B", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
  joinBtnDisabled: { opacity: 0.6 },
  joinBtnTxt: { color: "#fff", fontWeight: "900", fontSize: 14 },
  joinedBadge: { marginTop: 14, padding: 12, borderRadius: 10, backgroundColor: theme.colors.success, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
  joinedTxt: { color: "#fff", fontWeight: "800", fontSize: 13 },
  winnerRow: { flexDirection: "row", alignItems: "center", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "#FCD34D" },
  winnerRank: { fontSize: 18, fontWeight: "900", color: "#92400E", width: 60 },
  winnerName: { flex: 1, fontSize: 14, fontWeight: "700", color: theme.colors.textPrimary },
  winnerPrize: { fontSize: 14, fontWeight: "900", color: theme.colors.success },
  thanks: { marginTop: 10, fontStyle: "italic", color: theme.colors.textSecondary, fontSize: 11, textAlign: "center" },
  emptyTxt: { textAlign: "center", color: theme.colors.textSecondary, fontSize: 13, padding: 20 },
  disabledBox: { padding: 30, alignItems: "center", borderRadius: 12, backgroundColor: theme.colors.surfaceSecondary },
  disabledTxt: { color: theme.colors.textPrimary, fontSize: 14, textAlign: "center", marginTop: 8 },
});
