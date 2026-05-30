import React, { useEffect, useState } from "react";
import { FlatList, ScrollView, StyleSheet, Text, View, TouchableOpacity, TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";

import { Card } from "@/src/components/Card";
import { api } from "@/src/api";
import { theme } from "@/src/theme";
import { formatDate } from "@/src/utils/format";

const LEVEL_NAMES = ["Débutant","Influenceur","Archiveur","Ambassadeur","Pionnier","Mentor","Champion","Directeur","Titan","Icône","Légende","Empereur"];

export default function TeamDetails() {
  const router = useRouter();
  const [level, setLevel] = useState(1);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [members, setMembers] = useState<any[]>([]);

  const load = async () => {
    try {
      const params = new URLSearchParams({ level: String(level), sort });
      if (search) params.set("search", search);
      const r = await api.get<any[]>(`/team/details?${params.toString()}`);
      setMembers(r);
    } catch {
      setMembers([]);
    }
  };

  useEffect(() => { load(); }, [level, sort]);

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back}>
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>Détails d'équipe</Text>
        <Text style={styles.sub}>Filtrer par niveau, rechercher, trier.</Text>
      </LinearGradient>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.lvlBar}>
        {Array.from({ length: 12 }).map((_, i) => {
          const lvl = i + 1;
          const on = level === lvl;
          return (
            <TouchableOpacity
              key={lvl}
              style={[styles.lvlChip, on && styles.lvlChipOn]}
              onPress={() => setLevel(lvl)}
              testID={`level-filter-${lvl}`}
            >
              <Text style={[styles.lvlChipT, on && { color: "#fff" }]}>N{lvl}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <View style={styles.controls}>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={16} color={theme.colors.textSecondary} />
          <TextInput
            placeholder="Rechercher nom, téléphone..."
            placeholderTextColor={theme.colors.textSecondary}
            value={search}
            onChangeText={setSearch}
            onSubmitEditing={load}
            style={styles.searchInput}
            testID="team-search"
          />
        </View>
        <TouchableOpacity
          style={styles.sortBtn}
          onPress={() => setSort((s) => (s === "newest" ? "oldest" : "newest"))}
          testID="team-sort"
        >
          <Ionicons name={sort === "newest" ? "arrow-down" : "arrow-up"} size={16} color={theme.colors.primary} />
          <Text style={{ color: theme.colors.primary, fontWeight: "700", fontSize: 12 }}>
            {sort === "newest" ? "Récent" : "Ancien"}
          </Text>
        </TouchableOpacity>
      </View>

      <View style={styles.headerSection}>
        <Text style={styles.headerTitle}>Niveau {level} — {LEVEL_NAMES[level - 1]}</Text>
        <Text style={styles.headerCount}>{members.length} membre(s)</Text>
      </View>

      <FlatList
        data={members}
        keyExtractor={(it) => it.id}
        contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
        ListEmptyComponent={
          <Card>
            <View style={{ alignItems: "center", padding: 32 }}>
              <Ionicons name="search-outline" size={48} color={theme.colors.textSecondary} />
              <Text style={{ color: theme.colors.textSecondary, marginTop: 12 }}>
                Aucun membre dans votre matrice niveau {level}.
              </Text>
            </View>
          </Card>
        }
        renderItem={({ item, index }) => (
          <Card style={{ marginBottom: 6 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <Text style={styles.idx}>#{index + 1}</Text>
              <View style={[styles.dot, item.status === "active" ? styles.dotOn : styles.dotOff]} />
              <View style={{ flex: 1 }}>
                <Text style={styles.username}>{item.username}</Text>
                <Text style={styles.meta}>Niveau {item.max_level || 0} • Invité par {item.sponsor_username || "—"}</Text>
                <Text style={styles.meta}>{formatDate(item.created_at)}</Text>
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
  lvlBar: { padding: 12, gap: 6 },
  lvlChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: "#fff", borderWidth: 1, borderColor: theme.colors.border },
  lvlChipOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  lvlChipT: { fontWeight: "700", color: theme.colors.textPrimary },
  controls: { flexDirection: "row", paddingHorizontal: 16, gap: 8 },
  searchBox: { flex: 1, backgroundColor: "#fff", borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10 },
  searchInput: { flex: 1, paddingVertical: 10, color: theme.colors.textPrimary, fontSize: 14 },
  sortBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 12, backgroundColor: "#DBEAFE", borderRadius: 12 },
  headerSection: { padding: 16, paddingBottom: 8, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  headerTitle: { fontWeight: "800", color: theme.colors.textPrimary, fontSize: 16 },
  headerCount: { color: theme.colors.textSecondary, fontSize: 12 },
  idx: { width: 28, fontWeight: "700", color: theme.colors.textSecondary, fontSize: 12 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotOn: { backgroundColor: theme.colors.success },
  dotOff: { backgroundColor: theme.colors.danger },
  username: { fontWeight: "700", color: theme.colors.textPrimary },
  meta: { color: theme.colors.textSecondary, fontSize: 11 },
});
