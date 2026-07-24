import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, Image, Modal, Platform, SafeAreaView, ScrollView,
  StyleSheet, Text, TouchableOpacity, View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { theme } from "../../src/theme";
import { api, resolveMediaUrl } from "../../src/api";
import { useFeatures } from "../../src/features";

// Simple "Tâches" hub — aggregates all revenue-generating activities.
export default function TasksScreen() {
  const router = useRouter();
  const { features } = useFeatures();
  const [tasks, setTasks] = useState<any[]>([]);

  // Screenshot-proof modal state
  const [proofTask, setProofTask] = useState<any | null>(null);
  const [proofUrl, setProofUrl] = useState<string>("");
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [proofErr, setProofErr] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ items: any[] }>("/special-tasks");
      setTasks(r.items || []);
    } catch {}
  }, []);
  useEffect(() => { load(); }, [load]);

  const openTaskLink = (t: any) => {
    if (typeof window !== "undefined") window.open(t.link, "_blank");
    setProofTask(t);
    setProofUrl("");
    setProofErr(null);
  };

  const closeProof = () => {
    if (submitting || uploading) return;
    setProofTask(null);
    setProofUrl("");
    setProofErr(null);
  };

  const pickScreenshot = () => {
    if (Platform.OS !== "web") return;
    fileInputRef.current?.click();
  };

  const handleFile = async (file: File | null | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setProofErr("Le fichier doit être une image (capture d'écran).");
      return;
    }
    setProofErr(null);
    setUploading(true);
    try {
      const r = await api.upload<{ url: string }>("/user/uploads", file);
      setProofUrl(r.url);
    } catch (e: any) {
      setProofErr(e?.detail || "Échec de l'envoi de la capture.");
    } finally {
      setUploading(false);
    }
  };

  const submitProof = async () => {
    if (!proofTask || !proofUrl) {
      setProofErr("Ajoutez une capture d'écran pour valider.");
      return;
    }
    setSubmitting(true);
    setProofErr(null);
    try {
      const r = await api.post<{ credited: number; task_status: string }>(
        `/special-tasks/${proofTask.id}/complete`,
        { proof_url: proofUrl },
      );
      if (typeof window !== "undefined") {
        window.alert(`✅ Tâche validée. Vous avez gagné ${r.credited} FCFA !`);
      }
      setProofTask(null);
      setProofUrl("");
      load();
    } catch (e: any) {
      setProofErr(e?.detail || "Impossible de valider la tâche.");
    } finally {
      setSubmitting(false);
    }
  };

  const ACTION_ICONS: any = { video: "play", subscribe: "person-add", share: "share-social", like: "heart", comment: "chatbubble", group: "people" };
  const ACTION_BTN: any = { video: "▶️ Regarder", subscribe: "➕ S'abonner", share: "📤 Partager", like: "❤️ Aimer", comment: "💬 Commenter", group: "👥 Rejoindre" };
  const NET_LABELS: any = { tiktok: "TikTok", facebook: "Facebook", instagram: "Instagram", youtube: "YouTube", whatsapp: "WhatsApp", telegram: "Telegram" };

  const cards: { key: string; icon: any; title: string; sub: string; route?: string; soon?: boolean; hidden?: boolean }[] = [
    {
      key: "missions", icon: "briefcase",
      title: "Missions Rémunérées",
      sub: "Missions quotidiennes récurrentes — retraits indépendants par catégorie.",
      route: "/(app)/missions",
      hidden: !features.paid_tasks,
    },
    {
      key: "campaigns", icon: "megaphone",
      title: "Campagnes rémunérées",
      sub: "Participez aux campagnes publicitaires de la communauté SPILOVEURE.",
      soon: true,
      hidden: !features.ads,
    },
    {
      key: "special", icon: "flash",
      title: "Tâches spéciales",
      sub: "Missions ponctuelles à forte récompense proposées par les annonceurs.",
      soon: true,
      hidden: !features.special_tasks,
    },
    {
      key: "challenges", icon: "trophy",
      title: "Challenges actifs",
      sub: "Objectif d'invitations avec grosse récompense — voir le dashboard.",
      route: "/(app)/dashboard",
    },
  ];

  const previewUri = proofUrl ? resolveMediaUrl(proofUrl) : "";

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} testID="tasks-back">
          <Ionicons name="arrow-back" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>📋 Tâches</Text>
      </View>
      <ScrollView contentContainerStyle={styles.list}>
        <Text style={styles.intro}>
          Toutes les activités rémunérées de SPILOVEURE en un seul endroit. Choisissez une catégorie pour commencer à générer des revenus.
        </Text>

        {tasks.length > 0 && (
          <>
            <Text style={{ fontWeight: "900", fontSize: 14, color: theme.colors.textPrimary, marginTop: 8 }}>🔥 Tâches actives ({tasks.length})</Text>
            {tasks.map((t) => (
              <View key={t.id} style={styles.card} testID={`st-card-${t.id}`}>
                <View style={styles.iconBox}>
                  <Ionicons name={ACTION_ICONS[t.action_type]} size={22} color="#fff" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>{ACTION_BTN[t.action_type]} • {NET_LABELS[t.network]}</Text>
                  <Text style={styles.cardSub} numberOfLines={2}>{t.description || "Aucune description"}</Text>
                  <Text style={{ fontSize: 11, color: theme.colors.success, fontWeight: "800", marginTop: 4 }}>
                    💰 {t.reward_per_action} FCFA • {t.quantity_completed}/{t.quantity_target}
                  </Text>
                </View>
                <TouchableOpacity onPress={() => openTaskLink(t)} style={styles.doBtn} testID={`st-do-${t.id}`}>
                  <Text style={styles.doT}>{ACTION_BTN[t.action_type].split(" ")[0]}</Text>
                </TouchableOpacity>
              </View>
            ))}
          </>
        )}
        {cards.filter((c) => !c.hidden).map((c) => (
          <TouchableOpacity
            key={c.key} style={styles.card}
            onPress={() => {
              if (c.route) router.push(c.route as any);
              else if (typeof window !== "undefined") window.alert("🚧 Bientôt disponible");
            }}
            testID={`tasks-card-${c.key}`}
          >
            <View style={styles.iconBox}>
              <Ionicons name={c.icon} size={22} color="#fff" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>{c.title}</Text>
              <Text style={styles.cardSub}>{c.sub}</Text>
            </View>
            {c.soon ? (
              <View style={styles.soonBadge}>
                <Text style={styles.soonText}>Bientôt</Text>
              </View>
            ) : (
              <Ionicons name="chevron-forward" size={20} color={theme.colors.textSecondary} />
            )}
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* ─── Screenshot-proof modal ────────────────────────────── */}
      <Modal
        visible={!!proofTask}
        animationType="slide"
        transparent
        onRequestClose={closeProof}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard} testID="proof-modal">
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>📸 Preuve d'exécution</Text>
              <TouchableOpacity onPress={closeProof} disabled={submitting || uploading}>
                <Ionicons name="close" size={22} color={theme.colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalStep}>
              1️⃣ Effectuez l'action demandée sur le lien qui vient de s'ouvrir.
            </Text>
            <Text style={styles.modalStep}>
              2️⃣ Prenez une <Text style={{ fontWeight: "800" }}>capture d'écran</Text> montrant clairement l'action réalisée.
            </Text>
            <Text style={styles.modalStep}>
              3️⃣ Importez-la ci-dessous, puis validez pour recevoir votre récompense.
            </Text>

            <TouchableOpacity
              style={[styles.uploadBtn, uploading && { opacity: 0.6 }]}
              onPress={pickScreenshot}
              disabled={uploading || submitting || Platform.OS !== "web"}
              testID="proof-pick-btn"
            >
              {uploading ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Ionicons name="cloud-upload-outline" size={16} color="#fff" />
              )}
              <Text style={styles.uploadTxt}>
                {uploading ? "Envoi…" : proofUrl ? "Remplacer la capture" : "Importer une capture d'écran"}
              </Text>
            </TouchableOpacity>

            {proofUrl && previewUri ? (
              <View style={styles.previewBox}>
                <Image source={{ uri: previewUri }} style={styles.previewImg} resizeMode="cover" />
                <Text style={styles.previewOk}>✓ Capture prête à être envoyée</Text>
              </View>
            ) : null}

            {proofErr ? <Text style={styles.errTxt}>{proofErr}</Text> : null}

            <View style={styles.modalActions}>
              <TouchableOpacity
                onPress={closeProof}
                style={styles.cancelBtn}
                disabled={submitting || uploading}
                testID="proof-cancel-btn"
              >
                <Text style={styles.cancelTxt}>Annuler</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={submitProof}
                style={[styles.submitBtn, (!proofUrl || submitting) && { opacity: 0.5 }]}
                disabled={!proofUrl || submitting || uploading}
                testID="proof-submit-btn"
              >
                {submitting ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.submitTxt}>Valider & recevoir</Text>
                )}
              </TouchableOpacity>
            </View>

            {Platform.OS === "web" && (
              // @ts-ignore raw html input on web only
              <input
                ref={fileInputRef as any}
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={(e: any) => handleFile(e?.target?.files?.[0])}
              />
            )}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: 16, paddingTop: 16, paddingBottom: 14,
    backgroundColor: theme.colors.primary,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignItems: "center", justifyContent: "center",
  },
  title: { color: "#fff", fontWeight: "900", fontSize: 18 },
  list: { padding: 16, gap: 12 },
  intro: { color: theme.colors.textSecondary, fontSize: 13, marginBottom: 4 },
  card: {
    flexDirection: "row", alignItems: "center", gap: 12,
    padding: 14, borderRadius: 14,
    backgroundColor: theme.colors.surface,
    borderWidth: 1, borderColor: theme.colors.border,
  },
  iconBox: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: theme.colors.primary,
    alignItems: "center", justifyContent: "center",
  },
  cardTitle: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 15 },
  cardSub: { color: theme.colors.textSecondary, fontSize: 12, marginTop: 2 },
  soonBadge: {
    backgroundColor: theme.colors.warning,
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12,
  },
  soonText: { color: "#fff", fontWeight: "800", fontSize: 10 },
  doBtn: { backgroundColor: theme.colors.primary, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 },
  doT: { color: "#fff", fontWeight: "900", fontSize: 12 },

  // Modal
  modalOverlay: {
    flex: 1, backgroundColor: "rgba(11,45,111,0.55)",
    alignItems: "center", justifyContent: "center", padding: 20,
  },
  modalCard: {
    width: "100%", maxWidth: 480,
    backgroundColor: "#fff", borderRadius: 20, padding: 20,
  },
  modalHeader: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    marginBottom: 14,
  },
  modalTitle: { fontSize: 18, fontWeight: "900", color: theme.colors.textPrimary },
  modalStep: { fontSize: 13, color: theme.colors.textSecondary, marginBottom: 8, lineHeight: 19 },
  uploadBtn: {
    marginTop: 8, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: theme.colors.primary, paddingVertical: 12, borderRadius: 12,
  },
  uploadTxt: { color: "#fff", fontWeight: "800", fontSize: 14 },
  previewBox: {
    marginTop: 12, borderRadius: 12, overflow: "hidden",
    borderWidth: 1, borderColor: theme.colors.border,
  },
  previewImg: { width: "100%", height: 180, backgroundColor: "#F1F5F9" },
  previewOk: { color: theme.colors.success, fontWeight: "700", fontSize: 12, padding: 8, textAlign: "center" },
  errTxt: { color: theme.colors.danger, fontSize: 12, marginTop: 10, fontWeight: "600" },
  modalActions: { flexDirection: "row", gap: 10, marginTop: 18 },
  cancelBtn: {
    flex: 1, alignItems: "center", justifyContent: "center",
    paddingVertical: 12, borderRadius: 12,
    borderWidth: 1.5, borderColor: theme.colors.border,
  },
  cancelTxt: { color: theme.colors.textSecondary, fontWeight: "700" },
  submitBtn: {
    flex: 1, alignItems: "center", justifyContent: "center",
    paddingVertical: 12, borderRadius: 12,
    backgroundColor: theme.colors.success,
  },
  submitTxt: { color: "#fff", fontWeight: "900" },
});
