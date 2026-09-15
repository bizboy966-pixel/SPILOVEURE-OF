/**
 * TradingCard — horizontal long, compact & animated card displayed on
 * the Dashboard between "Nos services" and the Commissions duo. Redirects
 * the user to the Trading Telegram channel configured from the Admin
 * Panel (`GET /api/settings/trading`).
 *
 * v26 (2026-02-14) — no trading logic is created or altered by this
 * component; it is purely a community redirect card.
 */
import React, { useEffect, useRef } from "react";
import { Animated, Easing, Linking, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/src/theme";

type Props = {
  title?: string;
  description?: string;
  buttonLabel?: string;
  telegramUrl?: string;
  onPressWithoutUrl?: () => void;
};

export const TradingCard: React.FC<Props> = ({
  title = "TRADING",
  description,
  buttonLabel = "Accéder au canal Telegram",
  telegramUrl,
  onPressWithoutUrl,
}) => {
  // Subtle pulse + glow loop on the trading logo — no lib, native driver.
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1400, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 1400, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] });
  const glowOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0.75] });

  const handlePress = () => {
    const url = (telegramUrl || "").trim();
    if (!url) {
      if (onPressWithoutUrl) onPressWithoutUrl();
      return;
    }
    // On web we prefer window.open(_blank) so the user stays on the
    // dashboard while Telegram opens in a new tab. On native the RN
    // Linking module is the correct primitive.
    if (typeof window !== "undefined" && typeof window.open === "function") {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    try { Linking.openURL(url).catch(() => {}); } catch {}
  };

  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={handlePress}
      style={styles.wrap}
      testID="dashboard-trading-card"
    >
      <LinearGradient
        colors={["#0E1F4F", "#0EA5E9", "#0B2D6F"] as any}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.card}
      >
        {/* Left — animated logo */}
        <View style={styles.logoBox}>
          <Animated.View
            style={[
              styles.logoGlow,
              { opacity: glowOpacity, transform: [{ scale }] },
            ]}
          />
          <Animated.View style={{ transform: [{ scale }] }}>
            <Ionicons name="trending-up" size={28} color="#F0F9FF" />
          </Animated.View>
        </View>

        {/* Middle — title + description */}
        <View style={styles.body}>
          <View style={styles.titleRow}>
            <Text style={styles.title}>{title}</Text>
            <View style={styles.badge}>
              <Ionicons name="paper-plane" size={9} color="#0EA5E9" />
              <Text style={styles.badgeTxt}>Telegram</Text>
            </View>
          </View>
          <Text style={styles.desc} numberOfLines={2}>
            {description ||
              "Rejoignez notre canal Telegram Trading et retrouvez nos actualités, analyses et contenus liés au Trading."}
          </Text>
          <View style={styles.ctaRow}>
            <Text style={styles.ctaTxt} testID="dashboard-trading-cta">
              {buttonLabel}
            </Text>
            <Ionicons name="arrow-forward" size={13} color="#F0F9FF" />
          </View>
        </View>
      </LinearGradient>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  wrap: {
    marginTop: 14,
    borderRadius: 20,
    shadowColor: "#0EA5E9",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.28,
    shadowRadius: 26,
    elevation: 8,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
    overflow: "hidden",
  },
  logoBox: {
    width: 56,
    height: 56,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.16)",
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  logoGlow: {
    position: "absolute",
    width: 56, height: 56,
    borderRadius: 18,
    backgroundColor: "#38BDF8",
  },
  body: { flex: 1, minWidth: 0 },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
  },
  title: {
    color: "#F0F9FF",
    fontSize: 15,
    fontWeight: "900",
    letterSpacing: 1.6,
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: "#E0F2FE",
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 8,
  },
  badgeTxt: {
    color: "#0EA5E9",
    fontSize: 9,
    fontWeight: "900",
    letterSpacing: 0.4,
  },
  desc: {
    color: "#DBEAFE",
    fontSize: 11,
    fontWeight: "500",
    lineHeight: 15,
    marginBottom: 6,
  },
  ctaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  ctaTxt: {
    color: "#F0F9FF",
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
});

export default TradingCard;
