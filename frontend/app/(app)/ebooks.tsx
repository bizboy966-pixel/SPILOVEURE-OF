import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator, FlatList, Image, Linking, Platform, RefreshControl,
  StyleSheet, Text, TouchableOpacity, View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { api, resolveMediaUrl } from "@/src/api";
import { theme } from "@/src/theme";
import { EmptySoon } from "@/src/components/EmptySoon";

type Ebook = { id: string; title: string; description?: string; image_url?: string; pdf_url?: string };

async function openUrl(url: string) {
  const u = resolveMediaUrl(url);
  if (!u) return;
  if (Platform.OS === "web" && typeof window !== "undefined") {
    window.open(u, "_blank");
  } else {
    try { await Linking.openURL(u); } catch {}
  }
}

export default function EbooksScreen() {
  const router = useRouter();
  const [items, setItems] = useState<Ebook[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get<Ebook[]>("/ebooks");
      setItems(Array.isArray(r) ? r : []);
    } catch { setItems([]); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back} testID="back-btn">
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>
        <View style={styles.titleRow}>
          <Ionicons name="book" size={24} color="#fff" />
          <Text style={styles.title}>E-Books</Text>
        </View>
        <Text style={styles.sub}>Lisez et téléchargez nos e-books exclusifs.</Text>
      </LinearGradient>

      {loading ? (
        <ActivityIndicator color={theme.colors.primary} style={{ marginTop: 32 }} />
      ) : items.length === 0 ? (
        <EmptySoon icon="book" />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          contentContainerStyle={{ padding: 14, paddingBottom: 60 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
          renderItem={({ item }) => (
            <View style={styles.card} testID={`ebook-card-${item.id}`}>
              <View style={{ flexDirection: "row", gap: 12 }}>
                {item.image_url ? (
                  <Image source={{ uri: resolveMediaUrl(item.image_url) }} style={styles.cover} resizeMode="cover" />
                ) : (
                  <View style={[styles.cover, styles.coverPlaceholder]}>
                    <Ionicons name="book" size={32} color={theme.colors.primary} />
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>{item.title}</Text>
                  {item.description ? (
                    <Text style={styles.cardBody} numberOfLines={4}>{item.description}</Text>
                  ) : null}
                </View>
              </View>
              {item.pdf_url ? (
                <View style={styles.actions}>
                  <TouchableOpacity
                    style={styles.btnPrimary}
                    onPress={() => openUrl(item.pdf_url!)}
                    testID={`ebook-read-${item.id}`}
                  >
                    <Ionicons name="book" size={16} color="#fff" />
                    <Text style={styles.btnPrimaryTxt}>LIRE</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.btnSecondary}
                    onPress={() => openUrl(item.pdf_url!)}
                    testID={`ebook-download-${item.id}`}
                  >
                    <Ionicons name="download" size={16} color={theme.colors.primary} />
                    <Text style={styles.btnSecondaryTxt}>TÉLÉCHARGER</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: { padding: 16, paddingTop: 22, paddingBottom: 18 },
  back: { width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center", marginBottom: 6 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { color: "#fff", fontSize: 22, fontWeight: "800" },
  sub: { color: "#C7D9FF", marginTop: 2, fontSize: 12 },
  card: { backgroundColor: theme.colors.surface, borderRadius: 16, marginBottom: 12, padding: 12, borderWidth: 1, borderColor: theme.colors.border, ...theme.shadow.card },
  cover: { width: 80, height: 110, borderRadius: 10, backgroundColor: theme.colors.surfaceSecondary },
  coverPlaceholder: { alignItems: "center", justifyContent: "center" },
  cardTitle: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 15 },
  cardBody: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 17, marginTop: 4 },
  actions: { flexDirection: "row", gap: 8, marginTop: 12 },
  btnPrimary: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, paddingVertical: 10, borderRadius: 18, backgroundColor: theme.colors.primary },
  btnPrimaryTxt: { color: "#fff", fontWeight: "800", fontSize: 12 },
  btnSecondary: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, paddingVertical: 10, borderRadius: 18, backgroundColor: "#DBEAFE" },
  btnSecondaryTxt: { color: theme.colors.primary, fontWeight: "800", fontSize: 12 },
});
