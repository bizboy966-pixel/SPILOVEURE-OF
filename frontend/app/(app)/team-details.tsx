import React, { useEffect, useMemo, useState } from "react";
import { FlatList, ScrollView, StyleSheet, Text, View, TouchableOpacity, TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";

import { Card } from "@/src/components/Card";
import { api } from "@/src/api";
import { theme } from "@/src/theme";
import { formatDate } from "@/src/utils/format";

const LEVEL_NAMES = ["Débutant", "Influenceur", "Archiveur", "Ambassadeur", "Pionnier", "Mentor", "Champion", "Directeur", "Titan", "Icône", "Légende", "Empereur"];

export default function TeamDetails() {
  const router = useRouter();
  const [level, setLevel] = useState(1);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [members, setMembers] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  // Capacity at matrix level N = 2^N (forced binary matrix)
  const capacity = useMemo(() => Math.pow(2, level), [level]);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get<any[]>(`/team/level?level=${level}`);
      setMembers(Array.isArray(r) ? r : []);
    } catch {
      setMembers([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [level]);

  // Client-side search + sort on the matrix-depth result
  const visible = useMemo(() => {
    let list = [...members];
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((m) =>
        (m.username || "").toLowerCase().includes(q) ||
        (m.email || "").toLowerCase().includes(q) ||
        (m.phone || "").toLowerCase().includes(q),
      );
    }
    list.sort((a, b) => {
      const da = new Date(a.created_at || 0).getTime();
      const db = new Date(b.created_at || 0).getTime();
      return sort === "newest" ? db - da : da - db;
    });
    return list;
  }, [members, search, sort]);

  const fillPercent = Math.min(100, Math.round((members.length / capacity) * 100));

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back}>
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>Détails d'équipe</Text>
        <Text style={styles.sub}>Membres présents dans votre matrice par niveau (2ⁿ par niveau).</Text>
      </LinearGradient>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.lvlBar}>
        {Array.from({ length: 12 }).map((_, i) => {
          const lvl = i + 1;
          const on = level === lvl;
          const cap = Math.pow(2, lvl);
          return (
            <TouchableOpacity
              key={lvl}
              style={[styles.lvlChip, on && styles.lvlChipOn]}
              onPress={() => setLevel(lvl)}
              testID={`level-filter-${lvl}`}
            >
              <Text style={[styles.lvlChipT, on && { color: "#fff" }]}>N{lvl}</Text>
              <Text style={[styles.lvlChipCap, on && { color: "rgba(255,255,255,0.85)" }]}>
                {cap >= 1000 ? `${cap / 1000}k` : cap}
              </Text>
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
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Niveau {level} — {LEVEL_NAMES[level - 1]}</Text>
          <Text style={styles.headerCount}>
            {members.length} / {capacity} place{capacity > 1 ? "s" : ""} occupée{members.length > 1 ? "s" : ""}
          </Text>
        </View>
        <View style={styles.fillPill}>
          <Text style={styles.fillPillT}>{fillPercent}%</Text>
        </View>
      </View>

      <View style={styles.progressBar}>
        <View style={[styles.progressFill, { width: `${fillPercent}%` }]} />
      </View>

      <FlatList
        data={visible}
        keyExtractor={(it) => it.id}
        contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
        ListEmptyComponent={
          <Card>
            <View style={{ alignItems: "center", padding: 32 }}>
              <Ionicons
                name={loading ? "hourglass-outline" : "search-outline"}
                size={48}
                color={theme.colors.textSecondary}
              />
              <Text style={{ color: theme.colors.textSecondary, marginTop: 12, textAlign: "center" }}>
                {loading
                  ? "Chargement..."
                  : `Aucun membre à la profondeur ${level} de votre matrice.${
                      search ? "" : `\nIl peut y en avoir jusqu'à ${capacity}.`
                    }`}
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
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <Text style={styles.username}>{item.username}</Text>
                  {item.is_spillover ? (
                    <View style={[styles.miniBadge, { backgroundColor: theme.colors.warningBg }]}>
                      <Text style={[styles.miniBadgeT, { color: theme.colors.warning }]}>↻ Spillover</Text>
                    </View>
                  ) : null}
                  {item.leg ? (
                    <View style={[styles.miniBadge, { backgroundColor: "#DBEAFE" }]}>
                      <Text style={[styles.miniBadgeT, { color: theme.colors.primary }]}>
                        {item.leg === "left" ? "Gauche" : "Droite"}
                      </Text>
                    </View>
                  ) : null}
                </View>
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
  lvlChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: "#fff", borderWidth: 1, borderColor: theme.colors.border, alignItems: "center", minWidth: 56 },
  lvlChipOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  lvlChipT: { fontWeight: "700", color: theme.colors.textPrimary, fontSize: 13 },
  lvlChipCap: { fontSize: 9, color: theme.colors.textSecondary, marginTop: -1 },
  controls: { flexDirection: "row", paddingHorizontal: 16, gap: 8 },
  searchBox: { flex: 1, backgroundColor: "#fff", borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10 },
  searchInput: { flex: 1, paddingVertical: 10, color: theme.colors.textPrimary, fontSize: 14 },
  sortBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 12, backgroundColor: "#DBEAFE", borderRadius: 12 },
  headerSection: { padding: 16, paddingBottom: 8, flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  headerTitle: { fontWeight: "800", color: theme.colors.textPrimary, fontSize: 16 },
  headerCount: { color: theme.colors.textSecondary, fontSize: 12, marginTop: 2 },
  fillPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, backgroundColor: "#DBEAFE" },
  fillPillT: { color: theme.colors.primary, fontWeight: "800", fontSize: 12 },
  progressBar: { height: 6, backgroundColor: theme.colors.border, marginHorizontal: 16, borderRadius: 4, overflow: "hidden" },
  progressFill: { height: 6, backgroundColor: theme.colors.primary },
  idx: { width: 28, fontWeight: "700", color: theme.colors.textSecondary, fontSize: 12 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotOn: { backgroundColor: theme.colors.success },
  dotOff: { backgroundColor: theme.colors.danger },
  username: { fontWeight: "700", color: theme.colors.textPrimary },
  meta: { color: theme.colors.textSecondary, fontSize: 11 },
  miniBadge: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 },
  miniBadgeT: { fontWeight: "700", fontSize: 10 },
});
