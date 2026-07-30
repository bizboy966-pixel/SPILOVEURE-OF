/**
 * "Mes récompenses réacteur" — user-facing history of ad interaction rewards.
 *
 * Reads from GET /api/me/reactor-rewards and shows a running total plus a
 * chronological feed of individual credits (view / like / share / comment).
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  ScrollView, StyleSheet, Text, View, TouchableOpacity, ActivityIndicator, RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { Card } from "@/src/components/Card";
import { api } from "@/src/api";
import { theme } from "@/src/theme";

type Reward = {
  id: string;
  ad_id: string;
  action: "view" | "like" | "share" | "comment";
  amount: number;
  currency: string;
  created_at: string;
};

type Payload = { items: Reward[]; total_earned: number };

const ICONS: Record<string, string> = {
  view: "eye-outline",
  like: "heart-outline",
  share: "share-social-outline",
  comment: "chatbubble-outline",
};
const LABELS: Record<string, string> = {
  view: "Vue",
  like: "J'aime",
  share: "Partage",
  comment: "Commentaire",
};

export default function ReactorRewards() {
  const router = useRouter();
  const [data, setData] = useState<Payload | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get<Payload>("/me/reactor-rewards");
      setData(r);
    } catch {
      setData({ items: [], total_earned: 0 });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <LinearGradient colors={["#0F172A", "#1E293B"]} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} testID="rr-back">
          <Ionicons name="chevron-back" size={22} color="#fff" />
          <Text style={styles.backTxt}>Retour</Text>
        </TouchableOpacity>
        <View style={styles.headerRow}>
          <View style={styles.headerIcon}><Ionicons name="trophy" size={26} color="#0F172A" /></View>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>🎯 Mes récompenses réacteur</Text>
            <Text style={styles.headerSub}>Gains sur les publicités où vous avez interagi</Text>
          </View>
        </View>
        <View style={styles.totalBlock}>
          <Text style={styles.totalLabel}>Total gagné</Text>
          <Text style={styles.totalVal} testID="rr-total">
            {data ? data.total_earned.toLocaleString("fr-FR") : "—"} FCFA
          </Text>
        </View>
      </LinearGradient>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {!data && (
          <View style={styles.center}><ActivityIndicator size="large" color="#F59E0B" /></View>
        )}

        {data && data.items.length === 0 && (
          <Card>
            <View style={styles.empty}>
              <Ionicons name="megaphone-outline" size={48} color={theme.colors.textSecondary} />
              <Text style={styles.emptyT}>Aucune récompense pour le moment</Text>
              <Text style={styles.emptyS}>
                Regardez, aimez, partagez ou commentez les publicités
                sur la plateforme pour gagner de l'argent réel.
              </Text>
              <TouchableOpacity
                style={styles.cta}
                onPress={() => router.push("/(app)/advertising" as any)}
                testID="rr-cta-ads"
              >
                <Ionicons name="arrow-forward" size={16} color="#fff" />
                <Text style={styles.ctaT}>Voir les publicités</Text>
              </TouchableOpacity>
            </View>
          </Card>
        )}

        {data && data.items.length > 0 && (
          <Card>
            <Text style={styles.section}>Historique ({data.items.length})</Text>
            {data.items.map((it) => (
              <View key={it.id} style={styles.row} testID={`rr-row-${it.id}`}>
                <View style={styles.rowIcon}>
                  <Ionicons name={(ICONS[it.action] || "star-outline") as any} size={18} color="#F59E0B" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowLabel}>{LABELS[it.action] || it.action}</Text>
                  <Text style={styles.rowMeta}>{new Date(it.created_at).toLocaleString("fr-FR")}</Text>
                </View>
                <Text style={styles.rowAmount}>+{it.amount.toLocaleString("fr-FR")} {it.currency}</Text>
              </View>
            ))}
          </Card>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#F1F5F9" },
  header: { padding: 18, paddingBottom: 22 },
  backBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    alignSelf: "flex-start", paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 20, backgroundColor: "rgba(255,255,255,0.12)",
  },
  backTxt: { color: "#fff", fontWeight: "700", fontSize: 13 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 14 },
  headerIcon: {
    width: 52, height: 52, borderRadius: 16, backgroundColor: "#FBBF24",
    alignItems: "center", justifyContent: "center",
  },
  headerTitle: { color: "#fff", fontWeight: "900", fontSize: 20 },
  headerSub: { color: "#CBD5E1", fontSize: 12, marginTop: 2 },
  totalBlock: {
    marginTop: 16, backgroundColor: "rgba(245, 158, 11, 0.15)",
    borderWidth: 1, borderColor: "rgba(245, 158, 11, 0.4)",
    padding: 12, borderRadius: 14, alignItems: "center",
  },
  totalLabel: { color: "#FDE68A", fontSize: 11, fontWeight: "700" },
  totalVal: { color: "#fff", fontSize: 28, fontWeight: "900", marginTop: 2 },
  center: { padding: 40, alignItems: "center" },
  section: { fontWeight: "800", fontSize: 15, color: theme.colors.textPrimary, marginBottom: 10 },
  empty: { alignItems: "center", padding: 24, gap: 8 },
  emptyT: { fontWeight: "800", fontSize: 15, color: theme.colors.textPrimary },
  emptyS: { textAlign: "center", color: theme.colors.textSecondary, fontSize: 12, lineHeight: 17 },
  cta: {
    marginTop: 12, flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: theme.colors.primary, paddingHorizontal: 16, paddingVertical: 10,
    borderRadius: 20,
  },
  ctaT: { color: "#fff", fontWeight: "800", fontSize: 13 },
  row: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingVertical: 10, borderBottomWidth: 1, borderColor: theme.colors.border,
  },
  rowIcon: {
    width: 34, height: 34, borderRadius: 12,
    backgroundColor: "rgba(245, 158, 11, 0.15)",
    alignItems: "center", justifyContent: "center",
  },
  rowLabel: { fontWeight: "800", fontSize: 13, color: theme.colors.textPrimary },
  rowMeta: { fontSize: 10, color: theme.colors.textSecondary, marginTop: 1 },
  rowAmount: { color: "#10B981", fontWeight: "900", fontSize: 14 },
});
