/**
 * VoiceMessage — custom voice-note player used inside chat bubbles.
 *
 * Renders a circular Play/Pause button, a progress bar, and the elapsed /
 * remaining duration à la WhatsApp.
 *
 * Cross-browser gotchas addressed here :
 *   ▸ Uses a DOM <audio> element (via <div dangerouslySet…> pattern is NOT
 *     used ; instead we mount a real HTMLAudioElement in a ref) so Safari
 *     honours user-gesture playback rules.
 *   ▸ Chromium reports `duration=Infinity` for MediaRecorder WebM blobs —
 *     we seek to `1e101` on `loadedmetadata` to force a real value.
 *   ▸ On play() rejection (autoplay policy or unsupported codec) we surface
 *     an error hint below the bar so the user knows why nothing plays.
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
  const [err, setErr] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    // eslint-disable-next-line no-undef
    const a = new Audio();
    a.preload = "metadata";
    a.crossOrigin = "anonymous";
    // Set src LAST so the metadata / error events fire after listeners attach.
    audioRef.current = a;

    const onLoaded = () => {
      setErr(null);
      const d = a.duration;
      if (isFinite(d) && d > 0) { setDuration(d); setLoaded(true); return; }
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
    const onPlay = () => { setPlaying(true); setErr(null); };
    const onPause = () => setPlaying(false);
    const onError = () => {
      // MediaError codes : 1 aborted, 2 network, 3 decode, 4 src unsupported
      const code = a.error?.code;
      if (code === 4 || code === 3) {
        setErr("Format audio non supporté par votre navigateur.");
      } else if (code === 2) {
        setErr("Échec du téléchargement audio.");
      }
    };
    a.addEventListener("loadedmetadata", onLoaded);
    a.addEventListener("durationchange", onLoaded);
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("ended", onEnd);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    a.addEventListener("error", onError);
    a.src = src;
    return () => {
      try { a.pause(); } catch {}
      a.removeEventListener("loadedmetadata", onLoaded);
      a.removeEventListener("durationchange", onLoaded);
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("ended", onEnd);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      a.removeEventListener("error", onError);
      audioRef.current = null;
    };
  }, [src]);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      a.play().catch((e: any) => {
        setPlaying(false);
        // AbortError happens when pause is called quickly after play — ignore.
        if (e && e.name !== "AbortError") {
          setErr("Lecture impossible : " + (e.message || "codec non supporté"));
        }
      });
    } else {
      a.pause();
    }
  };

  const seek = (evt: any) => {
    const a = audioRef.current;
    if (!a || !loaded || !duration) return;
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
  const iconColor = "#fff";
  const trackBg = own ? "rgba(255,255,255,0.28)" : theme.colors.primary + "22";
  const fillBg = own ? "#fff" : theme.colors.primary;
  const textCol = own ? "rgba(255,255,255,0.9)" : theme.colors.textSecondary;
  const errCol = own ? "#FCA5A5" : theme.colors.danger;

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
        {err ? (
          <Text style={{ color: errCol, fontSize: 10, fontWeight: "700" }} numberOfLines={2}>
            ⚠ {err}
          </Text>
        ) : null}
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
    ...(Platform.OS === "web" ? { cursor: "pointer" as any } : {}),
  },
  fill: {
    height: "100%",
    borderRadius: 3,
  },
});
