/**
 * SwipeToReply — wraps a chat bubble and turns a horizontal drag into a
 * "reply to this message" action, matching the WhatsApp / Telegram UX.
 *
 * Web : uses native pointer events attached to the wrapper ref (Playwright
 *       and real touch devices both work reliably ; the react-native-web
 *       ResponderEventPlugin can miss captures when the child is a Pressable).
 * Native (iOS/Android) : falls back to PanResponder + Animated.
 */
import React, { useEffect, useRef } from "react";
import { Animated, PanResponder, Platform, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/src/theme";

type Props = {
  children: React.ReactNode;
  onReply: () => void;
  disabled?: boolean;
  maxTranslate?: number;
  threshold?: number;
};

export default function SwipeToReply({
  children, onReply, disabled = false,
  maxTranslate = 90, threshold = 55,
}: Props) {
  const translateX = useRef(new Animated.Value(0)).current;
  const hintOpacity = useRef(new Animated.Value(0)).current;
  const containerRef = useRef<View | null>(null);
  const dragStartX = useRef<number | null>(null);
  const dragging = useRef(false);
  const lastDx = useRef(0);

  // ────────────────────────── WEB : native pointer events ──────────────────
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const node = containerRef.current as unknown as HTMLElement | null;
    if (!node) return;

    const springBack = () => {
      Animated.spring(translateX, { toValue: 0, useNativeDriver: false, speed: 20, bounciness: 6 }).start();
      Animated.timing(hintOpacity, { toValue: 0, duration: 180, useNativeDriver: false }).start();
    };

    const onDown = (e: PointerEvent) => {
      if (disabled) return;
      // Only left mouse button or touch/pen
      if (e.pointerType === "mouse" && e.button !== 0) return;
      dragStartX.current = e.clientX;
      dragging.current = false;
      lastDx.current = 0;
    };
    const onMove = (e: PointerEvent) => {
      if (disabled || dragStartX.current == null) return;
      const dx = e.clientX - dragStartX.current;
      // Claim the gesture only once movement is horizontal-dominant
      if (!dragging.current) {
        if (Math.abs(dx) < 8) return;
        dragging.current = true;
        try { node.setPointerCapture(e.pointerId); } catch { /* silent */ }
      }
      const clamped = Math.max(-maxTranslate, Math.min(maxTranslate, dx));
      translateX.setValue(clamped);
      hintOpacity.setValue(Math.min(1, Math.abs(clamped) / threshold));
      lastDx.current = clamped;
      // prevent text selection while swiping
      e.preventDefault?.();
    };
    const onUp = (_e: PointerEvent) => {
      if (dragStartX.current == null) return;
      const passed = Math.abs(lastDx.current) >= threshold;
      dragStartX.current = null;
      const wasDragging = dragging.current;
      dragging.current = false;
      springBack();
      if (wasDragging && passed && !disabled) onReply();
    };

    node.addEventListener("pointerdown", onDown as any);
    node.addEventListener("pointermove", onMove as any);
    node.addEventListener("pointerup", onUp as any);
    node.addEventListener("pointercancel", onUp as any);
    return () => {
      node.removeEventListener("pointerdown", onDown as any);
      node.removeEventListener("pointermove", onMove as any);
      node.removeEventListener("pointerup", onUp as any);
      node.removeEventListener("pointercancel", onUp as any);
    };
  }, [disabled, onReply, maxTranslate, threshold, translateX, hintOpacity]);

  // ────────────────────────── NATIVE : PanResponder ────────────────────────
  const nativeResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_e, g) =>
        !disabled && Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderMove: (_e, g) => {
        const clamped = Math.max(-maxTranslate, Math.min(maxTranslate, g.dx));
        translateX.setValue(clamped);
        hintOpacity.setValue(Math.min(1, Math.abs(clamped) / threshold));
      },
      onPanResponderRelease: (_e, g) => {
        const passed = Math.abs(g.dx) >= threshold;
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true, speed: 20, bounciness: 6 }).start();
        Animated.timing(hintOpacity, { toValue: 0, duration: 180, useNativeDriver: true }).start();
        if (passed && !disabled) onReply();
      },
      onPanResponderTerminate: () => {
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
        Animated.timing(hintOpacity, { toValue: 0, duration: 150, useNativeDriver: true }).start();
      },
    }),
  ).current;

  const panHandlers = Platform.OS === "web" ? {} : nativeResponder.panHandlers;

  return (
    <View ref={containerRef} style={styles.container} {...panHandlers}>
      <Animated.View pointerEvents="none" style={[styles.hintLeft, { opacity: hintOpacity }]}>
        <Ionicons name="arrow-undo" size={16} color={theme.colors.primary} />
      </Animated.View>
      <Animated.View pointerEvents="none" style={[styles.hintRight, { opacity: hintOpacity }]}>
        <Ionicons name="arrow-undo" size={16} color={theme.colors.primary} />
      </Animated.View>
      <Animated.View style={{ transform: [{ translateX }] }}>
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "relative",
    // On web the wrapper must catch pointer events for setPointerCapture to
    // work even when the finger leaves the child bubble.
    ...(Platform.OS === "web" ? { touchAction: "pan-y" as any } : {}),
  },
  hintLeft: {
    position: "absolute",
    left: 6, top: 0, bottom: 0,
    width: 28, alignItems: "center", justifyContent: "center",
    zIndex: 0,
  },
  hintRight: {
    position: "absolute",
    right: 6, top: 0, bottom: 0,
    width: 28, alignItems: "center", justifyContent: "center",
    zIndex: 0,
  },
});
