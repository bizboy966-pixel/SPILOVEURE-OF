/**
 * Paid Missions — user page. Lists missions, embeds a timer enforcing the
 * minimum watch duration, optional question, and credits the reward to the
 * matching wallet on success.
 */
import React, { useEffect, useState, useCallback } from "react";
import { Linking, Platform, RefreshControl, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { api } from "@/src/api";
import { theme } from "@/src/theme";

const TYPE_META: Record<string, { label: string; icon: any; color: string }> = {
  youtube: { label: "YouTube", icon: "logo-youtube", color: "#FF0000" },
  tiktok: { label: "TikTok", icon: "musical-notes", color: "#000" },
  instagram: { label: "Instagram", icon: "logo-instagram", color: "#E1306C" },
  facebook: { label: "Facebook", icon: "logo-facebook", color: "#1877F2" },
  questionnaire: { label: "Questionnaire", icon: "help-circle", color: "#7B61FF" },
};

function fmt(n: number) { return `${Math.round(n)} FCFA`; }

function MissionCard({ m, onDone }: any) {
  const router = useRouter();
  const meta = TYPE_META[m.type] || { label: m.type, icon: "play", color: theme.colors.primary };
  const [watched, setWatched] = useState(0);
  const [running, setRunning] = useState(false);
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setWatched((s) => Math.min(s + 1, m.duration_seconds + 1)), 1000);
    return () => clearInterval(t);
  }, [running, m.duration_seconds]);

  const open = () => {
    if (!m.url) return;
    setRunning(true);
    if (Platform.OS === "web" && typeof window !== "undefined") window.open(m.url, "_blank");
    else Linking.openURL(m.url).catch(() => {});
  };

  const canValidate = watched >= (m.duration_seconds || 0);
  const submit = async () => {
    setSubmitting(true);
    try {
      const r = await api.post<any>(`/missions/${m.id}/complete`, { watched_seconds: watched, answer });
      if (typeof window !== "undefined") window.alert(`✅ +${r.reward} FCFA crédités sur votre solde ${meta.label}`);
      onDone?.();
    } catch (e: any) {
      Alert.alert("Erreur", e?.detail || "Impossible de valider.");
    } finally {
      setSubmitting(false);
    }
  };

  if (m.completed_by_user) {
    return (
      <View style={[styles.card, { opacity: 0.55 }]} testID={`mission-${m.id}`}>
        <Text style={styles.title}>{m.title}</Text>
        <Text style={styles.done}>✅ Mission déjà validée</Text>
      </View>
    );
  }

  return (
    <View style={styles.card} testID={`mission-${m.id}`}>
      <View style={styles.head}>
        <View style={[styles.typePill, { backgroundColor: meta.color }]}>
          <Ionicons name={meta.icon} size={12} color="#fff" />
          <Text style={styles.typeTxt}>{meta.label}</Text>
        </View>
        <Text style={styles.reward}>+{fmt(m.reward)}</Text>
      </View>
      <Text style={styles.title}>{m.title}</Text>
      {m.description ? <Text style={styles.desc}>{m.description}</Text> : null}

      {m.url && m.type !== "questionnaire" ? (
        <TouchableOpacity style={styles.openBtn} onPress={open} testID={`mission-open-${m.id}`}>
          <Ionicons name="play-circle" size={16} color="#fff" />
          <Text style={styles.openTxt}>Ouvrir la vidéo</Text>
        </TouchableOpacity>
      ) : null}

      <Text style={styles.timer}>
        ⏱ {watched}s / {m.duration_seconds}s {canValidate ? "✅" : ""}
      </Text>

      {m.question ? (
        <View style={{ marginTop: 6 }}>
          <Text style={styles.q}>❓ {m.question}</Text>
          <TextInput
            style={styles.input}
            value={answer}
            onChangeText={setAnswer}
            placeholder="Votre réponse"
            placeholderTextColor={theme.colors.textSecondary}
            testID={`mission-answer-${m.id}`}
          />
        </View>
      ) : null}

      <TouchableOpacity
        style={[styles.validateBtn, !canValidate && { backgroundColor: theme.colors.surfaceSecondary }]}
        onPress={submit}
        disabled={!canValidate || submitting}
        testID={`mission-validate-${m.id}`}
      >
        <Text style={[styles.validateTxt, !canValidate && { color: theme.colors.textSecondary }]}>
          {submitting ? "Validation…" : canValidate ? "✅ Valider la mission" : "Patientez…"}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

export default function MissionsPage() {
  const router = useRouter();
  const [items, setItems] = useState<any[]>([]);
  const [windowOpen, setWindowOpen] = useState(true);
  const [message, setMessage] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [wallets, setWallets] = useState<any>({ wallets: [], total: 0 });

  const load = useCallback(async () => {
    try {
      const [m, w] = await Promise.all([
        api.get<any>("/missions"),
        api.get<any>("/me/mission-wallets"),
      ]);
      setItems(m.items || []);
      setWindowOpen(!!m.window_open);
      setMessage(m.message || "");
      setWallets(w);
    } catch {}
  }, []);

  useEffect(() => { load(); }, [load]);

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
        <View style={styles.totalCard}>
          <Text style={styles.totalLbl}>💰 Solde total Missions</Text>
          <Text style={styles.totalVal}>{fmt(wallets.total || 0)}</Text>
        </View>

        {!windowOpen ? (
          <View style={styles.closed} testID="missions-closed-banner">
            <Text style={styles.closedTxt}>{message || "🚫 Missions actuellement indisponibles.\n📅 Lundi à Vendredi de 08h00 à 16h00."}</Text>
          </View>
        ) : items.length === 0 ? (
          <Text style={styles.empty}>Aucune mission disponible pour le moment.</Text>
        ) : (
          items.map((m) => <MissionCard key={m.id} m={m} onDone={load} />)
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 12 },
  hTitle: { color: "#fff", fontWeight: "800", fontSize: 16 },
  totalCard: { padding: 14, borderRadius: 14, backgroundColor: theme.colors.surface, marginBottom: 10, borderWidth: 1, borderColor: theme.colors.border },
  totalLbl: { color: theme.colors.textSecondary, fontSize: 12 },
  totalVal: { color: theme.colors.primary, fontWeight: "800", fontSize: 22, marginTop: 4 },
  closed: { padding: 18, borderRadius: 14, backgroundColor: "#FEF2F2", borderWidth: 1, borderColor: theme.colors.danger },
  closedTxt: { color: theme.colors.danger, fontWeight: "700", textAlign: "center" },
  empty: { color: theme.colors.textSecondary, textAlign: "center", marginTop: 30 },
  card: { padding: 14, borderRadius: 14, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, marginBottom: 10 },
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
});
