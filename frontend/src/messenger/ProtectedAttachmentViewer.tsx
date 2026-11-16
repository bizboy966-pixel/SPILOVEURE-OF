import React, { useEffect, useRef, useState } from "react";
import { Image, Modal, Platform, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { protectedFileUrl } from "./api";
import type { Attachment } from "./types";

export type AttachmentPreview = {
  url: string; mime: string; name: string; fileId?: string;
  sticker?: { conversationId: string; messageId: string };
};

export async function openProtectedAttachment(file: Attachment, onPreview: (preview: AttachmentPreview) => void) {
  const url = await protectedFileUrl(file.id);
  if (file.mime.startsWith("image/") || file.mime.startsWith("audio/") || file.mime.startsWith("video/")) {
    onPreview({ url, mime: file.mime, name: file.name });
    return;
  }
  if (typeof document === "undefined") return;
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = file.name; anchor.target = "_blank"; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function ProtectedAttachmentViewer({
  preview, onClose, onSaveSticker, stickerSaved = false,
}: {
  preview: AttachmentPreview | null;
  onClose: () => void;
  onSaveSticker?: () => Promise<void>;
  stickerSaved?: boolean;
}) {
  const mediaContainer = useRef<View | null>(null);
  const [savingSticker, setSavingSticker] = useState(false);
  const [savedSticker, setSavedSticker] = useState(false);
  useEffect(() => setSavedSticker(stickerSaved), [preview?.fileId, stickerSaved]);
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
    if (preview?.url) URL.revokeObjectURL(preview.url);
    onClose();
  };
  const saveSticker = async () => {
    if (!onSaveSticker || savingSticker || savedSticker || stickerSaved) return;
    setSavingSticker(true);
    try {
      await onSaveSticker();
      setSavedSticker(true);
    } catch (error: any) {
      if (typeof window !== "undefined") window.alert(error?.detail || error?.message || "Impossible d’enregistrer ce sticker.");
    } finally {
      setSavingSticker(false);
    }
  };
  return <Modal visible={!!preview} transparent animationType="fade" onRequestClose={close}>
    <View style={styles.backdrop}>
      <TouchableOpacity style={styles.close} onPress={close} accessibilityLabel="Fermer l’aperçu"><Ionicons name="close-circle" size={32} color="#fff" /></TouchableOpacity>
      {preview?.mime.startsWith("image/") && <Image source={{ uri: preview.url }} resizeMode="contain" style={styles.image} />}
      {preview && !preview.mime.startsWith("image/") && <View style={styles.mediaCard}><Text style={styles.name}>{preview.name}</Text><View ref={mediaContainer} style={styles.media} /></View>}
      {preview?.sticker && <TouchableOpacity
        onPress={() => void saveSticker()}
        disabled={savingSticker || stickerSaved || savedSticker}
        style={[styles.saveSticker, (stickerSaved || savedSticker) && styles.savedSticker]}
        accessibilityRole="button"
        accessibilityLabel={stickerSaved || savedSticker ? "Sticker enregistré" : "Enregistrer le sticker"}
        testID="messenger-save-sticker"
      >
        <Ionicons name={stickerSaved || savedSticker ? "bookmark" : "bookmark-outline"} size={19} color="#fff" />
        <Text style={styles.saveStickerText}>{savingSticker ? "Enregistrement…" : stickerSaved || savedSticker ? "Enregistré" : "Enregistrer"}</Text>
      </TouchableOpacity>}
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(5,12,25,.92)", alignItems: "center", justifyContent: "center" },
  close: { position: "absolute", zIndex: 2, top: 22, right: 20 },
  image: { width: "92%", height: "78%", maxWidth: "100%" },
  saveSticker: { position: "absolute", bottom: 28, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#1769e8", borderRadius: 24, paddingHorizontal: 18, paddingVertical: 12 },
  savedSticker: { backgroundColor: "#27844a" },
  saveStickerText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  mediaCard: { width: "min(90%, 520px)" as any, backgroundColor: "#fff", borderRadius: 15, padding: 16 },
  name: { color: "#102042", fontWeight: "800", marginBottom: 12 }, media: { width: "100%", minHeight: 42 },
});
