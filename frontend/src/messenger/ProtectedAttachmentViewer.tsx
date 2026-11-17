import React, { useEffect, useRef } from "react";
import { Image, Modal, Platform, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { protectedFileUrl } from "./api";
import type { Attachment } from "./types";
import { chatVisual } from "./chatVisualTokens";

export type AttachmentPreview = {
  url: string; mime: string; name: string; fileId?: string;
  releaseUrl?: boolean;
  sticker?: { conversationId: string; messageId: string };
};

export async function openProtectedAttachment(
  file: Attachment,
  onPreview: (preview: AttachmentPreview) => void,
  loadedUrl?: string,
) {
  const url = loadedUrl || await protectedFileUrl(file.id);
  if (file.mime.startsWith("image/") || file.mime.startsWith("audio/") || file.mime.startsWith("video/")) {
    onPreview({ url, mime: file.mime, name: file.name, releaseUrl: !loadedUrl });
    return;
  }
  if (typeof document === "undefined") return;
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = file.name; anchor.target = "_blank"; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function ProtectedAttachmentViewer({
  preview, onClose,
}: {
  preview: AttachmentPreview | null;
  onClose: () => void;
}) {
  const mediaContainer = useRef<View | null>(null);
  useEffect(() => {
    if (!preview || Platform.OS !== "web" || typeof document === "undefined" || preview.mime.startsWith("image/")) return;
    const container = mediaContainer.current as unknown as HTMLElement | null;
    if (!container) return;
    const media = document.createElement(preview.mime.startsWith("video/") ? "video" : "audio");
    media.controls = true; media.preload = "metadata"; media.src = preview.url; media.style.width = "100%";
    if (media instanceof HTMLVideoElement) media.style.maxHeight = "60vh";
    container.replaceChildren(media);
    return () => {
      if (media instanceof HTMLMediaElement) media.pause();
      media.removeAttribute("src"); media.load(); container.replaceChildren();
    };
  }, [preview]);
  const close = () => {
    if (preview?.releaseUrl && preview.url) URL.revokeObjectURL(preview.url);
    onClose();
  };
  return <Modal visible={!!preview} transparent animationType="fade" onRequestClose={close}>
    <View style={styles.backdrop}>
      <TouchableOpacity style={styles.close} onPress={close} accessibilityLabel="Fermer l’aperçu"><Ionicons name="close-circle" size={32} color="#fff" /></TouchableOpacity>
      {preview?.mime.startsWith("image/") && <Image source={{ uri: preview.url }} resizeMode="contain" style={styles.image} />}
      {preview && !preview.mime.startsWith("image/") && <View style={styles.mediaCard}><Text style={styles.name}>{preview.name}</Text><View ref={mediaContainer} style={styles.media} /></View>}
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(10,18,32,.94)", alignItems: "center", justifyContent: "center" },
  close: { position: "absolute", zIndex: 2, top: 22, right: 20 },
  image: { width: "92%", height: "78%", maxWidth: "100%" },
  mediaCard: { width: "min(90%, 520px)" as any, backgroundColor: "#fffefa", borderRadius: 17, padding: 19, borderWidth: 1, borderColor: "#e1e7ef" },
  name: { color: chatVisual.ink, fontWeight: "800", marginBottom: 12 }, media: { width: "100%", minHeight: 42 },
});
