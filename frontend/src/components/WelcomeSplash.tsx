/**
 * WelcomeSplash — a mini animated banner shown ONCE right after a
 * successful sign-in. It reads a one-shot `sessionStorage` flag set by
 * the login screen and clears it as soon as the animation starts, so
 * further navigations inside the app never replay it.
 *
 * Layout: a floating rounded pill dropping in from the top with the
 * user's round logo, "Bienvenue @{username}" and a soft golden glow.
 * Auto-dismisses in ~2.4 s.
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
import { LinearGradient } from "expo-linear-gradient";

import { useAuth } from "@/src/auth";

const FLAG = "spilv_welcome_pending";

export function armWelcomeSplash() {
  if (Platform.OS !== "web") return;
  try {
    window.sessionStorage.setItem(FLAG, "1");
  } catch {
    /* private mode — no-op */
  }
}

export function WelcomeSplash() {
  const { user } = useAuth();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!user) return;
    if (Platform.OS !== "web") return;
    let armed = false;
    try {
      armed = window.sessionStorage.getItem(FLAG) === "1";
      if (armed) window.sessionStorage.removeItem(FLAG);
    } catch {
      /* no-op */
    }
    if (armed) setShow(true);
  }, [user?.id]);

  const translateY = useRef(new Animated.Value(-80)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.9)).current;

  useEffect(() => {
    if (!show) return;
    Animated.sequence([
      Animated.parallel([
        Animated.spring(translateY, {
          toValue: 0, damping: 12, stiffness: 140,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1, duration: 350, useNativeDriver: true,
        }),
        Animated.spring(scale, {
          toValue: 1, damping: 10, stiffness: 160, useNativeDriver: true,
        }),
      ]),
      Animated.delay(1500),
      Animated.parallel([
        Animated.timing(translateY, {
          toValue: -80, duration: 350,
          easing: Easing.in(Easing.cubic), useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0, duration: 350, useNativeDriver: true,
        }),
      ]),
    ]).start(({ finished }) => finished && setShow(false));
  }, [show, translateY, opacity, scale]);

  if (!show || !user) return null;
  const username = user.username || "vous";

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.wrap, { opacity, transform: [{ translateY }, { scale }] }]}
      testID="welcome-splash"
    >
      <LinearGradient
        colors={["#1e3a8a", "#2563eb", "#f59e0b"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.pill}
      >
        <Image
          source={require("@/assets/images/spiloveure-logo.png")}
          style={styles.avatar}
          resizeMode="contain"
        />
        <View style={{ flex: 1 }}>
          <Text style={styles.hello}>Bienvenue 👋</Text>
          <Text style={styles.name} numberOfLines={1}>@{username}</Text>
        </View>
      </LinearGradient>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    top: 20,
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 9998,
    ...(Platform.OS === "web" ? { position: "fixed" as any } : null),
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 999,
    minWidth: 260,
    maxWidth: 380,
    shadowColor: "#F59E0B",
    shadowOpacity: 0.5,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  avatar: { width: 40, height: 40, borderRadius: 24 },
  hello: {
    color: "#FDE68A",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.4,
  },
  name: { color: "#fff", fontSize: 15, fontWeight: "900" },
});
