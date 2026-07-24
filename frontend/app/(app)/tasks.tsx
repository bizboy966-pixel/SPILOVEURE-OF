import React, { useCallback, useEffect, useState } from "react";
import { SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { theme } from "../../src/theme";
import { api } from "../../src/api";

// Simple "Tâches" hub — aggregates all revenue-generating activities.
// This page is the target of the central button in the bottom nav.
export default function TasksScreen() {
  const router = useRouter();
  const [tasks, setTasks] = useState<any[]>([]);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ items: any[] }>("/special-tasks");
      setTasks(r.items || []);
    } catch {}
  }, []);
  useEffect(() => { load(); }, [load]);

  const complete = async (id: string, link: string) => {
    if (typeof window !== "undefined") window.open(link, "_blank");
    try {
      const r = await api.post<{ credited: number; task_status: string }>(`/special-tasks/${id}/complete`);
      if (typeof window !== "undefined") window.alert(`✅ Tâche validée. Vous avez gagné ${r.credited} FCFA !`);
      load();
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert(`❌ ${e?.detail || "Impossible de valider la tâche."}`);
    }
  };

  const ACTION_ICONS: any = { video: "play", subscribe: "person-add", share: "share-social", like: "heart", comment: "chatbubble", group: "people" };
  const ACTION_BTN: any = { video: "▶️ Regarder", subscribe: "➕ S'abonner", share: "📤 Partager", like: "❤️ Aimer", comment: "💬 Commenter", group: "👥 Rejoindre" };
  const NET_LABELS: any = { tiktok: "TikTok", facebook: "Facebook", instagram: "Instagram", youtube: "YouTube", whatsapp: "WhatsApp", telegram: "Telegram" };

  const cards: { key: string; icon: any; title: string; sub: string; route?: string; soon?: boolean }[] = [
    {
      key: "missions",
      icon: "briefcase",
      title: "Missions Rémunérées",
      sub: "Missions quotidiennes récurrentes — retraits indépendants par catégorie.",
      route: "/(app)/missions",
    },
    {
      key: "campaigns",
      icon: "megaphone",
      title: "Campagnes rémunérées",
      sub: "Participez aux campagnes publicitaires de la communauté SPILOVEURE.",
      soon: true,
    },
    {
      key: "special",
      icon: "flash",
      title: "Tâches spéciales",
      sub: "Missions ponctuelles à forte récompense proposées par les annonceurs.",
      soon: true,
    },
    {
      key: "challenges",
      icon: "trophy",
      title: "Challenges actifs",
      sub: "Objectif d'invitations avec grosse récompense — voir le dashboard.",
      route: "/(app)/dashboard",
    },
  ];

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
                <TouchableOpacity onPress={() => complete(t.id, t.link)} style={styles.doBtn} testID={`st-do-${t.id}`}>
                  <Text style={styles.doT}>{ACTION_BTN[t.action_type].split(" ")[0]}</Text>
                </TouchableOpacity>
              </View>
            ))}
          </>
        )}
        {cards.map((c) => (
          <TouchableOpacity
            key={c.key}
            style={styles.card}
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
});
