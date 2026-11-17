import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import ProtectedMessageMedia from "./ProtectedMessageMedia";
import { chatVisual } from "./chatVisualTokens";
import type { Attachment, Message } from "./types";

type Preview = {
  label: string;
  icon?: React.ComponentProps<typeof Ionicons>["name"];
  thumbnail?: Attachment;
};

function voiceDuration(seconds?: number) {
  if (!Number.isFinite(seconds) || seconds === undefined || seconds < 0) return "";
  const wholeSeconds = Math.round(seconds);
  return ` (${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, "0")})`;
}

function getPreview(message?: Message): Preview {
  if (!message) return { label: "Message précédent" };
  if (message.deleted) return { label: "Message supprimé" };

  const attachments = message.attachments || [];
  const voice = attachments.find(file => file.mime.startsWith("audio/"));
  if (voice) return { label: `Message vocal${voiceDuration(voice.duration_seconds)}`, icon: "mic-outline" };

  const sticker = attachments.find(file => file.sticker || file.name.toLowerCase().startsWith("sticker-"));
  if (sticker) return { label: message.text || "Sticker", icon: "happy-outline", thumbnail: sticker };

  const photo = attachments.find(file => file.mime.startsWith("image/"));
  if (photo) {
    return {
      label: message.text || (photo.view_once ? "Photo éphémère" : "Photo"),
      icon: "camera-outline",
      thumbnail: photo.view_once ? undefined : photo,
    };
  }

  const video = attachments.find(file => file.mime.startsWith("video/"));
  if (video) return { label: message.text || "Vidéo", icon: "videocam-outline" };

  const document = attachments[0];
  if (document) return { label: message.text || document.name || "Fichier", icon: "document-outline" };
  return { label: message.text || "Message" };
}

export default function ReplyAttachmentPreview({
  message,
  dark = false,
  maxLines = 2,
  onThumbnailPress,
  testID,
}: {
  message?: Message;
  dark?: boolean;
  maxLines?: number;
  onThumbnailPress?: () => void;
  testID?: string;
}) {
  const preview = getPreview(message);
  return (
    <View style={styles.row} testID={testID}>
      <View style={styles.copy}>
        {preview.icon ? <Ionicons name={preview.icon} size={14} color={dark ? "#b9c9df" : chatVisual.muted} /> : null}
        <Text numberOfLines={maxLines} style={[styles.label, dark && styles.labelDark]}>{preview.label}</Text>
      </View>
      {preview.thumbnail ? (
        <ProtectedMessageMedia
          file={preview.thumbnail}
          compact
          maxWidth={46}
          autoLoad
          onOpen={() => onThumbnailPress?.()}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0, maxWidth: "100%" },
  copy: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 5 },
  label: { flex: 1, minWidth: 0, color: chatVisual.muted, fontSize: 11, marginTop: 2 },
  labelDark: { color: "#b9c9df" },
});
