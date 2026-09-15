import React, { useCallback, useEffect, useState } from "react";
import {
  Alert, FlatList, RefreshControl, StyleSheet, Text, TouchableOpacity, View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { theme } from "@/src/theme";
import { api } from "@/src/api";
import { BottomNav } from "@/src/components/BottomNav";

type Notif = {
  id: string;
  title: string;
  body?: string;
  read: boolean;
  created_at: string;
  kind?: string;
};

const KIND_ICON: Record<string, any> = {
  deposit: "arrow-down-circle",
  withdrawal: "arrow-up-circle",
  commission: "cash",
  reactor_reward: "flame",
  reward: "gift",
  activation: "shield-checkmark",
  level_up: "trophy",
  lottery_win: "trophy",
  task: "checkmark-circle",
  ad: "megaphone",
};

function fmt(dt: string) {
  try {
    const d = new Date(dt);
    return d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch { return dt; }
}

export default function NotificationsScreen() {
  const router = useRouter();
  const [items, setItems] = useState<Notif[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ items: Notif[] }>("/me/notifications?limit=100");
      setItems(r.items || []);
    } catch {}
  }, []);
  useEffect(() => { load(); }, [load]);

  const markAll = async () => {
    try {
      await api.post("/me/notifications/mark-all-read", {});
      load();
    } catch {}
  };

  const deleteAll = () => {
    const doIt = async () => {
      try { await api.delete("/me/notifications/all"); load(); }
      catch {}
    };
    if (typeof window !== "undefined" && !window.confirm("Supprimer toutes les notifications ?")) return;
    doIt();
  };

  const openOne = async (n: Notif) => {
    if (!n.read) {
      try { await api.post(`/me/notifications/${n.id}/read`, {}); load(); } catch {}
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <SafeAreaView edges={["top"]}>
          <View style={styles.headerRow}>
            <TouchableOpacity onPress={() => router.back()} style={styles.back} testID="notif-back">
              <Ionicons name="chevron-back" size={22} color="#fff" />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Notifications</Text>
              <Text style={styles.subtitle}>{items.filter(i => !i.read).length} non lues</Text>
            </View>
          </View>
          <View style={styles.actionsRow}>
            <TouchableOpacity style={styles.actionBtn} onPress={markAll} testID="notif-mark-all">
              <Ionicons name="checkmark-done" size={14} color="#fff" />
              <Text style={styles.actionTxt}>Tout marquer lu</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionBtn, styles.actionBtnDanger]} onPress={deleteAll} testID="notif-delete-all">
              <Ionicons name="trash" size={14} color="#fff" />
              <Text style={styles.actionTxt}>Tout supprimer</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </LinearGradient>

      <FlatList
        data={items}
        keyExtractor={(it) => it.id}
        contentContainerStyle={{ padding: 12, paddingBottom: 140 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
        ListEmptyComponent={
          <View style={styles.empty} testID="notif-empty">
            <Ionicons name="notifications-off" size={44} color={theme.colors.textSecondary} />
            <Text style={styles.emptyT}>Aucune notification</Text>
            <Text style={styles.emptyS}>Les nouveaux événements de votre compte apparaîtront ici.</Text>
          </View>
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            style={[styles.card, !item.read && styles.cardUnread]}
            onPress={() => openOne(item)}
            testID={`notif-${item.id}`}
          >
            <View style={[styles.iconWrap, !item.read && { backgroundColor: theme.colors.primaryBg }]}>
              <Ionicons name={KIND_ICON[item.kind || ""] || "notifications"} size={20} color={theme.colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle} numberOfLines={1}>{item.title}</Text>
              {item.body ? <Text style={styles.cardBody} numberOfLines={2}>{item.body}</Text> : null}
              <Text style={styles.cardDate}>{fmt(item.created_at)}</Text>
            </View>
            {!item.read ? <View style={styles.dot} /> : null}
          </TouchableOpacity>
        )}
      />

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
  actionsRow: { flexDirection: "row", gap: 8, marginTop: 12 },
  actionBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: "rgba(255,255,255,0.16)", paddingVertical: 10, borderRadius: 12 },
  actionBtnDanger: { backgroundColor: "rgba(239,68,68,0.35)" },
  actionTxt: { color: "#fff", fontWeight: "800", fontSize: 12 },
  card: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 14, marginBottom: 8, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border },
  cardUnread: { backgroundColor: theme.colors.primaryBg, borderColor: theme.colors.primary },
  iconWrap: { width: 40, height: 40, borderRadius: 14, backgroundColor: theme.colors.surfaceMuted, alignItems: "center", justifyContent: "center" },
  cardTitle: { fontWeight: "900", fontSize: 13, color: theme.colors.textPrimary },
  cardBody: { color: theme.colors.textSecondary, fontSize: 12, marginTop: 2, lineHeight: 17 },
  cardDate: { color: theme.colors.textSecondary, fontSize: 10, marginTop: 4, fontWeight: "600" },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.primary },
  empty: { alignItems: "center", justifyContent: "center", padding: 40, gap: 8 },
  emptyT: { fontSize: 16, fontWeight: "900", color: theme.colors.textPrimary, marginTop: 8 },
  emptyS: { color: theme.colors.textSecondary, textAlign: "center", fontSize: 12 },
});
