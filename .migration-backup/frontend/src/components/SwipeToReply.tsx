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
  direction?: "left" | "right" | "both";
  maxTranslate?: number;
  threshold?: number;
};

export default function SwipeToReply({
  children, onReply, disabled = false, direction = "both",
  maxTranslate = 90, threshold = 55,
}: Props) {
  const translateX = useRef(new Animated.Value(0)).current;
  const hintOpacity = useRef(new Animated.Value(0)).current;
  const containerRef = useRef<View | null>(null);
  const dragStartX = useRef<number | null>(null);
  const dragStartY = useRef<number | null>(null);
  const activePointerId = useRef<number | null>(null);
  const dragging = useRef(false);
  const lastDx = useRef(0);
  const current = useRef({ onReply, disabled, direction, maxTranslate, threshold });
  current.current = { onReply, disabled, direction, maxTranslate, threshold };
  const canSwipe = (dx: number) => current.current.direction === "both"
    || (current.current.direction === "left" && dx < 0)
    || (current.current.direction === "right" && dx > 0);

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
      if (current.current.disabled) return;
      // Only left mouse button or touch/pen
      if (e.pointerType === "mouse" && e.button !== 0) return;
      dragStartX.current = e.clientX;
      dragStartY.current = e.clientY;
      activePointerId.current = e.pointerId;
      dragging.current = false;
      lastDx.current = 0;
    };
    const onMove = (e: PointerEvent) => {
      if (current.current.disabled || dragStartX.current == null || dragStartY.current == null || e.pointerId !== activePointerId.current) return;
      const dx = e.clientX - dragStartX.current;
      const dy = e.clientY - dragStartY.current;
      // Claim the gesture only once movement is horizontal-dominant
      if (!dragging.current) {
        if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 1.35 || !canSwipe(dx)) return;
        dragging.current = true;
      }
      const distance = current.current.maxTranslate;
      const clamped = Math.max(-distance, Math.min(distance, dx));
      translateX.setValue(clamped);
      hintOpacity.setValue(Math.min(1, Math.abs(clamped) / current.current.threshold));
      lastDx.current = clamped;
      // prevent text selection while swiping
      e.preventDefault?.();
    };
    const onUp = (_e: PointerEvent) => {
      if (dragStartX.current == null || _e.pointerId !== activePointerId.current) return;
      const passed = Math.abs(lastDx.current) >= current.current.threshold && canSwipe(lastDx.current);
      dragStartX.current = null;
      dragStartY.current = null;
      activePointerId.current = null;
      const wasDragging = dragging.current;
      dragging.current = false;
      springBack();
      if (wasDragging && passed && !current.current.disabled) current.current.onReply();
    };

    node.addEventListener("pointerdown", onDown as any);
    window.addEventListener("pointermove", onMove as any);
    window.addEventListener("pointerup", onUp as any);
    window.addEventListener("pointercancel", onUp as any);
    return () => {
      node.removeEventListener("pointerdown", onDown as any);
      window.removeEventListener("pointermove", onMove as any);
      window.removeEventListener("pointerup", onUp as any);
      window.removeEventListener("pointercancel", onUp as any);
    };
  }, [translateX, hintOpacity]);

  // ────────────────────────── NATIVE : PanResponder ────────────────────────
  const nativeResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_e, g) =>
        !current.current.disabled && Math.abs(g.dx) > 8
        && Math.abs(g.dx) > Math.abs(g.dy) * 1.5 && canSwipe(g.dx),
      onPanResponderMove: (_e, g) => {
        const distance = current.current.maxTranslate;
        const clamped = Math.max(-distance, Math.min(distance, g.dx));
        translateX.setValue(clamped);
        hintOpacity.setValue(Math.min(1, Math.abs(clamped) / current.current.threshold));
      },
      onPanResponderRelease: (_e, g) => {
        const passed = Math.abs(g.dx) >= current.current.threshold && canSwipe(g.dx);
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true, speed: 20, bounciness: 6 }).start();
        Animated.timing(hintOpacity, { toValue: 0, duration: 180, useNativeDriver: true }).start();
        if (passed && !current.current.disabled) current.current.onReply();
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
      {direction !== "left" && <Animated.View pointerEvents="none" style={[styles.hintRight, { opacity: hintOpacity }]}>
        <Ionicons name="arrow-undo" size={16} color={theme.colors.primary} />
      </Animated.View>}
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
