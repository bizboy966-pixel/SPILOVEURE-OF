import React, { useEffect, useState } from "react";
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api";
import { messengerApi } from "./api";
import type { Attachment, ContactState, Person, Post } from "./types";
import StatusStories from "./StatusStories";
import ProtectedMessageMedia from "./ProtectedMessageMedia";
import ProfileSettingsPanel from "./ProfileSettingsPanel";
import { chatVisual } from "./chatVisualTokens";

const blue = chatVisual.brand, ink = chatVisual.ink, muted = chatVisual.muted;
type ContactProps = { onStart: (person: Person) => void; onSave?: (person: Person) => Promise<void> };
export function ContactsPanel({ onStart, onSave }: ContactProps) {
  const [state, setState] = useState<ContactState>({ contacts: [], blocked: [], requests: [], sent: [] });
  const [results, setResults] = useState<Person[]>([]);
  const [directory, setDirectory] = useState<Person[]>([]);
  const [directoryOffset, setDirectoryOffset] = useState(0);
  const [directoryHasMore, setDirectoryHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [menu, setMenu] = useState<string | null>(null);
  const refresh = async () => {
    try {
      const contacts = await api.get<ContactState>("/messenger/contacts");
      setState(contacts);
      const members = await messengerApi.people("", 50, 0);
      setDirectory(members);
      setDirectoryOffset(members.length);
      setDirectoryHasMore(members.length === 50);
      setError("");
    }
    catch (e: any) { setError(e?.detail || "Chargement des contacts impossible."); }
    finally { setLoading(false); }
  };
  const loadMoreMembers = async () => {
    if (loadingMore || !directoryHasMore) return;
    setLoadingMore(true);
    try {
      const members = await messengerApi.people("", 50, directoryOffset);
      setDirectory(old => {
        const ids = new Set(old.map(person => person.id));
        return [...old, ...members.filter(person => !ids.has(person.id))];
      });
      setDirectoryOffset(directoryOffset + members.length);
      setDirectoryHasMore(members.length === 50);
    } catch (e: any) { setError(e?.detail || "Impossible de charger les autres membres."); }
    finally { setLoadingMore(false); }
  };
  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }
    let active = true;
    const timer = setTimeout(() => messengerApi.people(q).then(rows => active && setResults(rows)).catch(e => active && setError(e?.detail || "Recherche impossible.")), 250);
    return () => { active = false; clearTimeout(timer); };
  }, [query]);
  const run = async (fn: () => Promise<any>) => { try { await fn(); await refresh(); } catch (e: any) { setError(e?.detail || "Action impossible."); } finally { setMenu(null); } };
  const personRow = (person: Person, label?: string) => <View key={person.id} style={[styles.personRow, menu === person.id && styles.personRowMenuOpen]} testID={`messenger-contact-row-${person.id}`}>
    <TouchableOpacity onPress={() => onStart(person)} accessibilityRole="button" accessibilityLabel={`Ouvrir la discussion avec ${person.username}`} testID={`messenger-contact-open-${person.id}`} style={styles.personIdentity}>
      <View style={styles.avatar}>{person.avatar ? <Image source={{ uri: person.avatar }} style={styles.avatarImage} /> : <Text style={styles.avatarText}>{person.username.slice(0, 1).toUpperCase()}</Text>}</View>
      <View style={{ flex: 1, minWidth: 0 }}><Text style={styles.personName} numberOfLines={1}>{person.username}</Text><Text style={styles.personMeta}>{label || (person.online ? "En ligne" : "Membre SPILOVEURE")}</Text></View>
    </TouchableOpacity>
    <TouchableOpacity onPress={() => onStart(person)} style={styles.smallAction}><Ionicons name="chatbubble-outline" size={18} color={blue} /></TouchableOpacity>
    {onSave && state.contacts.some(p => p.id === person.id)
      ? <Text style={styles.savedLabel}>Enregistré</Text>
      : onSave && state.sent.includes(person.id)
        ? <Text style={styles.pendingRequest}>Demande envoyée</Text>
        : onSave && <TouchableOpacity onPress={() => run(() => onSave(person))} style={styles.saveAction} accessibilityRole="button" accessibilityLabel={`Enregistrer ${person.username} et ouvrir la discussion`} testID={`messenger-contact-save-${person.id}`}><Ionicons name="bookmark-outline" size={17} color={blue} /><Text style={styles.saveActionText}>Enregistrer</Text></TouchableOpacity>}
    <TouchableOpacity onPress={() => setMenu(menu === person.id ? null : person.id)} style={styles.smallAction} accessibilityRole="button" accessibilityLabel={`Options pour ${person.username}`} accessibilityState={{ expanded: menu === person.id }} testID={`messenger-contact-menu-toggle-${person.id}`}><Ionicons name="ellipsis-horizontal" size={19} color={muted} /></TouchableOpacity>
    {menu === person.id && <View style={styles.personActions} testID={`messenger-contact-menu-${person.id}`}>
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
      {query.trim().length >= 2 && <><Text style={styles.sectionTitle}>Résultats</Text>{results.length ? results.map(p => personRow(p, state.contacts.some(saved => saved.id === p.id) ? "Contact enregistré" : state.sent.includes(p.id) ? "Demande envoyée" : "Non enregistré")) : !loading ? <Text style={styles.empty}>Aucun membre trouvé.</Text> : null}</>}
      {!query && <><Text style={styles.sectionTitle}>Utilisateurs de la plateforme · {directory.length}</Text>
        {directory.map(person => personRow(person, state.contacts.some(saved => saved.id === person.id) ? "Contact enregistré" : state.sent.includes(person.id) ? "Demande envoyée" : person.online ? "En ligne · Non enregistré" : "Non enregistré"))}
        {directoryHasMore && <TouchableOpacity onPress={loadMoreMembers} disabled={loadingMore} style={styles.loadMore}>{loadingMore ? <ActivityIndicator color={blue} /> : <Text style={styles.saveActionText}>Afficher plus de membres</Text>}</TouchableOpacity>}
        {!loading && directory.length === 0 ? <Text style={styles.empty}>Aucun utilisateur à afficher.</Text> : null}
      </>}
      {!query && state.requests.length > 0 && <><Text style={styles.sectionTitle}>Demandes reçues</Text>{state.requests.map(p => <View key={p.id}>{personRow(p, "Demande de contact")}<TouchableOpacity onPress={() => run(() => api.post(`/messenger/contacts/${encodeURIComponent(p.id)}/accept`))} style={styles.accept}><Text style={styles.acceptText}>Accepter</Text></TouchableOpacity></View>)}</>}
      {!query && state.blocked.length > 0 && <><Text style={styles.sectionTitle}>Comptes bloqués</Text>{state.blocked.map(p => <View key={p.id}>{personRow(p, "Bloqué")}<TouchableOpacity onPress={() => run(() => api.delete(`/messenger/blocks/${encodeURIComponent(p.id)}`))}><Text style={styles.action}>Débloquer</Text></TouchableOpacity></View>)}</>}
    </ScrollView>
  </View>;
}

type FeedProps = {
  userId: string; version?: number; requestedStatusAuthor?: string | null; requestedStatusId?: string | null;
  onStatusRequestConsumed?: () => void; onStatusViewerClose?: () => void;
  onUnreadCount?: (count: number) => void;
  onStatusReply?: (authorId: string, text: string, statusId: string, voice?: Blob) => Promise<void>;
};
export function FeedPanel({ userId, version = 0, requestedStatusAuthor, requestedStatusId, onStatusRequestConsumed, onStatusViewerClose, onUnreadCount, onStatusReply }: FeedProps) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [text, setText] = useState("");
  const [canPublish, setCanPublish] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [comment, setComment] = useState<Record<string, string>>({});
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const load = async () => {
    try {
      const rows = await api.get<Post[]>("/messenger/feed");
      setPosts(rows);
      setError("");
      const latest = rows.find(post => post.is_official);
      if (latest) await api.post("/messenger/feed/read", { post_id: latest.id }).catch(() => {});
      const state = await api.get<{ count: number; can_publish: boolean }>("/messenger/feed/unread-count");
      setCanPublish(state.can_publish);
      onUnreadCount?.(state.count);
    }
    catch (e: any) { setError(e?.detail || "Impossible de charger les actus."); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { if (version > 0) load(); }, [version]);
  const publish = async () => {
    if (!canPublish || (!text.trim() && !attachments.length)) return;
    try { await api.post("/messenger/feed", { text: text.trim(), visibility: "public", attachments }); setText(""); setAttachments([]); await load(); }
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
    <StatusStories userId={userId} version={version} requestedAuthorId={requestedStatusAuthor} requestedStatusId={requestedStatusId} onRequestConsumed={onStatusRequestConsumed} onViewerClose={onStatusViewerClose} onReply={onStatusReply} />
    <Text style={styles.panelTitle}>Actualités SPILOVEURE</Text>
    {error ? <TouchableOpacity onPress={load} style={styles.error}><Text style={styles.errorText}>{error} · Réessayer</Text></TouchableOpacity> : null}
    <ScrollView contentContainerStyle={{ paddingBottom: 30 }}>
      {canPublish ? <View style={styles.composeCard}>
        <Text style={styles.composeTitle}>Publier une actualité officielle</Text>
        <TextInput value={text} onChangeText={setText} placeholder="Message ou annonce SPILOVEURE…" multiline style={styles.postInput} />
        {attachments.map(file => <View key={file.id} style={styles.feedAttachment}><Text style={styles.feedAttachmentName}>{file.name}</Text><TouchableOpacity onPress={() => setAttachments(old => old.filter(a => a.id !== file.id))}><Ionicons name="close-circle" size={18} color={muted} /></TouchableOpacity></View>)}
        <View style={styles.composeFooter}>
          <TouchableOpacity onPress={attachFeedFile} accessibilityLabel="Ajouter une photo ou vidéo"><Ionicons name="image-outline" size={19} color={blue} /></TouchableOpacity>
          <TouchableOpacity onPress={publish} style={[styles.publish, (!text.trim() && !attachments.length) && styles.disabled]} disabled={!text.trim() && !attachments.length}><Text style={styles.publishText}>Publier</Text></TouchableOpacity>
        </View>
      </View> : <Text style={styles.officialHint}>Les actualités officielles publiées par SPILOVEURE apparaîtront ici.</Text>}
      {loading ? <ActivityIndicator color={blue} style={{ marginTop: 25 }} /> : posts.length === 0 ? <Text style={styles.empty}>Aucune actualité pour le moment.</Text> : posts.map(post => <View key={post.id} style={styles.postCard}>
        <View style={styles.postHeader}><View style={styles.avatar}><Text style={styles.avatarText}>S</Text></View><View style={{ flex: 1 }}><View style={styles.officialTitle}><Text style={styles.personName}>{post.author_name}</Text><Ionicons name="checkmark-circle" size={16} color={blue} /></View><Text style={styles.personMeta}>{new Date(post.created_at).toLocaleString()} · Actualité officielle</Text></View>{post.author_id === userId && <TouchableOpacity onPress={async () => { if (typeof window === "undefined" || window.confirm("Supprimer cette actualité ?")) { await api.delete(`/messenger/feed/${encodeURIComponent(post.id)}`).then(load).catch(e => setError(e?.detail || "Suppression impossible.")); } }}><Ionicons name="trash-outline" size={18} color={muted} /></TouchableOpacity>}</View>
        {!!post.text && <Text style={styles.postText}>{post.text}</Text>}
        {post.attachments?.map(file => <ProtectedMessageMedia key={file.id} file={file} onOpen={() => {}} />)}
        <View style={styles.postActions}><TouchableOpacity onPress={() => api.post(`/messenger/feed/${encodeURIComponent(post.id)}/reaction`, { emoji: "👍" }).then(load).catch(e => setError(e?.detail || "Réaction impossible."))} style={styles.postAction}><Text style={styles.action}>👍 J’aime</Text></TouchableOpacity><Text style={styles.personMeta}>{Object.values(post.reactions || {}).reduce((n, a) => n + a.length, 0)} réactions · {post.comments.length} commentaires</Text></View>
        {post.comments.map(item => <View key={item.id} style={styles.comment}><Text style={styles.commentText}><Text style={{ fontWeight: "800" }}>{item.username} </Text>{item.text}</Text></View>)}
        <View style={styles.commentRow}><TextInput value={comment[post.id] || ""} onChangeText={v => setComment(old => ({ ...old, [post.id]: v }))} placeholder="Écrire un commentaire" style={styles.commentInput} /><TouchableOpacity onPress={() => addComment(post.id)}><Ionicons name="send" size={19} color={blue} /></TouchableOpacity></View>
      </View>)}
    </ScrollView>
  </View>;
}

type ProfileProps = {
  user: { id: string; username: string; email?: string; phone?: string; country?: string; profile_photo?: string };
  onOpenContacts?: () => void;
  onOpenChats?: () => void;
  onAppearanceChange?: (value: "light" | "dark") => void;
  onReduceMotionChange?: (value: boolean) => void;
  onHighContrastChange?: (value: boolean) => void;
};
export function ProfilePanel(props: ProfileProps) {
  return <ProfileSettingsPanel {...props} />;
}

const styles = StyleSheet.create({
  deviceHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  panel: { flex: 1, minHeight: 0, backgroundColor: "#fffefa", paddingHorizontal: 18, paddingTop: 19 },
  panelTitle: { fontSize: 21, fontWeight: "800", color: ink, marginBottom: 16, letterSpacing: -0.35 },
  officialHint: { color: muted, fontSize: 12, lineHeight: 18, marginBottom: 12 },
  search: { height: 44, flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 14, backgroundColor: "#f4f6f9", borderWidth: 1, borderColor: "#e8edf3", borderRadius: 13, marginBottom: 13 },
  searchInput: { flex: 1, fontSize: 14, outlineStyle: "none" as any, color: ink },
  sectionTitle: { color: muted, fontSize: 12, fontWeight: "800", marginTop: 17, marginBottom: 9, textTransform: "uppercase", letterSpacing: .5 },
  personRow: { minHeight: 72, flexDirection: "row", alignItems: "center", gap: 8, borderBottomWidth: 1, borderColor: "#edf0f4", position: "relative" },
  personRowMenuOpen: { zIndex: 10, overflow: "visible" },
  personIdentity: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 9 },
  avatar: { width: 43, height: 43, borderRadius: 23, backgroundColor: "#e4edff", justifyContent: "center", alignItems: "center", overflow: "hidden" }, avatarImage: { width: 43, height: 43, borderRadius: 23 }, avatarText: { color: blue, fontSize: 17, fontWeight: "900" },
  personName: { color: ink, fontSize: 14, fontWeight: "800" }, personMeta: { color: muted, fontSize: 11, marginTop: 3 },
  smallAction: { padding: 7 }, saveAction: { minHeight: 32, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 3, backgroundColor: "#eef4ff", borderRadius: 17, paddingHorizontal: 8 }, saveActionText: { color: blue, fontSize: 10, fontWeight: "800" }, personActions: { position: "absolute", zIndex: 2, right: 0, top: 54, backgroundColor: "#fff", padding: 10, borderRadius: 11, borderWidth: 1, borderColor: "#e7ebf1", shadowColor: "#233", shadowOffset: { width: 0, height: 3 }, shadowOpacity: .15, shadowRadius: 8, elevation: 5 },
  action: { color: blue, fontWeight: "700", fontSize: 12 }, pendingRequest: { color: muted, fontSize: 11, fontWeight: "700", padding: 5 }, savedLabel: { color: "#13864b", fontSize: 11, fontWeight: "800", padding: 5 }, loadMore: { alignSelf: "center", minWidth: 200, padding: 12, marginVertical: 10, alignItems: "center", borderRadius: 14, backgroundColor: "#edf3ff" }, accept: { alignSelf: "flex-end", backgroundColor: blue, borderRadius: 15, paddingVertical: 7, paddingHorizontal: 13, marginTop: -8, marginBottom: 8 }, acceptText: { color: "#fff", fontSize: 12, fontWeight: "800" },
  empty: { color: muted, fontSize: 13, textAlign: "center", marginTop: 28, paddingHorizontal: 20 }, error: { backgroundColor: "#fff1f0", borderRadius: 10, padding: 10 }, errorText: { color: "#bf3e45", fontSize: 12 },
  composeCard: { backgroundColor: "#fffefa", borderWidth: 1, borderColor: "#e8e6df", borderRadius: 15, padding: 15, marginBottom: 16 }, composeTitle: { color: ink, fontWeight: "800", marginBottom: 8 },
  feedAttachment: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 7, backgroundColor: "#eef4ff", borderRadius: 8, marginBottom: 5 }, feedAttachmentName: { color: ink, fontSize: 12, flex: 1, minWidth: 0 },
  postInput: { minHeight: 76, color: ink, outlineStyle: "none" as any, fontSize: 14, textAlignVertical: "top" }, composeFooter: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderTopWidth: 1, borderColor: "#e9edf3", paddingTop: 9 },
  visibility: { flexDirection: "row", gap: 5, alignItems: "center" }, visibilityText: { color: blue, fontSize: 12, fontWeight: "700" }, publish: { backgroundColor: blue, borderRadius: 17, paddingVertical: 8, paddingHorizontal: 16 }, publishText: { color: "#fff", fontSize: 12, fontWeight: "800" }, disabled: { opacity: .45 },
  postCard: { backgroundColor: "#fff", borderWidth: 1, borderColor: "#e8ebef", borderRadius: 15, padding: 15, marginBottom: 14 }, postHeader: { flexDirection: "row", alignItems: "center", gap: 11 }, officialTitle: { flexDirection: "row", alignItems: "center", gap: 5 }, postText: ({ color: ink, fontSize: 14, lineHeight: 22, marginTop: 12, marginBottom: 11, maxWidth: "100%", overflowWrap: "anywhere", wordBreak: "break-word" } as any), postActions: { borderTopWidth: 1, borderColor: "#edf0f4", flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: 10 },
  postAction: { paddingVertical: 4 }, comment: { borderTopWidth: 1, borderColor: "#f0f2f5", paddingVertical: 7 }, commentText: { color: ink, fontSize: 12, lineHeight: 18 }, commentRow: { flexDirection: "row", alignItems: "center", backgroundColor: "#f4f6f9", borderRadius: 19, paddingHorizontal: 12, marginTop: 8 }, commentInput: { flex: 1, height: 38, color: ink, outlineStyle: "none" as any, fontSize: 12 },
    profileCard: { alignItems: "center", paddingVertical: 24, backgroundColor: "#f7f9fc", borderRadius: 15, marginBottom: 9 }, profileAvatar: { width: 72, height: 72, borderRadius: 40, backgroundColor: blue, alignItems: "center", justifyContent: "center", marginBottom: 10, overflow: "visible" }, profileAvatarImage: { width: 72, height: 72, borderRadius: 40 }, profileCamera: { position: "absolute", right: -2, bottom: -2, width: 25, height: 25, borderRadius: 13, backgroundColor: blue, borderWidth: 2, borderColor: "#fff", alignItems: "center", justifyContent: "center" }, profileLetter: { color: "#fff", fontSize: 29, fontWeight: "900" }, profileName: { color: ink, fontWeight: "900", fontSize: 18 },
    personalLinkCard: { backgroundColor: "#f5f8ff", borderColor: "#e1eaff", borderWidth: 1, borderRadius: 14, padding: 13, marginBottom: 8 }, personalLinkTitle: { color: muted, fontSize: 11, fontWeight: "800" }, personalHandle: { color: ink, fontSize: 15, fontWeight: "900", marginTop: 4 }, personalUrl: ({ color: blue, fontSize: 11, lineHeight: 17, marginTop: 3, overflowWrap: "anywhere", wordBreak: "break-word" } as any), personalLinkActions: { flexDirection: "row", gap: 10, marginTop: 10 }, personalLinkButton: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: "#e8f0ff", borderRadius: 18, minHeight: 34, paddingHorizontal: 12 }, personalLinkActionText: { color: blue, fontSize: 12, fontWeight: "800" },
  settingRow: { minHeight: 66, flexDirection: "row", alignItems: "center", borderBottomWidth: 1, borderColor: "#eef1f5", gap: 12 }, settingTitle: { color: ink, fontSize: 14, fontWeight: "700" }, switch: { width: 40, height: 23, borderRadius: 14, backgroundColor: "#d3d9e2", padding: 3, justifyContent: "center" }, switchOn: { backgroundColor: blue }, switchKnob: { width: 17, height: 17, backgroundColor: "#fff", borderRadius: 9 }, switchKnobOn: { alignSelf: "flex-end" },
  notice: { flexDirection: "row", alignItems: "flex-start", gap: 10, backgroundColor: "#eef5ff", padding: 12, borderRadius: 12, marginTop: 20 }, noticeText: { flex: 1, color: "#52637e", fontSize: 12, lineHeight: 18 },
  capabilityCard: { backgroundColor: "#f7f9fc", borderRadius: 13, padding: 13, gap: 4, marginTop: 4 }, capabilityTitle: { color: ink, fontSize: 13, fontWeight: "800", marginTop: 8 },
});
