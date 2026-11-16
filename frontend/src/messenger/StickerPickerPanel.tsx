import React, { useEffect, useState } from "react";
import { Image, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { protectedFileUrl } from "./api";
import type { Attachment } from "./types";

function StickerThumbnail({ file, darkMode }: { file: Attachment; darkMode: boolean }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let active = true;
    let objectUrl = "";
    protectedFileUrl(file.id).then(value => {
      objectUrl = value;
      if (active) setUrl(value);
      else URL.revokeObjectURL(value);
    }).catch(() => {});
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.id]);
  return url
    ? <Image source={{ uri: url }} resizeMode="contain" style={styles.stickerImage} />
    : <View style={[styles.thumbnailLoading, darkMode && styles.thumbnailLoadingDark]}><Ionicons name="image-outline" size={24} color={darkMode ? "#b6c4d8" : "#7d879a"} /></View>;
}

type Props = {
  stickers: Attachment[];
  savedStickers: Attachment[];
  packStickers: Attachment[];
  builtinStickers: Attachment[];
  darkMode: boolean;
  error?: string;
  onSelect: (file: Attachment) => void;
  onCreate: () => void;
};

export default function StickerPickerPanel({ stickers, savedStickers, packStickers, builtinStickers, darkMode, error, onSelect, onCreate }: Props) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const savedIds = new Set(savedStickers.map(file => file.id));
  const shownSaved = savedStickers.filter(file => file.name.toLowerCase().includes(normalizedQuery));
  const packIds = new Set(packStickers.map(file => file.id));
  const shownUserPack = packStickers.filter(file => file.name.toLowerCase().includes(normalizedQuery));
  const shownRecent = stickers.filter(file => !savedIds.has(file.id) && !packIds.has(file.id) && file.name.toLowerCase().includes(normalizedQuery));
  const shownBuiltin = builtinStickers.filter(file => file.name.toLowerCase().includes(normalizedQuery));
  return (
    <View style={[styles.panel, darkMode && styles.panelDark]} testID="messenger-sticker-picker">
      <View style={[styles.searchBox, darkMode && styles.searchBoxDark]}>
        <Ionicons name="search" size={17} color={darkMode ? "#aab5c4" : "#7d879a"} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Rechercher un sticker"
          placeholderTextColor={darkMode ? "#aab5c4" : "#7d879a"}
          style={[styles.searchInput, darkMode && styles.textDark]}
          accessibilityLabel="Rechercher un sticker"
          testID="messenger-sticker-search"
        />
      </View>
      <View style={styles.sectionHeading}>
        <Text style={[styles.sectionTitle, darkMode && styles.textDark]}>Stickers</Text>
        <TouchableOpacity onPress={onCreate} style={styles.createButton} accessibilityRole="button" accessibilityLabel="Créer un sticker depuis une photo ou une vidéo" testID="messenger-create-sticker">
          <Ionicons name="create-outline" size={17} color="#1769e8" />
          <Text style={styles.createText}>Créer un sticker</Text>
        </TouchableOpacity>
      </View>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      <ScrollView contentContainerStyle={styles.grid} keyboardShouldPersistTaps="always">
        {!!shownSaved.length && <Text style={[styles.groupTitle, darkMode && styles.textMutedDark]}>Enregistrés</Text>}
        {shownSaved.map(file => (
          <TouchableOpacity key={`saved-${file.id}`} onPress={() => onSelect(file)} style={[styles.stickerTile, darkMode && styles.tileDark]} accessibilityRole="button" accessibilityLabel={`Envoyer le sticker enregistré ${file.name}`} testID={`messenger-sticker-saved-${file.id}`}>
            <StickerThumbnail file={file} darkMode={darkMode} />
          </TouchableOpacity>
        ))}
        {!!shownUserPack.length && <Text style={[styles.groupTitle, darkMode && styles.textMutedDark]}>Mon pack de stickers</Text>}
        {shownUserPack.map(file => (
          <TouchableOpacity key={`pack-${file.id}`} onPress={() => onSelect(file)} style={[styles.stickerTile, darkMode && styles.tileDark]} accessibilityRole="button" accessibilityLabel={`Envoyer le sticker de mon pack ${file.name}`}>
            <StickerThumbnail file={file} darkMode={darkMode} />
          </TouchableOpacity>
        ))}
        {!!shownRecent.length && <Text style={[styles.groupTitle, darkMode && styles.textMutedDark]}>Récents</Text>}
        {shownRecent.map(file => (
          <TouchableOpacity key={`recent-${file.id}`} onPress={() => onSelect(file)} style={[styles.stickerTile, darkMode && styles.tileDark]} accessibilityRole="button" accessibilityLabel={`Envoyer le sticker ${file.name}`} testID={`messenger-sticker-${file.id}`}>
            <StickerThumbnail file={file} darkMode={darkMode} />
          </TouchableOpacity>
        ))}
        {!!shownBuiltin.length && <Text style={[styles.groupTitle, darkMode && styles.textMutedDark]}>Pack libre · Twemoji</Text>}
        {shownBuiltin.map(file => (
          <TouchableOpacity key={file.id} onPress={() => onSelect(file)} style={[styles.stickerTile, darkMode && styles.tileDark]} accessibilityRole="button" accessibilityLabel={`Envoyer ${file.name}`}>
            <StickerThumbnail file={file} darkMode={darkMode} />
          </TouchableOpacity>
        ))}
        <Text style={styles.attribution}>Twemoji © Twitter et contributeurs · CC BY 4.0{'\n'}github.com/twitter/twemoji · creativecommons.org/licenses/by/4.0/</Text>
        <TouchableOpacity onPress={onCreate} style={[styles.createTile, darkMode && styles.tileDark]} accessibilityLabel="Créer un sticker" testID="messenger-create-sticker-tile">
          <Ionicons name="add-circle-outline" size={28} color="#1769e8" />
          <Text style={styles.createTileText}>Créer</Text>
        </TouchableOpacity>
        {!shownRecent.length && !shownSaved.length && !shownUserPack.length && !shownBuiltin.length && <Text style={[styles.emptyText, darkMode && styles.textMutedDark]}>{query ? "Aucun sticker trouvé." : "Les stickers que vous créez apparaîtront ici."}</Text>}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1, minHeight: 0, backgroundColor: "#fff", paddingHorizontal: 10, paddingTop: 8 },
  panelDark: { backgroundColor: "#101619" },
  searchBox: { height: 38, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#f1f3f4", borderRadius: 20, paddingHorizontal: 12 },
  searchBoxDark: { backgroundColor: "#1e272b" },
  searchInput: { flex: 1, minWidth: 0, paddingVertical: 0, color: "#172016", fontSize: 13, outlineStyle: "none" as any },
  textDark: { color: "#f1f3f4" },
  sectionHeading: { minHeight: 43, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, paddingTop: 7 },
  sectionTitle: { color: "#172016", fontSize: 13, fontWeight: "700" },
  groupTitle: { width: "100%", color: "#7d879a", fontSize: 11, fontWeight: "800", paddingTop: 3 },
  createButton: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 16, backgroundColor: "rgba(23,105,232,.1)" },
  createText: { color: "#1769e8", fontSize: 11, fontWeight: "700" },
  grid: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap: 8, paddingBottom: 10 },
  stickerTile: { width: "22%", aspectRatio: 1, alignItems: "center", justifyContent: "center", borderRadius: 9, backgroundColor: "#fff", overflow: "hidden" },
  tileDark: { backgroundColor: "#1e272b" },
  stickerImage: { width: "90%", height: "90%" },
  thumbnailLoading: { width: "100%", height: "100%", alignItems: "center", justifyContent: "center", backgroundColor: "#f1f3f4" },
  thumbnailLoadingDark: { backgroundColor: "#1e272b" },
  createTile: { width: "22%", aspectRatio: 1, alignItems: "center", justifyContent: "center", gap: 3, borderRadius: 9, backgroundColor: "#edf3ff" },
  createTileText: { color: "#1769e8", fontSize: 11, fontWeight: "700" },
  emptyText: { flex: 1, minWidth: "100%", textAlign: "center", color: "#7d879a", fontSize: 12, paddingTop: 24 },
  errorText: { color: "#c33", fontSize: 11, paddingVertical: 5, paddingHorizontal: 4 },
  attribution: { width: "100%", color: "#7d879a", fontSize: 9, paddingVertical: 8 },
  textMutedDark: { color: "#aab5c4" },
});
