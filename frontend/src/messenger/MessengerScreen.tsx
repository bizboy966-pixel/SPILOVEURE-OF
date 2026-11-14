import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Image, Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, useWindowDimensions, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { useAuth } from "@/src/auth";
import { messengerApi } from "./api";
import { useConversations } from "./useConversations";
import type { Conversation, MessengerCapabilities, Person } from "./types";
import ConversationThread from "./ConversationThread";
import ConversationDetails from "./ConversationDetails";
import PublicChannelsModal from "./PublicChannelsModal";
import { ContactsPanel, FeedPanel, ProfilePanel } from "./CommunityPanels";
import { useNavigationTransition } from "./NavigationTransition";

const logo = require("../../assets/images/spiloveure-logo.png");
const blue = "#1769e8", ink = "#102042", muted = "#8993a4";
type Filter = "Tous" | "Messages privés" | "Groupes" | "Canaux";
type Tab = "Échanges" | "Contacts" | "Actus" | "Profil";
const filters: Filter[] = ["Tous", "Messages privés", "Groupes", "Canaux"];

export default function MessengerScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const navTransition = useNavigationTransition();
  const { items, loading, error, refresh, archived, setArchived, version, feedVersion, typingByConversation, readReceipts } = useConversations(user?.id);
  const { width } = useWindowDimensions();
  const wide = width >= 760;
  const [tab, setTab] = useState<Tab>("Échanges");
  const [filter, setFilter] = useState<Filter>("Tous");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [creationOpen, setCreationOpen] = useState(false);
  const [kind, setKind] = useState<"private" | "group" | "channel">("private");
  const [isPublic, setIsPublic] = useState(false);
  const [title, setTitle] = useState("");
  const [personQuery, setPersonQuery] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [chosen, setChosen] = useState<Person[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [publicChannelsOpen, setPublicChannelsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<MessengerCapabilities | null>(null);
  useEffect(() => { messengerApi.capabilities().then(setCapabilities).catch(() => setCapabilities(null)); }, []);
  useEffect(() => {
    if (!selected) return;
    const fresh = items.find(item => item.id === selected.id);
    if (fresh && fresh !== selected) setSelected(fresh);
  }, [items, selected]);
  useEffect(() => {
    const q = personQuery.trim();
    if (q.length < 2) { setPeople([]); return; }
    let current = true;
    const timer = setTimeout(() => messengerApi.people(q).then(result => current && setPeople(result.filter(person => person.id !== user?.id))).catch((e: any) => current && setActionError(e?.detail || "Recherche impossible.")), 250);
    return () => { current = false; clearTimeout(timer); };
  }, [personQuery, user?.id]);
  const visible = useMemo(() => items.filter(item => {
    const matchesFilter = filter === "Tous" || (filter === "Messages privés" && item.kind === "private") || (filter === "Groupes" && item.kind === "group") || (filter === "Canaux" && item.kind === "channel");
    const q = query.trim().toLowerCase();
    return matchesFilter && (!q || item.title.toLowerCase().includes(q) || item.last_message?.text?.toLowerCase().includes(q));
  }).sort((a, b) => Number(b.pinned) - Number(a.pinned) || new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()), [items, filter, query]);

  const goHome = () => {
    navTransition.toHome(() => router.replace("/(app)/dashboard" as any));
  };
  const createPrivate = (person: Person) => {
    setBusy(true); setActionError("");
    messengerApi.createConversation({ kind: "private", member_ids: [person.id] }).then(result => {
      setSelected(result); setCreationOpen(false); setChosen([]); setPersonQuery(""); setTab("Échanges"); refresh();
    }).catch((e: any) => setActionError(e?.detail || "Conversation impossible à créer.")).finally(() => setBusy(false));
  };
  const createConversation = async () => {
    setBusy(true); setActionError("");
    try {
      const conversation = await messengerApi.createConversation({
        kind, ...(kind !== "private" ? { title: title.trim() } : {}),
        member_ids: chosen.map(person => person.id),
        ...(kind === "channel" ? { is_public: isPublic } : {}),
      });
      setSelected(conversation); setCreationOpen(false); setChosen([]); setTitle(""); setPersonQuery(""); setTab("Échanges"); await refresh();
    } catch (e: any) { setActionError(e?.detail || "Création impossible."); }
    finally { setBusy(false); }
  };
  const openCreate = (initial: "private" | "group" | "channel" = "private") => {
    setKind(initial); setTitle(""); setChosen([]); setIsPublic(false); setPersonQuery(""); setCreationOpen(true); setMenuOpen(false); setActionError("");
  };
  const togglePerson = (person: Person) => setChosen(old => {
    if (old.some(p => p.id === person.id)) return old.filter(p => p.id !== person.id);
    if (old.length >= 199) { setActionError("Un groupe ou canal peut compter au maximum 200 membres, vous compris."); return old; }
    return [...old, person];
  });
  const openJoinedChannel = (conversation: Conversation) => {
    setPublicChannelsOpen(false); setSelected(conversation); setTab("Échanges"); setFilter("Canaux"); refresh();
  };
  const runPreference = async (item: Conversation, key: "muted" | "archived" | "pinned") => {
    try { await messengerApi.patchConversation(item.id, { [key]: !item[key] }); await refresh(); }
    catch (e: any) { setActionError(e?.detail || "Mise à jour impossible."); }
  };
  const renderConversation = (item: Conversation) => {
    const preview = item.last_message?.deleted ? "Message supprimé" : item.last_message?.text || item.draft || (item.last_message?.attachments?.length ? "Pièce jointe" : "");
    return <TouchableOpacity key={item.id} style={[styles.conversationRow, selected?.id === item.id && styles.rowSelected]} onPress={() => setSelected(item)} activeOpacity={0.7} testID={`messenger-conversation-${item.id}`} accessibilityLabel={`Ouvrir la conversation ${item.title}`}>
      <View style={styles.rowAvatar}>
        {item.photo ? <Image source={{ uri: item.photo }} style={styles.rowPhoto} /> : <Text style={styles.rowAvatarLetter}>{item.title.slice(0, 1).toUpperCase()}</Text>}
        {item.kind === "private" && item.member_profiles.find(p => p.id !== user?.id)?.online && <View style={styles.onlineDot} />}
      </View>
      <View style={styles.rowMain}>
        <View style={styles.rowTop}><Text style={styles.rowTitle} numberOfLines={1}>{item.title}</Text><Text style={styles.rowTime}>{item.last_message?.created_at ? new Date(item.last_message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</Text><TouchableOpacity onPress={() => setRowMenu(rowMenu === item.id ? null : item.id)} hitSlop={8}><Ionicons name="ellipsis-horizontal" size={16} color={muted} /></TouchableOpacity></View>
        <View style={styles.rowBottom}><Text style={[styles.preview, !!item.draft && !item.last_message?.text && styles.draftText]} numberOfLines={1}>{item.draft && !item.last_message?.text ? "Brouillon : " : ""}{preview}</Text>
          <View style={styles.rowMarkers}>{item.muted && <Ionicons name="notifications-off" size={13} color="#9ba4b3" />}{item.pinned && <Ionicons name="pin" size={13} color={blue} />}{item.unread > 0 && <View style={styles.unread}><Text style={styles.unreadText}>{item.unread > 999 ? "999+" : item.unread}</Text></View>}</View>
        </View>
        {rowMenu === item.id && <View style={styles.rowQuickActions}>
          <TouchableOpacity onPress={() => runPreference(item, "pinned")}><Text style={styles.quickText}>{item.pinned ? "Désépingler" : "Épingler"}</Text></TouchableOpacity>
          <TouchableOpacity onPress={() => runPreference(item, "muted")}><Text style={styles.quickText}>{item.muted ? "Activer le son" : "Sourdine"}</Text></TouchableOpacity>
          <TouchableOpacity onPress={() => runPreference(item, "archived")}><Text style={styles.quickText}>{item.archived ? "Restaurer" : "Archiver"}</Text></TouchableOpacity>
        </View>}
      </View>
    </TouchableOpacity>;
  };
  const chatList = <View style={[styles.listPanel, wide && styles.wideList]}>
    <LinearGradient colors={["#075fdf", "#0647b4"]} style={styles.header}>
      <View pointerEvents="none" style={styles.goldSwoop} />
      <TouchableOpacity onPress={goHome} style={styles.brand} accessibilityLabel="Retourner à SPILOVEURE">
        <Image source={logo} style={styles.logo} resizeMode="contain" />
        <View><Text style={styles.brandTitle}>SPILOVEURE</Text><Text style={styles.brandSub}>Chat</Text></View>
      </TouchableOpacity>
      {searchOpen ? <TextInput value={query} onChangeText={setQuery} placeholder="Rechercher" autoFocus style={styles.headerSearch} onSubmitEditing={() => setSearchOpen(false)} /> : null}
      <TouchableOpacity onPress={() => { setSearchOpen(v => !v); setQuery(""); }} style={styles.headerIcon}><Ionicons name={searchOpen ? "close" : "search"} size={23} color="#fff" /></TouchableOpacity>
      <TouchableOpacity onPress={() => setMenuOpen(true)} style={styles.headerIcon}><Ionicons name="ellipsis-vertical" size={21} color="#fff" /></TouchableOpacity>
    </LinearGradient>
    <View style={styles.filters}>{filters.map(name => <TouchableOpacity key={name} onPress={() => setFilter(name)} style={[styles.filter, filter === name && styles.filterActive]}><Text style={[styles.filterText, filter === name && styles.filterActiveText]}>{name}</Text></TouchableOpacity>)}</View>
    {filter === "Canaux" && capabilities?.public_channels !== false && <TouchableOpacity onPress={() => setPublicChannelsOpen(true)} style={styles.discoverChannels} testID="messenger-channel-discovery" accessibilityLabel="Découvrir les canaux publics"><Ionicons name="compass-outline" size={17} color={blue} /><Text style={styles.discoverText}>Découvrir les canaux publics</Text></TouchableOpacity>}
    {archived && <View style={styles.archiveBanner}><Text style={styles.archiveText}>Conversations archivées</Text><TouchableOpacity onPress={() => setArchived(false)}><Text style={styles.quickText}>Retour</Text></TouchableOpacity></View>}
    {actionError ? <TouchableOpacity onPress={() => setActionError("")} style={styles.errorBanner}><Text style={styles.errorText}>{actionError}  ×</Text></TouchableOpacity> : null}
    {loading ? <View style={styles.loading}><View style={styles.skeleton} /><View style={styles.skeleton} /><View style={styles.skeleton} /></View>
      : error ? <TouchableOpacity onPress={refresh} style={styles.emptyState}><Ionicons name="cloud-offline-outline" size={30} color={blue} /><Text style={styles.emptyTitle}>{error}</Text><Text style={styles.emptyLink}>Réessayer</Text></TouchableOpacity>
        : visible.length ? <ScrollView contentContainerStyle={{ paddingBottom: 92 }}>{visible.map(renderConversation)}</ScrollView>
          : <View style={styles.emptyState}><View style={styles.emptyCircle}><Ionicons name="chatbubbles-outline" size={30} color={blue} /></View><Text style={styles.emptyTitle}>{query ? "Aucun résultat" : archived ? "Aucune conversation archivée" : "Aucune conversation pour le moment"}</Text><Text style={styles.emptyCopy}>{query ? "Essayez un autre nom." : "Commencez une conversation avec un membre SPILOVEURE."}</Text><TouchableOpacity onPress={() => openCreate()} style={styles.emptyButton}><Text style={styles.emptyButtonText}>Nouveau message</Text></TouchableOpacity></View>}
    <TouchableOpacity style={styles.fab} onPress={() => openCreate()} accessibilityLabel="Nouvelle conversation"><Ionicons name="add" size={31} color="#fff" /></TouchableOpacity>
  </View>;

  const navItems: { key: Tab; icon: any }[] = [
    { key: "Échanges", icon: "chatbubbles" }, { key: "Contacts", icon: "people" },
    { key: "Actus", icon: "megaphone" }, { key: "Profil", icon: "person" },
  ];
  return <View style={styles.page}>
    <View style={[styles.workspace, wide && styles.workspaceWide]}>
      {tab === "Échanges" ? <>
        {(!selected || wide) && chatList}
        {selected ? <ConversationThread key={selected.id} conversation={selected} userId={user?.id || ""} onBack={() => setSelected(null)} onChanged={refresh} onDetails={() => setDetailsOpen(true)} version={version} typing={typingByConversation[selected.id]} scheduledEnabled={capabilities?.scheduled_messages !== false} readReceipts={readReceipts[selected.id]} /> : null}
        {!selected && wide ? <View style={styles.welcome}><Image source={logo} style={styles.welcomeLogo} resizeMode="contain" /><Text style={styles.welcomeTitle}>SPILOVEURE Chat</Text><Text style={styles.welcomeText}>Vos échanges de communauté, au même endroit.</Text></View> : null}
      </> : tab === "Contacts" ? <ContactsPanel onStart={createPrivate} /> : tab === "Actus" ? <FeedPanel userId={user?.id || ""} version={feedVersion} /> : <ProfilePanel username={user?.username || "Membre"} />}
    </View>
    {!navTransition.active && <View style={styles.bottomDock}>
      <View style={styles.bottomBar}>
        {navItems.slice(0, 2).map(item => <TouchableOpacity key={item.key} style={styles.navItem} onPress={() => { setTab(item.key); setSelected(null); }}><Ionicons name={item.icon} size={24} color={tab === item.key ? blue : "#9ca8b8"} /><Text style={[styles.navLabel, tab === item.key && styles.navActive]}>{item.key}</Text></TouchableOpacity>)}
        <TouchableOpacity style={styles.centerLogoWrap} onPress={goHome} accessibilityLabel="Retour à l’accueil"><View style={styles.centerLogo}><Image source={logo} style={styles.centerLogoImage} resizeMode="contain" /></View></TouchableOpacity>
        {navItems.slice(2).map(item => <TouchableOpacity key={item.key} style={styles.navItem} onPress={() => { setTab(item.key); setSelected(null); }}><Ionicons name={item.icon} size={23} color={tab === item.key ? blue : "#9ca8b8"} /><Text style={[styles.navLabel, tab === item.key && styles.navActive]}>{item.key}</Text></TouchableOpacity>)}
      </View>
    </View>}
    {detailsOpen && selected && <ConversationDetails conversation={selected} userId={user?.id || ""} onClose={() => setDetailsOpen(false)} onChanged={() => { refresh(); messengerApi.conversation(selected.id).then(setSelected).catch(() => setSelected(null)); }} />}
    <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
      <TouchableOpacity style={styles.menuBackdrop} activeOpacity={1} onPress={() => setMenuOpen(false)}><View style={styles.menu}>
        <TouchableOpacity onPress={() => openCreate("private")} style={styles.menuRow}><Ionicons name="chatbubble-outline" size={19} color={blue} /><Text style={styles.menuText}>Nouveau message</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => openCreate("group")} style={styles.menuRow} testID="messenger-create-group"><Ionicons name="people-outline" size={19} color={blue} /><Text style={styles.menuText}>Nouveau groupe</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => openCreate("channel")} style={styles.menuRow}><Ionicons name="megaphone-outline" size={19} color={blue} /><Text style={styles.menuText}>Nouveau canal</Text></TouchableOpacity>
        {capabilities?.public_channels !== false && <TouchableOpacity onPress={() => { setPublicChannelsOpen(true); setMenuOpen(false); }} style={styles.menuRow} testID="messenger-channel-discovery-menu"><Ionicons name="compass-outline" size={19} color={blue} /><Text style={styles.menuText}>Découvrir les canaux publics</Text></TouchableOpacity>}
        <TouchableOpacity onPress={() => { setArchived(!archived); setMenuOpen(false); }} style={styles.menuRow}><Ionicons name="archive-outline" size={19} color={blue} /><Text style={styles.menuText}>{archived ? "Conversations actives" : "Archives"}</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => { setBusy(true); messengerApi.createConversation({ kind: "saved" }).then(setSelected).then(refresh).catch((e: any) => setActionError(e?.detail || "Messages enregistrés indisponibles.")).finally(() => setBusy(false)); setMenuOpen(false); }} style={styles.menuRow}><Ionicons name="bookmark-outline" size={19} color={blue} /><Text style={styles.menuText}>Messages enregistrés</Text></TouchableOpacity>
      </View></TouchableOpacity>
    </Modal>
    <Modal visible={creationOpen} transparent animationType="slide" onRequestClose={() => setCreationOpen(false)}>
      <View style={styles.modalBackdrop}><View style={styles.createSheet}><View style={styles.sheetTop}><Text style={styles.sheetTitle}>{kind === "private" ? "Nouveau message" : kind === "group" ? "Créer un groupe" : "Créer un canal"}</Text><TouchableOpacity onPress={() => setCreationOpen(false)}><Ionicons name="close" size={23} color={muted} /></TouchableOpacity></View>
        {kind !== "private" && <TextInput value={title} onChangeText={setTitle} placeholder={kind === "group" ? "Nom du groupe" : "Nom du canal"} style={styles.createInput} />}
        {kind === "channel" && <TouchableOpacity style={styles.publicToggle} onPress={() => setIsPublic(value => !value)} accessibilityRole="checkbox" accessibilityState={{ checked: isPublic }}><Ionicons name={isPublic ? "checkbox" : "square-outline"} size={20} color={isPublic ? blue : muted} /><View style={{ flex: 1 }}><Text style={styles.publicTitle}>Canal public</Text><Text style={styles.publicHelp}>Visible dans la découverte et ouvert aux abonnements</Text></View></TouchableOpacity>}
        <TextInput value={personQuery} onChangeText={setPersonQuery} placeholder="Rechercher des membres" style={styles.createInput} />
        {chosen.length > 0 && <Text style={styles.selectedLine}>Sélectionnés : {chosen.map(p => p.username).join(", ")}</Text>}
        <ScrollView style={{ maxHeight: 320 }}>{people.map(person => {
          const selectedPerson = chosen.some(p => p.id === person.id);
          return <TouchableOpacity key={person.id} onPress={() => kind === "private" ? createPrivate(person) : togglePerson(person)} style={styles.personChoice}><View style={styles.rowAvatar}><Text style={styles.rowAvatarLetter}>{person.username.slice(0, 1).toUpperCase()}</Text></View><Text style={[styles.choiceName, { flex: 1 }]}>{person.username}</Text>{kind === "private" ? <Ionicons name="chevron-forward" size={18} color={muted} /> : <Ionicons name={selectedPerson ? "checkmark-circle" : "ellipse-outline"} size={21} color={selectedPerson ? blue : muted} />}</TouchableOpacity>;
        })}{personQuery.trim().length >= 2 && !people.length ? <Text style={styles.emptyCopy}>Aucun membre trouvé.</Text> : null}</ScrollView>
        {kind !== "private" && <TouchableOpacity disabled={busy || !title.trim() || (kind === "group" && chosen.length === 0)} onPress={createConversation} style={[styles.createButton, (busy || !title.trim() || (kind === "group" && chosen.length === 0)) && { opacity: .45 }]} testID={kind === "group" ? "messenger-create-group-submit" : "messenger-create-channel-submit"}>{busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.createButtonText}>{kind === "group" ? "Créer le groupe" : "Créer le canal"}</Text>}</TouchableOpacity>}
        {kind === "private" && <Text style={styles.createHint}>Saisissez au moins deux caractères pour rechercher un membre.</Text>}
        {!!actionError && <Text style={styles.errorText}>{actionError}</Text>}
      </View></View>
    </Modal>
    <PublicChannelsModal visible={publicChannelsOpen} onClose={() => setPublicChannelsOpen(false)} onJoined={openJoinedChannel} />
  </View>;
}

const styles = StyleSheet.create({
  page: { flex: 1, minHeight: "100%", backgroundColor: "#f5f7fa" },
  workspace: { flex: 1, minHeight: 0, paddingBottom: 84 },
  workspaceWide: { width: "100%", maxWidth: 1180, alignSelf: "center", flexDirection: "row", borderLeftWidth: 1, borderRightWidth: 1, borderColor: "#e7ebf1" },
  listPanel: { flex: 1, minHeight: 0, backgroundColor: "#fff", position: "relative" },
  wideList: { flexGrow: 0, flexShrink: 0, flexBasis: 375, width: 375, borderRightWidth: 1, borderColor: "#e9edf2" },
  header: { height: 84, flexDirection: "row", alignItems: "center", paddingHorizontal: 13, gap: 3, borderBottomWidth: 1, borderColor: "#1d70ed", overflow: "hidden", position: "relative" },
  goldSwoop: { position: "absolute", width: 210, height: 150, right: -78, top: 14, borderTopWidth: 3, borderColor: "#d9ad42", borderRadius: 110, transform: [{ rotate: "-31deg" }], opacity: .95 },
  brand: { flex: 1, flexDirection: "row", alignItems: "center", gap: 9 }, logo: { width: 51, height: 51, borderRadius: 28, backgroundColor: "#0649b5" }, brandTitle: { color: "#fff", fontSize: 17, fontWeight: "900", letterSpacing: .2 }, brandSub: { color: "#fff", fontSize: 16, fontWeight: "800", marginTop: -2 },
  headerIcon: { width: 39, height: 45, alignItems: "center", justifyContent: "center" }, headerSearch: { flex: 1, color: "#fff", borderBottomWidth: 1, borderColor: "rgba(255,255,255,.7)", paddingVertical: 6, outlineStyle: "none" as any },
  filters: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 7, paddingHorizontal: 13, height: 60, backgroundColor: "#fff", borderBottomWidth: 1, borderColor: "#edf0f4" },
  discoverChannels: { marginHorizontal: 13, marginTop: 9, marginBottom: 2, height: 35, borderRadius: 18, backgroundColor: "#eef4ff", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7 }, discoverText: { color: blue, fontSize: 12, fontWeight: "800" },
  filter: { borderRadius: 21, paddingHorizontal: 14, paddingVertical: 9, backgroundColor: "#f2f4f8" }, filterActive: { backgroundColor: blue }, filterText: { color: "#283958", fontSize: 12, fontWeight: "700" }, filterActiveText: { color: "#fff" },
  conversationRow: { minHeight: 82, flexDirection: "row", alignItems: "center", paddingHorizontal: 13, borderBottomWidth: 1, borderColor: "#edf0f3", gap: 12, backgroundColor: "#fff" }, rowSelected: { backgroundColor: "#f4f8ff" },
  rowAvatar: { width: 54, height: 54, borderRadius: 29, backgroundColor: "#e7effd", alignItems: "center", justifyContent: "center", position: "relative" }, rowPhoto: { width: 54, height: 54, borderRadius: 28 }, rowAvatarLetter: { color: blue, fontSize: 22, fontWeight: "900" }, onlineDot: { position: "absolute", width: 13, height: 13, borderRadius: 7, backgroundColor: "#1bb779", bottom: -1, right: 0, borderWidth: 2, borderColor: "#fff" },
  rowMain: { flex: 1, minWidth: 0 }, rowTop: { flexDirection: "row", alignItems: "center", gap: 7 }, rowTitle: { flex: 1, color: "#111f3b", fontSize: 15, fontWeight: "800" }, rowTime: { color: "#8b95a5", fontSize: 11 }, rowBottom: { flexDirection: "row", alignItems: "center", marginTop: 4, gap: 8 }, preview: { flex: 1, color: "#7e8795", fontSize: 13 }, draftText: { color: "#4f78b8" }, rowMarkers: { flexDirection: "row", alignItems: "center", gap: 5 }, unread: { minWidth: 22, height: 22, borderRadius: 12, paddingHorizontal: 6, alignItems: "center", justifyContent: "center", backgroundColor: blue }, unreadText: { color: "#fff", fontSize: 11, fontWeight: "800" },
  rowQuickActions: { flexDirection: "row", gap: 12, paddingTop: 5, opacity: .82 }, quickText: { color: blue, fontSize: 10, fontWeight: "700" },
  fab: { position: "absolute", right: 19, bottom: 18, width: 62, height: 62, borderRadius: 34, backgroundColor: blue, alignItems: "center", justifyContent: "center", elevation: 7, shadowColor: "#0d4dac", shadowOffset: { width: 0, height: 5 }, shadowOpacity: .3, shadowRadius: 9 },
  loading: { padding: 18, gap: 18 }, skeleton: { height: 64, borderRadius: 30, backgroundColor: "#f0f3f8" }, emptyState: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 28 }, emptyCircle: { width: 62, height: 62, borderRadius: 32, backgroundColor: "#eaf1ff", alignItems: "center", justifyContent: "center" }, emptyTitle: { color: ink, fontSize: 16, fontWeight: "800", textAlign: "center", marginTop: 13 }, emptyCopy: { color: muted, fontSize: 13, textAlign: "center", marginTop: 7 }, emptyLink: { color: blue, fontSize: 13, fontWeight: "800", marginTop: 10 }, emptyButton: { marginTop: 17, backgroundColor: blue, borderRadius: 20, paddingVertical: 10, paddingHorizontal: 17 }, emptyButtonText: { color: "#fff", fontSize: 13, fontWeight: "800" },
  bottomDock: { position: "absolute", left: 10, right: 10, bottom: 8, zIndex: 5 }, bottomBar: { height: 75, borderRadius: 37, backgroundColor: "#fff", borderWidth: 1, borderColor: "#edf0f4", shadowColor: "#244067", shadowOffset: { width: 0, height: 6 }, shadowOpacity: .12, shadowRadius: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-around", paddingHorizontal: 4 },
  navItem: { flex: 1, alignItems: "center", justifyContent: "center", gap: 2 }, navLabel: { color: "#9ca8b8", fontSize: 10, fontWeight: "700" }, navActive: { color: blue }, centerLogoWrap: { width: 67, alignItems: "center", marginTop: -21 }, centerLogo: { width: 58, height: 58, borderRadius: 30, backgroundColor: "#fff", borderWidth: 4, borderColor: "#fff", elevation: 5, alignItems: "center", justifyContent: "center", shadowColor: blue, shadowOffset: { width: 0, height: 4 }, shadowOpacity: .2, shadowRadius: 8 }, centerLogoImage: { width: 52, height: 52, borderRadius: 27 }, 
  welcome: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#f4f7fb" }, welcomeLogo: { height: 75, width: 75, borderRadius: 40 }, welcomeTitle: { color: ink, fontSize: 20, fontWeight: "900", marginTop: 12 }, welcomeText: { color: muted, fontSize: 13, marginTop: 6 },
  menuBackdrop: { flex: 1, backgroundColor: "rgba(5,15,34,.1)" }, menu: { position: "absolute", right: 11, top: 74, width: 225, backgroundColor: "#fff", borderRadius: 13, padding: 7, shadowColor: "#11243e", shadowOffset: { width: 0, height: 5 }, shadowOpacity: .2, shadowRadius: 12, elevation: 8 }, menuRow: { height: 44, flexDirection: "row", alignItems: "center", gap: 11, paddingHorizontal: 9 }, menuText: { color: ink, fontWeight: "700", fontSize: 13 },
  publicToggle: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: 9, marginBottom: 8 }, publicTitle: { color: ink, fontSize: 13, fontWeight: "800" }, publicHelp: { color: muted, fontSize: 11, marginTop: 2 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(13,24,42,.38)", justifyContent: "flex-end" }, createSheet: { backgroundColor: "#fff", borderTopLeftRadius: 22, borderTopRightRadius: 22, maxHeight: "86%", paddingHorizontal: 18, paddingTop: 17, paddingBottom: 24 }, sheetTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }, sheetTitle: { color: ink, fontSize: 18, fontWeight: "900" }, createInput: { backgroundColor: "#f3f5f8", borderRadius: 11, paddingHorizontal: 13, height: 43, marginBottom: 10, color: ink, outlineStyle: "none" as any }, selectedLine: { color: blue, fontSize: 12, fontWeight: "700", paddingBottom: 9 }, personChoice: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: 10, borderBottomWidth: 1, borderColor: "#f0f2f5" }, choiceName: { color: ink, fontSize: 14, fontWeight: "700" }, createButton: { backgroundColor: blue, borderRadius: 22, height: 44, alignItems: "center", justifyContent: "center", marginTop: 14 }, createButtonText: { color: "#fff", fontSize: 14, fontWeight: "800" }, createHint: { color: muted, textAlign: "center", fontSize: 12, marginTop: 13 }, errorText: { color: "#c33", fontSize: 12, padding: 8 }, archiveBanner: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 14, paddingVertical: 10, backgroundColor: "#eef4ff" }, archiveText: { color: ink, fontWeight: "800", fontSize: 13 }, errorBanner: { backgroundColor: "#fff0ef", padding: 8 },
});
