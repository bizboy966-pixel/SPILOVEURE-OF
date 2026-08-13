import React, { useEffect, useState, useRef } from "react";
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  Linking,
  Platform,
  Animated,
  Easing,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { theme } from "@/src/theme";
import { api } from "@/src/api";

type Cfg = {
  enabled: boolean;
  title: string;
  description: string;
  image_url: string;
  telegram_url: string;
  button_label: string;
  auto_close_seconds: number;
};

const SESSION_KEY = "spilo_community_popup_seen";

function hasSeen() {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage?.getItem(SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

function markSeen() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage?.setItem(SESSION_KEY, "1");
  } catch {}
}

export const CommunityPopup: React.FC<{ userId: string | null | undefined }> = ({ userId }) => {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [visible, setVisible] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const scale = useRef(new Animated.Value(0.85)).current;

  // Fetch config & decide whether to show
  useEffect(() => {
    let cancelled = false;
    if (!userId) return;
    if (hasSeen()) return;
    (async () => {
      try {
        const data = await api.get<Cfg>("/settings/community-popup", { auth: false });
        if (cancelled || !data || !data.enabled) return;
        setCfg(data);
        setVisible(true);
        setRemaining(Math.max(0, Math.floor(data.auto_close_seconds || 0)));
        markSeen();
        Animated.timing(scale, {
          toValue: 1,
          duration: 220,
          easing: Easing.out(Easing.back(1.4)),
          useNativeDriver: true,
        }).start();
      } catch {
        // silent
      }
    })();
    return () => { cancelled = true; };
  }, [userId, scale]);

  // Auto-close timer
  useEffect(() => {
    if (!visible || !cfg || cfg.auto_close_seconds <= 0) return;
    if (remaining <= 0) {
      setVisible(false);
      return;
    }
    const t = setTimeout(() => setRemaining((r) => r - 1), 1000);
    return () => clearTimeout(t);
  }, [remaining, visible, cfg]);

  const close = () => setVisible(false);

  const openTelegram = async () => {
    if (!cfg?.telegram_url) {
      close();
      return;
    }
    try {
      if (Platform.OS === "web" && typeof window !== "undefined") {
        window.open(cfg.telegram_url, "_blank");
      } else {
        await Linking.openURL(cfg.telegram_url);
      }
    } catch {}
    close();
  };

  if (!visible || !cfg) return null;

  return (
    <Modal transparent animationType="fade" visible={visible} onRequestClose={close}>
      <View style={styles.backdrop}>
        <Animated.View style={[styles.card, { transform: [{ scale }] }]} testID="community-popup">
          <TouchableOpacity style={styles.closeBtn} onPress={close} testID="community-popup-close">
            <Ionicons name="close" size={20} color="#fff" />
          </TouchableOpacity>

          <LinearGradient colors={theme.colors.primaryGradient} style={styles.headerBand}>
            <View style={styles.logoCircle}>
              <Image
                source={require("@/assets/images/spiloveure-logo.png")}
                style={{ width: 44, height: 44 }}
                resizeMode="contain"
              />
            </View>
            <Text style={styles.headerTitle}>SPILOVEURE</Text>
          </LinearGradient>

          {cfg.image_url ? (
            <Image source={{ uri: cfg.image_url }} style={styles.banner} resizeMode="cover" />
          ) : null}

          <View style={styles.body}>
            <Text style={styles.title} testID="community-popup-title">{cfg.title}</Text>
            <Text style={styles.desc}>{cfg.description}</Text>

            <TouchableOpacity onPress={openTelegram} activeOpacity={0.85} testID="community-popup-cta">
              <LinearGradient
                colors={theme.colors.primaryGradient}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={styles.cta}
              >
                <Ionicons name="paper-plane" size={18} color="#fff" />
                <Text style={styles.ctaTxt}>{cfg.button_label}</Text>
              </LinearGradient>
            </TouchableOpacity>

            {cfg.auto_close_seconds > 0 && remaining > 0 && (
              <Text style={styles.countdown} testID="community-popup-countdown">
                Fermeture automatique dans {remaining}s
              </Text>
            )}
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(8, 13, 36, 0.72)",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  card: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: "#fff",
    borderRadius: 24,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 12 },
    elevation: 16,
  },
  closeBtn: {
    position: "absolute",
    top: 10,
    right: 10,
    zIndex: 10,
    width: 32,
    height: 32,
    borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  headerBand: {
    paddingVertical: 16,
    alignItems: "center",
    gap: 6,
  },
  logoCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "rgba(255,255,255,0.95)",
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: { color: "#fff", fontWeight: "800", letterSpacing: 1.5, fontSize: 16 },
  banner: { width: "100%", height: 150 },
  body: { padding: 18, gap: 10, alignItems: "center" },
  title: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 17, textAlign: "center" },
  desc: { color: theme.colors.textSecondary, fontSize: 13, textAlign: "center", lineHeight: 18 },
  cta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 14,
    marginTop: 6,
    alignSelf: "stretch",
  },
  ctaTxt: { color: "#fff", fontWeight: "800", fontSize: 14, letterSpacing: 0.4 },
  countdown: { color: theme.colors.textSecondary, fontSize: 11, fontStyle: "italic", marginTop: 4 },
});
