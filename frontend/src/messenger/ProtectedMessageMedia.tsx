import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Platform, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { protectedFileUrl } from "./api";
import type { Attachment } from "./types";

export default function ProtectedMessageMedia({
  file, onOpen, compact = false, autoLoad = true, maxWidth = 260,
}: { file: Attachment; onOpen: () => void; compact?: boolean; autoLoad?: boolean; maxWidth?: number }) {
  const [url, setUrl] = useState("");
  const [aspect, setAspect] = useState(4 / 3);
  const [error, setError] = useState(false);
  const [requested, setRequested] = useState(autoLoad);
  const videoHost = useRef<View | null>(null);
  const isVideo = file.mime.startsWith("video/");
  const isSticker = file.name.startsWith("sticker-");
  const width = Math.max(1, Math.min(isSticker ? 150 : compact ? 132 : 260, maxWidth));
  const height = isSticker
    ? Math.min(200, Math.max(80, width / aspect))
    : Math.min(compact ? 144 : 320, Math.max(112, width / aspect));

  useEffect(() => { if (autoLoad) setRequested(true); }, [autoLoad]);
  useEffect(() => {
    if (!requested) return;
    let active = true;
    let objectUrl = "";
    protectedFileUrl(file.id).then(value => {
      objectUrl = value;
      if (active) setUrl(value);
      else URL.revokeObjectURL(value);
    }).catch(() => { if (active) setError(true); });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.id, requested]);

  useEffect(() => {
    const host = videoHost.current as unknown as HTMLElement | null;
    if (!url || !isVideo || Platform.OS !== "web" || !host) return;
    const video = document.createElement("video");
    video.src = url;
    video.controls = true;
    video.preload = "metadata";
    video.playsInline = true;
    video.style.width = "100%";
    video.style.height = "100%";
    video.style.maxHeight = compact ? "144px" : "320px";
    video.style.objectFit = "contain";
    video.style.borderRadius = "12px";
    host.replaceChildren(video);
    return () => {
      video.pause();
      video.removeAttribute("src");
      video.load();
      host.replaceChildren();
    };
  }, [url, isVideo, compact]);

  if (error) return <View style={[styles.failed, { width, height, maxWidth: "100%" }]}><Image source={require("../../assets/images/spiloveure-logo.png")} style={styles.failedLogo} /></View>;
  if (!url && !requested) return <TouchableOpacity onPress={() => setRequested(true)} accessibilityRole="button" accessibilityLabel={`Charger le média ${file.name}`} style={[styles.loading, { width, height, maxWidth: "100%" }]} testID={`messenger-media-load-${file.id}`}>
    <Ionicons name="download-outline" size={25} color="#1769e8" /><Text style={styles.loadText}>Charger le média</Text>
  </TouchableOpacity>;
  if (!url) return <View style={[styles.loading, { width, height, maxWidth: "100%" }]}><ActivityIndicator color="#1769e8" /></View>;
  if (isVideo) return <View ref={videoHost} style={[styles.video, { width, height, maxWidth: "100%" }]} />;
  return <TouchableOpacity onPress={event => { event.stopPropagation?.(); onOpen(); }} accessibilityRole="button" accessibilityLabel={isSticker ? "Ouvrir le sticker" : `Ouvrir la photo ${file.name}`} testID={`messenger-image-${file.id}`} style={[styles.imageFrame, isSticker && styles.stickerFrame, { width, height, maxWidth: "100%" }]}>
    <Image
      source={{ uri: url }}
      resizeMode="contain"
      onLoad={(event: any) => {
        const { width: naturalWidth, height: naturalHeight } = event.nativeEvent.source || {};
        if (naturalWidth && naturalHeight) setAspect(naturalWidth / naturalHeight);
      }}
      style={styles.image}
    />
  </TouchableOpacity>;
}

const styles = StyleSheet.create({
  imageFrame: { backgroundColor: "#101827", borderRadius: 12, overflow: "hidden", marginTop: 5, minWidth: 0, flexShrink: 1 },
  stickerFrame: { backgroundColor: "transparent", borderRadius: 0, overflow: "visible", marginTop: 2 },
  image: { width: "100%", height: "100%", maxWidth: "100%" },
  video: { backgroundColor: "#080d15", borderRadius: 12, overflow: "hidden", marginTop: 5, minWidth: 0, flexShrink: 1 },
  loading: { backgroundColor: "#edf2fa", borderRadius: 12, alignItems: "center", justifyContent: "center", marginTop: 5, minWidth: 0, flexShrink: 1 },
  loadText: { color: "#1769e8", fontSize: 12, fontWeight: "700", marginTop: 5 },
  failed: { backgroundColor: "#edf2fa", borderRadius: 12, alignItems: "center", justifyContent: "center", marginTop: 5 },
  failedLogo: { width: 45, height: 45, opacity: .65 },
});
