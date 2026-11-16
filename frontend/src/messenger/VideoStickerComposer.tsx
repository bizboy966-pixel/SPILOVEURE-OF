import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";

type Props = { file: File; onClose: () => void; onConfirm: (start: number, duration: number) => Promise<void> };

export default function VideoStickerComposer({ file, onClose, onConfirm }: Props) {
  const host = useRef<View>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [length, setLength] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selection = useRef({ start, end });
  selection.current = { start, end };
  useEffect(() => {
    const node = host.current as unknown as HTMLElement;
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.src = url; video.controls = true; video.muted = true; video.playsInline = true;
    video.style.cssText = "width:100%;height:100%;object-fit:contain";
    video.onloadedmetadata = () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        setError("La durée de cette vidéo est illisible."); return;
      }
      setLength(video.duration); setEnd(Math.min(3, video.duration));
    };
    video.onerror = () => setError("Ce navigateur ne peut pas prévisualiser cette vidéo. Choisissez un fichier MP4 compatible.");
    video.ontimeupdate = () => {
      const range = selection.current;
      if (video.currentTime >= range.end || video.currentTime < range.start - 0.1) video.currentTime = range.start;
    };
    node.replaceChildren(video); videoRef.current = video;
    return () => {
      video.pause(); video.removeAttribute("src"); video.load();
      node.replaceChildren(); videoRef.current = null; URL.revokeObjectURL(url);
    };
  }, [file]);
  const preview = () => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = start;
    void videoRef.current.play().catch(() => setError("Appuyez sur Lecture dans la vidéo."));
  };
  const confirm = async () => {
    if (busy || !length || end <= start) return;
    setBusy(true); setError(""); videoRef.current?.pause();
    try { await onConfirm(start, end - start); }
    catch (e: any) { setError(e?.detail || e?.message || "Conversion impossible."); setBusy(false); }
  };
  return <Modal transparent animationType="slide" onRequestClose={() => !busy && onClose()}>
    <View style={styles.backdrop}><View style={styles.sheet} testID="video-sticker-composer">
      <Text style={styles.title}>Créer un sticker animé</Text>
      <Text style={styles.hint}>Choisissez un extrait de 6 secondes maximum. Le sticker sera muet et joué en boucle.</Text>
      <View ref={host} style={styles.preview} />
      <Text style={styles.label}>Début : {start.toFixed(1)} s</Text>
      {React.createElement("input", {
        type: "range", min: 0, max: Math.max(0, length - 0.1), step: 0.1, value: start,
        "aria-label": "Début du sticker", disabled: busy || !length, style: { width: "100%" },
        onChange: (e: any) => {
          const value = Number(e.target.value); setStart(value);
          setEnd(Math.min(length, Math.max(value + 0.1, Math.min(end, value + 6))));
          if (videoRef.current) videoRef.current.currentTime = value;
        },
      })}
      <Text style={styles.label}>Fin : {end.toFixed(1)} s · Durée : {(end - start).toFixed(1)} s</Text>
      {React.createElement("input", {
        type: "range", min: start + 0.1, max: Math.min(length, start + 6), step: 0.1, value: end,
        "aria-label": "Fin du sticker", disabled: busy || !length, style: { width: "100%" },
        onChange: (e: any) => setEnd(Number(e.target.value)),
      })}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}>
        <TouchableOpacity disabled={busy} onPress={onClose}><Text style={styles.label}>Annuler</Text></TouchableOpacity>
        <TouchableOpacity disabled={busy || !length} onPress={preview}><Text style={styles.label}>Prévisualiser</Text></TouchableOpacity>
        <TouchableOpacity disabled={busy || !length} onPress={() => void confirm()} style={styles.send}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.label}>Créer et envoyer</Text>}
        </TouchableOpacity>
      </View>
    </View></View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "#000b", justifyContent: "center", alignItems: "center", padding: 14 },
  sheet: { width: "100%", maxWidth: 520, padding: 16, borderRadius: 20, backgroundColor: "#14212c", gap: 10 },
  title: { color: "#fff", fontSize: 20, fontWeight: "700" },
  hint: { color: "#b4c6d6", fontSize: 13 }, label: { color: "#fff", fontSize: 13 },
  preview: { height: 240, maxHeight: "35vh" as any, width: "100%" },
  error: { color: "#ffaaa6", fontSize: 13 },
  actions: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  send: { paddingHorizontal: 12, paddingVertical: 12, borderRadius: 22, backgroundColor: "#1769e8" },
});
