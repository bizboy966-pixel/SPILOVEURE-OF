import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Platform, StyleSheet, TouchableOpacity, View } from "react-native";
import { protectedFileUrl } from "./api";
import type { Attachment } from "./types";

export default function ProtectedMessageMedia({
  file, onOpen, compact = false,
}: { file: Attachment; onOpen: () => void; compact?: boolean }) {
  const [url, setUrl] = useState("");
  const [aspect, setAspect] = useState(4 / 3);
  const [error, setError] = useState(false);
  const videoHost = useRef<View | null>(null);
  const isVideo = file.mime.startsWith("video/");
  const width = compact ? 132 : 250;
  const height = Math.min(compact ? 144 : 320, Math.max(112, width / aspect));

  useEffect(() => {
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
  }, [file.id]);

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

  if (error) return <View style={[styles.failed, { width, height }]}><Image source={require("../../assets/images/spiloveure-logo.png")} style={styles.failedLogo} /></View>;
  if (!url) return <View style={[styles.loading, { width, height }]}><ActivityIndicator color="#1769e8" /></View>;
  if (isVideo) return <View ref={videoHost} style={[styles.video, { width, height }]} />;
  return <TouchableOpacity onPress={onOpen} accessibilityLabel={`Ouvrir la photo ${file.name}`} testID={`messenger-image-${file.id}`} style={[styles.imageFrame, { width, height }]}>
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
  imageFrame: { backgroundColor: "#101827", borderRadius: 12, overflow: "hidden", marginTop: 5 },
  image: { width: "100%", height: "100%" },
  video: { backgroundColor: "#080d15", borderRadius: 12, overflow: "hidden", marginTop: 5 },
  loading: { backgroundColor: "#edf2fa", borderRadius: 12, alignItems: "center", justifyContent: "center", marginTop: 5 },
  failed: { backgroundColor: "#edf2fa", borderRadius: 12, alignItems: "center", justifyContent: "center", marginTop: 5 },
  failedLogo: { width: 45, height: 45, opacity: .65 },
});
