import React, { useEffect, useState, useCallback } from "react";
import { FlatList, RefreshControl, StyleSheet, Text, View, TouchableOpacity } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";

import { Card } from "@/src/components/Card";
import { api } from "@/src/api";
import { theme } from "@/src/theme";
import { formatDate } from "@/src/utils/format";

export default function TeamDirect() {
  const router = useRouter();
  const [data, setData] = useState<any>({ members: [], active: 0, inactive: 0 });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get("/team/direct");
      setData(r);
    } catch {}
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back}>
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>Équipe directe</Text>
        <Text style={styles.sub}>Vos filleuls directs et leur statut.</Text>
        <View style={styles.statsRow}>
          <View style={styles.statBox}>
            <Text style={styles.statLbl}>Total</Text>
            <Text style={styles.statVal}>{data.members?.length || 0}</Text>
          </View>
          <View style={[styles.statBox, { backgroundColor: "rgba(16,185,129,0.25)" }]}>
            <Text style={styles.statLbl}>Actifs</Text>
            <Text style={styles.statVal}>{data.active}</Text>
          </View>
          <View style={[styles.statBox, { backgroundColor: "rgba(239,68,68,0.25)" }]}>
            <Text style={styles.statLbl}>Inactifs</Text>
            <Text style={styles.statVal}>{data.inactive}</Text>
          </View>
        </View>
      </LinearGradient>

      <FlatList
        data={data.members || []}
        keyExtractor={(it) => it.id}
        contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
        ListEmptyComponent={
          <Card>
            <View style={{ alignItems: "center", paddingVertical: 32 }}>
              <Ionicons name="people-outline" size={48} color={theme.colors.textSecondary} />
              <Text style={{ color: theme.colors.textSecondary, marginTop: 12, textAlign: "center" }}>
                Aucun filleul direct pour le moment.{"\n"}Partagez votre lien d'invitation !
              </Text>
            </View>
          </Card>
        }
        renderItem={({ item }) => (
          <Card style={{ marginBottom: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <View style={[styles.avatar, item.status === "active" ? styles.avatarActive : styles.avatarInactive]}>
                <Ionicons name="person" size={20} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.username}>{item.username}</Text>
                <Text style={styles.meta}>Niveau {item.max_level || 0} • {formatDate(item.created_at)}</Text>
              </View>
              <View style={[styles.pill, item.status === "active" ? styles.pillActive : styles.pillInactive]}>
                <Text style={[styles.pillT, { color: item.status === "active" ? theme.colors.success : theme.colors.danger }]}>
                  {item.status === "active" ? "Actif" : "Inactif"}
                </Text>
              </View>
            </View>
          </Card>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: { padding: 16, paddingTop: 24, paddingBottom: 20 },
  back: { width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center", marginBottom: 8 },
  title: { color: "#fff", fontSize: 24, fontWeight: "800" },
  sub: { color: "#C7D9FF" },
  statsRow: { flexDirection: "row", gap: 8, marginTop: 16 },
  statBox: { flex: 1, backgroundColor: "rgba(255,255,255,0.15)", padding: 12, borderRadius: 12, alignItems: "center" },
  statLbl: { color: "#C7D9FF", fontSize: 11 },
  statVal: { color: "#fff", fontSize: 20, fontWeight: "800" },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  avatarActive: { backgroundColor: theme.colors.success },
  avatarInactive: { backgroundColor: theme.colors.textSecondary },
  username: { fontWeight: "700", color: theme.colors.textPrimary },
  meta: { color: theme.colors.textSecondary, fontSize: 12 },
  pill: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  pillActive: { backgroundColor: theme.colors.successBg },
  pillInactive: { backgroundColor: theme.colors.dangerBg },
  pillT: { fontWeight: "700", fontSize: 11 },
});
