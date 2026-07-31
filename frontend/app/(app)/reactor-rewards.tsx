/**
 * "Mes récompenses réacteur" — user-facing history of ad interaction rewards.
 *
 * V2 (2026-08):
 *   • Filter chips: Toutes / 👍 Likes / 💬 Commentaires
 *   • "Total par jour" section powered by the backend `by_day` aggregate
 *   • Grouped item list under each date header
 *   • Backwards-compatible with older feeds that included view/share
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ScrollView, StyleSheet, Text, View, TouchableOpacity,
  ActivityIndicator, RefreshControl,
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

type DailyTotal = {
  date: string; total: number; count: number;
  likes: number; comments: number;
};

type Payload = {
  items: Reward[];
  total_earned: number;
  by_day: DailyTotal[];
  filters: { action: string | null; from_date: string | null; to_date: string | null };
};

type FilterKey = "all" | "like" | "comment";

const ICONS: Record<string, string> = {
  view: "eye-outline",
  like: "heart",
  share: "share-social-outline",
  comment: "chatbubble",
};
const LABELS: Record<string, string> = {
  view: "Vue",
  like: "J'aime",
  share: "Partage",
  comment: "Commentaire",
};
const COLORS: Record<string, string> = {
  view: "#94A3B8",
  like: "#EF4444",
  share: "#F59E0B",
  comment: "#3B82F6",
};

const FILTERS: Array<{ key: FilterKey; label: string; icon: keyof typeof Ionicons.glyphMap }> = [
  { key: "all",     label: "Toutes",       icon: "layers-outline" },
  { key: "like",    label: "Likes",        icon: "heart" },
  { key: "comment", label: "Commentaires", icon: "chatbubble" },
];

function groupByDay(items: Reward[]): Array<{ date: string; rewards: Reward[] }> {
  const map: Record<string, Reward[]> = {};
  for (const r of items) {
    const day = (r.created_at || "").slice(0, 10);
    (map[day] = map[day] || []).push(r);
  }
  return Object.keys(map).sort((a, b) => (a > b ? -1 : 1)).map((d) => ({ date: d, rewards: map[d] }));
}

function friendlyDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  const today = new Date();
  const yest = new Date(); yest.setDate(today.getDate() - 1);
  const isSame = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (isSame(d, today)) return "Aujourd'hui";
  if (isSame(d, yest)) return "Hier";
  return d.toLocaleDateString("fr-FR", { weekday: "long", day: "2-digit", month: "short" });
}

export default function ReactorRewards() {
  const router = useRouter();
  const [data, setData] = useState<Payload | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<FilterKey>("all");

  const load = useCallback(async (f: FilterKey) => {
    try {
      const qs = f === "all" ? "" : `?action=${f}`;
      const r = await api.get<Payload>(`/me/reactor-rewards${qs}`);
      setData(r);
    } catch {
      setData({ items: [], total_earned: 0, by_day: [], filters: { action: null, from_date: null, to_date: null } });
    }
  }, []);

  useEffect(() => { load(filter); }, [load, filter]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load(filter);
    setRefreshing(false);
  };

  const grouped = useMemo(() => (data ? groupByDay(data.items) : []), [data]);
  const maxDayTotal = useMemo(
    () => (data && data.by_day.length > 0 ? Math.max(...data.by_day.map((d) => d.total)) : 0),
    [data],
  );

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
          <Text style={styles.totalLabel}>Total gagné {filter !== "all" && `(${LABELS[filter]}s)`}</Text>
          <Text style={styles.totalVal} testID="rr-total">
            {data ? data.total_earned.toLocaleString("fr-FR") : "—"} FCFA
          </Text>
        </View>
      </LinearGradient>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {/* Filter chips */}
        <View style={styles.filterRow}>
          {FILTERS.map((f) => {
            const on = filter === f.key;
            return (
              <TouchableOpacity
                key={f.key}
                onPress={() => setFilter(f.key)}
                style={[styles.chip, on && styles.chipOn]}
                testID={`rr-filter-${f.key}`}
              >
                <Ionicons name={f.icon} size={14} color={on ? "#fff" : theme.colors.textSecondary} />
                <Text style={[styles.chipTxt, on && styles.chipTxtOn]}>{f.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {!data && (
          <View style={styles.center}><ActivityIndicator size="large" color="#F59E0B" /></View>
        )}

        {data && data.items.length === 0 && (
          <Card>
            <View style={styles.empty}>
              <Ionicons name="megaphone-outline" size={48} color={theme.colors.textSecondary} />
              <Text style={styles.emptyT}>Aucune récompense pour le moment</Text>
              <Text style={styles.emptyS}>
                Aimez ou commentez les publicités pour gagner de l'argent réel.
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

        {data && data.by_day.length > 0 && (
          <Card style={{ marginBottom: 12 }}>
            <Text style={styles.section}>📊 Total par jour</Text>
            {data.by_day.slice(0, 14).map((d) => {
              const w = maxDayTotal > 0 ? Math.max(4, (d.total / maxDayTotal) * 100) : 4;
              return (
                <View key={d.date} style={styles.dayRow} testID={`rr-day-${d.date}`}>
                  <Text style={styles.dayLabel}>{friendlyDate(d.date)}</Text>
                  <View style={styles.barTrack}>
                    <View style={[styles.barFill, { width: `${w}%` }]} />
                  </View>
                  <Text style={styles.dayTotal}>+{d.total.toLocaleString("fr-FR")}</Text>
                </View>
              );
            })}
          </Card>
        )}

        {data && data.items.length > 0 && (
          <Card>
            <Text style={styles.section}>Historique ({data.items.length})</Text>
            {grouped.map(({ date, rewards }) => (
              <View key={date} style={{ marginBottom: 6 }}>
                <Text style={styles.groupHead}>{friendlyDate(date)}</Text>
                {rewards.map((it) => {
                  const color = COLORS[it.action] || "#F59E0B";
                  return (
                    <View key={it.id} style={styles.row} testID={`rr-row-${it.id}`}>
                      <View style={[styles.rowIcon, { backgroundColor: color + "22" }]}>
                        <Ionicons name={(ICONS[it.action] || "star-outline") as any} size={18} color={color} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.rowLabel}>{LABELS[it.action] || it.action}</Text>
                        <Text style={styles.rowMeta}>{new Date(it.created_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</Text>
                      </View>
                      <Text style={styles.rowAmount}>+{it.amount.toLocaleString("fr-FR")} {it.currency}</Text>
                    </View>
                  );
                })}
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
  groupHead: {
    fontWeight: "800", fontSize: 12, color: theme.colors.textSecondary,
    textTransform: "uppercase", letterSpacing: 0.6, marginTop: 8, marginBottom: 4,
  },
  filterRow: { flexDirection: "row", gap: 8, marginBottom: 12, flexWrap: "wrap" },
  chip: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20,
    backgroundColor: "#fff", borderWidth: 1, borderColor: theme.colors.border,
  },
  chipOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  chipTxt: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: "800" },
  chipTxtOn: { color: "#fff" },
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
    paddingVertical: 8, borderBottomWidth: 1, borderColor: theme.colors.border,
  },
  rowIcon: {
    width: 34, height: 34, borderRadius: 12,
    alignItems: "center", justifyContent: "center",
  },
  rowLabel: { fontWeight: "800", fontSize: 13, color: theme.colors.textPrimary },
  rowMeta: { fontSize: 10, color: theme.colors.textSecondary, marginTop: 1 },
  rowAmount: { color: "#10B981", fontWeight: "900", fontSize: 14 },
  dayRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingVertical: 6,
  },
  dayLabel: { width: 90, fontSize: 11, fontWeight: "700", color: theme.colors.textSecondary },
  barTrack: {
    flex: 1, height: 8, backgroundColor: "#F1F5F9",
    borderRadius: 4, overflow: "hidden",
  },
  barFill: { height: "100%", backgroundColor: "#F59E0B", borderRadius: 4 },
  dayTotal: { width: 84, textAlign: "right", fontWeight: "900", fontSize: 12, color: "#10B981" },
});
