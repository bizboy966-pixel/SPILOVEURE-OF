/**
 * TelegramFab — floating action button that opens the customer support
 * Telegram channel directly (no in-app chat modal).
 *
 * The chat modal (ChatBubble) still exists in the codebase for admins,
 * but on the user side the FAB now provides a friction-free jump to
 * Telegram support — a direct link discovery is fetched from the same
 * `/settings/support` endpoint that already powers the admin panel.
 */
import React, { useEffect, useState } from "react";
import { Linking, Platform, StyleSheet, Text, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api";
import { theme } from "@/src/theme";

type Support = {
  telegram_url?: string;
  whatsapp_url?: string;
};

const TelegramFab: React.FC = () => {
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
      if (Platform.OS === "web" && typeof window !== "undefined") {
        window.open(url, "_blank");
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
      accessibilityLabel="Contacter le service client sur Telegram"
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
