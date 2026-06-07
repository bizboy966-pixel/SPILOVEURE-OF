import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Linking,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { api } from "@/src/api";
import { theme } from "@/src/theme";
import { EmptySoon } from "@/src/components/EmptySoon";

type Formation = {
  id: string;
  title: string;
  description?: string;
  image_url?: string;
  video_url?: string;
  pdf_url?: string;
  audio_url?: string;
  category?: string;
};

async function openUrl(url: string) {
  if (!url) return;
  if (Platform.OS === "web" && typeof window !== "undefined") {
    window.open(url, "_blank");
  } else {
    try {
      await Linking.openURL(url);
    } catch {}
  }
}

export default function FormationsScreen() {
  const router = useRouter();
  const [items, setItems] = useState<Formation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState<string | null>(null); // expanded card

  const load = useCallback(async () => {
    try {
      const r = await api.get<Formation[]>("/formations");
      setItems(Array.isArray(r) ? r : []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back} testID="back-btn">
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>
        <View style={styles.titleRow}>
          <Ionicons name="school" size={24} color="#fff" />
          <Text style={styles.title}>Formations</Text>
        </View>
        <Text style={styles.sub}>Vidéos, PDFs et audios pour accélérer votre apprentissage.</Text>
      </LinearGradient>

      {loading ? (
        <ActivityIndicator color={theme.colors.primary} style={{ marginTop: 32 }} />
      ) : items.length === 0 ? (
        <EmptySoon icon="school" />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          contentContainerStyle={{ padding: 14, paddingBottom: 60 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={async () => {
                setRefreshing(true);
                await load();
                setRefreshing(false);
              }}
            />
          }
          renderItem={({ item }) => (
            <View style={styles.card} testID={`formation-card-${item.id}`}>
              <View style={styles.cardTop}>
                {item.image_url ? (
                  <Image source={{ uri: item.image_url }} style={styles.cover} resizeMode="cover" />
                ) : (
                  <View style={[styles.cover, styles.coverPlaceholder]}>
                    <Ionicons name="school" size={28} color={theme.colors.primary} />
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  {item.category ? (
                    <Text style={styles.category}>{item.category.toUpperCase()}</Text>
                  ) : null}
                  <Text style={styles.cardTitle} numberOfLines={2}>{item.title}</Text>
                  {item.description ? (
                    <Text style={styles.cardBody} numberOfLines={open === item.id ? undefined : 2}>
                      {item.description}
                    </Text>
                  ) : null}
                  {item.description && item.description.length > 90 ? (
                    <TouchableOpacity onPress={() => setOpen(open === item.id ? null : item.id)}>
                      <Text style={styles.more}>{open === item.id ? "Voir moins" : "Voir plus"}</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              </View>

              <View style={styles.actions}>
                {item.video_url ? (
                  <ActionChip icon="play-circle" label="Vidéo" onPress={() => openUrl(item.video_url!)} testID={`formation-video-${item.id}`} />
                ) : null}
                {item.pdf_url ? (
                  <ActionChip icon="document-text" label="PDF" onPress={() => openUrl(item.pdf_url!)} testID={`formation-pdf-${item.id}`} />
                ) : null}
                {item.audio_url ? (
                  <ActionChip icon="headset" label="Audio" onPress={() => openUrl(item.audio_url!)} testID={`formation-audio-${item.id}`} />
                ) : null}
              </View>
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}

function ActionChip({
  icon, label, onPress, testID,
}: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void; testID?: string }) {
  return (
    <TouchableOpacity style={styles.chip} onPress={onPress} testID={testID}>
      <Ionicons name={icon} size={16} color="#fff" />
      <Text style={styles.chipTxt}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: { padding: 16, paddingTop: 22, paddingBottom: 18 },
  back: { width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center", marginBottom: 6 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { color: "#fff", fontSize: 22, fontWeight: "800" },
  sub: { color: "#C7D9FF", marginTop: 2, fontSize: 12 },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: 16, marginBottom: 12, padding: 12,
    borderWidth: 1, borderColor: theme.colors.border,
    ...theme.shadow.card,
  },
  cardTop: { flexDirection: "row", gap: 12 },
  cover: { width: 96, height: 96, borderRadius: 12, backgroundColor: theme.colors.surfaceSecondary },
  coverPlaceholder: { alignItems: "center", justifyContent: "center" },
  category: { color: theme.colors.primary, fontWeight: "800", fontSize: 10, letterSpacing: 0.8 },
  cardTitle: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 15, marginTop: 2, lineHeight: 18 },
  cardBody: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 17, marginTop: 4 },
  more: { color: theme.colors.primary, fontWeight: "700", marginTop: 4, fontSize: 11 },
  actions: { flexDirection: "row", gap: 8, marginTop: 10, flexWrap: "wrap" },
  chip: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 18, backgroundColor: theme.colors.primary },
  chipTxt: { color: "#fff", fontWeight: "700", fontSize: 12 },
});
