import React, { useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { createMemoryAdapter, EmojiKeyboard, type CategoryTypes } from "@softwhere-uz/react-native-emoji-keyboard";
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

const quickReactions = ["❤️", "👍", "🔥", "🥰", "😂"];
const emojiStorage = createMemoryAdapter();
const emojiTranslation: Record<CategoryTypes, string> = {
  smileys_emotion: "Visages", people_body: "Personnes", animals_nature: "Animaux et nature",
  food_drink: "Nourriture", travel_places: "Voyages", activities: "Activités",
  objects: "Objets", symbols: "Symboles", flags: "Drapeaux", favorites: "Favoris",
  recently_used: "Récents", search: "Recherche",
};

export default function MessageContextMenu({
  message, left, top, screenWidth, screenHeight, canPin, canEdit, canDelete,
  onClose, onReply, onReact, onCopy, onCopyLink, onForward, onPin, onEdit, onDelete, onSave,
}: Props) {
  const [showAllEmoji, setShowAllEmoji] = useState(false);
  if (!message) return null;
  const media = message.attachments?.some(file => !file.view_once &&
    (file.mime.startsWith("image/") || file.mime.startsWith("video/") || !file.mime.startsWith("audio/")),
  );
  const menuWidth = Math.min(360, screenWidth - 24);
  const reactionBarWidth = menuWidth;
  const reactionBarLeft = Math.max(12, Math.min(screenWidth - reactionBarWidth - 12, left));
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
  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.backdrop} testID="messenger-message-context">
        <TouchableOpacity style={StyleSheet.absoluteFillObject} onPress={onClose} accessibilityLabel="Fermer les options du message" />
        <View style={[styles.reactionBar, { left: reactionBarLeft, width: reactionBarWidth, top: Math.max(12, top - 60) }]} testID="messenger-message-reactions">
          <ScrollView style={styles.reactionScroll} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.reactionRow}>
            {quickReactions.map(emoji => (
              <TouchableOpacity key={emoji} onPress={() => onReact(emoji)} style={styles.reactionButton} accessibilityRole="button" accessibilityLabel={`Réagir ${emoji}`} testID={`messenger-context-react-${emoji}`}>
                <Text style={styles.reactionEmoji}>{emoji}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <TouchableOpacity
            onPress={() => setShowAllEmoji(value => !value)}
            style={styles.moreReactionButton}
            accessibilityRole="button"
            accessibilityLabel="Afficher tous les emojis"
            testID="messenger-context-more-reactions"
          >
            <Ionicons name="add-circle-outline" size={27} color="#1769e8" />
          </TouchableOpacity>
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
        {showAllEmoji && <View style={[styles.emojiSheet, { height: Math.min(430, Math.max(250, screenHeight * 0.56)) }]} testID="messenger-context-emoji-picker">
          <View style={styles.emojiSheetHeader}>
            <Text style={styles.emojiSheetTitle}>Choisir une réaction</Text>
            <TouchableOpacity onPress={() => setShowAllEmoji(false)} accessibilityLabel="Fermer le sélecteur d’emojis">
              <Ionicons name="close" size={22} color="#202833" />
            </TouchableOpacity>
          </View>
          <EmojiKeyboard
            onEmojiSelected={item => { setShowAllEmoji(false); onReact(item.emoji); }}
            enableRecentlyUsed
            storage={emojiStorage}
            enableSearchBar
            categoryPosition="top"
            defaultHeight={Math.min(430, Math.max(250, screenHeight * 0.56)) - 48}
            hideHeader
            disableSafeArea
            colorScheme="light"
            translation={emojiTranslation}
            theme={{
              container: "#ffffff", header: "#ffffff",
              category: { icon: "#64748b", iconActive: "#1769e8", container: "#f3f6fb", containerActive: "#e3efff" },
              search: { background: "#f2f5f9", text: "#102042", placeholder: "#7d879a", icon: "#7d879a" },
              emoji: { selected: "#e3efff" },
            }}
          />
        </View>}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(10,18,30,.18)" },
  reactionBar: {
    position: "absolute", height: 54, flexDirection: "row", alignItems: "center", borderRadius: 28, backgroundColor: "#fff",
    paddingLeft: 7, paddingRight: 5, shadowColor: "#152238", shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2, shadowRadius: 12, elevation: 12,
  },
  reactionScroll: { flex: 1, minWidth: 0 },
  reactionRow: { alignItems: "center", gap: 2, paddingRight: 3 },
  reactionButton: { width: 42, height: 46, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  moreReactionButton: { width: 42, height: 46, alignItems: "center", justifyContent: "center" },
  reactionEmoji: { fontSize: 25 },
  menu: {
    position: "absolute", overflow: "hidden", borderRadius: 18, backgroundColor: "#fff",
    paddingVertical: 5, shadowColor: "#102042", shadowOffset: { width: 0, height: 7 },
    shadowOpacity: 0.23, shadowRadius: 18, elevation: 14,
  },
  action: { minHeight: 47, flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 17 },
  actionText: { color: "#202833", fontSize: 15, fontWeight: "500" },
  dangerText: { color: "#d73546" },
  emojiSheet: { position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: "#fff", borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow: "hidden", paddingTop: 8 },
  emojiSheetHeader: { height: 40, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16 },
  emojiSheetTitle: { color: "#202833", fontSize: 14, fontWeight: "700" },
});
