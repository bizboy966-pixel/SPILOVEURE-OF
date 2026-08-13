import React, { useEffect, useState, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Linking,
  Platform,
  Animated,
  Easing,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { theme } from "@/src/theme";
import { api } from "@/src/api";

type Support = {
  whatsapp_url?: string;
  telegram_url?: string;
  email?: string;
  phone?: string;
};

function openExternal(url: string) {
  if (!url) return;
  if (Platform.OS === "web" && typeof window !== "undefined") {
    window.open(url, "_blank");
  } else {
    Linking.openURL(url).catch(() => {});
  }
}

export const SupportFab: React.FC = () => {
  const [sup, setSup] = useState<Support | null>(null);
  const [open, setOpen] = useState(false);
  const fade = useRef(new Animated.Value(0)).current;
  const slide = useRef(new Animated.Value(12)).current;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<Support>("/settings/support", { auth: false });
        if (!cancelled) setSup(data);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fade, {
        toValue: open ? 1 : 0,
        duration: 180,
        useNativeDriver: true,
      }),
      Animated.timing(slide, {
        toValue: open ? 0 : 12,
        duration: 180,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [open, fade, slide]);

  const items: { key: string; label: string; color: string; icon: any; onPress: () => void; visible: boolean }[] = [
    {
      key: "whatsapp",
      label: "WhatsApp",
      color: "#25D366",
      icon: "logo-whatsapp",
      onPress: () => openExternal(sup?.whatsapp_url || ""),
      visible: !!sup?.whatsapp_url,
    },
    {
      key: "telegram",
      label: "Telegram",
      color: "#229ED9",
      icon: "paper-plane",
      onPress: () => openExternal(sup?.telegram_url || ""),
      visible: !!sup?.telegram_url,
    },
    {
      key: "email",
      label: "Email",
      color: theme.colors.primary,
      icon: "mail",
      onPress: () => openExternal(sup?.email ? `mailto:${sup.email}` : ""),
      visible: !!sup?.email,
    },
  ];
  const anyVisible = items.some((i) => i.visible);
  if (!anyVisible) return null;

  return (
    <View pointerEvents="box-none" style={styles.wrap}>
      {open && (
        <Animated.View
          pointerEvents="auto"
          style={[styles.menu, { opacity: fade, transform: [{ translateY: slide }] }]}
          testID="support-fab-menu"
        >
          <View style={styles.menuHead}>
            <Ionicons name="headset" size={14} color={theme.colors.primary} />
            <Text style={styles.menuTitle}>Service Client</Text>
          </View>
          {items.filter((i) => i.visible).map((it) => (
            <TouchableOpacity
              key={it.key}
              style={styles.menuItem}
              onPress={() => { it.onPress(); setOpen(false); }}
              testID={`support-fab-${it.key}`}
            >
              <View style={[styles.iconCircle, { backgroundColor: it.color }]}>
                <Ionicons name={it.icon} size={16} color="#fff" />
              </View>
              <Text style={styles.itemTxt}>{it.label}</Text>
              <Ionicons name="open-outline" size={14} color={theme.colors.textSecondary} />
            </TouchableOpacity>
          ))}
        </Animated.View>
      )}

      <TouchableOpacity
        onPress={() => setOpen((v) => !v)}
        activeOpacity={0.85}
        style={styles.fabTouch}
        testID="support-fab"
      >
        <LinearGradient
          colors={theme.colors.primaryGradient}
          style={styles.fab}
        >
          <Ionicons name={open ? "close" : "headset"} size={26} color="#fff" />
        </LinearGradient>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    position: Platform.OS === "web" ? ("fixed" as any) : "absolute",
    right: 20,
    bottom: 20,
    alignItems: "flex-end",
    zIndex: 9999,
  },
  fabTouch: { shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 10, shadowOffset: { width: 0, height: 6 }, elevation: 8 },
  fab: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 3,
    borderColor: "rgba(255,255,255,0.95)",
  },
  menu: {
    marginBottom: 10,
    backgroundColor: "#fff",
    borderRadius: 16,
    paddingVertical: 8,
    paddingHorizontal: 8,
    minWidth: 220,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  menuHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    marginBottom: 6,
  },
  menuTitle: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 13 },
  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 9,
    paddingHorizontal: 8,
    borderRadius: 10,
  },
  iconCircle: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  itemTxt: { flex: 1, color: theme.colors.textPrimary, fontWeight: "600", fontSize: 13 },
});
