import React, { useEffect, useState } from "react";
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { messengerApi } from "./api";
import type { Conversation, PublicChannel } from "./types";

const blue = "#1769e8", ink = "#102042", muted = "#7d879a";
export default function PublicChannelsModal({ visible, onClose, onJoined }: {
  visible: boolean; onClose: () => void; onJoined: (conversation: Conversation) => void;
}) {
  const [query, setQuery] = useState("");
  const [channels, setChannels] = useState<PublicChannel[]>([]);
  const [loading, setLoading] = useState(false);
  const [joining, setJoining] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  useEffect(() => {
    if (!visible) return;
    let current = true;
    setLoading(true); setError("");
    const timer = setTimeout(() => {
      messengerApi.publicChannels(query.trim()).then(rows => {
        if (current) setChannels(rows);
      }).catch((e: any) => {
        if (current) setError(e?.detail || "Impossible de charger les canaux publics.");
      }).finally(() => { if (current) setLoading(false); });
    }, 250);
    return () => { current = false; clearTimeout(timer); };
  }, [visible, query, retryKey]);
  const retry = () => setRetryKey(value => value + 1);
  const openChannel = async (channel: PublicChannel) => {
    setJoining(channel.id); setError("");
    try {
      const conversation = channel.joined
        ? await messengerApi.conversation(channel.id)
        : await messengerApi.joinChannel(channel.id);
      onJoined(conversation);
    } catch (e: any) { setError(e?.detail || "Impossible de rejoindre ce canal."); }
    finally { setJoining(null); }
  };
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
    <View style={styles.backdrop}><View style={styles.sheet}>
      <View style={styles.head}><View><Text style={styles.title}>Canaux publics</Text><Text style={styles.subtitle}>Parcourez les canaux ouverts à la communauté</Text></View><TouchableOpacity onPress={onClose} accessibilityLabel="Fermer la découverte des canaux"><Ionicons name="close" size={23} color={muted} /></TouchableOpacity></View>
      <View style={styles.search}><Ionicons name="search" size={18} color={muted} /><TextInput value={query} onChangeText={setQuery} placeholder="Rechercher un canal" style={styles.searchInput} testID="messenger-channel-search" /></View>
      {!!error && <TouchableOpacity onPress={retry}><Text style={styles.error}>{error} · Réessayer</Text></TouchableOpacity>}
      {loading ? <View style={styles.loading}><ActivityIndicator color={blue} /><Text style={styles.empty}>Recherche des canaux…</Text></View> : <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        {channels.map(channel => <View key={channel.id} style={styles.channelRow}>
          <View style={styles.avatar}><Ionicons name="megaphone-outline" size={21} color={blue} /></View>
          <View style={{ flex: 1 }}><Text style={styles.channelName} numberOfLines={1}>{channel.title}</Text><Text style={styles.channelMeta}>{channel.member_count.toLocaleString()} abonnés · Public</Text></View>
          <TouchableOpacity onPress={() => openChannel(channel)} disabled={joining === channel.id} style={[styles.join, channel.joined && styles.joined]} testID={`messenger-public-channel-join-${channel.id}`}>
            {joining === channel.id ? <ActivityIndicator size="small" color={channel.joined ? blue : "#fff"} /> : <Text style={[styles.joinText, channel.joined && styles.joinedText]}>{channel.joined ? "Ouvrir" : "Rejoindre"}</Text>}
          </TouchableOpacity>
        </View>)}
        {!channels.length && !loading && !error && <View style={styles.emptyState}><Ionicons name="radio-outline" size={30} color={blue} /><Text style={styles.empty}>Aucun canal public trouvé.</Text></View>}
      </ScrollView>}
    </View></View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(13,24,42,.4)", justifyContent: "flex-end" },
  sheet: { backgroundColor: "#fff", maxHeight: "90%", borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingHorizontal: 18, paddingTop: 18, paddingBottom: 18 },
  head: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 13 },
  title: { color: ink, fontSize: 19, fontWeight: "900" }, subtitle: { color: muted, fontSize: 12, marginTop: 4 },
  search: { height: 42, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 13, backgroundColor: "#f2f5f9", borderRadius: 22, marginBottom: 8 },
  searchInput: { flex: 1, fontSize: 14, outlineStyle: "none" as any, color: ink },
  channelRow: { minHeight: 67, flexDirection: "row", alignItems: "center", gap: 10, borderBottomWidth: 1, borderColor: "#eef1f5" },
  avatar: { width: 43, height: 43, borderRadius: 24, backgroundColor: "#e4edff", alignItems: "center", justifyContent: "center" },
  channelName: { color: ink, fontSize: 14, fontWeight: "800" }, channelMeta: { color: muted, fontSize: 11, marginTop: 3 },
  join: { height: 34, minWidth: 80, paddingHorizontal: 12, borderRadius: 17, backgroundColor: blue, alignItems: "center", justifyContent: "center" },
  joined: { backgroundColor: "#eaf1ff", borderWidth: 1, borderColor: "#d7e5ff" }, joinText: { color: "#fff", fontSize: 12, fontWeight: "800" }, joinedText: { color: blue },
  loading: { padding: 24, alignItems: "center", gap: 8 }, emptyState: { alignItems: "center", padding: 30 }, empty: { color: muted, textAlign: "center", fontSize: 13, padding: 8 }, error: { color: "#c34249", fontSize: 12, paddingVertical: 7 },
});
