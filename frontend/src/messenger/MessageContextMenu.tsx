import React from "react";
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { Message } from "./types";

type Props = {
  message: Message | null;
  left: number;
  top: number;
  screenWidth: number;
  screenHeight: number;
  canPin: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onClose: () => void;
  onReply: () => void;
  onReact: (emoji: string) => void;
  onCopy: () => void;
  onCopyLink: () => void;
  onForward: () => void;
  onPin: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSave: () => void;
};

const quickReactions = ["⭐", "❤️", "👍", "🔥", "🥰", "👋", "😁"];

export default function MessageContextMenu({
  message, left, top, screenWidth, screenHeight, canPin, canEdit, canDelete,
  onClose, onReply, onReact, onCopy, onCopyLink, onForward, onPin, onEdit, onDelete, onSave,
}: Props) {
  if (!message) return null;
  const media = message.attachments?.some(file => !file.view_once &&
    (file.mime.startsWith("image/") || file.mime.startsWith("video/") || !file.mime.startsWith("audio/")),
  );
  const actions = [
    { label: "Répondre", icon: "arrow-undo-outline" as const, onPress: onReply, testID: "reply" },
    ...(message.text || message.attachments?.length
      ? [{ label: "Copier", icon: "copy-outline" as const, onPress: onCopy, testID: "copy" }]
      : []),
    { label: "Copier le lien", icon: "link-outline" as const, onPress: onCopyLink, testID: "copy-link" },
    ...(media ? [{ label: "Enregistrer", icon: "download-outline" as const, onPress: onSave, testID: "save" }] : []),
    ...(message.attachments?.some(file => file.view_once)
      ? []
      : [{ label: "Transférer", icon: "arrow-redo-outline" as const, onPress: onForward, testID: "forward" }]),
    ...(canPin ? [{ label: message.pinned ? "Désépingler" : "Épingler", icon: "pin-outline" as const, onPress: onPin, testID: "pin" }] : []),
    ...(canEdit ? [{ label: "Modifier", icon: "create-outline" as const, onPress: onEdit, testID: "edit" }] : []),
    ...(canDelete ? [{ label: "Supprimer", icon: "trash-outline" as const, onPress: onDelete, testID: "delete", danger: true }] : []),
  ];
  const menuWidth = Math.min(288, screenWidth - 24);
  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.backdrop} testID="messenger-message-context">
        <TouchableOpacity style={StyleSheet.absoluteFillObject} onPress={onClose} accessibilityLabel="Fermer les options du message" />
        <View style={[styles.reactionBar, { left, top: Math.max(12, top - 60), maxWidth: screenWidth - 24 }]} testID="messenger-message-reactions">
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.reactionRow}>
            {quickReactions.map(emoji => (
              <TouchableOpacity key={emoji} onPress={() => onReact(emoji)} style={styles.reactionButton} accessibilityRole="button" accessibilityLabel={`Réagir ${emoji}`} testID={`messenger-context-react-${emoji}`}>
                <Text style={styles.reactionEmoji}>{emoji}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
        <View
          style={[
            styles.menu,
            {
              left,
              top,
              width: menuWidth,
              maxHeight: Math.max(180, screenHeight - top - 12),
            },
          ]}
          testID="messenger-message-actions"
        >
          <ScrollView keyboardShouldPersistTaps="always" showsVerticalScrollIndicator={false}>
            {actions.map(item => (
              <TouchableOpacity
                key={item.testID}
                onPress={item.onPress}
                style={styles.action}
                accessibilityRole="button"
                testID={`messenger-context-${item.testID}`}
              >
                <Ionicons name={item.icon} size={22} color={item.danger ? "#d73546" : "#202833"} />
                <Text style={[styles.actionText, item.danger && styles.dangerText]}>{item.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(10,18,30,.18)" },
  reactionBar: {
    position: "absolute", minHeight: 54, borderRadius: 28, backgroundColor: "#fff",
    paddingHorizontal: 8, shadowColor: "#152238", shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2, shadowRadius: 12, elevation: 12,
  },
  reactionRow: { alignItems: "center", gap: 3 },
  reactionButton: { width: 42, height: 46, alignItems: "center", justifyContent: "center" },
  reactionEmoji: { fontSize: 25 },
  menu: {
    position: "absolute", overflow: "hidden", borderRadius: 18, backgroundColor: "#fff",
    paddingVertical: 5, shadowColor: "#102042", shadowOffset: { width: 0, height: 7 },
    shadowOpacity: 0.23, shadowRadius: 18, elevation: 14,
  },
  action: { minHeight: 47, flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 17 },
  actionText: { color: "#202833", fontSize: 15, fontWeight: "500" },
  dangerText: { color: "#d73546" },
});
