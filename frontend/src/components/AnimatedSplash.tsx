/**
 * AnimatedSplash — premium intro shown once per app-load.
 *
 * Sequence (≈ 2.2 s):
 *   0.0 s  : full-screen dark backdrop, logo invisible.
 *   0.0 → 0.9 s  : logo fades in + subtle scale-up (0.85 → 1.0) + one gentle
 *                  rotation (-8° → 0°) — feels "landing softly".
 *   0.9 → 1.4 s  : radial glow pulse behind the logo (opacity 0 → 0.35).
 *   1.4 → 1.8 s  : tagline slides in from below, fades in.
 *   1.8 → 2.2 s  : entire overlay fades out → app is revealed.
 *
 * We use React Native's Animated API (native driver where possible) so the
 * effect stays 60 fps on web AND native. When the user has already seen
 * the splash in this browser tab (sessionStorage flag), we skip it.
 */
import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Image,
  Platform,
  StyleSheet,
  Text,
  View,
} from "react-native";

const STORAGE_KEY = "spilv_splash_seen_v1";

function alreadySeen(): boolean {
  if (Platform.OS !== "web") return false;
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function markSeen() {
  if (Platform.OS !== "web") return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, "1");
  } catch {
    /* private mode — no-op */
  }
}

export function AnimatedSplash() {
  const [visible, setVisible] = useState<boolean>(() => !alreadySeen());
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.85)).current;
  const rotation = useRef(new Animated.Value(0)).current; // 0 → 1  (=-8° → 0°)
  const glow = useRef(new Animated.Value(0)).current;
  const taglineY = useRef(new Animated.Value(20)).current;
  const taglineOpacity = useRef(new Animated.Value(0)).current;
  const overlayOpacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!visible) return;
    // Sequence — feel free to tweak durations later if the pacing needs a bump.
    Animated.sequence([
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 800, useNativeDriver: true }),
        Animated.timing(scale, {
          toValue: 1, duration: 900,
          easing: Easing.out(Easing.back(1.3)),
          useNativeDriver: true,
        }),
        Animated.timing(rotation, {
          toValue: 1, duration: 900,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
      Animated.timing(glow, {
        toValue: 1, duration: 500,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.parallel([
        Animated.timing(taglineOpacity, { toValue: 1, duration: 400, useNativeDriver: true }),
        Animated.timing(taglineY, {
          toValue: 0, duration: 400,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
      Animated.delay(400),
      Animated.timing(overlayOpacity, {
        toValue: 0, duration: 400,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (finished) {
        markSeen();
        setVisible(false);
      }
    });
  }, [visible, opacity, scale, rotation, glow, taglineY, taglineOpacity, overlayOpacity]);

  if (!visible) return null;

  const rotateDeg = rotation.interpolate({
    inputRange: [0, 1],
    outputRange: ["-8deg", "0deg"],
  });

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.overlay, { opacity: overlayOpacity }]}
      testID="animated-splash"
    >
      {/* Golden radial glow behind the logo */}
      <Animated.View style={[styles.glow, { opacity: glow.interpolate({ inputRange: [0, 1], outputRange: [0, 0.35] }) }]} />

      <Animated.View
        style={[
          styles.logoWrap,
          {
            opacity,
            transform: [{ scale }, { rotate: rotateDeg }],
          },
        ]}
      >
        <Image
          source={require("@/assets/images/spiloveure-logo.png")}
          style={styles.logo}
          resizeMode="contain"
        />
      </Animated.View>

      <Animated.Text
        style={[
          styles.tagline,
          { opacity: taglineOpacity, transform: [{ translateY: taglineY }] },
        ]}
      >
        Un réseau, des ambitions, un avenir.
      </Animated.Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: "#0B1220",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 9999,
    ...(Platform.OS === "web" ? { position: "fixed" as any } : null),
  },
  glow: {
    position: "absolute",
    width: 480,
    height: 480,
    borderRadius: 240,
    backgroundColor: "#F59E0B",
    // web-only radial glow — subtle premium touch.
    ...(Platform.OS === "web"
      ? {
          filter: "blur(120px)",
          background:
            "radial-gradient(circle, rgba(245,158,11,0.9) 0%, rgba(59,130,246,0.4) 55%, rgba(11,18,32,0) 75%)",
        }
      : null),
  } as any,
  logoWrap: {
    width: 220, height: 220,
    alignItems: "center", justifyContent: "center",
  },
  logo: { width: 220, height: 220 },
  tagline: {
    marginTop: 24,
    color: "#F8FAFC",
    fontSize: 14,
    fontWeight: "600",
    letterSpacing: 0.5,
    fontStyle: "italic",
  },
});
