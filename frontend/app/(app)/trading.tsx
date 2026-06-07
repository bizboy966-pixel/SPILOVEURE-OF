import React, { useEffect, useState } from "react";
import { ActivityIndicator, Linking, Platform, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { api } from "@/src/api";
import { theme } from "@/src/theme";
import { EmptySoon } from "@/src/components/EmptySoon";

type TradingCfg = { enabled: boolean; telegram_url: string; label: string; description?: string };

export default function TradingScreen() {
  const router = useRouter();
  const [cfg, setCfg] = useState<TradingCfg | null>(null);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.get<TradingCfg>("/settings/trading");
        setCfg(r);
      } catch {
        setCfg(null);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const openTelegram = async () => {
    const url = cfg?.telegram_url || "";
    if (!url) return;
    setOpening(true);
    try {
      if (Platform.OS === "web" && typeof window !== "undefined") {
        window.open(url, "_blank");
      } else {
        await Linking.openURL(url);
      }
    } catch {}
    setOpening(false);
  };

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back} testID="back-btn">
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>
        <View style={styles.titleRow}>
          <Ionicons name="trending-up" size={24} color="#fff" />
          <Text style={styles.title}>Trading</Text>
        </View>
        <Text style={styles.sub}>Rejoignez notre communauté Telegram pour analyser et trader ensemble.</Text>
      </LinearGradient>

      {loading ? (
        <ActivityIndicator color={theme.colors.primary} style={{ marginTop: 32 }} />
      ) : !cfg?.enabled || !cfg?.telegram_url ? (
        <EmptySoon icon="trending-up" />
      ) : (
        <View style={styles.body}>
          <View style={styles.iconCircle}>
            <Ionicons name="paper-plane" size={56} color="#229ED9" />
          </View>
          <Text style={styles.tg}>Communauté Trading</Text>
          {cfg.description ? <Text style={styles.desc}>{cfg.description}</Text> : (
            <Text style={styles.desc}>
              Apprenez, analysez et tradez intelligemment pour générer des revenus sur les marchés financiers.
            </Text>
          )}

          <TouchableOpacity
            style={styles.cta}
            onPress={openTelegram}
            disabled={opening}
            testID="open-telegram-btn"
          >
            {opening ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <Ionicons name="paper-plane" size={18} color="#fff" />
                <Text style={styles.ctaTxt}>REJOINDRE TELEGRAM</Text>
              </>
            )}
          </TouchableOpacity>
          <Text style={styles.url} numberOfLines={1}>{cfg.telegram_url}</Text>
        </View>
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
  body: { padding: 32, alignItems: "center" },
  iconCircle: {
    width: 110, height: 110, borderRadius: 55, backgroundColor: "#E6F4FB",
    alignItems: "center", justifyContent: "center", borderWidth: 6, borderColor: "#fff",
    ...theme.shadow.card,
  },
  tg: { fontSize: 22, fontWeight: "900", color: theme.colors.textPrimary, marginTop: 16 },
  desc: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 19, textAlign: "center", marginTop: 8 },
  cta: {
    marginTop: 22,
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 28, paddingVertical: 13,
    borderRadius: 28, backgroundColor: "#229ED9",
    ...theme.shadow.button,
  },
  ctaTxt: { color: "#fff", fontWeight: "900", letterSpacing: 0.5 },
  url: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 12, fontStyle: "italic" },
});
