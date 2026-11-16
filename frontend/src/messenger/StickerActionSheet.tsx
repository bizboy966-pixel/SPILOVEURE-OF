import React, { useEffect, useState } from "react";
import { ActivityIndicator, Image, Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { AttachmentPreview } from "./ProtectedAttachmentViewer";

export default function StickerActionSheet({
  preview, saved, onClose, onSave, onRemove,
}: {
  preview: AttachmentPreview | null;
  saved: boolean;
  onClose: () => void;
  onSave: () => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [isSaved, setIsSaved] = useState(saved);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setIsSaved(saved); }, [preview?.fileId, saved]);

  const close = () => {
    if (preview?.url) URL.revokeObjectURL(preview.url);
    onClose();
  };
  const toggleFavorite = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (isSaved) await onRemove();
      else await onSave();
      setIsSaved(!isSaved);
    } catch (error: any) {
      if (typeof window !== "undefined") window.alert(error?.detail || error?.message || "Impossible de modifier ce sticker.");
    } finally {
      setBusy(false);
    }
  };

  return <Modal visible={!!preview?.sticker} transparent animationType="fade" onRequestClose={close}>
    <View style={styles.backdrop} testID="messenger-sticker-action-sheet">
      <TouchableOpacity style={styles.dismiss} onPress={close} accessibilityLabel="Fermer les actions du sticker" />
      <View style={styles.card}>
        {preview?.url ? <Image
          source={{ uri: preview.url }}
          resizeMode="contain"
          style={styles.sticker}
          accessibilityLabel="Aperçu du sticker"
        /> : null}
        <Text style={styles.title}>Sticker</Text>
        <TouchableOpacity
          onPress={() => void toggleFavorite()}
          disabled={busy}
          style={[styles.favorite, isSaved && styles.removeFavorite]}
          accessibilityRole="button"
          accessibilityLabel={isSaved ? "Retirer des stickers favoris" : "Ajouter aux stickers favoris"}
          testID="messenger-toggle-sticker-favorite"
        >
          {busy ? <ActivityIndicator color="#fff" /> : <Ionicons name={isSaved ? "star" : "star-outline"} size={19} color="#fff" />}
          <Text style={styles.favoriteText}>
            {busy ? "Mise à jour…" : isSaved ? "Retirer des favoris" : "Ajouter aux favoris"}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={close} style={styles.close} accessibilityRole="button">
          <Text style={styles.closeText}>Fermer</Text>
        </TouchableOpacity>
      </View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(6,14,24,.42)", justifyContent: "center", alignItems: "center", padding: 18 },
  dismiss: { ...StyleSheet.absoluteFillObject },
  card: { width: "100%", maxWidth: 300, backgroundColor: "#fff", borderRadius: 20, padding: 16, alignItems: "center", shadowColor: "#08182a", shadowOpacity: .2, shadowRadius: 20, elevation: 12 },
  sticker: { width: 164, height: 164, marginBottom: 4 },
  title: { color: "#667085", fontSize: 13, fontWeight: "700", marginBottom: 12 },
  favorite: { minHeight: 46, width: "100%", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9, backgroundColor: "#1769e8", borderRadius: 24, paddingHorizontal: 14 },
  removeFavorite: { backgroundColor: "#58677a" },
  favoriteText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  close: { paddingVertical: 12, paddingHorizontal: 18 },
  closeText: { color: "#1769e8", fontWeight: "700", fontSize: 14 },
});
