import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Platform, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { protectedFileUrl } from "./api";
import type { Attachment } from "./types";
import { chatVisual } from "./chatVisualTokens";

export default function ProtectedMessageMedia({
  file, onOpen, onLongPress, compact = false, autoLoad = true, maxWidth = 260,
}: { file: Attachment; onOpen: (loadedUrl?: string) => void; onLongPress?: (event: any) => void; compact?: boolean; autoLoad?: boolean; maxWidth?: number }) {
  const [url, setUrl] = useState("");
  const [aspect, setAspect] = useState(4 / 3);
  const [error, setError] = useState(false);
  const [requested, setRequested] = useState(autoLoad);
  const videoHost = useRef<View | null>(null);
  const isVideo = file.mime.startsWith("video/");
  const isSticker = file.sticker || file.name.startsWith("sticker-");
  const width = Math.max(1, Math.min(isSticker ? 150 : compact ? 132 : 260, maxWidth, isSticker ? 150 : (compact ? 144 : 380) * aspect));
  const height = isSticker ? width : width / aspect;

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
    video.onloadedmetadata = () => {
      if (video.videoWidth && video.videoHeight) setAspect(video.videoWidth / video.videoHeight);
    };
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
  if (!url && !requested) return <TouchableOpacity onPress={() => setRequested(true)} onLongPress={event => { event.stopPropagation?.(); onLongPress?.(event); }} delayLongPress={420} accessibilityRole="button" accessibilityLabel={isSticker ? "Charger le sticker" : `Charger le média ${file.name}`} style={[styles.loading, { width, height, maxWidth: "100%" }]} testID={`${isSticker ? "messenger-sticker" : "messenger-media"}-load-${file.id}`}>
    <Ionicons name={isSticker ? "happy-outline" : "download-outline"} size={25} color={chatVisual.brand} /><Text style={styles.loadText}>{isSticker ? "Charger le sticker" : "Charger le média"}</Text>
  </TouchableOpacity>;
  if (!url) return <View style={[styles.loading, { width, height, maxWidth: "100%" }]}><ActivityIndicator color="#1769e8" /></View>;
  if (isVideo) return <View style={[styles.videoFrame, { width, height, maxWidth: "100%" }]}>
    <TouchableOpacity activeOpacity={1} onLongPress={event => { event.stopPropagation?.(); onLongPress?.(event); }} delayLongPress={420} accessibilityRole="button" accessibilityLabel={`Options de la vidéo ${file.name}`} testID={`messenger-video-${file.id}`}>
      <View ref={videoHost} style={[styles.video, { width, height, maxWidth: "100%" }]} />
    </TouchableOpacity>
    <TouchableOpacity
      style={styles.videoExpand}
      onPress={event => { event.stopPropagation?.(); onOpen(url); }}
      accessibilityRole="button"
      accessibilityLabel={`Ouvrir la vidéo ${file.name} en grand`}
      testID={`messenger-video-open-${file.id}`}
    >
      <Ionicons name="expand-outline" size={18} color="#fff" />
    </TouchableOpacity>
  </View>;
  return <TouchableOpacity onPress={event => { event.stopPropagation?.(); onOpen(url); }} onLongPress={event => { event.stopPropagation?.(); onLongPress?.(event); }} delayLongPress={420} accessibilityRole="button" accessibilityLabel={isSticker ? "Ouvrir les actions du sticker" : `Ouvrir la photo ${file.name}`} testID={`${isSticker ? "messenger-sticker" : "messenger-image"}-${file.id}`} style={[styles.imageFrame, isSticker && styles.stickerFrame, { width, height, maxWidth: "100%" }]}>
    <Image
      source={{ uri: url }}
      resizeMode={isSticker ? "contain" : "cover"}
      onLoad={(event: any) => {
        const { width: naturalWidth, height: naturalHeight } = event.nativeEvent.source || {};
        if (naturalWidth && naturalHeight) setAspect(naturalWidth / naturalHeight);
      }}
      style={styles.image}
    />
  </TouchableOpacity>;
}

const styles = StyleSheet.create({
  imageFrame: { backgroundColor: "transparent", borderRadius: 13, overflow: "hidden", marginTop: 0, minWidth: 0, flexShrink: 1, borderWidth: 1, borderColor: "rgba(16,32,66,.09)" },
  stickerFrame: { backgroundColor: "transparent", borderRadius: 0, overflow: "visible", marginTop: 2 },
  image: { width: "100%", height: "100%", maxWidth: "100%" },
  videoFrame: { position: "relative" },
  video: { backgroundColor: "#080d15", borderRadius: 10, overflow: "hidden", marginTop: 0, minWidth: 0, flexShrink: 1 },
  videoExpand: { position: "absolute", right: 8, bottom: 8, width: 34, height: 34, borderRadius: 17, backgroundColor: "rgba(0,0,0,.68)", alignItems: "center", justifyContent: "center" },
  loading: { backgroundColor: "#f3f7fb", borderWidth: 1, borderColor: "#e1e8f0", borderRadius: 13, alignItems: "center", justifyContent: "center", marginTop: 5, minWidth: 0, flexShrink: 1 },
  loadText: { color: "#1769e8", fontSize: 12, fontWeight: "700", marginTop: 5 },
  failed: { backgroundColor: "#edf2fa", borderWidth: 1, borderColor: "#e1e8f0", borderRadius: 13, alignItems: "center", justifyContent: "center", marginTop: 5 },
  failedLogo: { width: 45, height: 45, opacity: .65 },
});
