import React, { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api";
import { messengerApi } from "./api";
import type { Conversation } from "./types";

type ChatList = { id: string; name: string; conversation_ids: string[]; updated_at: string };
type Props = { mode: "lists" | "broadcasts" };
const blue = "#1769e8", ink = "#102042", muted = "#7d879a";

export default function ChatListsManager({ mode }: Props) {
  const [lists, setLists] = useState<ChatList[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [name, setName] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editing, setEditing] = useState<ChatList | null>(null);
  const [broadcastList, setBroadcastList] = useState<ChatList | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const privateChats = conversations.filter(c => c.kind === "private" && !c.is_saved);

  const load = async () => {
    setBusy(true);
    try {
      const [saved, chats] = await Promise.all([
        api.get<ChatList[]>("/messenger/lists"),
        messengerApi.conversations(),
      ]);
      setLists(saved);
      setConversations(chats);
      setError("");
    } catch (e: any) {
      setError(e?.detail || "Impossible de charger vos listes.");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const resetEditor = () => { setEditing(null); setName(""); setSelectedIds([]); };
  const startEdit = (list: ChatList) => {
    setEditing(list);
    setName(list.name);
    setSelectedIds([...list.conversation_ids]);
    setNotice("");
  };
  const toggleConversation = (id: string) => setSelectedIds(previous =>
    previous.includes(id) ? previous.filter(value => value !== id) : previous.length >= 50 ? previous : [...previous, id],
  );
  const save = async () => {
    if (!name.trim()) { setError("Donnez un nom à la liste."); return; }
    if (!selectedIds.length) { setError("Choisissez au moins une conversation privée."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const body = { name: name.trim(), conversation_ids: selectedIds };
      await (editing?.id
        ? api.patch(`/messenger/lists/${encodeURIComponent(editing.id)}`, body)
        : api.post("/messenger/lists", body));
      resetEditor();
      setNotice("Liste enregistrée.");
      await load();
    } catch (e: any) {
      setError(e?.detail || "Impossible d’enregistrer la liste.");
    } finally { setBusy(false); }
  };
  const remove = async (list: ChatList) => {
    const removeNow = async () => {
      setBusy(true); setError(""); setNotice("");
      try {
        await api.delete(`/messenger/lists/${encodeURIComponent(list.id)}`);
        if (editing?.id === list.id) resetEditor();
        await load();
        setNotice("Liste supprimée. Les conversations et leurs messages restent intacts.");
      } catch (e: any) { setError(e?.detail || "Impossible de supprimer la liste."); }
      finally { setBusy(false); }
    };
    if (Platform.OS === "web" && typeof window !== "undefined") {
      if (window.confirm(`Supprimer la liste « ${list.name} » ? Les discussions et messages ne seront pas supprimés.`)) await removeNow();
      return;
    }
    Alert.alert("Supprimer la liste", `« ${list.name} » sera supprimée. Les discussions restent intactes.`, [
      { text: "Annuler", style: "cancel" }, { text: "Supprimer", style: "destructive", onPress: () => void removeNow() },
    ]);
  };
  const confirmBroadcast = async () => {
    if (!broadcastList || !message.trim()) return;
    const sendNow = async () => {
      setBusy(true); setError(""); setNotice("");
      try {
        const result = await api.post<{ sent: number }>(`/messenger/lists/${encodeURIComponent(broadcastList.id)}/broadcast`, { text: message.trim() });
        setNotice(`Message envoyé séparément à ${result.sent} contact${result.sent > 1 ? "s" : ""}.`);
        setMessage("");
        setBroadcastList(null);
      } catch (e: any) { setError(e?.detail || "La diffusion n’a pas été envoyée."); }
      finally { setBusy(false); }
    };
    const prompt = `Envoyer ce message individuellement aux ${broadcastList.conversation_ids.length} conversations de « ${broadcastList.name} » ? Aucun groupe ne sera créé.`;
    if (Platform.OS === "web" && typeof window !== "undefined") {
      if (window.confirm(prompt)) await sendNow();
      return;
    }
    Alert.alert("Confirmer la diffusion", prompt, [
      { text: "Annuler", style: "cancel" }, { text: "Envoyer", onPress: () => void sendNow() },
    ]);
  };

  return <View style={styles.root} testID={`chat-lists-manager-${mode}`}>
    <Text style={styles.intro}>{mode === "lists"
      ? "Créez des filtres de conversations privées. Une liste ne crée pas de groupe."
      : "Les messages sont envoyés séparément aux contacts de la liste. Vérifiez le texte avant l’envoi."}</Text>
    {error ? <Text style={styles.error}>{error}</Text> : null}
    {notice ? <Text style={styles.notice}>{notice}</Text> : null}
    {busy && !lists.length ? <ActivityIndicator color={blue} /> : null}

    {mode === "lists" && !editing && <TouchableOpacity onPress={() => { setEditing({ id: "", name: "", conversation_ids: [], updated_at: "" }); setName(""); setSelectedIds([]); }} style={styles.primary} testID="chat-list-create">
      <Ionicons name="add-circle-outline" size={19} color="#fff" /><Text style={styles.primaryText}>Créer une liste</Text>
    </TouchableOpacity>}
    {editing && mode === "lists" && <View style={styles.editor}>
      <Text style={styles.title}>{editing.id ? "Modifier la liste" : "Nouvelle liste"}</Text>
      <TextInput value={name} onChangeText={setName} placeholder="Nom de la liste" maxLength={40} style={styles.input} testID="chat-list-name" />
      <Text style={styles.caption}>Conversations privées ({selectedIds.length}/50)</Text>
      {!privateChats.length ? <Text style={styles.muted}>Aucune conversation privée disponible pour le moment.</Text> : privateChats.map(chat => {
        const selected = selectedIds.includes(chat.id);
        return <TouchableOpacity key={chat.id} onPress={() => toggleConversation(chat.id)} style={styles.member} accessibilityRole="checkbox" accessibilityState={{ checked: selected }} testID={`chat-list-chat-${chat.id}`}>
          <View style={[styles.check, selected && styles.checkOn]}>{selected && <Ionicons name="checkmark" size={14} color="#fff" />}</View>
          <Text style={styles.memberText} numberOfLines={1}>{chat.title}</Text>
        </TouchableOpacity>;
      })}
      <View style={styles.editorActions}>
        <TouchableOpacity onPress={resetEditor} style={styles.secondary}><Text style={styles.secondaryText}>Annuler</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => void save()} disabled={busy} style={styles.primary} testID="chat-list-save"><Text style={styles.primaryText}>Enregistrer</Text></TouchableOpacity>
      </View>
    </View>}

    {mode === "broadcasts" && broadcastList && <View style={styles.editor}>
      <Text style={styles.title}>Message pour « {broadcastList.name} »</Text>
      <TextInput value={message} onChangeText={setMessage} placeholder="Écrire le message" multiline maxLength={8000} style={[styles.input, styles.messageInput]} testID="broadcast-message" />
      <Text style={styles.muted}>Chaque destinataire recevra un message privé distinct.</Text>
      <View style={styles.editorActions}>
        <TouchableOpacity onPress={() => { setBroadcastList(null); setMessage(""); }} style={styles.secondary}><Text style={styles.secondaryText}>Annuler</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => void confirmBroadcast()} disabled={!message.trim() || busy} style={styles.primary} testID="broadcast-send"><Ionicons name="send" size={16} color="#fff" /><Text style={styles.primaryText}>Envoyer</Text></TouchableOpacity>
      </View>
    </View>}

    {lists.map(list => <View key={list.id} style={styles.listCard}>
      <View style={styles.listHead}>
        <View style={styles.listCopy}><Text style={styles.title} numberOfLines={1}>{list.name}</Text><Text style={styles.muted}>{list.conversation_ids.length} conversation{list.conversation_ids.length === 1 ? "" : "s"}</Text></View>
        {mode === "lists" && <TouchableOpacity onPress={() => startEdit(list)} accessibilityLabel={`Modifier ${list.name}`} testID={`chat-list-edit-${list.id}`}><Ionicons name="create-outline" size={19} color={blue} /></TouchableOpacity>}
        {mode === "lists" && <TouchableOpacity onPress={() => void remove(list)} accessibilityLabel={`Supprimer ${list.name}`} testID={`chat-list-delete-${list.id}`}><Ionicons name="trash-outline" size={19} color="#c43e48" /></TouchableOpacity>}
      </View>
      {mode === "broadcasts" && <TouchableOpacity onPress={() => { setBroadcastList(list); setMessage(""); setError(""); setNotice(""); }} style={styles.primary} testID={`broadcast-open-${list.id}`}>
        <Ionicons name="send-outline" size={16} color="#fff" /><Text style={styles.primaryText}>Préparer une diffusion</Text>
      </TouchableOpacity>}
    </View>)}
    {!busy && !lists.length && <Text style={styles.muted}>{mode === "lists" ? "Aucune liste enregistrée." : "Créez d’abord une liste de diffusion dans « Listes »."}</Text>}
  </View>;
}

const styles = StyleSheet.create({
  root: { gap: 9, paddingBottom: 12 },
  intro: { color: muted, fontSize: 12, lineHeight: 18, marginBottom: 4 },
  error: { color: "#bd3745", backgroundColor: "#fff0f0", padding: 10, borderRadius: 10, fontSize: 12 },
  notice: { color: "#16724b", backgroundColor: "#eaf8f0", padding: 10, borderRadius: 10, fontSize: 12 },
  editor: { backgroundColor: "#f5f8ff", borderColor: "#e3ebf8", borderWidth: 1, borderRadius: 14, padding: 12, gap: 8 },
  title: { color: ink, fontSize: 14, fontWeight: "800" },
  caption: { color: ink, fontSize: 12, fontWeight: "700", marginTop: 4 },
  muted: { color: muted, fontSize: 12, lineHeight: 17 },
  input: { minHeight: 42, borderWidth: 1, borderColor: "#dbe4f0", borderRadius: 10, backgroundColor: "#fff", paddingHorizontal: 11, paddingVertical: 9, color: ink, fontSize: 14 },
  messageInput: { minHeight: 98, textAlignVertical: "top" },
  member: { flexDirection: "row", alignItems: "center", minHeight: 42, gap: 9, borderBottomWidth: 1, borderColor: "#e6ebf2" },
  check: { height: 20, width: 20, borderRadius: 6, borderWidth: 1.5, borderColor: "#9aa8bb", alignItems: "center", justifyContent: "center" },
  checkOn: { backgroundColor: blue, borderColor: blue },
  memberText: { flex: 1, color: ink, fontSize: 13, fontWeight: "600" },
  editorActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 8, marginTop: 5 },
  primary: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, backgroundColor: blue, borderRadius: 10, minHeight: 40, paddingHorizontal: 13 },
  primaryText: { color: "#fff", fontSize: 12, fontWeight: "800" },
  secondary: { backgroundColor: "#e8edf5", borderRadius: 10, minHeight: 40, justifyContent: "center", paddingHorizontal: 13 },
  secondaryText: { color: ink, fontSize: 12, fontWeight: "700" },
  listCard: { borderColor: "#e5eaf1", borderWidth: 1, borderRadius: 13, padding: 11, gap: 10, backgroundColor: "#fff" },
  listHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  listCopy: { flex: 1 },
});
