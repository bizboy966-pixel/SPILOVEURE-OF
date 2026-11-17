import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Image, Modal, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, useWindowDimensions, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useLocalSearchParams, useRouter } from "expo-router";
import Svg, { Defs, LinearGradient as SvgLinearGradient, Path, Stop } from "react-native-svg";
import { useChat } from "@/src/chat/ChatContext";
import { api } from "@/src/api";
import { storage } from "@/src/utils/storage";
import { messengerApi } from "./api";
import { useConversations } from "./useConversations";
import type { ChatStatus, Conversation, MessengerCapabilities, Person } from "./types";
import ConversationThread from "./ConversationThread";
import ConversationDetails from "./ConversationDetails";
import PublicChannelsModal from "./PublicChannelsModal";
import ProfilePhotoViewer from "./ProfilePhotoViewer";
import { ContactsPanel, FeedPanel, ProfilePanel } from "./CommunityPanels";
import { useNavigationTransition } from "./NavigationTransition";
import { normalizeSpvUsername } from "./userLinks";
import { setActiveNotificationConversation } from "./notificationRuntime";
import { wasChatExplicitlyLoggedOut } from "@/src/chat/chatLaunchState";
import { chatVisual } from "./chatVisualTokens";

const logo = require("../../assets/images/spiloveure-logo.png");
const blue = chatVisual.brand, ink = chatVisual.ink, muted = "#8993a4";
type Filter = "Tous" | "Messages privés" | "Groupes" | "Canaux";
type Tab = "Échanges" | "Contacts" | "Actus" | "Profil";
const filters: Filter[] = ["Tous", "Messages privés", "Groupes", "Canaux"];

export default function MessengerScreen() {
  const router = useRouter();
  const [webViewport, setWebViewport] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined" || typeof document === "undefined") return;
    const visualViewport = window.visualViewport;
    const html = document.documentElement;
    const body = document.body;
    const originalHtmlOverflow = html.style.overflow;
    const originalHtmlHeight = html.style.height;
    const originalBodyOverflow = body.style.overflow;
    const originalBodyHeight = body.style.height;
    const originalScrollY = window.scrollY;

    // Keep Safari from scrolling the whole document to reveal the focused input.
    // The chat itself is resized to the visible viewport below, above the keyboard.
    html.style.overflow = "hidden";
    html.style.height = "100%";
    body.style.overflow = "hidden";
    body.style.height = "100%";

    const measureViewport = () => {
      const next = {
        top: Math.max(0, Math.round(visualViewport?.offsetTop ?? 0)),
        height: Math.max(1, Math.round(visualViewport?.height ?? window.innerHeight)),
      };
      setWebViewport(previous => previous?.top === next.top && previous.height === next.height ? previous : next);
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };
    measureViewport();
    visualViewport?.addEventListener("resize", measureViewport);
    visualViewport?.addEventListener("scroll", measureViewport);
    window.addEventListener("resize", measureViewport);
    window.addEventListener("orientationchange", measureViewport);

    return () => {
      visualViewport?.removeEventListener("resize", measureViewport);
      visualViewport?.removeEventListener("scroll", measureViewport);
      window.removeEventListener("resize", measureViewport);
      window.removeEventListener("orientationchange", measureViewport);
      html.style.overflow = originalHtmlOverflow;
      html.style.height = originalHtmlHeight;
      body.style.overflow = originalBodyOverflow;
      body.style.height = originalBodyHeight;
      window.scrollTo(0, originalScrollY);
    };
  }, []);
  const params = useLocalSearchParams<{ invite?: string | string[]; username?: string | string[]; conversation?: string | string[]; message?: string | string[]; notificationAction?: string | string[] }>();
  const conversationParam = Array.isArray(params.conversation) ? params.conversation[0] : params.conversation;
  const messageParam = Array.isArray(params.message) ? params.message[0] : params.message;
  const notificationAction = Array.isArray(params.notificationAction) ? params.notificationAction[0] : params.notificationAction;
  const handledNotification = useRef<string | null>(null);
  const inviteParam = Array.isArray(params.invite) ? params.invite[0] : params.invite;
  const directUsernameParam = Array.isArray(params.username) ? params.username[0] : params.username;
  const handledInvite = useRef<string | null>(null);
  const handledUserLink = useRef<string | null>(null);
  const { user, loading: chatLoading, sessionExpired, refresh: refreshChat } = useChat();
  const navTransition = useNavigationTransition();
  const { items, loading, error, refresh, archived, setArchived, version, feedVersion, typingByConversation, readReceipts } = useConversations(user?.id);
  const { width } = useWindowDimensions();
  const wide = width >= 760;
  const [photoPreview, setPhotoPreview] = useState<{ uri: string; label: string } | null>(null);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [logoutMarkerChecked, setLogoutMarkerChecked] = useState(false);
  const [explicitlyLoggedOut, setExplicitlyLoggedOut] = useState(false);
  useEffect(() => {
    let active = true;
    void wasChatExplicitlyLoggedOut().then(loggedOut => {
      if (!active) return;
      setExplicitlyLoggedOut(loggedOut);
      setLogoutMarkerChecked(true);
      if (loggedOut) router.replace("/(auth)/login" as any);
    });
    return () => { active = false; };
  }, [router]);
  useEffect(() => { if (!chatLoading) void refreshChat(); }, [chatLoading, refreshChat]);
  useEffect(() => {
    if (!user?.id) return;
    let active = true;
    api.get<{ appearance?: "light" | "dark"; reduce_motion?: boolean }>("/messenger/settings")
      .then(value => {
        if (!active) return;
        setAppearance(value.appearance === "dark" ? "dark" : "light");
        setReduceMotion(Boolean(value.reduce_motion));
      })
      .catch(() => {});
    return () => { active = false; };
  }, [user?.id]);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const style = document.createElement("style");
    style.dataset.spvAccessibility = "true";
    style.textContent = `
      [data-testid^="messenger-"]:focus-visible,
      [data-testid^="profile-settings-"]:focus-visible,
      [data-testid^="chat-list-"]:focus-visible {
        outline: 3px solid #c99a45 !important;
        outline-offset: 3px !important;
        z-index: 20;
      }
      [data-testid^="messenger-"]:hover { transition: opacity 120ms ease, transform 120ms ease; }
      .spv-chat-reduce-motion *, .spv-chat-reduce-motion *::before, .spv-chat-reduce-motion *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; scroll-behavior: auto !important; }
    `;
    document.head.appendChild(style);
    document.documentElement.classList.toggle("spv-chat-reduce-motion", reduceMotion);
    return () => {
      document.documentElement.classList.remove("spv-chat-reduce-motion");
      style.remove();
    };
  }, [reduceMotion]);
  useEffect(() => {
    if (!sessionExpired || !logoutMarkerChecked || explicitlyLoggedOut) return;
    const returnTo = directUsernameParam
      ? `/messenger?username=${encodeURIComponent(directUsernameParam)}`
      : "/messenger";
    router.replace(`/verify-email?source=chat&expired=1&returnTo=${encodeURIComponent(returnTo)}` as any);
  }, [sessionExpired, directUsernameParam, router, logoutMarkerChecked, explicitlyLoggedOut]);
  const [tab, setTab] = useState<Tab>("Échanges");
  const [filter, setFilter] = useState<Filter>("Tous");
  const [filterReadyFor, setFilterReadyFor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [selectedMessageConversationId, setSelectedMessageConversationId] = useState<string | null>(null);
  const [appearance, setAppearance] = useState<"light" | "dark">("light");
  const [notificationReplyTarget, setNotificationReplyTarget] = useState<string | null>(null);
  useEffect(() => {
    setActiveNotificationConversation(tab === "Échanges" ? selected?.id || null : null);
    return () => setActiveNotificationConversation(null);
  }, [tab, selected?.id]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onUnread = (event: Event) => {
      const cid = (event as CustomEvent).detail?.conversationId;
      setSelected(previous => previous?.id === cid ? null : previous);
    };
    const onRefresh = () => { void refresh(); };
    window.addEventListener("spv-chat-mark-unread", onUnread);
    window.addEventListener("spv-chat-inbox-refresh", onRefresh);
    return () => {
      window.removeEventListener("spv-chat-mark-unread", onUnread);
      window.removeEventListener("spv-chat-inbox-refresh", onRefresh);
    };
  }, [refresh]);
  useEffect(() => {
    if (!conversationParam) { handledNotification.current = null; return; }
    if (!user?.id) return;
    const key = `${conversationParam}:${notificationAction || "open"}:${messageParam || ""}`;
    if (handledNotification.current === key) return;
    handledNotification.current = key;
    let cancelled = false;
    void (async () => {
      try {
        if (notificationAction === "unread") {
          setSelected(null);
          await api.post(`/messenger/conversations/${encodeURIComponent(conversationParam)}/unread`, {});
          await refresh();
        } else {
          const conversation = await messengerApi.conversation(conversationParam);
          if (cancelled) return;
          setNotificationReplyTarget(notificationAction === "reply" ? conversationParam : null);
          setSelectedMessageId(messageParam || null);
          setSelectedMessageConversationId(messageParam ? conversationParam : null);
          setSelected(conversation);
          setTab("Échanges");
        }
        if (!cancelled) router.setParams({ conversation: "", notificationAction: "" });
      } catch (failure: any) {
        if (!cancelled) setActionError(failure?.detail || "La discussion demandée est indisponible.");
      }
    })();
    return () => { cancelled = true; };
  }, [conversationParam, messageParam, notificationAction, user?.id, refresh, router]);
  const [creationOpen, setCreationOpen] = useState(false);
  const [kind, setKind] = useState<"private" | "group" | "channel">("private");
  const [isPublic, setIsPublic] = useState(false);
  const [title, setTitle] = useState("");
  const [personQuery, setPersonQuery] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [searchPeople, setSearchPeople] = useState<Person[]>([]);
  const [searchPeopleLoading, setSearchPeopleLoading] = useState(false);
  const [chosen, setChosen] = useState<Person[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [publicChannelsOpen, setPublicChannelsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [statusAuthorIds, setStatusAuthorIds] = useState<Set<string>>(new Set());
  const [statusUnreadAuthorIds, setStatusUnreadAuthorIds] = useState<Set<string>>(new Set());
  const [requestedStatusAuthor, setRequestedStatusAuthor] = useState<string | null>(null);
  const [requestedStatusId, setRequestedStatusId] = useState<string | null>(null);
  const [statusReturnTab, setStatusReturnTab] = useState<Tab | null>(null);
  const [unreadNewsCount, setUnreadNewsCount] = useState(0);
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<MessengerCapabilities | null>(null);
  const filterStorageKey = user?.id ? `spv_messenger_filter_v1:${user.id}` : "";
  useEffect(() => {
    if (!user?.id || !inviteParam || handledInvite.current === inviteParam) return;
    handledInvite.current = inviteParam;
    void api.post<Conversation>(`/messenger/invites/${encodeURIComponent(inviteParam)}/join`, {})
      .then(joined => {
        setSelected(joined);
        setTab("Échanges");
        setActionError("");
        void refresh();
        router.replace("/messenger" as any);
      })
      .catch((e: any) => {
        setActionError(e?.detail || "Le lien d’invitation ne fonctionne plus.");
        router.replace("/messenger" as any);
      });
  }, [inviteParam, user?.id, refresh, router]);
  const refreshStatusAuthors = useCallback(async () => {
    if (!user?.id) {
      setStatusAuthorIds(new Set());
      setStatusUnreadAuthorIds(new Set());
      return;
    }
    try {
      const rows = await api.get<ChatStatus[]>("/messenger/statuses");
      setStatusAuthorIds(new Set(rows.map(status => status.author_id)));
      setStatusUnreadAuthorIds(new Set(rows.filter(status => status.author_id !== user.id && !status.viewed_by_me).map(status => status.author_id)));
    } catch {
      setStatusAuthorIds(new Set());
      setStatusUnreadAuthorIds(new Set());
    }
  }, [user?.id]);
  useEffect(() => { void refreshStatusAuthors(); }, [refreshStatusAuthors, feedVersion]);
  useEffect(() => {
    if (!user?.id) { setUnreadNewsCount(0); return; }
    let active = true;
    api.get<{ count: number }>("/messenger/feed/unread-count")
      .then(result => { if (active) setUnreadNewsCount(result.count || 0); })
      .catch(() => { if (active) setUnreadNewsCount(0); });
    return () => { active = false; };
  }, [user?.id, feedVersion]);
  useEffect(() => {
    if (!user?.id) { setFilter("Tous"); setFilterReadyFor(null); return; }
    let active = true;
    const userId = user.id;
    const key = `spv_messenger_filter_v1:${userId}`;
    setFilter("Tous");
    setFilterReadyFor(null);
    void storage.getItem<string>(key, "Tous").then(saved => {
      if (!active) return;
      setFilter(filters.find(option => option === saved) || "Tous");
      setFilterReadyFor(userId);
    });
    return () => { active = false; };
  }, [user?.id]);
  useEffect(() => {
    if (user?.id && filterReadyFor === user.id) void storage.setItem(filterStorageKey, filter);
  }, [filter, filterReadyFor, filterStorageKey, user?.id]);
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
  useEffect(() => {
    const q = query.trim();
    if (!searchOpen || q.length < 2) { setSearchPeople([]); setSearchPeopleLoading(false); return; }
    let current = true;
    setSearchPeopleLoading(true);
    const timer = setTimeout(() => messengerApi.people(q)
      .then(result => current && setSearchPeople(result.filter(person => person.id !== user?.id)))
      .catch((e: any) => current && setActionError(e?.detail || "Recherche de membres impossible."))
      .finally(() => current && setSearchPeopleLoading(false)), 250);
    return () => { current = false; clearTimeout(timer); };
  }, [query, searchOpen, user?.id]);
  const visible = useMemo(() => items.filter(item => {
    const matchesFilter = ((filter === "Tous" || filter === "Messages privés") && item.kind === "private")
      || (filter === "Groupes" && item.kind === "group")
      || (filter === "Canaux" && item.kind === "channel");
    const q = query.trim().toLowerCase();
    return matchesFilter && (!q || item.title.toLowerCase().includes(q) || item.last_message?.text?.toLowerCase().includes(q));
  }).sort((a, b) => Number(b.pinned) - Number(a.pinned) || new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()), [items, filter, query]);

  const closeSearch = () => {
    setSearchOpen(false);
    setQuery("");
    setSearchPeople([]);
  };
  const openSearch = () => {
    setQuery("");
    setSearchPeople([]);
    setSearchOpen(true);
  };
  const goHome = () => {
    navTransition.toHome(() => router.replace("/account-access?source=chat" as any));
  };
  const createPrivate = (person: Person) => {
    setBusy(true); setActionError("");
    return messengerApi.createConversation({ kind: "private", member_ids: [person.id] }).then(result => {
      setSelected(result); setCreationOpen(false); setChosen([]); setPersonQuery(""); setSearchOpen(false); setQuery(""); setTab("Échanges"); refresh();
    }).catch((e: any) => setActionError(e?.detail || "Conversation impossible à créer.")).finally(() => setBusy(false));
  };
  const replyToStatus = async (authorId: string, text: string, statusId: string, voice?: Blob) => {
    const conversation = await messengerApi.createConversation({ kind: "private", member_ids: [authorId] });
    const attachments = voice ? [await messengerApi.file(
      conversation.id,
      new File([voice], `reponse-statut-${Date.now()}.${voice.type.includes("ogg") ? "ogg" : voice.type.includes("mp4") ? "m4a" : "webm"}`, {
        type: voice.type || "audio/webm",
      }),
    )] : [];
    await messengerApi.send(conversation.id, {
      text,
      attachments,
      status_reply_id: statusId,
      client_id: `status-reply-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
    await refresh();
  };
  const openSpvUser = useCallback(async (rawUsername: string) => {
    const username = normalizeSpvUsername(rawUsername);
    if (username.length < 2) return;
    setBusy(true);
    setActionError("");
    try {
      const rows = await messengerApi.people(`SPV@${username}`);
      const person = rows.find(item => item.username.toLocaleLowerCase() === username.toLocaleLowerCase() && item.id !== user?.id);
      if (!person) throw new Error(`Aucun membre ne correspond à SPV@${username}.`);
      const conversation = await messengerApi.createConversation({ kind: "private", member_ids: [person.id] });
      setSelected(conversation);
      setTab("Échanges");
      setSearchOpen(false);
      setQuery("");
      await refresh();
    } catch (e: any) {
      setActionError(e?.detail || e?.message || "Impossible d’ouvrir cette conversation.");
    } finally {
      setBusy(false);
    }
  }, [refresh, user?.id]);
  useEffect(() => {
    if (!user?.id || !directUsernameParam || inviteParam || handledUserLink.current === directUsernameParam) return;
    handledUserLink.current = directUsernameParam;
    let active = true;
    void openSpvUser(directUsernameParam).finally(() => {
      if (active) router.replace("/messenger" as any);
    });
    return () => { active = false; };
  }, [directUsernameParam, inviteParam, openSpvUser, router, user?.id]);
  const saveContactAndConversation = async (person: Person) => {
    setBusy(true); setActionError("");
    try {
      await api.post(`/messenger/contacts/${encodeURIComponent(person.id)}`);
      const conversation = await messengerApi.createConversation({ kind: "private", member_ids: [person.id] });
      const pinned = await messengerApi.patchConversation(conversation.id, { pinned: true });
      setSelected(pinned); setCreationOpen(false); setSearchOpen(false); setQuery(""); setPersonQuery("");
      setTab("Échanges"); await refresh();
    } catch (e: any) { setActionError(e?.detail || "Impossible d’enregistrer le contact et la discussion."); }
    finally { setBusy(false); }
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
    if (initial !== "private") {
      setFilter(initial === "group" ? "Groupes" : "Canaux");
      setCreationOpen(false);
      setMenuOpen(false);
      setActionError("");
      return;
    }
    setKind(initial); setTitle(""); setChosen([]); setIsPublic(false); setPersonQuery(""); setCreationOpen(true); setMenuOpen(false); setActionError("");
  };
  const togglePerson = (person: Person) => setChosen(old => {
    if (old.some(p => p.id === person.id)) return old.filter(p => p.id !== person.id);
    if (old.length >= 199) { setActionError("Un groupe ou canal peut compter au maximum 200 membres, vous compris."); return old; }
    return [...old, person];
  });
  const openJoinedChannel = (conversation: Conversation) => {
    setPublicChannelsOpen(false); setSelected(conversation); setTab("Échanges"); chooseFilter("Canaux"); refresh();
  };
  const runPreference = async (item: Conversation, key: "muted" | "archived" | "pinned") => {
    try { await messengerApi.patchConversation(item.id, { [key]: !item[key] }); await refresh(); }
    catch (e: any) { setActionError(e?.detail || "Mise à jour impossible."); }
  };
  const unreadConversationCount = (name: Filter) => items.filter(item =>
    item.unread > 0 && (
      (name === "Tous" && item.kind === "private") ||
      (name === "Messages privés" && item.kind === "private") ||
      (name === "Groupes" && item.kind === "group") ||
      (name === "Canaux" && item.kind === "channel")
    )
  ).length;
  const chooseFilter = (name: Filter) => {
    setFilter(name);
    if (user?.id) void storage.setItem(`spv_messenger_filter_v1:${user.id}`, name);
  };
  const openStatusFor = (authorId: string, statusId?: string) => {
    setStatusReturnTab(tab === "Actus" ? null : tab);
    setRequestedStatusAuthor(authorId);
    setRequestedStatusId(statusId || null);
    if (tab !== "Actus") setTab("Actus");
  };
  const closeRequestedStatus = () => {
    if (statusReturnTab) setTab(statusReturnTab);
    setStatusReturnTab(null);
    setRequestedStatusAuthor(null);
    setRequestedStatusId(null);
    void refreshStatusAuthors();
  };
  const renderConversation = (item: Conversation, onSelect?: () => void) => {
    const preview = item.last_message?.deleted ? "Message supprimé" : item.last_message?.text || item.draft || (item.last_message?.attachments?.length ? "Pièce jointe" : "");
    const otherPerson = item.is_saved
      ? item.member_profiles.find(person => person.id === user?.id)
      : item.member_profiles.find(person => person.id !== user?.id);
    const photo = item.photo || (item.kind === "private" ? otherPerson?.avatar : undefined);
    const statusAuthorId = item.kind === "private" && !item.is_saved ? otherPerson?.id : undefined;
    const hasActiveStatus = !!statusAuthorId && statusAuthorIds.has(statusAuthorId);
    const hasUnreadStatus = !!statusAuthorId && statusUnreadAuthorIds.has(statusAuthorId);
    const openConversation = () => onSelect ? onSelect() : setSelected(item);
    return <TouchableOpacity
      key={item.id}
      style={[styles.conversationRow, selected?.id === item.id && styles.rowSelected]}
      onPress={openConversation}
      activeOpacity={0.82}
      accessibilityRole="button"
      accessibilityLabel={`Ouvrir la conversation ${item.title}`}
      testID={`messenger-conversation-${item.id}`}
    >
      <View style={[styles.avatarRing, hasActiveStatus && (hasUnreadStatus ? styles.avatarRingUnread : styles.avatarRingSeen)]}>
        <TouchableOpacity style={[styles.rowAvatar, hasActiveStatus && styles.rowAvatarInside]} onPress={event => {
          event.stopPropagation();
          if (hasActiveStatus && statusAuthorId) openStatusFor(statusAuthorId);
          else if (photo) setPhotoPreview({ uri: photo, label: item.title });
        }} disabled={!photo && !hasActiveStatus} activeOpacity={0.8} accessibilityRole={photo || hasActiveStatus ? "button" : undefined} accessibilityLabel={hasActiveStatus ? `Voir le statut de ${item.title}` : photo ? `Afficher la photo de ${item.title}` : `Profil de ${item.title}`} testID={`messenger-conversation-avatar-${item.id}`}>
          {photo ? <Image source={{ uri: photo }} style={[styles.rowPhoto, hasActiveStatus && styles.rowPhotoInside]} /> : <Text style={styles.rowAvatarLetter}>{item.title.slice(0, 1).toUpperCase()}</Text>}
          {item.kind === "private" && otherPerson?.online && <View style={styles.onlineDot} />}
        </TouchableOpacity>
      </View>
      <View style={styles.rowMain}>
        <View style={styles.rowTop}>
          <View style={styles.rowOpenTitle}>
            <Text style={styles.rowTitle} numberOfLines={1}>{item.title}</Text>
            <Text style={styles.rowTime}>{item.last_message?.created_at ? new Date(item.last_message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</Text>
          </View>
          <View style={styles.rowControls}>
            <TouchableOpacity onPress={event => { event.stopPropagation(); void runPreference(item, "pinned"); }} hitSlop={8} accessibilityRole="button" accessibilityLabel={item.pinned ? "Désenregistrer la discussion" : "Enregistrer la discussion"} testID={`messenger-pin-${item.id}`}><Ionicons name={item.pinned ? "bookmark" : "bookmark-outline"} size={16} color={item.pinned ? blue : muted} /></TouchableOpacity>
            <TouchableOpacity onPress={event => { event.stopPropagation(); setRowMenu(rowMenu === item.id ? null : item.id); }} hitSlop={8} accessibilityLabel="Autres options de la discussion"><Ionicons name="ellipsis-horizontal" size={16} color={muted} /></TouchableOpacity>
          </View>
        </View>
        <View style={styles.rowOpenPreview}>
          <View style={styles.rowBottom}><Text style={[styles.preview, !!item.draft && !item.last_message?.text && styles.draftText]} numberOfLines={1}>{item.draft && !item.last_message?.text ? "Brouillon : " : ""}{preview}</Text>
            <View style={styles.rowMarkers}>{item.muted && <Ionicons name="notifications-off" size={13} color="#9ba4b3" />}{item.pinned && <Ionicons name="pin" size={13} color={blue} />}{item.unread > 0 && <View style={styles.unread} accessibilityLabel={`${item.unread} messages non lus`} testID={`messenger-conversation-unread-${item.id}`}><Text style={styles.unreadText}>{item.unread > 999 ? "999+" : item.unread}</Text></View>}</View>
          </View>
        </View>
        {rowMenu === item.id && <View style={styles.rowQuickActions}>
          <TouchableOpacity onPress={event => { event.stopPropagation(); void runPreference(item, "pinned"); }}><Text style={styles.quickText}>{item.pinned ? "Désépingler" : "Épingler"}</Text></TouchableOpacity>
          <TouchableOpacity onPress={event => { event.stopPropagation(); void runPreference(item, "muted"); }}><Text style={styles.quickText}>{item.muted ? "Activer le son" : "Sourdine"}</Text></TouchableOpacity>
          <TouchableOpacity onPress={event => { event.stopPropagation(); void runPreference(item, "archived"); }}><Text style={styles.quickText}>{item.archived ? "Restaurer" : "Archiver"}</Text></TouchableOpacity>
        </View>}
      </View>
    </TouchableOpacity>;
  };
  const chatList = <View style={[styles.listPanel, wide && styles.wideList, appearance === "dark" && { backgroundColor: "#111827" }]}>
    <LinearGradient colors={["#063ba8", "#0057ee"]} style={styles.header}>
      <View pointerEvents="none" style={styles.goldSwoop} testID="messenger-header-gold-swoop">
        <Svg width="100%" height="100%" viewBox="0 0 575 94" preserveAspectRatio="none">
          <Defs>
            <SvgLinearGradient
              id="messenger-header-panel-gradient"
              gradientUnits="userSpaceOnUse"
              x1="315"
              y1="47"
              x2="575"
              y2="47"
            >
              <Stop offset="0" stopColor="#003ea3" />
              <Stop offset=".4" stopColor="#033ea6" />
              <Stop offset=".52" stopColor="#0040ab" />
              <Stop offset="1" stopColor="#004cbf" />
            </SvgLinearGradient>
            <SvgLinearGradient
              id="messenger-header-gold-gradient"
              x1="0"
              y1="0"
              x2="0"
              y2="94"
              gradientUnits="userSpaceOnUse"
            >
              <Stop offset="0" stopColor="#d7e0eb" />
              <Stop offset=".18" stopColor="#d7d8c8" />
              <Stop offset=".36" stopColor="#ead79b" />
              <Stop offset=".62" stopColor="#e2bd68" />
              <Stop offset="1" stopColor="#d2a13d" />
            </SvgLinearGradient>
          </Defs>
          <Path
            d="M 315 94 C 342 91 354 74 374 54 C 400 28 425 20 455 10 C 468 6 480 2 490 0 L 575 0 L 575 94 Z"
            fill="url(#messenger-header-panel-gradient)"
          />
          <Path
            d="M 315 94 C 342 91 354 74 374 54 C 400 28 425 20 455 10 C 421 21 405 31 382 54 C 362 74 352 94 325 94 Z"
            fill="url(#messenger-header-gold-gradient)"
          />
        </Svg>
      </View>
      <TouchableOpacity onPress={goHome} style={styles.brand} accessibilityLabel="Retourner à SPILOVEURE">
        <Image source={logo} style={styles.logo} resizeMode="contain" />
        <View><Text style={styles.brandTitle}>SPILOVEURE</Text><Text style={styles.brandSub}>Chat</Text></View>
      </TouchableOpacity>
      <TouchableOpacity onPress={openSearch} style={styles.headerIcon} testID="messenger-search-toggle" accessibilityLabel="Rechercher"><Ionicons name="search" size={23} color="#fff" /></TouchableOpacity>
      <TouchableOpacity onPress={() => setMenuOpen(true)} style={styles.headerIcon}><Ionicons name="ellipsis-vertical" size={21} color="#fff" /></TouchableOpacity>
    </LinearGradient>
    <View style={styles.filters} testID="messenger-filter-row">
       {filters.map(name => {
         const disabledFeature = name === "Groupes" || name === "Canaux";
         const unread = disabledFeature ? 0 : unreadConversationCount(name);
         return <TouchableOpacity key={name} onPress={() => chooseFilter(name)} style={[styles.filter, name === "Messages privés" && styles.filterPrivate, filter === name && styles.filterActive]} accessibilityRole="button" accessibilityState={{ selected: filter === name }} accessibilityLabel={`${name}${unread ? `, ${unread} conversation${unread > 1 ? "s" : ""} non lue${unread > 1 ? "s" : ""}` : ""}`} testID={`messenger-filter-${name}`}>
           <Text style={[styles.filterText, filter === name && styles.filterActiveText, disabledFeature && styles.filterSoon]}>{name}</Text>
          {unread > 0 && <View style={styles.filterBadge} testID={`messenger-filter-unread-${name}`}><Text style={styles.filterBadgeText}>{unread > 99 ? "99+" : unread}</Text></View>}
        </TouchableOpacity>;
      })}
    </View>
    {filter === "Canaux" && capabilities?.public_channels !== false && <TouchableOpacity onPress={() => setPublicChannelsOpen(true)} style={styles.discoverChannels} testID="messenger-channel-discovery" accessibilityLabel="Découvrir les canaux publics"><Ionicons name="compass-outline" size={17} color={blue} /><Text style={styles.discoverText}>Découvrir les canaux publics</Text></TouchableOpacity>}
    {archived && <View style={styles.archiveBanner}><Text style={styles.archiveText}>Conversations archivées</Text><TouchableOpacity onPress={() => setArchived(false)}><Text style={styles.quickText}>Retour</Text></TouchableOpacity></View>}
    {actionError ? <TouchableOpacity onPress={() => setActionError("")} style={styles.errorBanner}><Text style={styles.errorText}>{actionError}  ×</Text></TouchableOpacity> : null}
    {(filter === "Groupes" || filter === "Canaux") ? <View style={styles.featureSoon} testID={`messenger-${filter.toLowerCase()}-coming-soon`}>
      <View style={styles.emptyCircle}><Ionicons name={filter === "Groupes" ? "people-outline" : "megaphone-outline"} size={28} color={blue} /></View>
      <Text style={styles.emptyTitle}>Bientôt disponible</Text>
      <Text style={styles.emptyCopy}>Nous préparons les {filter.toLowerCase()}. Pour le moment, les messages privés sont disponibles.</Text>
      <TouchableOpacity onPress={() => chooseFilter("Messages privés")} style={styles.emptyButton}><Text style={styles.emptyButtonText}>Voir les messages privés</Text></TouchableOpacity>
    </View> : loading ? <View style={styles.loading}><View style={styles.skeleton} /><View style={styles.skeleton} /><View style={styles.skeleton} /></View>
      : error ? <TouchableOpacity onPress={refresh} style={styles.emptyState}><Ionicons name="cloud-offline-outline" size={30} color={blue} /><Text style={styles.emptyTitle}>{error}</Text><Text style={styles.emptyLink}>Réessayer</Text></TouchableOpacity>
         : visible.length ? <ScrollView contentContainerStyle={{ paddingBottom: 92 }}>{visible.map(item => renderConversation(item))}</ScrollView>
         : <View style={styles.emptyState}><View style={styles.emptyCircle}><Ionicons name="chatbubbles-outline" size={30} color={blue} /></View><Text style={styles.emptyTitle}>{query ? "Aucun échange trouvé" : archived ? "Aucune conversation archivée" : "Aucune conversation pour le moment"}</Text><Text style={styles.emptyCopy}>{query ? "Essayez un autre nom." : "Commencez une conversation avec un membre SPILOVEURE."}</Text><TouchableOpacity onPress={() => openCreate()} style={styles.emptyButton}><Text style={styles.emptyButtonText}>Nouveau message</Text></TouchableOpacity></View>}
    <TouchableOpacity style={styles.fab} onPress={() => openCreate()} accessibilityLabel="Nouvelle conversation"><Ionicons name="add" size={31} color="#fff" /></TouchableOpacity>
  </View>;

  const navItems: { key: Tab; icon: any; label: string }[] = [
    { key: "Échanges", icon: "chatbubbles", label: "Échanges" }, { key: "Contacts", icon: "people", label: "Contacts" },
    { key: "Actus", icon: "megaphone", label: "Actus" }, { key: "Profil", icon: "person", label: "Profil" },
  ];
  if (!logoutMarkerChecked || explicitlyLoggedOut || chatLoading || !user) return <View style={styles.page}><View style={styles.emptyState}><View style={styles.loading}><View style={styles.skeleton} /><View style={styles.skeleton} /><View style={styles.skeleton} /></View><Text style={styles.emptyCopy}>Connexion sécurisée au Chat…</Text></View></View>;
  return <View style={[
    styles.page,
    appearance === "dark" && { backgroundColor: "#0b1220" },
    Platform.OS === "web" && webViewport && {
      position: "fixed",
      top: webViewport.top,
      left: 0,
      right: 0,
      width: "100%",
      height: webViewport.height,
      minHeight: 0,
      flex: 0,
      overflow: "hidden",
    } as any,
  ]}>
    <View style={[styles.workspace, selected && styles.workspaceThread, wide && styles.workspaceWide]}>
      {tab === "Échanges" ? <>
        {(!selected || wide) && chatList}
          {selected ? <ConversationThread key={selected.id} conversation={selected} userId={user?.id || ""} focusMessageId={selectedMessageConversationId === selected.id ? selectedMessageId || undefined : undefined} focusComposer={notificationReplyTarget === selected.id} onBack={() => { setSelected(null); setSelectedMessageId(null); setSelectedMessageConversationId(null); }} onChanged={refresh} onDetails={() => setDetailsOpen(true)} onViewPhoto={(uri, label) => setPhotoPreview({ uri, label })} onOpenUsername={openSpvUser} hasActiveStatus={selected.kind === "private" && !selected.is_saved && selected.members.some(id => id !== user?.id && statusAuthorIds.has(id))} onOpenStatus={(statusAuthorId, statusId) => { const authorId = statusAuthorId || selected.members.find(id => id !== user?.id && statusAuthorIds.has(id)); if (authorId) openStatusFor(authorId, statusId); }} version={version} typing={typingByConversation[selected.id]} scheduledEnabled={capabilities?.scheduled_messages !== false} readReceipts={readReceipts[selected.id]} /> : null}
        {!selected && wide ? <View style={styles.welcome}><Image source={logo} style={styles.welcomeLogo} resizeMode="contain" /><Text style={styles.welcomeTitle}>SPILOVEURE Chat</Text><Text style={styles.welcomeText}>Vos échanges de communauté, au même endroit.</Text></View> : null}
         </> : tab === "Contacts" ? <ContactsPanel onStart={createPrivate} onSave={saveContactAndConversation} /> : tab === "Actus" ? <FeedPanel userId={user?.id || ""} version={feedVersion} requestedStatusAuthor={requestedStatusAuthor} requestedStatusId={requestedStatusId} onStatusRequestConsumed={() => { setRequestedStatusAuthor(null); setRequestedStatusId(null); }} onStatusViewerClose={closeRequestedStatus} onUnreadCount={setUnreadNewsCount} onStatusReply={replyToStatus} /> : <ProfilePanel user={user} onOpenContacts={() => setTab("Contacts")} onOpenChats={() => setTab("Échanges")} onAppearanceChange={setAppearance} onReduceMotionChange={setReduceMotion} />}
    </View>
    {!selected && !navTransition.active && <View style={styles.bottomDock}>
      <View style={styles.bottomBar}>
       {navItems.slice(0, 2).map(item => <TouchableOpacity key={item.key} style={styles.navItem} onPress={() => { setTab(item.key); setSelected(null); }} testID={`messenger-tab-${item.key}`}><Ionicons name={item.icon} size={24} color={tab === item.key ? blue : "#9ca8b8"} /><Text style={[styles.navLabel, tab === item.key && styles.navActive]}>{item.label}</Text></TouchableOpacity>)}
        <TouchableOpacity style={styles.centerLogoWrap} onPress={goHome} accessibilityLabel="Retour à l’accueil"><View style={styles.centerLogo}><Image source={logo} style={styles.centerLogoImage} resizeMode="contain" /></View></TouchableOpacity>
       {navItems.slice(2).map(item => <TouchableOpacity key={item.key} style={styles.navItem} onPress={() => { setTab(item.key); setSelected(null); }} testID={`messenger-tab-${item.key}`} accessibilityLabel={item.key === "Actus" && unreadNewsCount ? `Statuts, ${unreadNewsCount} actualités officielles non lues` : item.label}>
         <View style={styles.navIconWrap}><Ionicons name={item.icon} size={23} color={tab === item.key ? blue : "#9ca8b8"} />
           {item.key === "Actus" && unreadNewsCount > 0 && <View style={styles.newsBadge} testID="messenger-official-news-unread"><Text style={styles.newsBadgeText}>{unreadNewsCount > 99 ? "99+" : unreadNewsCount}</Text></View>}
         </View>
         <Text style={[styles.navLabel, tab === item.key && styles.navActive]}>{item.label}</Text>
       </TouchableOpacity>)}
      </View>
    </View>}
    {detailsOpen && selected && <ConversationDetails conversation={selected} userId={user?.id || ""} onClose={() => setDetailsOpen(false)} onChanged={() => { refresh(); messengerApi.conversation(selected.id).then(setSelected).catch(() => setSelected(null)); }} />}
    <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
      <TouchableOpacity style={styles.menuBackdrop} activeOpacity={1} onPress={() => setMenuOpen(false)}><View style={styles.menu}>
        <TouchableOpacity onPress={() => openCreate("private")} style={styles.menuRow}><Ionicons name="chatbubble-outline" size={19} color={blue} /><Text style={styles.menuText}>Nouveau message</Text></TouchableOpacity>
         <TouchableOpacity onPress={() => openCreate("group")} style={styles.menuRow} testID="messenger-create-group"><Ionicons name="people-outline" size={19} color={muted} /><Text style={[styles.menuText, styles.menuSoon]}>Groupes · bientôt disponible</Text></TouchableOpacity>
         <TouchableOpacity onPress={() => openCreate("channel")} style={styles.menuRow}><Ionicons name="megaphone-outline" size={19} color={muted} /><Text style={[styles.menuText, styles.menuSoon]}>Canaux · bientôt disponible</Text></TouchableOpacity>
         <TouchableOpacity onPress={() => { setFilter("Canaux"); setMenuOpen(false); }} style={styles.menuRow} testID="messenger-channel-discovery-menu"><Ionicons name="compass-outline" size={19} color={muted} /><Text style={[styles.menuText, styles.menuSoon]}>Découvrir les canaux · bientôt</Text></TouchableOpacity>
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
          return <TouchableOpacity key={person.id} onPress={() => kind === "private" ? createPrivate(person) : togglePerson(person)} style={styles.personChoice}><View style={styles.rowAvatar}>{person.avatar ? <Image source={{ uri: person.avatar }} style={styles.rowPhoto} /> : <Text style={styles.rowAvatarLetter}>{person.username.slice(0, 1).toUpperCase()}</Text>}</View><Text style={[styles.choiceName, { flex: 1 }]}>{person.username}</Text>{kind === "private" ? <Ionicons name="chevron-forward" size={18} color={muted} /> : <Ionicons name={selectedPerson ? "checkmark-circle" : "ellipse-outline"} size={21} color={selectedPerson ? blue : muted} />}</TouchableOpacity>;
        })}{personQuery.trim().length >= 2 && !people.length ? <Text style={styles.emptyCopy}>Aucun membre trouvé.</Text> : null}</ScrollView>
        {kind !== "private" && <TouchableOpacity disabled={busy || !title.trim() || (kind === "group" && chosen.length === 0)} onPress={createConversation} style={[styles.createButton, (busy || !title.trim() || (kind === "group" && chosen.length === 0)) && { opacity: .45 }]} testID={kind === "group" ? "messenger-create-group-submit" : "messenger-create-channel-submit"}>{busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.createButtonText}>{kind === "group" ? "Créer le groupe" : "Créer le canal"}</Text>}</TouchableOpacity>}
        {kind === "private" && <Text style={styles.createHint}>Saisissez au moins deux caractères pour rechercher un membre.</Text>}
        {!!actionError && <Text style={styles.errorText}>{actionError}</Text>}
      </View></View>
    </Modal>
    <PublicChannelsModal visible={publicChannelsOpen} onClose={() => setPublicChannelsOpen(false)} onJoined={openJoinedChannel} />
    <ProfilePhotoViewer photo={photoPreview} onClose={() => setPhotoPreview(null)} />
    <Modal visible={searchOpen} animationType="slide" onRequestClose={closeSearch}>
      <View style={styles.searchModalPage} testID="messenger-search-modal">
        <View style={styles.searchModalHeader}>
          <TouchableOpacity onPress={closeSearch} style={styles.searchClose} accessibilityLabel="Fermer la recherche">
            <Ionicons name="arrow-back" size={22} color={ink} />
          </TouchableOpacity>
          <View style={styles.searchModalField}>
            <Ionicons name="search" size={18} color={muted} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Rechercher un membre ou une discussion"
              autoFocus
              autoCapitalize="none"
              returnKeyType="search"
              style={styles.searchModalInput}
              testID="messenger-global-search"
            />
            {!!query && <TouchableOpacity onPress={() => setQuery("")} accessibilityLabel="Effacer la recherche"><Ionicons name="close-circle" size={19} color={muted} /></TouchableOpacity>}
          </View>
        </View>
        {query.trim().length < 2
          ? <View style={styles.searchModalEmpty}><Ionicons name="search-outline" size={27} color={blue} /><Text style={styles.searchModalHint}>Saisissez au moins deux caractères.</Text></View>
          : <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.searchModalResults}>
            {!!visible.length && <>
              <Text style={styles.memberSearchTitle}>Discussions</Text>
              {visible.slice(0, 20).map(item => renderConversation(item, () => {
                setSelected(item);
                setTab("Échanges");
                closeSearch();
              }))}
            </>}
            <Text style={styles.memberSearchTitle}>Membres SPILOVEURE</Text>
            {searchPeopleLoading ? <ActivityIndicator color={blue} style={{ padding: 14 }} /> : searchPeople.length
              ? searchPeople.slice(0, 10).map(person => <View key={person.id} style={styles.memberSearchRow}>
                <TouchableOpacity onPress={() => { void createPrivate(person); }} style={styles.memberSearchIdentity} accessibilityRole="button" accessibilityLabel={`Ouvrir la discussion avec ${person.username}`} testID={`messenger-search-person-${person.id}`}>
                  <View style={styles.searchAvatar}>{person.avatar ? <Image source={{ uri: person.avatar }} style={styles.searchPhoto} /> : <Text style={styles.searchAvatarText}>{person.username.slice(0, 1).toUpperCase()}</Text>}</View>
                  <Text style={styles.memberSearchName} numberOfLines={1}>{person.username}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => { void createPrivate(person); }} style={styles.searchAction} accessibilityLabel={`Discuter avec ${person.username}`}><Ionicons name="chatbubble-outline" size={18} color={blue} /></TouchableOpacity>
                <TouchableOpacity onPress={() => { void saveContactAndConversation(person); closeSearch(); }} style={styles.searchAction} accessibilityLabel={`Enregistrer ${person.username} et épingler la discussion`}><Ionicons name="bookmark-outline" size={18} color={blue} /></TouchableOpacity>
              </View>)
              : <Text style={styles.memberSearchEmpty}>{visible.length ? "Aucun autre membre correspondant." : "Aucun membre ni discussion ne correspond."}</Text>}
          </ScrollView>}
      </View>
    </Modal>
  </View>;
}

const styles = StyleSheet.create({
  page: { flex: 1, minHeight: "100%", backgroundColor: chatVisual.canvas },
  workspace: { flex: 1, minHeight: 0, paddingBottom: 84 },
  workspaceThread: { paddingBottom: 0 },
  workspaceWide: { width: "100%", maxWidth: 1280, alignSelf: "center", flexDirection: "row", borderLeftWidth: 1, borderRightWidth: 1, borderColor: chatVisual.border },
  listPanel: { flex: 1, minHeight: 0, backgroundColor: chatVisual.paper, position: "relative" },
  wideList: { flexGrow: 0, flexShrink: 0, flexBasis: 390, width: 390, borderRightWidth: 1, borderColor: chatVisual.border },
  header: { height: 76, flexDirection: "row", alignItems: "center", paddingHorizontal: 17, gap: 8, borderBottomWidth: 1, borderColor: "#1d70ed", overflow: "hidden", position: "relative" },
  goldSwoop: { ...StyleSheet.absoluteFillObject, zIndex: 0, opacity: .95 },
  brand: { flex: 1, flexDirection: "row", alignItems: "center", gap: 11 }, logo: { width: 48, height: 48, borderRadius: 26, backgroundColor: "#0649b5" }, brandTitle: { color: "#fff", fontSize: 16, fontWeight: "900", letterSpacing: .35 }, brandSub: { color: "#f5dfad", fontSize: 13, fontWeight: "700", marginTop: 1, letterSpacing: .2 },
  headerIcon: { width: 42, height: 42, alignItems: "center", justifyContent: "center", borderRadius: 13, backgroundColor: "rgba(255,255,255,.1)" },
  filters: { flexGrow: 0, flexShrink: 0, minHeight: 58, flexDirection: "row", alignItems: "center", paddingHorizontal: 11, backgroundColor: chatVisual.paper, borderBottomWidth: 1, borderColor: chatVisual.border },
  searchModalPage: { flex: 1, backgroundColor: chatVisual.canvas },
  searchModalHeader: { minHeight: 68, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, backgroundColor: chatVisual.paper, borderBottomWidth: 1, borderColor: chatVisual.border },
  searchClose: { width: 38, height: 42, alignItems: "center", justifyContent: "center" },
  searchModalField: { flex: 1, minWidth: 0, height: 44, flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 14, borderRadius: 14, backgroundColor: "#f2f5f9", borderWidth: 1, borderColor: chatVisual.border },
  searchModalInput: { flex: 1, minWidth: 0, color: ink, fontSize: 14, outlineStyle: "none" as any },
  searchModalEmpty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 24 },
  searchModalHint: { color: muted, fontSize: 13 },
  searchModalResults: { paddingHorizontal: 16, paddingBottom: 30, backgroundColor: chatVisual.paper },
  memberSearchTitle: { color: muted, fontSize: 10, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase", paddingVertical: 10 },
  memberSearchRow: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: 8, borderBottomWidth: 1, borderColor: chatVisual.border },
  memberSearchIdentity: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 9, paddingVertical: 4 },
  searchAvatar: { width: 34, height: 34, borderRadius: 18, backgroundColor: "#e7effd", alignItems: "center", justifyContent: "center" }, searchAvatarText: { color: blue, fontWeight: "900" },
  searchPhoto: { width: 34, height: 34, borderRadius: 18 },
  memberSearchName: { flex: 1, color: ink, fontSize: 13, fontWeight: "800" }, searchAction: { width: 34, height: 34, alignItems: "center", justifyContent: "center", borderRadius: 17, backgroundColor: "#eef4ff" },
  memberSearchEmpty: { color: muted, fontSize: 12, paddingVertical: 10 },
  discoverChannels: { marginHorizontal: 14, marginTop: 10, marginBottom: 5, minHeight: 40, borderRadius: 12, backgroundColor: "#f1f6ff", borderWidth: 1, borderColor: "#e1eafb", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7 }, discoverText: { color: blue, fontSize: 12, fontWeight: "800" },
  filter: { flex: 1, flexBasis: 0, minWidth: 0, minHeight: 38, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, borderRadius: 11, marginHorizontal: 2, paddingHorizontal: 4, paddingVertical: 7, backgroundColor: "#f2f5f9" }, filterPrivate: { flexGrow: 1.55 }, filterActive: { backgroundColor: blue }, filterText: { flexShrink: 1, textAlign: "center", color: "#34445f", fontSize: 11, fontWeight: "700" }, filterActiveText: { color: "#fff" }, filterSoon: { color: "#8692a6" },
  filterBadge: { flexShrink: 0, minWidth: 17, height: 17, borderRadius: 9, paddingHorizontal: 4, alignItems: "center", justifyContent: "center", backgroundColor: "#e34252" }, filterBadgeText: { color: "#fff", fontSize: 10, fontWeight: "900", lineHeight: 13 },
  conversationRow: { minHeight: 82, minWidth: 0, flexDirection: "row", alignItems: "center", paddingHorizontal: 16, borderBottomWidth: 1, borderColor: "#edf0f4", gap: 13, backgroundColor: chatVisual.paper }, rowSelected: { backgroundColor: "#f1f6ff" },
  avatarRing: { width: 54, height: 54, alignItems: "center", justifyContent: "center" }, avatarRingUnread: { width: 60, height: 60, borderRadius: 30, padding: 2, borderWidth: 2, borderColor: "#13b981" }, avatarRingSeen: { width: 60, height: 60, borderRadius: 30, padding: 2, borderWidth: 2, borderColor: "#f2a934" },
  rowAvatar: { width: 54, height: 54, borderRadius: 29, backgroundColor: "#e7effd", alignItems: "center", justifyContent: "center", position: "relative" }, rowAvatarInside: { width: 50, height: 50, borderRadius: 25 }, rowPhoto: { width: 54, height: 54, borderRadius: 28 }, rowPhotoInside: { width: 50, height: 50, borderRadius: 25 }, rowAvatarLetter: { color: blue, fontSize: 22, fontWeight: "900" }, onlineDot: { position: "absolute", width: 13, height: 13, borderRadius: 7, backgroundColor: "#1bb779", bottom: -1, right: 0, borderWidth: 2, borderColor: "#fff" },
  rowOpenTitle: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 7 }, rowControls: { flexShrink: 0, flexDirection: "row", alignItems: "center", gap: 10 }, rowOpenPreview: { flex: 1, minWidth: 0 },
   rowMain: { flex: 1, minWidth: 0 }, rowTop: { minWidth: 0, flexDirection: "row", alignItems: "center", gap: 7 }, rowTitle: { flex: 1, flexShrink: 1, minWidth: 0, color: "#17263f", fontSize: 14, fontWeight: "800" }, rowTime: { flexShrink: 0, color: "#8994a5", fontSize: 10 }, rowBottom: { flexDirection: "row", alignItems: "center", marginTop: 5, gap: 8 }, preview: { flex: 1, color: "#748198", fontSize: 12 }, draftText: { color: "#4f78b8" }, rowMarkers: { flexDirection: "row", alignItems: "center", gap: 5 }, unread: { minWidth: 21, height: 21, borderRadius: 11, paddingHorizontal: 6, alignItems: "center", justifyContent: "center", backgroundColor: blue }, unreadText: { color: "#fff", fontSize: 10, fontWeight: "800" },
  rowQuickActions: { flexDirection: "row", gap: 12, paddingTop: 5, opacity: .82 }, quickText: { color: blue, fontSize: 10, fontWeight: "700" },
  fab: { position: "absolute", right: 19, bottom: 18, width: 54, height: 54, borderRadius: 18, backgroundColor: blue, alignItems: "center", justifyContent: "center", elevation: 5, shadowColor: "#0d4dac", shadowOffset: { width: 0, height: 3 }, shadowOpacity: .2, shadowRadius: 8 },
  loading: { padding: 18, gap: 14 }, skeleton: { height: 68, borderRadius: 18, backgroundColor: "#edf2f8" }, emptyState: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 28 }, featureSoon: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 28, backgroundColor: chatVisual.paper }, emptyCircle: { width: 62, height: 62, borderRadius: 32, backgroundColor: "#eaf1ff", alignItems: "center", justifyContent: "center" }, emptyTitle: { color: ink, fontSize: 16, fontWeight: "800", textAlign: "center", marginTop: 13 }, emptyCopy: { color: muted, fontSize: 13, lineHeight: 19, textAlign: "center", marginTop: 7, maxWidth: 300 }, emptyLink: { color: blue, fontSize: 13, fontWeight: "800", marginTop: 10 }, emptyButton: { marginTop: 17, backgroundColor: blue, borderRadius: 12, paddingVertical: 11, paddingHorizontal: 17 }, emptyButtonText: { color: "#fff", fontSize: 13, fontWeight: "800" },
  bottomDock: { position: "absolute", left: 12, right: 12, bottom: 10, zIndex: 5 }, bottomBar: { height: 68, borderRadius: 19, backgroundColor: chatVisual.paper, borderWidth: 1, borderColor: "#e1e7ef", shadowColor: "#244067", shadowOffset: { width: 0, height: 4 }, shadowOpacity: .08, shadowRadius: 13, flexDirection: "row", alignItems: "center", justifyContent: "space-around", paddingHorizontal: 4 },
  navItem: { flex: 1, alignItems: "center", justifyContent: "center", gap: 2 }, navIconWrap: { width: 29, height: 26, alignItems: "center", justifyContent: "center", position: "relative" }, newsBadge: { position: "absolute", right: -9, top: -6, minWidth: 16, height: 16, paddingHorizontal: 4, borderRadius: 9, backgroundColor: "#e3444b", alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#fff" }, newsBadgeText: { color: "#fff", fontSize: 9, fontWeight: "900" }, navLabel: { color: "#9ca8b8", fontSize: 10, fontWeight: "700" }, navActive: { color: blue }, centerLogoWrap: { width: 67, alignItems: "center", marginTop: -21 }, centerLogo: { width: 58, height: 58, borderRadius: 30, backgroundColor: "#fff", borderWidth: 4, borderColor: "#fff", elevation: 5, alignItems: "center", justifyContent: "center", shadowColor: blue, shadowOffset: { width: 0, height: 4 }, shadowOpacity: .2, shadowRadius: 8 }, centerLogoImage: { width: 52, height: 52, borderRadius: 27 },
  welcome: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#f3f6fa" }, welcomeLogo: { height: 75, width: 75, borderRadius: 40 }, welcomeTitle: { color: ink, fontSize: 20, fontWeight: "900", marginTop: 12 }, welcomeText: { color: muted, fontSize: 13, marginTop: 6 },
  menuBackdrop: { flex: 1, backgroundColor: "rgba(5,15,34,.16)" }, menu: { position: "absolute", right: 11, top: 74, width: 242, backgroundColor: chatVisual.paper, borderRadius: 16, padding: 7, borderWidth: 1, borderColor: chatVisual.border, shadowColor: "#11243e", shadowOffset: { width: 0, height: 6 }, shadowOpacity: .16, shadowRadius: 16, elevation: 8 }, menuRow: { minHeight: 46, flexDirection: "row", alignItems: "center", gap: 11, paddingHorizontal: 10, borderRadius: 10 }, menuText: { color: ink, fontWeight: "700", fontSize: 13 }, menuSoon: { color: muted, fontSize: 11 },
  publicToggle: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: 9, marginBottom: 8 }, publicTitle: { color: ink, fontSize: 13, fontWeight: "800" }, publicHelp: { color: muted, fontSize: 11, marginTop: 2 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(13,24,42,.38)", justifyContent: "flex-end" }, createSheet: { backgroundColor: chatVisual.paper, borderTopLeftRadius: 22, borderTopRightRadius: 22, maxHeight: "86%", paddingHorizontal: 20, paddingTop: 18, paddingBottom: 24 }, sheetTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }, sheetTitle: { color: ink, fontSize: 19, fontWeight: "800" }, createInput: { backgroundColor: "#f3f6fa", borderWidth: 1, borderColor: chatVisual.border, borderRadius: 12, paddingHorizontal: 13, height: 46, marginBottom: 10, color: ink, outlineStyle: "none" as any }, selectedLine: { color: blue, fontSize: 12, fontWeight: "700", paddingBottom: 9 }, personChoice: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: 10, borderBottomWidth: 1, borderColor: "#edf0f4" }, choiceName: { color: ink, fontSize: 14, fontWeight: "700" }, createButton: { backgroundColor: blue, borderRadius: 13, height: 46, alignItems: "center", justifyContent: "center", marginTop: 14 }, createButtonText: { color: "#fff", fontSize: 14, fontWeight: "800" }, createHint: { color: muted, textAlign: "center", fontSize: 12, marginTop: 13 }, errorText: { color: "#c33", fontSize: 12, padding: 8 }, archiveBanner: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 14, paddingVertical: 11, backgroundColor: "#eef4ff" }, archiveText: { color: ink, fontWeight: "800", fontSize: 13 }, errorBanner: { backgroundColor: "#fff0ef", padding: 8 },
});
