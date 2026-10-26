import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, Image, Modal, Platform, ScrollView,
  StyleSheet, Text, TouchableOpacity, View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { theme } from "@/src/theme";
import { api, resolveMediaUrl } from "@/src/api";
import { useFeatures } from "@/src/features";
import { BottomNav } from "@/src/components/BottomNav";
import { ChallengeCard, CurrentChallenge } from "@/src/components/tasks/ChallengeCard";

/**
 * TÂCHES → Voir plus (v17 — 2026-02-14).
 *
 * Sub-catalog reachable from `/(app)/tasks` via the "Voir plus" CTA.
 * Contains every extra tasks-related feature that used to sit on the
 * main hub: user-submitted active special tasks, "Tâches spéciales"
 * creator flow, and "Challenges actifs". Business logic is preserved
 * as-is; only navigation is re-shaped.
 */
export default function TasksMoreScreen() {
  const router = useRouter();
  const { task: focusTaskId } = useLocalSearchParams<{ task?: string }>();
  const [focus, setFocus] = useState<{ available: boolean; message: string } | null>(null);
  const { features } = useFeatures();
  const [tasks, setTasks] = useState<any[]>([]);
  const [challenge, setChallenge] = useState<CurrentChallenge | null>(null);
  const [loading, setLoading] = useState(true);

  // ── Screenshot-proof modal state (same as the historical tasks.tsx) ──
  const [proofTask, setProofTask] = useState<any | null>(null);
  const [proofUrl, setProofUrl] = useState<string>("");
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [proofErr, setProofErr] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    const [st, ch] = await Promise.all([
      api.get<{ items: any[] }>("/special-tasks").catch(() => ({ items: [] })),
      api.get<CurrentChallenge>("/challenges/current").catch(() => null),
    ]);
    setTasks(st.items || []);
    setChallenge(ch);
    setLoading(false);
  }, []);
  useEffect(() => {
    load();
    (async () => { try { await api.post("/special-tasks/mark-seen", {}); } catch {} })();
  }, [load]);

  useEffect(() => {
    if (!focusTaskId) { setFocus(null); return; }
    api.get<{ available: boolean; message: string }>(`/special-tasks/${focusTaskId}/availability`)
      .then(setFocus).catch(() => setFocus(null));
  }, [focusTaskId]);

  const openTaskLink = (t: any) => {
    if (typeof window !== "undefined") window.open(t.link, "_blank");
    setProofTask(t); setProofUrl(""); setProofErr(null);
  };
  const closeProof = () => { if (submitting || uploading) return; setProofTask(null); setProofUrl(""); setProofErr(null); };
  const pickScreenshot = () => { if (Platform.OS !== "web") return; fileInputRef.current?.click(); };
  const handleFile = async (file: File | null | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setProofErr("Le fichier doit être une image (capture d'écran)."); return; }
    setProofErr(null); setUploading(true);
    try {
      const r = await api.upload<{ url: string }>("/user/uploads", file);
      setProofUrl(r.url);
    } catch (e: any) { setProofErr(e?.detail || "Échec de l'envoi de la capture."); }
    finally { setUploading(false); }
  };
  const submitProof = async () => {
    if (!proofTask || !proofUrl) { setProofErr("Ajoutez une capture d'écran pour valider."); return; }
    setSubmitting(true); setProofErr(null);
    try {
      const r = await api.post<{ credited: number; ai?: { verified: boolean; confidence: number } }>(
        `/special-tasks/${proofTask.id}/complete`, { proof_url: proofUrl },
      );
      if (typeof window !== "undefined") {
        const conf = r.ai ? ` (IA : ${(r.ai.confidence * 100).toFixed(0)}%)` : "";
        window.alert(`✅ Tâche validée${conf}. Vous avez gagné ${r.credited} FCFA !`);
      }
      setProofTask(null); setProofUrl(""); load();
    } catch (e: any) { setProofErr(e?.detail || "Impossible de valider la tâche."); }
    finally { setSubmitting(false); }
  };

  const ACTION_ICONS: any = { video: "play", subscribe: "person-add", share: "share-social", like: "heart", comment: "chatbubble", group: "people" };
  const ACTION_BTN: any = { video: "Regarder", subscribe: "S'abonner", share: "Partager", like: "Aimer", comment: "Commenter", group: "Rejoindre" };
  const NET_LABELS: any = { tiktok: "TikTok", facebook: "Facebook", instagram: "Instagram", youtube: "YouTube", whatsapp: "WhatsApp", telegram: "Telegram" };

  const EXTRA_CARDS = [
    {
      key: "special", title: "Créer ma campagne",
      subtitle: "Créez votre campagne de likes, abonnements, vues, partages ou groupes.",
      icon: "add-circle", color: "#7B61FF", bg: "#EDE9FE",
      route: "/(app)/special-task-create",
      hidden: !features.special_tasks,
    },
  ];

  const previewUri = proofUrl ? resolveMediaUrl(proofUrl) : "";

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <SafeAreaView edges={["top"]}>
          <View style={styles.headerRow}>
            <TouchableOpacity onPress={() => router.back()} style={styles.back} testID="tasks-more-back">
              <Ionicons name="chevron-back" size={22} color="#fff" />
            </TouchableOpacity>
            <View>
              <Text style={styles.title}>Tâches spéciales</Text>
              <Text style={styles.subtitle}>Tâches et challenges actifs</Text>
            </View>
          </View>
        </SafeAreaView>
      </LinearGradient>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 140, width: "100%", maxWidth: 760, alignSelf: "center" }}>
        {loading ? <ActivityIndicator color={theme.colors.primary} style={{ marginVertical: 24 }} testID="tasks-more-loading" /> : null}

        {focus ? (
          <View style={[styles.focusBanner, focus.available ? styles.focusOk : styles.focusKo]} testID={`task-focus-${focus.available ? "available" : "unavailable"}`}>
            <Ionicons name={focus.available ? "checkmark-circle" : "alert-circle"} size={18} color={focus.available ? "#047857" : "#B91C1C"} />
            <Text style={[styles.focusTxt, { color: focus.available ? "#047857" : "#B91C1C" }]}>
              {focus.available ? "Cette tâche est disponible : retrouvez-la en surbrillance ci-dessous." : focus.message}
            </Text>
          </View>
        ) : null}

        <Text style={styles.sectionTitle}>Tâches spéciales disponibles{loading ? "" : ` (${tasks.length})`}</Text>
        {!loading && tasks.length === 0 ? (
          <View style={styles.empty} testID="special-tasks-empty">
            <Ionicons name="flash-outline" size={22} color={theme.colors.textMuted} />
            <Text style={styles.emptyTxt}>Aucune tâche spéciale disponible pour le moment. Revenez bientôt !</Text>
          </View>
        ) : null}
        {tasks.length > 0 ? (
          <>
            {[...tasks].sort((a, b) => Number(b.id === focusTaskId) - Number(a.id === focusTaskId)).map((t) => (
              <View key={t.id} style={[styles.taskCard, t.id === focusTaskId && styles.taskFocused]} testID={`st-card-${t.id}`}>
                <View style={styles.taskIcon}>
                  <Ionicons name={ACTION_ICONS[t.action_type]} size={22} color="#fff" />
                </View>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <Text style={styles.taskTitle}>{ACTION_BTN[t.action_type]} · {NET_LABELS[t.network]}</Text>
                    <View style={styles.liveBadge}><Text style={styles.liveBadgeTxt}>Disponible</Text></View>
                    {t.is_new ? (
                      <View style={styles.newBadge} testID={`st-new-${t.id}`}>
                        <Text style={styles.newBadgeTxt}>NOUVEAU</Text>
                      </View>
                    ) : null}
                  </View>
                  <Text style={styles.taskSub} numberOfLines={3}>{t.description || "Aucune description"}</Text>
                  <Text style={styles.taskRule}>Effectuez l'action puis envoyez une capture d'écran comme preuve. Une seule validation par tâche.</Text>
                  <Text style={styles.reward} testID={`st-reward-${t.id}`}>
                    {t.reward_per_action} FCFA · {t.quantity_completed}/{t.quantity_target} places prises
                  </Text>
                </View>
                <TouchableOpacity onPress={() => openTaskLink(t)} style={styles.doBtn} testID={`st-do-${t.id}`}>
                  <Text style={styles.doT}>Commencer</Text>
                </TouchableOpacity>
              </View>
            ))}
          </>
        ) : null}

        <Text style={[styles.sectionTitle, { marginTop: 10 }]}>Challenge actif</Text>
        {challenge?.challenge ? (
          <ChallengeCard data={challenge} />
        ) : !loading ? (
          <View style={styles.empty} testID="challenge-empty">
            <Ionicons name="trophy-outline" size={22} color={theme.colors.textMuted} />
            <Text style={styles.emptyTxt}>Aucun challenge actif en ce moment.</Text>
          </View>
        ) : null}

        {features.special_tasks ? <Text style={[styles.sectionTitle, { marginTop: 10 }]}>Votre campagne</Text> : null}
        {EXTRA_CARDS.filter((c) => !c.hidden).map((c) => (
          <TouchableOpacity
            key={c.key}
            style={styles.card}
            onPress={() => router.push(c.route as any)}
            activeOpacity={0.85}
            testID={`tasks-more-${c.key}`}
          >
            <View style={[styles.catIcon, { backgroundColor: c.bg }]}>
              <Ionicons name={c.icon as any} size={24} color={c.color} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>{c.title}</Text>
              <Text style={styles.cardSub}>{c.subtitle}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={theme.colors.textSecondary} />
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Screenshot-proof modal — inchangé, préservé de tasks.tsx */}
      <Modal visible={!!proofTask} animationType="slide" transparent onRequestClose={closeProof}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard} testID="proof-modal">
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Preuve d'exécution</Text>
              <TouchableOpacity onPress={closeProof} disabled={submitting || uploading}>
                <Ionicons name="close" size={22} color={theme.colors.textSecondary} />
              </TouchableOpacity>
            </View>
            <Text style={styles.modalStep}>1. Effectuez l'action demandée sur le lien qui vient de s'ouvrir.</Text>
            <Text style={styles.modalStep}>2. Prenez une capture d'écran montrant clairement l'action réalisée.</Text>
            <Text style={styles.modalStep}>3. Importez-la ci-dessous, puis validez pour recevoir votre récompense.</Text>
            <TouchableOpacity
              style={[styles.uploadBtn, uploading && { opacity: 0.6 }]}
              onPress={pickScreenshot}
              disabled={uploading || submitting || Platform.OS !== "web"}
              testID="proof-pick-btn"
            >
              {uploading ? <ActivityIndicator color="#fff" size="small" /> : <Ionicons name="cloud-upload-outline" size={16} color="#fff" />}
              <Text style={styles.uploadTxt}>{uploading ? "Envoi…" : proofUrl ? "Remplacer la capture" : "Importer une capture d'écran"}</Text>
            </TouchableOpacity>
            {proofUrl && previewUri ? (
              <View style={styles.previewBox}>
                <Image source={{ uri: previewUri }} style={styles.previewImg} resizeMode="cover" />
                <Text style={styles.previewOk}>Capture prête à être envoyée</Text>
              </View>
            ) : null}
            {proofErr ? <Text style={styles.errTxt}>{proofErr}</Text> : null}
            <View style={styles.modalActions}>
              <TouchableOpacity onPress={closeProof} style={styles.cancelBtn} disabled={submitting || uploading} testID="proof-cancel-btn">
                <Text style={styles.cancelTxt}>Annuler</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={submitProof} style={[styles.submitBtn, (!proofUrl || submitting) && { opacity: 0.5 }]} disabled={!proofUrl || submitting || uploading} testID="proof-submit-btn">
                {submitting ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.submitTxt}>Valider & recevoir</Text>}
              </TouchableOpacity>
            </View>
            {Platform.OS === "web" && (
              // @ts-ignore raw html input on web only
              <input ref={fileInputRef as any} type="file" accept="image/*" style={{ display: "none" }} onChange={(e: any) => handleFile(e?.target?.files?.[0])} />
            )}
          </View>
        </View>
      </Modal>

      <BottomNav />
    </View>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 14, paddingBottom: 14 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 6 },
  back: { width: 38, height: 38, borderRadius: 19, backgroundColor: "rgba(255,255,255,0.16)", alignItems: "center", justifyContent: "center" },
  title: { color: "#fff", fontSize: 20, fontWeight: "900", letterSpacing: -0.2 },
  subtitle: { color: "#A5C2FF", fontSize: 11, marginTop: 2 },

  sectionTitle: { fontWeight: "900", color: theme.colors.textPrimary, fontSize: 14, marginBottom: 10, letterSpacing: -0.2 },

  taskCard: {
    flexDirection: "row", alignItems: "center", gap: 12,
    padding: 12, borderRadius: 16, marginBottom: 10,
    backgroundColor: theme.colors.surface,
    borderWidth: 1, borderColor: theme.colors.border,
    ...theme.shadow.card,
  },
  taskIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: theme.colors.primary, alignItems: "center", justifyContent: "center" },
  taskTitle: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 13 },
  taskSub: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 2 },
  reward: { fontSize: 11, color: theme.colors.success, fontWeight: "800", marginTop: 4 },
  newBadge: { backgroundColor: "#EF4444", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8 },
  newBadgeTxt: { color: "#fff", fontWeight: "900", fontSize: 9, letterSpacing: 0.5 },
  liveBadge: { backgroundColor: "#D1FAE5", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8 },
  liveBadgeTxt: { color: "#047857", fontWeight: "900", fontSize: 9 },
  taskRule: { color: theme.colors.textMuted, fontSize: 10.5, marginTop: 3, lineHeight: 14 },
  empty: {
    flexDirection: "row", alignItems: "center", gap: 10, padding: 14, borderRadius: 16, marginBottom: 12,
    backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, borderStyle: "dashed",
  },
  emptyTxt: { flex: 1, color: theme.colors.textSecondary, fontSize: 12.5 },
  focusBanner: { flexDirection: "row", alignItems: "center", gap: 8, padding: 12, borderRadius: 14, marginBottom: 12, borderWidth: 1 },
  focusOk: { backgroundColor: "#ECFDF5", borderColor: "#A7F3D0" },
  focusKo: { backgroundColor: "#FEF2F2", borderColor: "#FECACA" },
  focusTxt: { flex: 1, fontSize: 12.5, fontWeight: "700" },
  taskFocused: { borderColor: "#7B61FF", borderWidth: 2 },
  doBtn: { backgroundColor: theme.colors.primary, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 12 },
  doT: { color: "#fff", fontWeight: "900", fontSize: 12 },

  card: {
    flexDirection: "row", alignItems: "center", gap: 14,
    padding: 14, borderRadius: 18, marginBottom: 12,
    backgroundColor: theme.colors.surface,
    borderWidth: 1, borderColor: theme.colors.border,
    ...theme.shadow.card,
  },
  catIcon: { width: 52, height: 52, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  cardTitle: { fontSize: 14, fontWeight: "900", color: theme.colors.textPrimary, letterSpacing: -0.2 },
  cardSub: { fontSize: 12, color: theme.colors.textSecondary, marginTop: 3, lineHeight: 17 },

  modalOverlay: { flex: 1, backgroundColor: "rgba(11,45,111,0.55)", alignItems: "center", justifyContent: "center", padding: 20 },
  modalCard: { width: "100%", maxWidth: 480, backgroundColor: "#fff", borderRadius: 24, padding: 20 },
  modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 14 },
  modalTitle: { fontSize: 18, fontWeight: "900", color: theme.colors.textPrimary },
  modalStep: { fontSize: 13, color: theme.colors.textSecondary, marginBottom: 8, lineHeight: 19 },
  uploadBtn: { marginTop: 8, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: theme.colors.primary, paddingVertical: 12, borderRadius: 14 },
  uploadTxt: { color: "#fff", fontWeight: "800", fontSize: 14 },
  previewBox: { marginTop: 12, borderRadius: 14, overflow: "hidden", borderWidth: 1, borderColor: theme.colors.border },
  previewImg: { width: "100%", height: 180, backgroundColor: "#F1F5F9" },
  previewOk: { color: theme.colors.success, fontWeight: "700", fontSize: 12, padding: 8, textAlign: "center" },
  errTxt: { color: theme.colors.danger, fontSize: 12, marginTop: 10, fontWeight: "600" },
  modalActions: { flexDirection: "row", gap: 10, marginTop: 18 },
  cancelBtn: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 12, borderRadius: 14, borderWidth: 1.5, borderColor: theme.colors.border },
  cancelTxt: { color: theme.colors.textSecondary, fontWeight: "700" },
  submitBtn: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 12, borderRadius: 14, backgroundColor: theme.colors.success },
  submitTxt: { color: "#fff", fontWeight: "900" },
});
