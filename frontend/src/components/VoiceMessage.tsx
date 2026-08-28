/**
 * VoiceMessage — custom voice-note player used inside chat bubbles.
 *
 * Renders a circular Play/Pause button, a progress bar, and the elapsed /
 * total duration à la WhatsApp. Works on both React-Native Web (via the
 * DOM <audio> element under the hood) and gracefully degrades on native
 * where the native <audio> tag is not available.
 *
 * Props :
 *   src          — data-URL or remote URL for the audio blob.
 *   tint         — bubble tint (own vs other) to color the play button.
 *   accent       — accent color for the progress fill.
 *   testID       — root testID to help E2E tests locate the widget.
 */
import React, { useEffect, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/src/theme";

type Props = {
  src: string;
  tint?: "own" | "other";
  testID?: string;
};

function fmt(seconds: number) {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function VoiceMessage({ src, tint = "other", testID }: Props) {
  const own = tint === "own";
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const barRef = useRef<View | null>(null);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    // eslint-disable-next-line no-undef
    const a = new Audio();
    a.preload = "metadata";
    a.src = src;
    audioRef.current = a;
    const onLoaded = () => {
      const d = a.duration;
      if (isFinite(d) && d > 0) { setDuration(d); setLoaded(true); return; }
      // Chromium reports Infinity for MediaRecorder webm blobs. Force the
      // browser to seek to the end so `durationchange` fires with a real value.
      try {
        a.currentTime = 1e101;
        const onFix = () => {
          if (isFinite(a.duration)) { setDuration(a.duration); setLoaded(true); }
          try { a.currentTime = 0; } catch {}
          a.removeEventListener("timeupdate", onFix);
        };
        a.addEventListener("timeupdate", onFix);
      } catch { /* silent */ }
    };
    const onTime = () => setCurrent(a.currentTime || 0);
    const onEnd = () => { setPlaying(false); setCurrent(0); };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    a.addEventListener("loadedmetadata", onLoaded);
    a.addEventListener("durationchange", onLoaded);
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("ended", onEnd);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    return () => {
      try { a.pause(); } catch {}
      a.removeEventListener("loadedmetadata", onLoaded);
      a.removeEventListener("durationchange", onLoaded);
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("ended", onEnd);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      audioRef.current = null;
    };
  }, [src]);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) { a.play().catch(() => setPlaying(false)); }
    else { a.pause(); }
  };

  const seek = (evt: any) => {
    const a = audioRef.current;
    if (!a || !loaded || !duration) return;
    // web: use offsetX / clientX for the progress bar rect
    try {
      const rect = evt?.currentTarget?.getBoundingClientRect?.();
      const x = evt?.nativeEvent?.offsetX ?? (evt?.clientX && rect ? evt.clientX - rect.left : 0);
      const w = rect?.width || 1;
      const ratio = Math.max(0, Math.min(1, x / w));
      a.currentTime = ratio * duration;
      setCurrent(a.currentTime);
    } catch { /* silent */ }
  };

  const pct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;
  const btnBg = own ? "rgba(255,255,255,0.22)" : theme.colors.primary;
  const iconColor = own ? "#fff" : "#fff";
  const trackBg = own ? "rgba(255,255,255,0.28)" : theme.colors.primary + "22";
  const fillBg = own ? "#fff" : theme.colors.primary;
  const textCol = own ? "rgba(255,255,255,0.9)" : theme.colors.textSecondary;

  return (
    <View style={styles.wrap} testID={testID}>
      <Pressable
        onPress={toggle}
        style={[styles.playBtn, { backgroundColor: btnBg }]}
        testID={testID ? `${testID}-toggle` : undefined}
      >
        <Ionicons name={playing ? "pause" : "play"} size={16} color={iconColor} />
      </Pressable>
      <View style={{ flex: 1, gap: 4 }}>
        <Pressable
          onPress={Platform.OS === "web" ? (seek as any) : undefined}
          style={[styles.track, { backgroundColor: trackBg }]}
          // @ts-ignore web-only pointer events for drag-to-seek
          onPointerDown={Platform.OS === "web" ? (seek as any) : undefined}
        >
          <View style={[styles.fill, { width: `${pct}%`, backgroundColor: fillBg }]} />
        </Pressable>
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Text style={{ color: textCol, fontSize: 10, fontVariant: ["tabular-nums"] }}>
            {fmt(current)}
          </Text>
          <Text style={{ color: textCol, fontSize: 10, fontVariant: ["tabular-nums"] }}>
            {fmt(duration - current)}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 4,
    minWidth: 200,
  },
  playBtn: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: "center", justifyContent: "center",
  },
  track: {
    height: 6, borderRadius: 3,
    overflow: "hidden",
    // cursor pointer on web
    ...(Platform.OS === "web" ? { cursor: "pointer" as any } : {}),
  },
  fill: {
    height: "100%",
    borderRadius: 3,
  },
});
