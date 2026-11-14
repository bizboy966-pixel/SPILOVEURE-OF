import React, { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api";
import { messengerApi } from "./api";
import type { Attachment, ContactState, MessengerCapabilities, Person, Post } from "./types";

const blue = "#1769e8", ink = "#102042", muted = "#7d879a";
type ContactProps = { onStart: (person: Person) => void };
export function ContactsPanel({ onStart }: ContactProps) {
  const [state, setState] = useState<ContactState>({ contacts: [], blocked: [], requests: [], sent: [] });
  const [results, setResults] = useState<Person[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [menu, setMenu] = useState<string | null>(null);
  const refresh = async () => {
    try { setState(await api.get<ContactState>("/messenger/contacts")); setError(""); }
    catch (e: any) { setError(e?.detail || "Chargement des contacts impossible."); }
    finally { setLoading(false); }
  };
  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }
    let active = true;
    const timer = setTimeout(() => messengerApi.people(q).then(rows => active && setResults(rows)).catch(e => active && setError(e?.detail || "Recherche impossible.")), 250);
    return () => { active = false; clearTimeout(timer); };
  }, [query]);
  const run = async (fn: () => Promise<any>) => { try { await fn(); await refresh(); } catch (e: any) { setError(e?.detail || "Action impossible."); } };
  const personRow = (person: Person, label?: string) => <View key={person.id} style={styles.personRow}>
    <View style={styles.avatar}><Text style={styles.avatarText}>{person.username.slice(0, 1).toUpperCase()}</Text></View>
    <View style={{ flex: 1 }}><Text style={styles.personName}>{person.username}</Text><Text style={styles.personMeta}>{label || (person.online ? "En ligne" : "Membre SPILOVEURE")}</Text></View>
    <TouchableOpacity onPress={() => onStart(person)} style={styles.smallAction}><Ionicons name="chatbubble-outline" size={18} color={blue} /></TouchableOpacity>
    <TouchableOpacity onPress={() => setMenu(menu === person.id ? null : person.id)} style={styles.smallAction}><Ionicons name="ellipsis-horizontal" size={19} color={muted} /></TouchableOpacity>
    {menu === person.id && <View style={styles.personActions}>
      {state.contacts.some(p => p.id === person.id)
        ? <TouchableOpacity onPress={() => run(() => api.delete(`/messenger/contacts/${encodeURIComponent(person.id)}`))}><Text style={[styles.action, { color: "#c43e48" }]}>Retirer des contacts</Text></TouchableOpacity>
        : state.sent.includes(person.id)
          ? <Text style={styles.pendingRequest}>Demande envoyée</Text>
          : <TouchableOpacity onPress={() => run(() => api.post(`/messenger/contacts/${encodeURIComponent(person.id)}`))}><Text style={styles.action}>Ajouter aux contacts</Text></TouchableOpacity>}
      <TouchableOpacity onPress={() => run(() => api.post(`/messenger/blocks/${encodeURIComponent(person.id)}`))}><Text style={styles.action}>Bloquer</Text></TouchableOpacity>
      <TouchableOpacity onPress={() => {
        const reason = typeof window !== "undefined" ? window.prompt("Motif du signalement") : null;
        if (reason?.trim()) run(() => api.post("/messenger/reports", { user_id: person.id, reason: reason.trim() }));
      }}><Text style={[styles.action, { color: "#c43e48" }]}>Signaler</Text></TouchableOpacity>
    </View>}
  </View>;
  return <View style={styles.panel}>
    <Text style={styles.panelTitle}>Contacts</Text>
    <View style={styles.search}><Ionicons name="search" size={18} color={muted} /><TextInput value={query} onChangeText={setQuery} placeholder="Rechercher un membre" style={styles.searchInput} /></View>
    {error ? <TouchableOpacity onPress={refresh} style={styles.error}><Text style={styles.errorText}>{error} · Réessayer</Text></TouchableOpacity> : null}
    <ScrollView contentContainerStyle={{ paddingBottom: 28 }}>
      {loading ? <ActivityIndicator color={blue} style={{ marginTop: 28 }} /> : null}
      {query.trim().length >= 2 && <><Text style={styles.sectionTitle}>Résultats</Text>{results.length ? results.map(p => personRow(p, state.sent.includes(p.id) ? "Demande envoyée" : undefined)) : !loading ? <Text style={styles.empty}>Aucun membre trouvé.</Text> : null}</>}
      {!query && state.requests.length > 0 && <><Text style={styles.sectionTitle}>Demandes reçues</Text>{state.requests.map(p => <View key={p.id}>{personRow(p, "Demande de contact")}<TouchableOpacity onPress={() => run(() => api.post(`/messenger/contacts/${encodeURIComponent(p.id)}/accept`))} style={styles.accept}><Text style={styles.acceptText}>Accepter</Text></TouchableOpacity></View>)}</>}
      {!query && <><Text style={styles.sectionTitle}>Mes contacts · {state.contacts.length}</Text>{state.contacts.map(p => personRow(p))}</>}
      {!loading && !query && !state.contacts.length && !state.requests.length && <Text style={styles.empty}>Vos contacts SPILOVEURE apparaîtront ici.</Text>}
      {!query && state.blocked.length > 0 && <><Text style={styles.sectionTitle}>Comptes bloqués</Text>{state.blocked.map(p => <View key={p.id}>{personRow(p, "Bloqué")}<TouchableOpacity onPress={() => run(() => api.delete(`/messenger/blocks/${encodeURIComponent(p.id)}`))}><Text style={styles.action}>Débloquer</Text></TouchableOpacity></View>)}</>}
    </ScrollView>
  </View>;
}

type FeedProps = { userId: string; version?: number };
export function FeedPanel({ userId, version = 0 }: FeedProps) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [text, setText] = useState("");
  const [visibility, setVisibility] = useState<"contacts" | "public">("contacts");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [comment, setComment] = useState<Record<string, string>>({});
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const load = async () => {
    try { setPosts(await api.get<Post[]>("/messenger/feed")); setError(""); }
    catch (e: any) { setError(e?.detail || "Impossible de charger les actus."); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { if (version > 0) load(); }, [version]);
  const publish = async () => {
    if (!text.trim()) return;
    try { await api.post("/messenger/feed", { text: text.trim(), visibility, attachments }); setText(""); setAttachments([]); await load(); }
    catch (e: any) { setError(e?.detail || "Publication impossible."); }
  };
  const addComment = async (id: string) => {
    if (!comment[id]?.trim()) return;
    try { await api.post(`/messenger/feed/${encodeURIComponent(id)}/comments`, { text: comment[id].trim() }); setComment(v => ({ ...v, [id]: "" })); await load(); }
    catch (e: any) { setError(e?.detail || "Commentaire impossible."); }
  };
  const attachFeedFile = () => {
    if (typeof document === "undefined") return;
    const input = document.createElement("input"); input.type = "file"; input.multiple = true; input.accept = "image/*,video/*";
    input.onchange = async () => {
      try {
        const uploaded: Attachment[] = [];
        for (const file of Array.from(input.files || [])) {
          if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name} dépasse 20 Mo.`);
          uploaded.push(await api.upload<Attachment>("/messenger/feed/files", file));
        }
        setAttachments(old => [...old, ...uploaded]);
      } catch (e: any) { setError(e?.detail || e.message || "Téléversement impossible."); }
    };
    input.click();
  };
  return <View style={styles.panel}>
    <Text style={styles.panelTitle}>Actus SPILOVEURE</Text>
    {error ? <TouchableOpacity onPress={load} style={styles.error}><Text style={styles.errorText}>{error} · Réessayer</Text></TouchableOpacity> : null}
    <ScrollView contentContainerStyle={{ paddingBottom: 30 }}>
      <View style={styles.composeCard}>
        <Text style={styles.composeTitle}>Partager une actualité</Text>
        <TextInput value={text} onChangeText={setText} placeholder="Quoi de neuf ?" multiline style={styles.postInput} />
        {attachments.map(file => <View key={file.id} style={styles.feedAttachment}><Text style={styles.feedAttachmentName}>{file.name}</Text><TouchableOpacity onPress={() => setAttachments(old => old.filter(a => a.id !== file.id))}><Ionicons name="close-circle" size={18} color={muted} /></TouchableOpacity></View>)}
        <View style={styles.composeFooter}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 13 }}><TouchableOpacity style={styles.visibility} onPress={() => setVisibility(v => v === "contacts" ? "public" : "contacts")}><Ionicons name={visibility === "public" ? "globe-outline" : "people-outline"} size={16} color={blue} /><Text style={styles.visibilityText}>{visibility === "public" ? "Public" : "Contacts"}</Text></TouchableOpacity><TouchableOpacity onPress={attachFeedFile} accessibilityLabel="Ajouter une photo ou vidéo"><Ionicons name="image-outline" size={19} color={blue} /></TouchableOpacity></View>
          <TouchableOpacity onPress={publish} style={[styles.publish, !text.trim() && styles.disabled]}><Text style={styles.publishText}>Publier</Text></TouchableOpacity>
        </View>
      </View>
      {loading ? <ActivityIndicator color={blue} style={{ marginTop: 25 }} /> : posts.length === 0 ? <Text style={styles.empty}>Aucune actualité pour le moment.</Text> : posts.map(post => <View key={post.id} style={styles.postCard}>
        <View style={styles.postHeader}><View style={styles.avatar}><Text style={styles.avatarText}>{post.author_name.slice(0, 1).toUpperCase()}</Text></View><View style={{ flex: 1 }}><Text style={styles.personName}>{post.author_name}</Text><Text style={styles.personMeta}>{new Date(post.created_at).toLocaleString()} · {post.visibility === "public" ? "Public" : "Contacts"}</Text></View>{post.author_id === userId && <TouchableOpacity onPress={async () => { if (typeof window === "undefined" || window.confirm("Supprimer cette publication ?")) { await api.delete(`/messenger/feed/${encodeURIComponent(post.id)}`).then(load).catch(e => setError(e?.detail || "Suppression impossible.")); } }}><Ionicons name="trash-outline" size={18} color={muted} /></TouchableOpacity>}</View>
        <Text style={styles.postText}>{post.text}</Text>
        <View style={styles.postActions}><TouchableOpacity onPress={() => api.post(`/messenger/feed/${encodeURIComponent(post.id)}/reaction`, { emoji: "👍" }).then(load).catch(e => setError(e?.detail || "Réaction impossible."))} style={styles.postAction}><Text style={styles.action}>👍 J’aime</Text></TouchableOpacity><Text style={styles.personMeta}>{Object.values(post.reactions || {}).reduce((n, a) => n + a.length, 0)} réactions · {post.comments.length} commentaires</Text></View>
        {post.comments.map(item => <View key={item.id} style={styles.comment}><Text style={styles.commentText}><Text style={{ fontWeight: "800" }}>{item.username} </Text>{item.text}</Text></View>)}
        <View style={styles.commentRow}><TextInput value={comment[post.id] || ""} onChangeText={v => setComment(old => ({ ...old, [post.id]: v }))} placeholder="Écrire un commentaire" style={styles.commentInput} /><TouchableOpacity onPress={() => addComment(post.id)}><Ionicons name="send" size={19} color={blue} /></TouchableOpacity></View>
      </View>)}
    </ScrollView>
  </View>;
}

type ProfileProps = { username: string };
export function ProfilePanel({ username }: ProfileProps) {
  const [settings, setSettings] = useState({ show_presence: true, allow_contacts: true });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [capabilities, setCapabilities] = useState<MessengerCapabilities | null>(null);
  useEffect(() => { api.get<typeof settings>("/messenger/settings").then(setSettings).catch((e: any) => setError(e?.detail || "Paramètres indisponibles.")).finally(() => setLoading(false)); }, []);
  useEffect(() => { messengerApi.capabilities().then(setCapabilities).catch(() => setCapabilities(null)); }, []);
  const toggle = async (key: keyof typeof settings) => {
    const next = { ...settings, [key]: !settings[key] }; setSettings(next);
    try { setSettings(await api.patch("/messenger/settings", next)); } catch (e: any) { setSettings(settings); setError(e?.detail || "Modification impossible."); }
  };
  return <View style={styles.panel}><Text style={styles.panelTitle}>Profil</Text>
    <View style={styles.profileCard}><View style={styles.profileAvatar}><Text style={styles.profileLetter}>{username.slice(0, 1).toUpperCase()}</Text></View><Text style={styles.profileName}>{username}</Text><Text style={styles.personMeta}>Membre SPILOVEURE</Text></View>
    <Text style={styles.sectionTitle}>Confidentialité</Text>
    {loading ? <ActivityIndicator color={blue} /> : <>
      <TouchableOpacity onPress={() => toggle("show_presence")} style={styles.settingRow}><View style={{ flex: 1 }}><Text style={styles.settingTitle}>Afficher ma présence</Text><Text style={styles.personMeta}>Autoriser les membres à voir quand vous êtes en ligne</Text></View><View style={[styles.switch, settings.show_presence && styles.switchOn]}><View style={[styles.switchKnob, settings.show_presence && styles.switchKnobOn]} /></View></TouchableOpacity>
      <TouchableOpacity onPress={() => toggle("allow_contacts")} style={styles.settingRow}><View style={{ flex: 1 }}><Text style={styles.settingTitle}>Demandes de contact</Text><Text style={styles.personMeta}>Autoriser les membres à vous ajouter</Text></View><View style={[styles.switch, settings.allow_contacts && styles.switchOn]}><View style={[styles.switchKnob, settings.allow_contacts && styles.switchKnobOn]} /></View></TouchableOpacity>
    </>}
    {error ? <Text style={styles.errorText}>{error}</Text> : null}
    <Text style={styles.sectionTitle}>Fonctions disponibles</Text>
    <View style={styles.capabilityCard}>
      <Text style={styles.capabilityTitle}>Notifications push</Text>
      <Text style={styles.noticeText}>{capabilities ? capabilities.push_configured ? "Configuration Firebase active." : "Non configurées sur ce serveur : les notifications push ne sont pas disponibles." : "État de la configuration indisponible."}</Text>
      <Text style={styles.capabilityTitle}>Appels</Text>
      <Text style={styles.noticeText}>{capabilities?.calls ? "Disponibles." : `Non disponibles${capabilities?.calls_reason ? ` : ${capabilities.calls_reason}` : "."}`}</Text>
      <Text style={styles.capabilityTitle}>Chiffrement de bout en bout</Text>
      <Text style={styles.noticeText}>{capabilities?.end_to_end_encryption ? "Activé." : "Non disponible ; les messages ne sont pas présentés comme chiffrés de bout en bout."}</Text>
      <Text style={styles.capabilityTitle}>Messages programmés</Text>
      <Text style={styles.noticeText}>{capabilities?.scheduled_messages ? "Disponibles dans les conversations." : "Non disponibles."}</Text>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  panel: { flex: 1, minHeight: 0, backgroundColor: "#fff", paddingHorizontal: 16, paddingTop: 17 },
  panelTitle: { fontSize: 20, fontWeight: "900", color: ink, marginBottom: 14 },
  search: { height: 42, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 13, backgroundColor: "#f2f5f9", borderRadius: 22, marginBottom: 12 },
  searchInput: { flex: 1, fontSize: 14, outlineStyle: "none" as any, color: ink },
  sectionTitle: { color: muted, fontSize: 12, fontWeight: "800", marginTop: 17, marginBottom: 9, textTransform: "uppercase", letterSpacing: .5 },
  personRow: { minHeight: 68, flexDirection: "row", alignItems: "center", gap: 10, borderBottomWidth: 1, borderColor: "#eef1f5", position: "relative" },
  avatar: { width: 43, height: 43, borderRadius: 23, backgroundColor: "#e4edff", justifyContent: "center", alignItems: "center" }, avatarText: { color: blue, fontSize: 17, fontWeight: "900" },
  personName: { color: ink, fontSize: 14, fontWeight: "800" }, personMeta: { color: muted, fontSize: 11, marginTop: 3 },
  smallAction: { padding: 8 }, personActions: { position: "absolute", zIndex: 2, right: 0, top: 54, backgroundColor: "#fff", padding: 10, borderRadius: 11, borderWidth: 1, borderColor: "#e7ebf1", shadowColor: "#233", shadowOffset: { width: 0, height: 3 }, shadowOpacity: .15, shadowRadius: 8, elevation: 5 },
  action: { color: blue, fontWeight: "700", fontSize: 12 }, pendingRequest: { color: muted, fontSize: 11, fontWeight: "700", padding: 5 }, accept: { alignSelf: "flex-end", backgroundColor: blue, borderRadius: 15, paddingVertical: 7, paddingHorizontal: 13, marginTop: -8, marginBottom: 8 }, acceptText: { color: "#fff", fontSize: 12, fontWeight: "800" },
  empty: { color: muted, fontSize: 13, textAlign: "center", marginTop: 28, paddingHorizontal: 20 }, error: { backgroundColor: "#fff1f0", borderRadius: 10, padding: 10 }, errorText: { color: "#bf3e45", fontSize: 12 },
  composeCard: { backgroundColor: "#f8faff", borderWidth: 1, borderColor: "#e8edf5", borderRadius: 15, padding: 13, marginBottom: 14 }, composeTitle: { color: ink, fontWeight: "800", marginBottom: 7 },
  feedAttachment: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 7, backgroundColor: "#eef4ff", borderRadius: 8, marginBottom: 5 }, feedAttachmentName: { color: ink, fontSize: 12 },
  postInput: { minHeight: 76, color: ink, outlineStyle: "none" as any, fontSize: 14, textAlignVertical: "top" }, composeFooter: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderTopWidth: 1, borderColor: "#e9edf3", paddingTop: 9 },
  visibility: { flexDirection: "row", gap: 5, alignItems: "center" }, visibilityText: { color: blue, fontSize: 12, fontWeight: "700" }, publish: { backgroundColor: blue, borderRadius: 17, paddingVertical: 8, paddingHorizontal: 16 }, publishText: { color: "#fff", fontSize: 12, fontWeight: "800" }, disabled: { opacity: .45 },
  postCard: { backgroundColor: "#fff", borderWidth: 1, borderColor: "#e9edf3", borderRadius: 15, padding: 13, marginBottom: 12 }, postHeader: { flexDirection: "row", alignItems: "center", gap: 10 }, postText: { color: ink, fontSize: 14, lineHeight: 21, marginTop: 11, marginBottom: 10 }, postActions: { borderTopWidth: 1, borderColor: "#edf0f4", flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: 9 },
  postAction: { paddingVertical: 4 }, comment: { borderTopWidth: 1, borderColor: "#f0f2f5", paddingVertical: 7 }, commentText: { color: ink, fontSize: 12, lineHeight: 18 }, commentRow: { flexDirection: "row", alignItems: "center", backgroundColor: "#f4f6f9", borderRadius: 19, paddingHorizontal: 12, marginTop: 8 }, commentInput: { flex: 1, height: 38, color: ink, outlineStyle: "none" as any, fontSize: 12 },
  profileCard: { alignItems: "center", paddingVertical: 24, backgroundColor: "#f7f9fc", borderRadius: 15, marginBottom: 9 }, profileAvatar: { width: 72, height: 72, borderRadius: 40, backgroundColor: blue, alignItems: "center", justifyContent: "center", marginBottom: 10 }, profileLetter: { color: "#fff", fontSize: 29, fontWeight: "900" }, profileName: { color: ink, fontWeight: "900", fontSize: 18 },
  settingRow: { minHeight: 66, flexDirection: "row", alignItems: "center", borderBottomWidth: 1, borderColor: "#eef1f5", gap: 12 }, settingTitle: { color: ink, fontSize: 14, fontWeight: "700" }, switch: { width: 40, height: 23, borderRadius: 14, backgroundColor: "#d3d9e2", padding: 3, justifyContent: "center" }, switchOn: { backgroundColor: blue }, switchKnob: { width: 17, height: 17, backgroundColor: "#fff", borderRadius: 9 }, switchKnobOn: { alignSelf: "flex-end" },
  notice: { flexDirection: "row", alignItems: "flex-start", gap: 10, backgroundColor: "#eef5ff", padding: 12, borderRadius: 12, marginTop: 20 }, noticeText: { flex: 1, color: "#52637e", fontSize: 12, lineHeight: 18 },
  capabilityCard: { backgroundColor: "#f7f9fc", borderRadius: 13, padding: 13, gap: 4, marginTop: 4 }, capabilityTitle: { color: ink, fontSize: 13, fontWeight: "800", marginTop: 8 },
});
