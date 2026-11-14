import React, { useEffect, useState } from "react";
import { ActivityIndicator, Image, Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api";
import { messengerApi } from "./api";
import type { Conversation, Person } from "./types";

const blue = "#1769e8", ink = "#102042", muted = "#7d879a";
export default function ConversationDetails({ conversation, userId, onClose, onChanged }: {
  conversation: Conversation; userId: string; onClose: () => void; onChanged: () => void;
}) {
  const [title, setTitle] = useState(conversation.title);
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isAdmin = conversation.admins.includes(userId) || conversation.owner_id === userId;
  useEffect(() => {
    if (query.trim().length < 2) { setPeople([]); return; }
    let live = true;
    const timer = setTimeout(() => messengerApi.people(query.trim()).then(list => live && setPeople(list.filter(p => !conversation.members.includes(p.id)))).catch(e => live && setError(e?.detail || "Recherche impossible.")), 250);
    return () => { live = false; clearTimeout(timer); };
  }, [query, conversation.members]);
  const run = async (job: () => Promise<any>) => {
    setBusy(true); setError("");
    try { await job(); onChanged(); } catch (e: any) { setError(e?.detail || "Action impossible."); } finally { setBusy(false); }
  };
  const memberAction = (id: string, action: string) => run(() => api.post(`/messenger/conversations/${encodeURIComponent(conversation.id)}/members`, { user_id: id, action }));
  const rename = () => run(async () => { await messengerApi.patchConversation(conversation.id, { title: title.trim() }); });
  const leaveOrDelete = () => {
    if (typeof window !== "undefined" && !window.confirm(conversation.owner_id === userId ? "Supprimer définitivement cette conversation ?" : "Quitter cette conversation ?")) return;
    run(() => conversation.owner_id === userId
      ? api.delete(`/messenger/conversations/${encodeURIComponent(conversation.id)}`)
      : api.post(`/messenger/conversations/${encodeURIComponent(conversation.id)}/leave`)).then(onClose);
  };
  return <Modal visible transparent animationType="slide" onRequestClose={onClose}>
    <View style={styles.overlay}><View style={styles.sheet}>
      <View style={styles.grabber} /><View style={styles.head}><Text style={styles.title}>Détails de la conversation</Text><TouchableOpacity onPress={onClose}><Ionicons name="close" size={22} color={muted} /></TouchableOpacity></View>
      <ScrollView contentContainerStyle={{ paddingBottom: 18 }}>
        <View style={styles.convoIntro}><View style={styles.bigAvatar}><Text style={styles.bigAvatarLetter}>{conversation.title.slice(0, 1).toUpperCase()}</Text></View>
          {isAdmin && conversation.kind !== "private" ? <><TextInput value={title} onChangeText={setTitle} style={styles.renameInput} /><TouchableOpacity onPress={rename} disabled={busy}><Text style={styles.link}>Enregistrer le nom</Text></TouchableOpacity></> : <Text style={styles.convoTitle}>{conversation.title}</Text>}
          <Text style={styles.sub}>{conversation.kind === "private" ? "Conversation privée" : `${conversation.members.length} membres · ${conversation.kind === "channel" ? "Canal" : "Groupe"}`}</Text>
        </View>
        <View style={styles.preferenceRow}>
          <TouchableOpacity onPress={() => run(() => messengerApi.patchConversation(conversation.id, { muted: !conversation.muted }))} style={styles.preference}><Ionicons name={conversation.muted ? "notifications-off-outline" : "notifications-outline"} size={20} color={blue} /><Text style={styles.preferenceText}>{conversation.muted ? "Activer le son" : "Mettre en sourdine"}</Text></TouchableOpacity>
          <TouchableOpacity onPress={() => run(() => messengerApi.patchConversation(conversation.id, { archived: !conversation.archived }))} style={styles.preference}><Ionicons name="archive-outline" size={20} color={blue} /><Text style={styles.preferenceText}>{conversation.archived ? "Désarchiver" : "Archiver"}</Text></TouchableOpacity>
        </View>
        {conversation.kind === "channel" && <View style={styles.publicSection}>
          {isAdmin ? <TouchableOpacity onPress={() => run(() => messengerApi.patchConversation(conversation.id, { is_public: !conversation.is_public }))} style={styles.publicToggle} accessibilityRole="checkbox" accessibilityState={{ checked: !!conversation.is_public }} testID="messenger-channel-public-toggle">
            <Ionicons name={conversation.is_public ? "checkbox" : "square-outline"} size={20} color={conversation.is_public ? blue : muted} />
            <View style={{ flex: 1 }}><Text style={styles.memberName}>Canal public</Text><Text style={styles.sub}>{conversation.is_public ? "Visible dans la découverte" : "Privé, accessible aux membres uniquement"}</Text></View>
          </TouchableOpacity> : <Text style={styles.sub}>{conversation.is_public ? "Canal public" : "Canal privé"}</Text>}
        </View>}
        {(conversation.kind === "group" || conversation.kind === "channel") && <>
          <Text style={styles.section}>Membres · {conversation.member_profiles.length}</Text>
          {conversation.member_profiles.map(person => {
            const admin = conversation.admins.includes(person.id) || conversation.owner_id === person.id;
            return <View key={person.id} style={styles.memberRow}><View style={styles.avatar}>{person.avatar ? <Image source={{ uri: person.avatar }} style={styles.avatarImage} /> : <Text style={styles.avatarText}>{person.username.slice(0, 1).toUpperCase()}</Text>}</View><View style={{ flex: 1 }}><Text style={styles.memberName}>{person.username}</Text><Text style={styles.sub}>{admin ? "Administrateur" : "Membre"}</Text></View>
              {isAdmin && person.id !== conversation.owner_id && <View style={styles.memberActions}>
                <TouchableOpacity onPress={() => memberAction(person.id, admin ? "demote" : "promote")}><Text style={styles.link}>{admin ? "Rétrograder" : "Promouvoir"}</Text></TouchableOpacity>
                <TouchableOpacity onPress={() => memberAction(person.id, "remove")}><Text style={styles.danger}>Retirer</Text></TouchableOpacity>
              </View>}
            </View>;
          })}
          {isAdmin && conversation.members.length >= 200 && <Text style={styles.error}>La limite de 200 membres est atteinte.</Text>}
          {isAdmin && conversation.members.length < 200 && <><Text style={styles.section}>Ajouter un membre</Text><TextInput value={query} onChangeText={setQuery} placeholder="Rechercher un membre" style={styles.search} />
            {people.map(person => <TouchableOpacity key={person.id} onPress={() => memberAction(person.id, "add")} style={styles.memberRow}><View style={styles.avatar}><Text style={styles.avatarText}>{person.username.slice(0, 1).toUpperCase()}</Text></View><Text style={[styles.memberName, { flex: 1 }]}>{person.username}</Text><Ionicons name="add-circle-outline" size={21} color={blue} /></TouchableOpacity>)}
          </>}
        </>}
        <TouchableOpacity onPress={leaveOrDelete} style={styles.leave}><Text style={styles.danger}>{conversation.owner_id === userId ? "Supprimer la conversation" : "Quitter la conversation"}</Text></TouchableOpacity>
        {busy && <ActivityIndicator color={blue} style={{ marginTop: 10 }} />}{error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>
    </View></View>
  </Modal>;
}
const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(13,24,42,.35)", justifyContent: "flex-end" }, sheet: { backgroundColor: "#fff", maxHeight: "88%", borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingHorizontal: 18, paddingTop: 9 },
  grabber: { width: 38, height: 4, borderRadius: 4, backgroundColor: "#d7dce4", alignSelf: "center", marginBottom: 12 }, head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }, title: { color: ink, fontSize: 18, fontWeight: "900" },
  convoIntro: { alignItems: "center", paddingVertical: 14 }, bigAvatar: { width: 70, height: 70, borderRadius: 36, backgroundColor: "#e5eeff", justifyContent: "center", alignItems: "center", marginBottom: 8 }, bigAvatarLetter: { color: blue, fontSize: 27, fontWeight: "900" }, convoTitle: { color: ink, fontSize: 17, fontWeight: "900" }, renameInput: { borderBottomWidth: 1, borderColor: blue, minWidth: 190, textAlign: "center", color: ink, padding: 6 }, sub: { color: muted, fontSize: 12, marginTop: 3 }, link: { color: blue, fontSize: 12, fontWeight: "800", padding: 5 }, danger: { color: "#c7464e", fontSize: 12, fontWeight: "800", padding: 5 },
  preferenceRow: { flexDirection: "row", gap: 10, marginBottom: 10 }, preference: { flex: 1, flexDirection: "row", gap: 7, alignItems: "center", padding: 12, borderRadius: 12, backgroundColor: "#f2f6fd" }, preferenceText: { color: ink, fontSize: 11, fontWeight: "700" }, publicSection: { backgroundColor: "#f6f8fb", borderRadius: 11, padding: 11, marginBottom: 9 }, publicToggle: { flexDirection: "row", alignItems: "center", gap: 9 },
  section: { fontSize: 12, fontWeight: "900", color: muted, marginTop: 13, marginBottom: 4, textTransform: "uppercase" }, memberRow: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: 9, borderBottomWidth: 1, borderColor: "#eff1f4" }, avatar: { width: 36, height: 36, borderRadius: 20, backgroundColor: "#e5eeff", alignItems: "center", justifyContent: "center", overflow: "hidden" }, avatarImage: { width: 36, height: 36, borderRadius: 20 }, avatarText: { color: blue, fontWeight: "900" }, memberName: { color: ink, fontSize: 13, fontWeight: "800" }, memberActions: { flexDirection: "row", alignItems: "center" },
  search: { backgroundColor: "#f3f5f8", height: 40, borderRadius: 11, paddingHorizontal: 12, color: ink, outlineStyle: "none" as any }, leave: { borderTopWidth: 1, borderColor: "#eef0f3", marginTop: 16, alignItems: "center", paddingVertical: 13 }, error: { color: "#c7464e", fontSize: 12, padding: 8 },
});
