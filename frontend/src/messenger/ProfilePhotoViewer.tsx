import React from "react";
import { Image, Modal, Platform, StatusBar, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

type Props = {
  photo: { uri: string; label: string } | null;
  onClose: () => void;
};

export default function ProfilePhotoViewer({ photo, onClose }: Props) {
  return (
    <Modal visible={!!photo} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.screen} testID="messenger-profile-photo-viewer">
        <StatusBar hidden />
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Retour à la discussion" testID="messenger-profile-photo-back">
            <Ionicons name="arrow-back" size={23} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.title} numberOfLines={1}>{photo?.label || "Photo de profil"}</Text>
          <TouchableOpacity onPress={onClose} style={styles.closeButton} accessibilityRole="button" accessibilityLabel="Fermer la photo">
            <Ionicons name="close" size={23} color="#fff" />
          </TouchableOpacity>
        </View>
        {photo?.uri ? <Image source={{ uri: photo.uri }} resizeMode="contain" style={styles.photo} accessibilityLabel={`Photo de profil de ${photo.label}`} /> : null}
        <View style={styles.footer}>
          <Text style={styles.footerText}>Photo de profil</Text>
          {Platform.OS === "web" ? <Text style={styles.footerHint}>Appuyez sur Retour pour reprendre la conversation.</Text> : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#101827", alignItems: "center", justifyContent: "center" },
  header: { position: "absolute", zIndex: 1, top: Platform.OS === "ios" ? 48 : 18, left: 14, right: 14, flexDirection: "row", alignItems: "center", gap: 12 },
  backButton: { width: 42, height: 42, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,.13)", borderWidth: 1, borderColor: "rgba(255,255,255,.15)" },
  closeButton: { width: 42, height: 42, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,.13)", borderWidth: 1, borderColor: "rgba(255,255,255,.15)" },
  title: { color: "#fff", fontSize: 15, fontWeight: "700", flex: 1, textAlign: "center" },
  photo: { width: "100%", height: "100%" },
  footer: { position: "absolute", left: 18, right: 18, bottom: Platform.OS === "ios" ? 38 : 20, alignItems: "center", gap: 5 },
  footerText: { color: "#fff", fontSize: 13, fontWeight: "700" },
  footerHint: { color: "rgba(255,255,255,.7)", fontSize: 11 },
});
