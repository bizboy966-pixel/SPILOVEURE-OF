/**
 * VoiceMessage — custom voice-note player used inside chat bubbles.
 *
 * Renders a circular Play/Pause button, an audio waveform seek control, and the elapsed /
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
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/src/theme";
import { voiceWaveform } from "./voiceWaveform";
import { formatVoiceDuration } from "./voiceDuration";

type Props = {
  src: string;
  tint?: "own" | "other";
  testID?: string;
  durationSeconds?: number;
  loading?: boolean;
};

export default function VoiceMessage({ src, testID, durationSeconds, loading = false }: Props) {
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(durationSeconds || 0);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [waveform, setWaveform] = useState<number[]>(() => Array.from({ length: 36 }, () => 7));
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const trackRef = useRef<View | null>(null);

  useEffect(() => {
    const recordedDuration = Number.isFinite(durationSeconds) && (durationSeconds || 0) > 0
      ? durationSeconds as number
      : 0;
    setDuration(recordedDuration);
    setCurrent(0);
    setLoaded(false);
    setErr(null);
    if (!src) return;
    if (Platform.OS !== "web") return;
    // eslint-disable-next-line no-undef
    const a = new Audio();
    a.preload = "metadata";
    a.crossOrigin = "anonymous";
    let disposed = false;
    let decodeContext: AudioContext | null = null;
    const controller = new AbortController();
    setWaveform(Array.from({ length: 36 }, () => 7));
    // Decode when possible so the bars represent this recording, not invented samples.
    const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioContextCtor) {
      try {
        decodeContext = new AudioContextCtor();
        fetch(src, { signal: controller.signal }).then(response => {
          if (!response.ok) throw new Error("Audio unavailable");
          return response.arrayBuffer();
        }).then(buffer => decodeContext!.decodeAudioData(buffer)).then(decoded => {
          if (disposed) return;
          setWaveform(voiceWaveform(decoded.getChannelData(0)));
          if (!recordedDuration) {
            setDuration(decoded.duration);
            setLoaded(true);
          }
        }).catch(() => {
          if (!disposed) setWaveform(Array.from({ length: 36 }, () => 7));
        }).finally(() => {
          if (decodeContext && decodeContext.state !== "closed") void decodeContext.close().catch(() => {});
        });
      } catch {
        setWaveform(Array.from({ length: 36 }, () => 7));
      }
    } else {
      setWaveform(Array.from({ length: 36 }, () => 7));
    }
    // Set src LAST so the metadata / error events fire after listeners attach.
    audioRef.current = a;

    const onLoaded = () => {
      setErr(null);
      if (recordedDuration) { setLoaded(true); return; }
      const d = a.duration;
      if (isFinite(d) && d > 0) { setDuration(d); setLoaded(true); return; }
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
      disposed = true;
      controller.abort();
      try { a.pause(); } catch {}
      a.removeEventListener("loadedmetadata", onLoaded);
      a.removeEventListener("durationchange", onLoaded);
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("ended", onEnd);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      a.removeEventListener("error", onError);
      audioRef.current = null;
      if (decodeContext && decodeContext.state !== "closed") void decodeContext.close().catch(() => {});
    };
  }, [src, durationSeconds]);

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
      const rect = (trackRef.current as any)?.getBoundingClientRect?.();
      const clientX = evt?.clientX ?? evt?.nativeEvent?.clientX
        ?? (evt?.nativeEvent?.pageX != null ? evt.nativeEvent.pageX - window.scrollX : null);
      const x = clientX != null && rect
        ? clientX - rect.left
        : evt?.nativeEvent?.locationX ?? evt?.nativeEvent?.offsetX ?? 0;
      const w = rect?.width || 1;
      const ratio = Math.max(0, Math.min(1, x / w));
      a.currentTime = ratio * duration;
      setCurrent(a.currentTime);
    } catch { /* silent */ }
  };

  const pct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;
  const btnBg = "#75bd70";
  const iconColor = "#fff";
  const trackBg = "transparent";
  const fillBg = "#75bd70";
  const textCol = "#66865e";
  const errCol = theme.colors.danger;

  if (!src && loading) {
    return <View style={styles.wrap} testID={testID}>
      <Pressable disabled style={[styles.playBtn, { backgroundColor: btnBg, opacity: 0.75 }]} accessibilityLabel="Chargement du message vocal">
        <Ionicons name="play" size={16} color={iconColor} />
      </Pressable>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <View style={[styles.track, { backgroundColor: trackBg }]}>
          <View style={styles.waveform} pointerEvents="none">
            {waveform.map((height, index) => <View key={index} style={[styles.waveBar, { height, backgroundColor: "#a8c89e" }]} />)}
          </View>
        </View>
        <View style={styles.loadingRow}>
          <Text style={{ color: textCol, fontSize: 12, fontVariant: ["tabular-nums"] }}>
            {durationSeconds ? formatVoiceDuration(durationSeconds) : "…"}
          </Text>
          <Text style={styles.loadingText}>Chargement du vocal</Text>
          <ActivityIndicator size="small" color={btnBg} />
        </View>
      </View>
    </View>;
  }

  return (
    <View style={styles.wrap} testID={testID}>
      <Pressable
        onPress={toggle}
        style={[styles.playBtn, { backgroundColor: btnBg }]}
        testID={testID ? `${testID}-toggle` : undefined}
        accessibilityRole="button"
        accessibilityLabel={playing ? "Mettre le message vocal en pause" : "Lire le message vocal"}
      >
        <Ionicons name={playing ? "pause" : "play"} size={16} color={iconColor} />
      </Pressable>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <Pressable
          ref={trackRef}
          onPress={Platform.OS === "web" ? (seek as any) : undefined}
          style={[styles.track, { backgroundColor: trackBg }]}
          accessibilityRole="adjustable"
          accessibilityLabel="Position de lecture du message vocal"
          accessibilityValue={{ min: 0, max: duration, now: current }}
          testID={testID ? `${testID}-seek` : undefined}
          // @ts-ignore web-only pointer events for drag-to-seek
          onPointerDown={Platform.OS === "web" ? (seek as any) : undefined}
        >
          <View style={styles.waveform} pointerEvents="none">
            {waveform.map((height, index) => (
              <View
                key={index}
                style={[
                  styles.waveBar,
                  { height, backgroundColor: index / waveform.length <= pct / 100 ? fillBg : "#a8c89e" },
                ]}
              />
            ))}
          </View>
        </Pressable>
        <View style={{ flexDirection: "row" }}>
          <Text style={{ color: textCol, fontSize: 12, fontVariant: ["tabular-nums"] }}>
            {formatVoiceDuration(playing || current > 0 ? current : duration)}
          </Text>
        </View>
        {err ? (
          <Text style={{ color: errCol, fontSize: 10, fontWeight: "700" }} numberOfLines={2}>
            {err}
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
    width: "100%",
    minWidth: 0,
  },
  playBtn: {
    width: 44, height: 44, borderRadius: 22, flexShrink: 0,
    alignItems: "center", justifyContent: "center",
  },
  track: {
    height: 25, borderRadius: 5,
    overflow: "hidden", justifyContent: "center", paddingHorizontal: 3,
    minWidth: 0,
    ...(Platform.OS === "web" ? { cursor: "pointer" as any } : {}),
  },
  waveform: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", width: "100%", height: "100%", gap: 2 },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  loadingText: { color: "#66865e", fontSize: 11, flex: 1 },
  waveBar: {
    width: 2,
    minWidth: 1,
    borderRadius: 2,
  },
});
