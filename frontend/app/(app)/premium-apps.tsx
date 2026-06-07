import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator, FlatList, Image, Linking, Platform, RefreshControl,
  StyleSheet, Text, TouchableOpacity, View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { api } from "@/src/api";
import { theme } from "@/src/theme";
import { EmptySoon } from "@/src/components/EmptySoon";

type App = {
  id: string; name: string; description?: string; image_url?: string;
  apk_url?: string; download_url?: string; version?: string;
};

async function openUrl(url: string) {
  if (!url) return;
  if (Platform.OS === "web" && typeof window !== "undefined") {
    window.open(url, "_blank");
  } else {
    try { await Linking.openURL(url); } catch {}
  }
}

export default function PremiumAppsScreen() {
  const router = useRouter();
  const [items, setItems] = useState<App[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get<App[]>("/premium-apps");
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
          <Ionicons name="diamond" size={24} color="#fff" />
          <Text style={styles.title}>Applications Premium</Text>
        </View>
        <Text style={styles.sub}>Téléchargez nos applications puissantes et innovantes.</Text>
      </LinearGradient>

      {loading ? (
        <ActivityIndicator color={theme.colors.primary} style={{ marginTop: 32 }} />
      ) : items.length === 0 ? (
        <EmptySoon icon="diamond" />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          contentContainerStyle={{ padding: 14, paddingBottom: 60 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
          renderItem={({ item }) => {
            const target = item.apk_url || item.download_url || "";
            return (
              <View style={styles.card} testID={`app-card-${item.id}`}>
                <View style={{ flexDirection: "row", gap: 12 }}>
                  {item.image_url ? (
                    <Image source={{ uri: item.image_url }} style={styles.icon} resizeMode="cover" />
                  ) : (
                    <View style={[styles.icon, styles.iconPlaceholder]}>
                      <Ionicons name="diamond" size={28} color={theme.colors.primary} />
                    </View>
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cardTitle}>{item.name}</Text>
                    {item.version ? <Text style={styles.version}>v{item.version}</Text> : null}
                    {item.description ? (
                      <Text style={styles.cardBody} numberOfLines={4}>{item.description}</Text>
                    ) : null}
                  </View>
                </View>
                {target ? (
                  <TouchableOpacity
                    style={styles.btn}
                    onPress={() => openUrl(target)}
                    testID={`app-download-${item.id}`}
                  >
                    <Ionicons name="download" size={18} color="#fff" />
                    <Text style={styles.btnTxt}>TÉLÉCHARGER</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            );
          }}
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
  icon: { width: 64, height: 64, borderRadius: 14, backgroundColor: theme.colors.surfaceSecondary },
  iconPlaceholder: { alignItems: "center", justifyContent: "center" },
  cardTitle: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 15 },
  version: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 1 },
  cardBody: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 17, marginTop: 4 },
  btn: { marginTop: 12, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 11, borderRadius: 22, backgroundColor: theme.colors.primary },
  btnTxt: { color: "#fff", fontWeight: "800", fontSize: 13, letterSpacing: 0.5 },
});
