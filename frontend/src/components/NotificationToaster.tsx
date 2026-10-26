/**
 * NotificationToaster — mounted once at the app shell, shows a stacked
 * toast for every new in-app notification. Uses `useNotificationsFeed`
 * for polling and dismisses each toast after 5 s.
 *
 * We intentionally keep it web-friendly (no Reanimated, no native-only
 * libs) so it runs on Expo Web without extra setup.
 */
import React, { useEffect, useRef, useState } from "react";
import { Animated, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { theme } from "@/src/theme";
import { useNotificationsFeed, AppNotification } from "@/src/hooks/useNotificationsFeed";

type Displayed = AppNotification & { _fade: Animated.Value };

const ICON_BY_KIND: Record<string, keyof typeof Ionicons.glyphMap> = {
  reactor_reward: "gift",
  special_task_reward: "flash",
  special_task_new: "flash",
  payment_confirmed: "checkmark-circle",
  ad_approved: "megaphone",
  ad_rejected: "close-circle",
};

const COLOR_BY_KIND: Record<string, string> = {
  reactor_reward: "#F59E0B",
  special_task_reward: "#7B61FF",
  special_task_new: "#7B61FF",
  payment_confirmed: "#10B981",
  ad_approved: "#3B82F6",
  ad_rejected: "#EF4444",
};

const MAX_STACK = 2;
const AUTO_DISMISS_MS = 5000;

export function NotificationToaster() {
  const router = useRouter();
  const { latest, unread } = useNotificationsFeed(10000);
  const [stack, setStack] = useState<Displayed[]>([]);
  const seenIdsRef = useRef<Set<string>>(new Set());

  // Feed new items into the stack (deduped by id).
  useEffect(() => {
    if (!latest || latest.length === 0) return;
    const fresh: Displayed[] = [];
    for (const n of latest) {
      if (seenIdsRef.current.has(n.id)) continue;
      seenIdsRef.current.add(n.id);
      fresh.push({ ...n, _fade: new Animated.Value(0) });
    }
    if (fresh.length === 0) return;
    setStack((prev) => [...fresh, ...prev].slice(0, MAX_STACK));
    fresh.forEach((f) => {
      Animated.timing(f._fade, { toValue: 1, duration: 200, useNativeDriver: Platform.OS !== "web" }).start();
      setTimeout(() => {
        Animated.timing(f._fade, { toValue: 0, duration: 300, useNativeDriver: Platform.OS !== "web" })
          .start(() => setStack((prev) => prev.filter((p) => p.id !== f.id)));
      }, AUTO_DISMISS_MS);
    });
    // v27 (2026-02-14) — the toaster no longer touches the "read" flag.
    // The bell badge must persist until the user visits /notifications
    // (or taps a specific item). Local `seenIdsRef` handles dedup within
    // the current session, `isFirstFetchRef` in the hook prevents re-firing
    // on refresh.
  }, [latest]);

  if (stack.length === 0) return null;

  return (
    <View pointerEvents="box-none" style={styles.wrap} testID="notif-toaster">
      {stack.map((n) => {
        const color = COLOR_BY_KIND[n.kind] || theme.colors.primary;
        const icon = ICON_BY_KIND[n.kind] || "notifications";
        const title = n.title || n.message || "Nouvelle notification";
        const body = n.body || "";
        return (
          <Animated.View
            key={n.id}
            style={[styles.toast, { borderLeftColor: color, opacity: n._fade,
              transform: [{ translateY: n._fade.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] }) }] }]}
            testID={`notif-toast-${n.id}`}
          >
            <View style={[styles.iconBox, { backgroundColor: color }]}>
              <Ionicons name={icon} size={18} color="#fff" />
            </View>
            <Pressable
              style={{ flex: 1 }}
              disabled={!(n as any).link}
              onPress={() => { setStack((prev) => prev.filter((p) => p.id !== n.id)); router.push((n as any).link); }}
              testID={`notif-toast-open-${n.id}`}
            >
              <Text style={styles.title} numberOfLines={1}>{title}</Text>
              {!!body && <Text style={styles.body} numberOfLines={2}>{body}</Text>}
            </Pressable>
            <Pressable
              onPress={() => setStack((prev) => prev.filter((p) => p.id !== n.id))}
              hitSlop={8}
              testID={`notif-toast-close-${n.id}`}
            >
              <Ionicons name="close" size={16} color={theme.colors.textSecondary} />
            </Pressable>
          </Animated.View>
        );
      })}
      {unread > MAX_STACK && (
        <View style={styles.more}>
          <Text style={styles.moreTxt}>+{unread - MAX_STACK} autres</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    top: Platform.OS === "web" ? 16 : 60,
    right: 16,
    left: Platform.OS === "web" ? undefined : 16,
    maxWidth: 380,
    gap: 8,
    zIndex: 9999,
  },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#0F172A",
    borderLeftWidth: 4,
    borderRadius: 14,
    padding: 12,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  iconBox: {
    width: 34, height: 34, borderRadius: 12,
    alignItems: "center", justifyContent: "center",
  },
  title: { color: "#fff", fontWeight: "800", fontSize: 13 },
  body: { color: "#CBD5E1", fontSize: 11, marginTop: 2 },
  more: {
    alignSelf: "flex-end",
    backgroundColor: "rgba(15, 23, 42, 0.85)",
    borderRadius: 24, paddingHorizontal: 10, paddingVertical: 4,
  },
  moreTxt: { color: "#CBD5E1", fontSize: 10, fontWeight: "700" },
});
