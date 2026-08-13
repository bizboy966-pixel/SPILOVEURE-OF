import React, { useEffect, useState } from "react";
import { Platform, StyleSheet, TouchableOpacity, View, Text } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { api } from "../api";

/**
 * Floating Lottery Jackpot launcher. Renders only when the module is enabled
 * AND `floating_icon_visible` is true in the admin settings. Positioned at
 * the bottom-LEFT corner so it doesn't collide with the SupportFab (right).
 */
export function LotteryFab() {
  const router = useRouter();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const r = await api.get<any>("/lottery/settings");
        if (!active) return;
        setVisible(!!r.enabled && !!r.floating_icon_visible);
      } catch {
        if (active) setVisible(false);
      }
    };
    load();
    const id = setInterval(load, 60000);
    return () => { active = false; clearInterval(id); };
  }, []);

  if (!visible) return null;

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <TouchableOpacity
        style={styles.fabTouch}
        onPress={() => router.push("/(app)/lottery")}
        accessibilityLabel="Ouvrir le Lottery Jackpot"
        testID="lottery-fab"
      >
        <LinearGradient
          colors={["#F59E0B", "#DC2626"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.fab}
        >
          <Ionicons name="ticket" size={26} color="#fff" />
          <Text style={styles.fabTxt}>JACKPOT</Text>
        </LinearGradient>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: Platform.OS === "web" ? ("fixed" as any) : "absolute",
    left: 20,
    bottom: 20,
    zIndex: 9998,
  },
  fabTouch: { shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: { width: 0, height: 6 }, elevation: 8 },
  fab: {
    width: 64,
    height: 64,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 3,
    borderColor: "rgba(255,255,255,0.95)",
  },
  fabTxt: { color: "#fff", fontWeight: "900", fontSize: 8, marginTop: 2, letterSpacing: 0.5 },
});
