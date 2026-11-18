/** Floating support action. SPILOVEURE Chat profile links open in-app; other support URLs stay external. */
import React, { useEffect, useState } from "react";
import { Linking, Platform, StyleSheet, Text, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { api } from "@/src/api";
import { messengerProfileRouteFromUrl } from "@/src/messenger/userLinks";

type Support = {
  telegram_url?: string;
  whatsapp_url?: string;
};

const TelegramFab: React.FC = () => {
  const router = useRouter();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sup = await api.get<Support>("/settings/support", { auth: false } as any);
        if (!cancelled) {
          setUrl(sup?.telegram_url || sup?.whatsapp_url || null);
        }
      } catch {
        if (!cancelled) setUrl(null);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const open = async () => {
    if (!url) {
      if (typeof window !== "undefined") {
        window.alert("Service client indisponible pour le moment. Réessayez plus tard.");
      }
      return;
    }
    try {
      const chatRoute = messengerProfileRouteFromUrl(url);
      if (chatRoute) {
        router.push(chatRoute as any);
        return;
      }
      if (Platform.OS === "web" && typeof window !== "undefined") {
        window.open(url, "_blank", "noopener,noreferrer");
      } else {
        await Linking.openURL(url);
      }
    } catch {}
  };

  return (
    <TouchableOpacity
      style={styles.fab}
      onPress={open}
      activeOpacity={0.85}
      testID="telegram-fab"
      accessibilityLabel="Ouvrir le support"
    >
      <Ionicons name="paper-plane" size={17} color="#fff" />
      <Text style={styles.label}>Support</Text>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  fab: {
    position: "absolute",
    right: 14,
    bottom: 100,   // sits above the floating bottom nav (12px margin + 84px nav)
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#229ED9", // Telegram brand blue
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#0B2D6F",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.28,
    shadowRadius: 14,
    elevation: 12,
    zIndex: 90,
  },
  label: {
    color: "#fff",
    fontSize: 6.5,
    fontWeight: "900",
    marginTop: 1,
    letterSpacing: 0.2,
  },
});

export default TelegramFab;
