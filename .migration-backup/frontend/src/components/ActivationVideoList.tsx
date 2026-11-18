/**
 * ActivationVideoList — public list of admin-uploaded guide videos shown
 * on the payment/activation page BEFORE the user activates.
 *
 * Source: GET /api/settings/activation-videos.
 * Player: native <video> tag on web with full HTML5 controls (play/pause,
 * volume, fullscreen). On native RN, expo-av <Video> would be used but
 * SPILOVEURE is web-first so we ship the HTML5 tag inline.
 *
 * The component is silent when the admin has not uploaded any video.
 */
import React, { useEffect, useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api";
import { theme } from "@/src/theme";

type Video = {
  id: string;
  title: string;
  description?: string;
  url: string;
  content_type?: string;
};

// Backend URL to build absolute video URL from `/api/uploads/xxx`.
const BASE = process.env.EXPO_PUBLIC_BACKEND_URL || "";

export function ActivationVideoList() {
  const [items, setItems] = useState<Video[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.get<{ items: Video[] }>("/settings/activation-videos");
        setItems(r.items || []);
      } catch {
        setItems([]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading || items.length === 0) return null;

  return (
    <View style={styles.wrap} testID="activation-videos-section">
      <View style={styles.headerRow}>
        <Ionicons name="videocam" size={20} color={theme.colors.primary} />
        <Text style={styles.header}>🎥 Vidéos d'activation</Text>
      </View>
      <Text style={styles.sub}>
        Regardez ces vidéos avant d'effectuer votre paiement pour
        comprendre les étapes clés.
      </Text>
      {items.map((v, i) => {
        const src = v.url.startsWith("http") ? v.url : `${BASE}${v.url}`;
        return (
          <View key={v.id} style={styles.card} testID={`activation-video-${v.id}`}>
            <Text style={styles.title}>
              {i + 1}. {v.title}
            </Text>
            {!!v.description && <Text style={styles.desc}>{v.description}</Text>}
            {Platform.OS === "web" ? (
              // @ts-ignore — native web video element for full HTML5 controls
              <video
                src={src}
                controls
                preload="metadata"
                playsInline
                style={{
                  width: "100%",
                  maxHeight: 300,
                  borderRadius: 12,
                  backgroundColor: "#000",
                  marginTop: 8,
                }}
              />
            ) : (
              <View style={styles.nativeFallback}>
                <Ionicons name="play-circle" size={40} color={theme.colors.primary} />
                <Text style={styles.nativeTxt}>
                  Lecture vidéo — ouvrez SPILOVEURE dans un navigateur pour
                  regarder cette vidéo intégrée.
                </Text>
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: 18,
    padding: 14,
    borderRadius: 16,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
  },
  header: {
    color: theme.colors.textPrimary,
    fontSize: 16,
    fontWeight: "900",
  },
  sub: {
    color: theme.colors.textSecondary,
    fontSize: 12.5,
    lineHeight: 17,
    marginBottom: 12,
  },
  card: {
    padding: 12,
    borderRadius: 12,
    backgroundColor: theme.colors.surfaceMuted,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginBottom: 12,
  },
  title: {
    color: theme.colors.textPrimary,
    fontWeight: "800",
    fontSize: 14,
    marginBottom: 2,
  },
  desc: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    lineHeight: 16,
    marginBottom: 4,
  },
  nativeFallback: {
    padding: 16,
    borderRadius: 12,
    backgroundColor: theme.colors.background,
    alignItems: "center",
    gap: 8,
    marginTop: 8,
  },
  nativeTxt: {
    color: theme.colors.textSecondary,
    fontSize: 11,
    textAlign: "center",
  },
});

export default ActivationVideoList;
