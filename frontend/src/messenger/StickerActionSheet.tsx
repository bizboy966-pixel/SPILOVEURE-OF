import React, { useEffect, useState } from "react";
import { ActivityIndicator, Image, Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { AttachmentPreview } from "./ProtectedAttachmentViewer";
import { chatVisual } from "./chatVisualTokens";

export default function StickerActionSheet({
  preview, saved, packed, onClose, onSave, onRemove, onAddToPack, onRemoveFromPack, onEdit,
}: {
  preview: AttachmentPreview | null;
  saved: boolean;
  packed: boolean;
  onClose: () => void;
  onSave: () => Promise<void>;
  onRemove: () => Promise<void>;
  onAddToPack: () => Promise<void>;
  onRemoveFromPack: () => Promise<void>;
  onEdit: () => Promise<void>;
}) {
  const [isSaved, setIsSaved] = useState(saved);
  const [isPacked, setIsPacked] = useState(packed);
  const [busy, setBusy] = useState<"favorite" | "pack" | "edit" | null>(null);
  useEffect(() => { setIsSaved(saved); setIsPacked(packed); }, [preview?.fileId, saved, packed]);

  const close = () => {
    if (preview?.releaseUrl && preview.url) URL.revokeObjectURL(preview.url);
    onClose();
  };
  const runAction = async (key: "favorite" | "pack" | "edit", action: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    try {
      await action();
      if (key === "favorite") setIsSaved(value => !value);
      if (key === "pack") setIsPacked(value => !value);
    } catch (error: any) {
      if (typeof window !== "undefined") window.alert(error?.detail || error?.message || "Impossible de modifier ce sticker.");
    } finally {
      setBusy(null);
    }
  };
  const actionRow = (
    key: "favorite" | "pack" | "edit",
    icon: React.ComponentProps<typeof Ionicons>["name"],
    label: string,
    action: () => Promise<void>,
    testID: string,
  ) => <TouchableOpacity
    onPress={() => void runAction(key, action)}
    disabled={busy !== null}
    style={styles.actionRow}
    accessibilityRole="button"
    testID={testID}
  >
    {busy === key ? <ActivityIndicator color="#1769e8" /> : <Ionicons name={icon} size={25} color="#64748b" />}
    <Text style={styles.actionText}>{busy === key ? "Veuillez patienter…" : label}</Text>
  </TouchableOpacity>;

  return <Modal visible={!!preview?.sticker} transparent animationType="slide" onRequestClose={close}>
    <View style={styles.backdrop} testID="messenger-sticker-action-sheet">
      <TouchableOpacity style={styles.dismiss} onPress={close} accessibilityLabel="Fermer les actions du sticker" />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <View style={styles.previewArea}>
          <TouchableOpacity style={styles.close} onPress={close} accessibilityLabel="Fermer les actions du sticker">
            <Ionicons name="close" size={25} color="#172016" />
          </TouchableOpacity>
          {preview?.url ? <Image
            source={{ uri: preview.url }}
            resizeMode="contain"
            style={styles.sticker}
            accessibilityLabel="Aperçu du sticker"
          /> : null}
        </View>
        <View style={styles.divider} />
        {actionRow("favorite", isSaved ? "star-half-outline" : "star-outline",
          isSaved ? "Retirer des favoris" : "Ajouter aux favoris",
          isSaved ? onRemove : onSave, "messenger-toggle-sticker-favorite")}
        <View style={styles.divider} />
        {actionRow("pack", isPacked ? "albums" : "albums-outline",
          isPacked ? "Retirer du pack de stickers" : "Ajouter au pack de stickers",
          isPacked ? onRemoveFromPack : onAddToPack, "messenger-toggle-sticker-pack")}
        <View style={styles.divider} />
        {actionRow("edit", "create-outline", "Modifier", onEdit, "messenger-edit-sticker")}
        <View style={styles.bottomInset} />
      </View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(10,18,32,.38)", justifyContent: "flex-end" },
  dismiss: { ...StyleSheet.absoluteFillObject },
  sheet: { width: "100%", minHeight: 490, maxHeight: "76%", backgroundColor: "#fffefa", paddingTop: 12, paddingBottom: 8, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, borderColor: "#e1e7ef" },
  handle: { alignSelf: "center", width: 38, height: 4, borderRadius: 2, backgroundColor: "#cbd3dd", marginBottom: 9 },
  previewArea: { height: 222, justifyContent: "center", alignItems: "center" },
  close: { position: "absolute", left: 20, top: 18, zIndex: 2, width: 42, height: 42, justifyContent: "center", alignItems: "center" },
  sticker: { width: 205, height: 205 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: "#e4e9f0" },
  actionRow: { height: 70, flexDirection: "row", alignItems: "center", gap: 20, paddingHorizontal: 24 },
  actionText: { color: chatVisual.ink, fontSize: 15, fontWeight: "600" },
  bottomInset: { height: 8 },
});
