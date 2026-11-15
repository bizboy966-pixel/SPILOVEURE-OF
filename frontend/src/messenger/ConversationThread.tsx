import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Keyboard, Linking, Modal, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { createMemoryAdapter, EmojiKeyboard, type CategoryTypes } from "@softwhere-uz/react-native-emoji-keyboard";
import { api } from "@/src/api";
import { messengerApi } from "./api";
import { protectedFileUrl } from "./api";
import type { Attachment, ContactState, Conversation, Message, Person, ReadReceipts } from "./types";
import ScheduledMessages from "./ScheduledMessages";
import { openProtectedAttachment, ProtectedAttachmentViewer, type AttachmentPreview } from "./ProtectedAttachmentViewer";
import MediaComposer from "./MediaComposer";
import ProtectedMessageMedia from "./ProtectedMessageMedia";
import SwipeToReply from "@/src/components/SwipeToReply";
import VoiceMessage from "@/src/components/VoiceMessage";
import { chatProfileUrl } from "./userLinks";

type Props = {
  conversation: Conversation; userId: string; onBack: () => void; onChanged: () => void;
  onDetails: () => void; onViewPhoto: (uri: string, label: string) => void; onOpenUsername?: (username: string) => void;
  hasActiveStatus?: boolean; onOpenStatus?: (authorId?: string, statusId?: string) => void;
  version: number; typing?: { username?: string }; scheduledEnabled?: boolean;
  readReceipts?: ReadReceipts;
};
const blue = "#1769e8", ink = "#102042", muted = "#7d879a";
const logo = require("../../assets/images/spiloveure-logo.png");
const emojiStorage = createMemoryAdapter();
const emojiTranslation: Record<CategoryTypes, string> = {
  smileys_emotion: "Visages",
  people_body: "Personnes",
  animals_nature: "Animaux et nature",
  food_drink: "Nourriture",
  travel_places: "Voyages",
  activities: "Activités",
  objects: "Objets",
  symbols: "Symboles",
  flags: "Drapeaux",
  favorites: "Favoris",
  recently_used: "Récents",
  search: "Recherche",
};
const makeId = () => typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const messageKey = (message: Message) => message.client_id ? `client:${message.sender_id}:${message.client_id}` : `id:${message.id}`;
const composerHeightFor = (value: string, contentWidth: number) => {
  const charsPerLine = Math.max(12, Math.floor(contentWidth / 8.5));
  const lines = value.split("\n").reduce((total, line) => total + Math.max(1, Math.ceil(Array.from(line).length / charsPerLine)), 0);
  return Math.min(176, Math.max(42, lines * 22 + 18));
};
function mergeMessages(existing: Message[], incoming: Message[]) {
  const byKey = new Map<string, Message>();
  existing.forEach(message => byKey.set(messageKey(message), message));
  incoming.forEach(message => byKey.set(messageKey(message), message));
  return [...byKey.values()].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
}

function ProtectedVoicePlayer({ file, own }: { file: Attachment; own: boolean }) {
  const [src, setSrc] = useState("");
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    let url = "";
    protectedFileUrl(file.id).then(value => {
      url = value;
      if (active) setSrc(value);
      else URL.revokeObjectURL(value);
    }).catch(() => { if (active) setError(true); });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.id]);
  if (error) return <Text style={styles.fileLabel}>Vocal indisponible</Text>;
  if (!src) return <ActivityIndicator size="small" color={blue} />;
  return <VoiceMessage src={src} tint={own ? "own" : "other"} testID={`messenger-voice-${file.id}`} />;
}

export default function ConversationThread({ conversation, userId, onBack, onChanged, onDetails, onViewPhoto, onOpenUsername, hasActiveStatus, onOpenStatus, version, typing, scheduledEnabled = true, readReceipts }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  useEffect(() => {
    if (!readReceipts) return;
    setMessages(previous => previous.map(message => ({
      ...message,
      read_by: [...new Set([
        ...(message.read_by || []),
        ...Object.entries(readReceipts).filter(([, stamp]) => stamp >= message.created_at).map(([uid]) => uid),
      ])],
    })));
  }, [readReceipts]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [messageError, setMessageError] = useState("");
  const [attachmentPreview, setAttachmentPreview] = useState<AttachmentPreview | null>(null);
  const [pendingMedia, setPendingMedia] = useState<File[] | null>(null);
  const [text, setText] = useState(conversation.draft || "");
  const [composerInputHeight, setComposerInputHeight] = useState(42);
  const [composerSelection, setComposerSelection] = useState({ start: (conversation.draft || "").length, end: (conversation.draft || "").length });
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [composerActionsOpen, setComposerActionsOpen] = useState(false);
  const [reply, setReply] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [historyQuery, setHistoryQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [forwarding, setForwarding] = useState<Message | null>(null);
  const [targets, setTargets] = useState<Conversation[]>([]);
  const [recording, setRecording] = useState(false);
  const [voiceSending, setVoiceSending] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [failedIds, setFailedIds] = useState<string[]>([]);
  const [sharingContact, setSharingContact] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [silent, setSilent] = useState(false);
  const [shareContacts, setShareContacts] = useState<Person[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const discardRecording = useRef(false);
  const sendRecordingAfterStop = useRef(false);
  const sendVoiceRef = useRef<(blob: Blob) => Promise<void>>(async () => {});
  const scroll = useRef<ScrollView>(null);
  const nearBottom = useRef(true);
  const initialScrollPending = useRef(true);
  const saveDraft = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftValue = useRef(conversation.draft || "");
  const draftQueue = useRef<Promise<void>>(Promise.resolve());
  const retries = useRef<Record<string, () => Promise<Message>>>({});
  const lastVersion = useRef(version);
  const lastTypingAt = useRef(0);
  const composerInput = useRef<TextInput>(null);
  const composerTextWidth = useRef(190);
  const changeDraft = (value: string) => {
    draftValue.current = value;
    setText(value);
    setComposerInputHeight(composerHeightFor(value, composerTextWidth.current));
  };
  const beginReply = (message: Message) => {
    setReply(message);
    setExpanded(null);
    setEmojiPickerOpen(false);
    requestAnimationFrame(() => composerInput.current?.focus());
  };

  const loadMessages = async (q?: string, mode: "replace" | "merge" = "replace") => {
    setLoading(true);
    try {
      const result = await messengerApi.messages(conversation.id, undefined, q);
      setMessages(previous => mode === "merge" ? mergeMessages(previous, result.items) : result.items);
      if (mode === "merge") {
        const resolved = new Set(result.items.filter(message => message.sender_id === userId).map(message => message.client_id).filter(Boolean));
        setFailedIds(previous => previous.filter(id => !resolved.has(id)));
        resolved.forEach(id => { if (id) delete retries.current[id]; });
      }
      setMore(result.has_more);
      setMessageError("");
    } catch (e: any) { setMessageError(e?.detail || "Impossible de charger l’historique."); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    setMessages([]);
    loadMessages();
  // The thread belongs to a conversation id; text is intentionally not a fetch dependency.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id]);
  useEffect(() => {
    if (lastVersion.current !== version) {
      lastVersion.current = version;
      loadMessages(undefined, "merge");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  useEffect(() => {
    if (saveDraft.current) clearTimeout(saveDraft.current);
    const snapshot = text;
    const enqueueSnapshot = () => {
      draftQueue.current = draftQueue.current
        .catch(() => {})
        .then(async () => {
          if (draftValue.current !== snapshot) return;
          await messengerApi.patchConversation(conversation.id, { draft: snapshot });
        })
        .catch(() => {});
    };
    saveDraft.current = setTimeout(() => {
      saveDraft.current = null;
      enqueueSnapshot();
    }, 450);
    return () => {
      if (saveDraft.current) {
        clearTimeout(saveDraft.current);
        saveDraft.current = null;
        enqueueSnapshot();
      }
    };
  }, [text, conversation.id]);
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setRecordSeconds(v => v + 1), 1000);
    return () => clearInterval(timer);
  }, [recording]);
  useEffect(() => () => {
    recorder.current?.state === "recording" && recorder.current.stop();
    streamRef.current?.getTracks().forEach(track => track.stop());
  }, []);
  const read = () => api.post(`/messenger/conversations/${encodeURIComponent(conversation.id)}/read`).catch(() => {});
  useEffect(() => { if (!loading) read(); }, [loading, conversation.id]);
  const fetchOlder = async () => {
    const oldest = messages[0];
    if (!oldest || !more) return;
    try {
      const result = await messengerApi.messages(conversation.id, oldest.id);
      setMessages(prev => mergeMessages(prev, result.items)); setMore(result.has_more);
    } catch (e: any) { setMessageError(e?.detail || "Impossible de charger les anciens messages."); }
  };
  const send = async (extra: Partial<{ attachments: Attachment[]; forwarded_from: string; text: string }> = {}) => {
    const content = (extra.text ?? text).trim();
    if (!canSend || (!content && !extra.attachments?.length)) return;
    nearBottom.current = true;
    const client_id = makeId(), silentSend = silent;
    const optimistic: Message = {
      id: `pending:${client_id}`, client_id, conversation_id: conversation.id, sender_id: userId,
      sender_name: "Vous", text: content, created_at: new Date().toISOString(), deleted: false,
      attachments: extra.attachments || [], reactions: {}, pinned: false, read_by: [], reply_to: reply?.id,
      forwarded_from: extra.forwarded_from,
    };
    setMessages(prev => [...prev, optimistic]); changeDraft(""); setReply(null);
    const transmit = async () => messengerApi.send(conversation.id, {
      text: content, client_id, attachments: extra.attachments, reply_to: optimistic.reply_to,
      forwarded_from: extra.forwarded_from, silent: silentSend || undefined,
    });
    setSilent(false);
    retries.current[client_id] = transmit;
    try {
      const sent = await transmit();
      setMessages(prev => prev.map(m => m.client_id === client_id ? sent : m)); onChanged();
      delete retries.current[client_id];
    } catch {
      setFailedIds(prev => prev.includes(client_id) ? prev : [...prev, client_id]);
    }
  };
  const updateComposer = (value: string) => {
    changeDraft(value);
    setEmojiPickerOpen(false);
    if (value.trim() && Date.now() - lastTypingAt.current > 1800) {
      lastTypingAt.current = Date.now();
      api.post(`/messenger/conversations/${encodeURIComponent(conversation.id)}/typing`).catch(() => {});
    }
  };
  const handleHistoryContentSizeChange = () => {
    if (!initialScrollPending.current && !nearBottom.current) return;
    scroll.current?.scrollToEnd({ animated: !initialScrollPending.current });
    initialScrollPending.current = false;
    nearBottom.current = true;
  };
  const handleHistoryScroll = (event: any) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    nearBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 90;
  };
  const insertEmoji = (emoji: string) => {
    const current = draftValue.current;
    const start = Math.max(0, Math.min(composerSelection.start, current.length));
    const end = Math.max(start, Math.min(composerSelection.end, current.length));
    const next = `${current.slice(0, start)}${emoji}${current.slice(end)}`;
    const cursor = start + emoji.length;
    setComposerSelection({ start: cursor, end: cursor });
    updateComposer(next);
    setEmojiPickerOpen(true);
  };
  const toggleEmojiPicker = () => {
    if (emojiPickerOpen) {
      setEmojiPickerOpen(false);
      requestAnimationFrame(() => composerInput.current?.focus());
      return;
    }
    Keyboard.dismiss();
    composerInput.current?.blur();
    setEmojiPickerOpen(true);
  };
  const retrySend = async (clientId: string) => {
    const retry = retries.current[clientId];
    if (!retry) return;
    setFailedIds(prev => prev.filter(id => id !== clientId));
    try {
      const sent = await retry();
      setMessages(prev => prev.map(m => m.client_id === clientId ? sent : m));
      delete retries.current[clientId]; onChanged();
    } catch { setFailedIds(prev => [...prev, clientId]); }
  };
  const action = async (message: Message, kind: string, body?: any) => {
    if (kind === "delete" && typeof window !== "undefined" && !window.confirm("Supprimer ce message ?")) return;
    const root = `/messenger/conversations/${encodeURIComponent(conversation.id)}/messages/${encodeURIComponent(message.id)}`;
    try {
      let updated: Message | undefined;
      if (kind === "edit") updated = await messengerApiPatch(root, body);
      if (kind === "delete") await fetchAction(root, "DELETE");
      if (kind === "reaction") updated = await fetchAction(`${root}/reaction`, "POST", body);
      if (kind === "pin") updated = await fetchAction(`${root}/pin`, "POST");
      if (kind === "edit" && updated) setMessages(prev => prev.map(m => m.id === message.id ? updated! : m));
      else if (kind === "delete") setMessages(prev => prev.map(m => m.id === message.id ? { ...m, deleted: true, text: "", attachments: [] } : m));
      else if (updated) setMessages(prev => prev.map(m => m.id === message.id ? updated! : m));
      setExpanded(null);
      return true;
    } catch (e: any) { if (typeof window !== "undefined") window.alert(e?.detail || "Action impossible."); return false; }
  };
  const messengerApiPatch = async (path: string, body: any) => {
    return api.patch<Message>(path, body);
  };
  const fetchAction = async (path: string, method: string, body?: any) => {
    if (method === "DELETE") return api.delete(path);
    return api.post<Message>(path, body);
  };
  const openAttachment = async (file: Attachment) => {
    try {
      await openProtectedAttachment(file, setAttachmentPreview);
    } catch (e: any) { if (typeof window !== "undefined") window.alert(e.message); }
  };
  const attachFile = () => {
    if (!canSend || typeof document === "undefined") return;
    const input = document.createElement("input"); input.type = "file"; input.multiple = true;
    input.accept = "image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.zip,.txt";
    input.onchange = async () => {
      const files = Array.from(input.files || []);
      if (files.some(file => file.type.startsWith("image/") || file.type.startsWith("video/"))) {
        setPendingMedia(files);
        return;
      }
      try {
        const attached: Attachment[] = [];
        for (const file of files) {
          if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name} dépasse 20 Mo.`);
          attached.push(await messengerApi.file(conversation.id, file));
        }
        await send({ attachments: attached });
      } catch (e: any) { window.alert(e?.detail || e.message || "Envoi du fichier impossible."); }
    };
    input.click();
  };
  const sendSelectedMedia = async (files: File[], caption: string) => {
    const attached: Attachment[] = [];
    for (const file of files) {
      if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name} dépasse 20 Mo.`);
      attached.push(await messengerApi.file(conversation.id, file));
    }
    await send({ attachments: attached, text: caption });
    setPendingMedia(null);
  };
  const sendVoiceBlob = async (blob: Blob) => {
    setVoiceSending(true);
    try {
      const mime = blob.type || "audio/webm";
      const extension = mime.includes("ogg") ? ".ogg" : mime.includes("mp4") ? ".m4a" : mime.includes("mpeg") ? ".mp3" : ".webm";
      const file = new File([blob], `message-vocal-${Date.now()}${extension}`, { type: mime });
      if (file.size > 20 * 1024 * 1024) throw new Error("Le message vocal dépasse 20 Mo.");
      const attachment = await messengerApi.file(conversation.id, file);
      await send({ attachments: [attachment], text: "" });
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert(e?.detail || e?.message || "Envoi vocal impossible.");
    } finally { setVoiceSending(false); }
  };
  sendVoiceRef.current = sendVoiceBlob;
  const voice = async () => {
    if (!canSend) return;
    if (recording) {
      sendRecordingAfterStop.current = true;
      recorder.current?.stop();
      setRecording(false);
      return;
    }
    if (voiceSending) return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      if (typeof window !== "undefined") window.alert("L’enregistrement vocal n’est pas disponible sur ce navigateur.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); streamRef.current = stream;
      const supportedTypes = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
      const mimeType = supportedTypes.find(type => MediaRecorder.isTypeSupported(type));
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined); const chunks: BlobPart[] = [];
      rec.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      discardRecording.current = false;
      rec.onstop = () => {
        const recordedType = rec.mimeType || chunks.find(chunk => chunk instanceof Blob)?.type || "audio/webm";
        if (!discardRecording.current && sendRecordingAfterStop.current) {
          sendRecordingAfterStop.current = false;
          void sendVoiceRef.current(new Blob(chunks, { type: recordedType }));
        }
        stream.getTracks().forEach(t => t.stop());
      };
      recorder.current = rec; setRecordSeconds(0); setRecording(true); rec.start();
    } catch { if (typeof window !== "undefined") window.alert("Autorisez le microphone pour enregistrer."); }
  };
  const forward = async (target: Conversation) => {
    if (!forwarding) return;
    try { await messengerApi.send(target.id, { text: forwarding.text, client_id: makeId(), attachments: forwarding.attachments, forwarded_from: forwarding.id }); setForwarding(null); onChanged(); }
    catch (e: any) { window.alert(e?.detail || "Transfert impossible."); }
  };
  const openContactShare = async () => {
    setSharingContact(true); setContactsLoading(true);
    try {
      const state = await api.get<ContactState>("/messenger/contacts");
      setShareContacts(state.contacts || []);
    } catch (e: any) {
      setShareContacts([]);
      if (typeof window !== "undefined") window.alert(e?.detail || "Impossible de charger les contacts.");
    } finally { setContactsLoading(false); }
  };
  const shareContact = async (person: Person) => {
    if (!canSend) return;
    try {
      const message = await messengerApi.send(conversation.id, {
        text: `Contact SPILOVEURE : SPV@${person.username}\n${chatProfileUrl(person.username)}`,
        client_id: makeId(),
      });
      setMessages(previous => mergeMessages(previous, [message]));
      setSharingContact(false);
      onChanged();
    } catch (e: any) { if (typeof window !== "undefined") window.alert(e?.detail || "Partage du contact impossible."); }
  };
  const openUrl = (url: string) => {
    if (Platform.OS === "web" && typeof window !== "undefined") window.open(url, "_blank", "noopener,noreferrer");
    else Linking.openURL(url).catch(() => {});
  };
  const renderText = (content: string) => content.split(/(https?:\/\/[^\s]+|SPV@[^\s.,!?;:()[\]{}<>]+)/gi).map((part, index) => {
    if (/^https?:\/\//i.test(part)) {
      return <Text key={`${index}-${part}`} style={styles.linkText} onPress={() => openUrl(part)}>{part}</Text>;
    }
    const handle = part.match(/^SPV@(.+)$/i);
    return handle
      ? <Text key={`${index}-${part}`} style={styles.linkText} onPress={() => onOpenUsername?.(handle[1])}>{part}</Text>
      : <Text key={`${index}-${part}`}>{part}</Text>;
  });
  const otherPerson = conversation.member_profiles.find(person => person.id !== userId);
  const otherPhoto = (conversation.is_saved
    ? conversation.member_profiles.find(person => person.id === userId)?.avatar
    : otherPerson?.avatar) || conversation.photo;
  const isChannelAdmin = conversation.admins.includes(userId) || conversation.owner_id === userId;
  const canSend = conversation.kind !== "channel" || isChannelAdmin;
  const presence = conversation.is_saved ? "Votre espace privé" : otherPerson?.online ? "En ligne" : otherPerson?.last_seen
    ? `Vu ${new Date(otherPerson.last_seen).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}`
    : conversation.kind === "private" ? "Membre SPILOVEURE" : `${conversation.member_profiles.length} membres`;

  return (
    <View style={styles.thread}>
      <View style={styles.threadHead}>
        <TouchableOpacity onPress={onBack} style={styles.back} accessibilityLabel="Retour aux conversations" testID="messenger-back"><Ionicons name="arrow-back" size={23} color={blue} /></TouchableOpacity>
        <View style={styles.identity}>
          <TouchableOpacity onPress={() => hasActiveStatus ? onOpenStatus?.() : otherPhoto ? onViewPhoto(otherPhoto, conversation.title) : onDetails()} style={[styles.avatar, hasActiveStatus && styles.avatarStoryRing]} accessibilityRole="button" accessibilityLabel={hasActiveStatus ? `Voir le statut de ${conversation.title}` : otherPhoto ? `Afficher la photo de ${conversation.title}` : `Détails de ${conversation.title}`} testID="messenger-thread-avatar">
            {otherPhoto ? <Image source={{ uri: otherPhoto }} style={[styles.avatarPhoto, hasActiveStatus && styles.avatarPhotoStory]} /> : <Text style={styles.avatarText}>{conversation.title.slice(0, 1).toUpperCase()}</Text>}
          </TouchableOpacity>
          <TouchableOpacity onPress={onDetails} style={styles.identityText} activeOpacity={0.75} accessibilityRole="button">
            <Text style={styles.name} numberOfLines={1}>{conversation.title}</Text><Text style={[styles.presence, typing && styles.typing]}>{typing ? `${typing.username || "Quelqu’un"} écrit…` : presence}</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity style={styles.headerIcon} onPress={() => setSearching(v => !v)}><Ionicons name="search" size={21} color={blue} /></TouchableOpacity>
        {canSend && scheduledEnabled && <TouchableOpacity style={styles.headerIcon} onPress={() => setScheduleOpen(true)} accessibilityLabel="Messages programmés" testID="messenger-scheduled-open"><Ionicons name="calendar-outline" size={20} color={blue} /></TouchableOpacity>}
        <TouchableOpacity style={styles.headerIcon} onPress={onDetails}><Ionicons name="ellipsis-vertical" size={20} color={blue} /></TouchableOpacity>
      </View>
      {searching && <View style={styles.searchRow}><TextInput value={historyQuery} onChangeText={setHistoryQuery} placeholder="Rechercher dans l’historique" style={styles.searchInput} onSubmitEditing={() => loadMessages(historyQuery)} /><TouchableOpacity onPress={() => loadMessages(historyQuery)}><Ionicons name="search" size={20} color={blue} /></TouchableOpacity></View>}
      <ScrollView ref={scroll} style={styles.history} contentContainerStyle={styles.historyContent} onContentSizeChange={handleHistoryContentSizeChange} onScroll={handleHistoryScroll} scrollEventThrottle={100}>
        {more && <TouchableOpacity onPress={fetchOlder} style={styles.older}><Text style={styles.olderText}>Charger les messages précédents</Text></TouchableOpacity>}
        {messageError ? <TouchableOpacity onPress={() => loadMessages(historyQuery || undefined)} style={styles.historyError}><Text style={styles.historyErrorText}>{messageError} · Réessayer</Text></TouchableOpacity> : null}
        {loading ? <ActivityIndicator color={blue} /> : messages.length === 0 && !messageError ? <View style={styles.empty}><Text style={styles.emptyTitle}>Votre conversation commence ici</Text><Text style={styles.emptyText}>Envoyez un message à {conversation.title}.</Text></View> : null}
        {messages.map(message => {
          const own = message.sender_id === userId;
          const quoted = message.reply_to ? messages.find(item => item.id === message.reply_to) : undefined;
          const bubble = <View style={[styles.bubble, own ? styles.ownBubble : styles.otherBubble]}>
              {!own && <Text style={styles.sender}>{message.sender_name}</Text>}
              {message.deleted ? <Text style={styles.deleted}>Message supprimé</Text> : <>
                {message.forwarded_from && <Text style={styles.forwarded}>Message transféré</Text>}
                {!!message.reply_to && <View style={styles.replyQuote} testID={`messenger-reply-quote-${message.id}`}>
                  <Text style={styles.replyQuoteSender}>{quoted?.sender_name || "Message précédent"}</Text>
                  <Text numberOfLines={2} style={styles.replyQuotePreview}>{quoted?.deleted ? "Message supprimé" : quoted?.text || quoted?.attachments?.[0]?.name || "Pièce jointe"}</Text>
                </View>}
                {message.status_reply && <View style={styles.statusReplyCard} testID={`messenger-status-reply-${message.id}`}>
                  <TouchableOpacity style={styles.statusReplyHeader} onPress={() => onOpenStatus?.(message.status_reply?.author_id, message.status_reply?.status_id)} accessibilityRole="button" accessibilityLabel={`Revoir le statut de ${message.status_reply.author_name}`}>
                    <View style={styles.statusReplyCopy}>
                      <Text style={styles.statusReplyTitle}>Statut de {message.status_reply.author_name}</Text>
                      <Text numberOfLines={2} style={styles.statusReplyText}>{message.status_reply.text || (message.status_reply.attachments?.length ? "Photo du statut" : "Statut")}</Text>
                    </View>
                    <Ionicons name="arrow-forward" size={15} color={blue} />
                  </TouchableOpacity>
                  {!!message.status_reply.attachments?.length && <View style={styles.statusReplyMedia}>
                    {message.status_reply.attachments.slice(0, 1).map(file =>
                      <ProtectedMessageMedia key={file.id} file={file} compact onOpen={() => openAttachment(file)} />)}
                  </View>}
                </View>}
                {!!message.attachments?.some(file => file.mime.startsWith("image/") || file.mime.startsWith("video/")) && <View style={[styles.mediaGroup, own && styles.ownAttachment]}>
                  {message.attachments.filter(file => file.mime.startsWith("image/") || file.mime.startsWith("video/")).map(file =>
                    <ProtectedMessageMedia key={file.id} file={file} compact={message.attachments.length > 1} onOpen={() => openAttachment(file)} />)}
                </View>}
                {!!message.text && <Text style={styles.messageText}>{renderText(message.text)}</Text>}
                {message.attachments?.filter(file => file.mime.startsWith("audio/")).map(file =>
                  <View key={file.id} style={[styles.voiceCard, own && styles.ownAttachment]}><ProtectedVoicePlayer file={file} own={own} /></View>)}
                {message.attachments?.filter(file => !file.mime.startsWith("audio/") && !file.mime.startsWith("image/") && !file.mime.startsWith("video/")).map(file =>
                  <TouchableOpacity key={file.id} onPress={() => openAttachment(file)} style={[styles.fileChip, own && styles.ownAttachment]}>
                    <Ionicons name="document-outline" size={17} color={blue} />
                    <Text style={styles.fileLabel} numberOfLines={1}>{file.name}</Text><Ionicons name="download-outline" size={16} color={blue} />
                  </TouchableOpacity>)}
              </>}
              <View style={styles.meta}><Text style={styles.time}>{new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{message.edited_at ? " · modifié" : ""}</Text>{own && (() => {
                const peers = conversation.members.filter(memberId => memberId !== userId);
                const read = peers.length > 0 && peers.every(peerId => message.read_by?.includes(peerId));
                const delivered = peers.some(peerId => message.delivered_by?.includes(peerId));
                return <Text style={[styles.receipt, delivered && styles.receiptDelivered, read && styles.receiptRead]} accessibilityLabel={read ? "Lu" : delivered ? "Distribué" : "Envoyé"}>{read || delivered ? "✓✓" : "✓"}</Text>;
              })()}
                {message.client_id && failedIds.includes(message.client_id) && <TouchableOpacity onPress={() => retrySend(message.client_id!)}><Text style={styles.retryText}>Réessayer</Text></TouchableOpacity>}
                <TouchableOpacity onPress={() => setExpanded(expanded === message.id ? null : message.id)} accessibilityLabel="Actions du message" testID={`messenger-message-menu-${message.id}`}><Ionicons name="ellipsis-horizontal" size={16} color={muted} /></TouchableOpacity>
              </View>
              {Object.entries(message.reactions || {}).filter(([, ids]) => ids.length).map(([emoji, ids]) => <Text key={emoji} style={styles.reaction}>{emoji} {ids.length}</Text>)}
              {expanded === message.id && <View style={styles.actions}>
                <TouchableOpacity onPress={() => beginReply(message)} testID={`messenger-message-reply-${message.id}`}><Text style={styles.actionText}>Répondre</Text></TouchableOpacity>
                <TouchableOpacity onPress={() => action(message, "reaction", { emoji: "👍" })} testID={`messenger-message-react-${message.id}`}><Text style={styles.actionText}>👍</Text></TouchableOpacity>
                <TouchableOpacity onPress={() => { setForwarding(message); messengerApi.conversations().then(setTargets).catch(() => setTargets([])); setExpanded(null); }} testID={`messenger-message-forward-${message.id}`}><Text style={styles.actionText}>Transférer</Text></TouchableOpacity>
                {(conversation.kind === "private" || isChannelAdmin) && <TouchableOpacity onPress={() => action(message, "pin")} testID={`messenger-message-pin-${message.id}`}><Text style={styles.actionText}>{message.pinned ? "Désépingler" : "Épingler"}</Text></TouchableOpacity>}
                {own && <TouchableOpacity onPress={() => { setEditing(message); changeDraft(message.text); setExpanded(null); }} testID={`messenger-message-edit-${message.id}`}><Text style={styles.actionText}>Modifier</Text></TouchableOpacity>}
                {(own || isChannelAdmin) && <TouchableOpacity onPress={() => action(message, "delete")} testID={`messenger-message-delete-${message.id}`}><Text style={[styles.actionText, { color: "#d33" }]}>Supprimer</Text></TouchableOpacity>}
              </View>}
            </View>;
          return <View key={message.id} style={[styles.bubbleWrap, own && styles.ownWrap]}>
            {!message.deleted
              ? <SwipeToReply direction="left" onReply={() => beginReply(message)}><View style={[styles.swipeMessage, own && styles.swipeMessageOwn]} testID={`messenger-swipe-reply-${message.id}`}>{bubble}</View></SwipeToReply>
              : bubble}
          </View>;
        })}
      </ScrollView>
      {reply && <View style={styles.replyBanner} testID="messenger-reply-preview">
        <View style={styles.replyBannerCopy}><Text style={styles.replyBannerLabel}>Réponse à {reply.sender_name}</Text><Text numberOfLines={1} style={styles.replyBannerText}>{reply.deleted ? "Message supprimé" : reply.text || reply.attachments?.[0]?.name || "Pièce jointe"}</Text></View>
        <TouchableOpacity onPress={() => setReply(null)} accessibilityLabel="Annuler la réponse"><Ionicons name="close" size={19} color={blue} /></TouchableOpacity>
      </View>}
      {editing && <View style={styles.replyBanner}><Text style={styles.replyBannerText}>Modification du message</Text><TouchableOpacity onPress={() => { setEditing(null); changeDraft(""); }}><Ionicons name="close" size={19} color={blue} /></TouchableOpacity></View>}
      {(recording || voiceSending) && <View style={styles.recordStatus}><View style={styles.recordDot} /><Text style={styles.recordText}>{recording ? `Enregistrement · ${recordSeconds}s` : "Envoi du vocal…"}</Text>{recording && <TouchableOpacity onPress={() => { discardRecording.current = true; sendRecordingAfterStop.current = false; recorder.current?.state === "recording" && recorder.current.stop(); streamRef.current?.getTracks().forEach(t => t.stop()); setRecording(false); }}><Text style={styles.cancelText}>Annuler</Text></TouchableOpacity>}</View>}
      {!canSend && <View style={styles.readOnly}><Ionicons name="eye-outline" size={17} color={muted} /><Text style={styles.readOnlyText}>Lecture seule · seuls les administrateurs peuvent publier dans ce canal.</Text></View>}
      {canSend && emojiPickerOpen && <View style={styles.emojiPickerPanel} testID="messenger-emoji-picker">
        <EmojiKeyboard
          onEmojiSelected={item => insertEmoji(item.emoji)}
          enableRecentlyUsed
          storage={emojiStorage}
          enableSearchBar
          categoryPosition="top"
          defaultHeight={420}
          hideHeader
          disableSafeArea
          colorScheme="light"
          translation={emojiTranslation}
          theme={{
            container: "#ffffff",
            header: "#ffffff",
            category: { icon: "#64748b", iconActive: blue, container: "#f3f6fb", containerActive: "#e3efff" },
            search: { background: "#f2f5f9", text: ink, placeholder: muted, icon: muted },
            emoji: { selected: "#e3efff" },
          }}
        />
      </View>}
      <View style={styles.composer}>
        <TouchableOpacity onPress={toggleEmojiPicker} style={styles.composerIcon} accessibilityLabel={emojiPickerOpen ? "Revenir au clavier pour écrire" : "Choisir un emoji"} testID="messenger-emoji-toggle"><Ionicons name={emojiPickerOpen ? "keypad-outline" : "happy-outline"} size={23} color={blue} /></TouchableOpacity>
        <View
          style={styles.inputShell}
          onLayout={event => {
            const width = Math.max(100, event.nativeEvent.layout.width - 58);
            if (Math.abs(width - composerTextWidth.current) > 4) {
              composerTextWidth.current = width;
              setComposerInputHeight(composerHeightFor(draftValue.current, width));
            }
          }}
        >
          <TextInput
            ref={composerInput}
            value={text}
            onChangeText={updateComposer}
            onFocus={() => setEmojiPickerOpen(false)}
            onSelectionChange={event => setComposerSelection(event.nativeEvent.selection)}
            selection={composerSelection}
            editable={canSend}
            placeholder={canSend ? "Message" : "Lecture seule"}
            multiline
            blurOnSubmit={false}
            scrollEnabled={composerInputHeight >= 176}
            style={[styles.input, { height: composerInputHeight }, !canSend && styles.readOnlyInput]}
          />
          {canSend && <TouchableOpacity onPress={() => setComposerActionsOpen(true)} style={styles.inputAttach} accessibilityLabel="Pièce jointe et options" testID="messenger-composer-actions"><Ionicons name="attach" size={23} color={blue} /></TouchableOpacity>}
        </View>
        {canSend && (recording || voiceSending
          ? <TouchableOpacity style={[styles.sendButton, voiceSending && styles.disabled]} onPress={voice} disabled={voiceSending} accessibilityLabel="Terminer et envoyer le message vocal" testID="messenger-send-voice"><Image source={logo} style={styles.sendLogo} resizeMode="contain" /></TouchableOpacity>
          : text.trim() || editing
            ? <TouchableOpacity style={styles.sendButton} onPress={() => editing ? action(editing, "edit", { text }).then(ok => { if (ok) { setEditing(null); changeDraft(""); } }) : send()} accessibilityLabel="Envoyer le message" testID="messenger-send"><Image source={logo} style={styles.sendLogo} resizeMode="contain" testID="messenger-send-brand" /></TouchableOpacity>
            : <TouchableOpacity onPress={voice} style={styles.recordButton} accessibilityLabel="Enregistrer un message vocal" testID="messenger-record-voice"><Ionicons name="mic" size={22} color="#fff" /></TouchableOpacity>)}
      </View>
      <Modal visible={composerActionsOpen} transparent animationType="fade" onRequestClose={() => setComposerActionsOpen(false)}>
        <View style={styles.composerActionsBackdrop}>
          <TouchableOpacity style={styles.composerActionsDismiss} onPress={() => setComposerActionsOpen(false)} accessibilityLabel="Fermer les options" />
          <View style={styles.composerActionsSheet}>
            <Text style={styles.actionsTitle}>Ajouter au message</Text>
            <TouchableOpacity style={styles.composerActionRow} onPress={() => { setComposerActionsOpen(false); attachFile(); }}><Ionicons name="attach" size={20} color={blue} /><Text style={styles.composerActionText}>Photo, vidéo ou fichier</Text></TouchableOpacity>
            <TouchableOpacity style={styles.composerActionRow} onPress={() => { setComposerActionsOpen(false); openContactShare(); }}><Ionicons name="person-add-outline" size={20} color={blue} /><Text style={styles.composerActionText}>Partager un contact</Text></TouchableOpacity>
            <TouchableOpacity style={styles.composerActionRow} onPress={() => { setSilent(value => !value); setComposerActionsOpen(false); }} accessibilityRole="checkbox" accessibilityState={{ checked: silent }} testID="messenger-silent-toggle"><Ionicons name={silent ? "notifications-off" : "notifications-outline"} size={20} color={blue} /><Text style={styles.composerActionText}>{silent ? "Désactiver l’envoi silencieux" : "Activer l’envoi silencieux"}</Text></TouchableOpacity>
          </View>
        </View>
      </Modal>
      <Modal visible={!!forwarding} transparent animationType="fade" onRequestClose={() => setForwarding(null)}>
        <View style={styles.modalBackdrop}><View style={styles.forwardModal}><Text style={styles.modalTitle}>Transférer vers</Text><ScrollView style={{ maxHeight: 340 }}>{targets.filter(target => target.id !== conversation.id).map(target => <TouchableOpacity key={target.id} onPress={() => forward(target)} style={styles.targetRow}><Text style={styles.targetName}>{target.title}</Text><Ionicons name="chevron-forward" size={18} color={muted} /></TouchableOpacity>)}</ScrollView><TouchableOpacity onPress={() => setForwarding(null)}><Text style={styles.cancelText}>Annuler</Text></TouchableOpacity></View></View>
      </Modal>
      <ProtectedAttachmentViewer preview={attachmentPreview} onClose={() => setAttachmentPreview(null)} />
      <MediaComposer
        visible={!!pendingMedia}
        files={pendingMedia || []}
        initialCaption={text}
        onClose={() => setPendingMedia(null)}
        onConfirm={sendSelectedMedia}
      />
      {canSend && scheduledEnabled && <ScheduledMessages conversationId={conversation.id} visible={scheduleOpen} onClose={() => setScheduleOpen(false)} />}
      <Modal visible={sharingContact} transparent animationType="slide" onRequestClose={() => setSharingContact(false)}>
        <View style={styles.modalBackdrop}><View style={styles.forwardModal}><Text style={styles.modalTitle}>Partager un contact</Text>
          {contactsLoading ? <ActivityIndicator color={blue} /> : <ScrollView style={{ maxHeight: 340 }}>
            {shareContacts.map(person => <TouchableOpacity key={person.id} onPress={() => shareContact(person)} style={styles.targetRow}><Text style={styles.targetName}>@{person.username}</Text><Ionicons name="send-outline" size={18} color={blue} /></TouchableOpacity>)}
            {!shareContacts.length && <Text style={styles.emptyText}>Ajoutez d’abord des contacts pour les partager.</Text>}
          </ScrollView>}
          <TouchableOpacity onPress={() => setSharingContact(false)}><Text style={styles.cancelText}>Annuler</Text></TouchableOpacity>
        </View></View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  thread: { flex: 1, backgroundColor: "#f4f7fb", minHeight: 0, position: "relative" },
  threadHead: { minHeight: 68, flexDirection: "row", alignItems: "center", backgroundColor: "#fff", borderBottomWidth: 1, borderColor: "#e8edf5", paddingHorizontal: 12, gap: 7 },
  back: { padding: 7 }, identity: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10 }, identityText: { flex: 1, minWidth: 0, paddingVertical: 3 },
  avatar: { width: 43, height: 43, borderRadius: 24, backgroundColor: "#e4edff", alignItems: "center", justifyContent: "center", overflow: "hidden" }, avatarStoryRing: { width: 49, height: 49, borderRadius: 26, padding: 2, borderWidth: 2, borderColor: "#f2a934" }, avatarPhoto: { width: 43, height: 43, borderRadius: 24 }, avatarPhotoStory: { width: 39, height: 39, borderRadius: 20 }, avatarText: { color: blue, fontWeight: "900", fontSize: 18 },
  name: { fontSize: 16, color: ink, fontWeight: "800" }, presence: { fontSize: 12, color: muted, marginTop: 2 }, typing: { color: blue, fontWeight: "700" },
  headerIcon: { padding: 9 }, searchRow: { backgroundColor: "#fff", flexDirection: "row", alignItems: "center", paddingHorizontal: 16, gap: 10 },
  searchInput: { flex: 1, height: 44, fontSize: 14, color: ink },
  history: { flex: 1, minHeight: 0 }, historyContent: { padding: 14, paddingBottom: 14, gap: 8 },
  older: { alignSelf: "center", backgroundColor: "#e8f0ff", borderRadius: 18, paddingVertical: 8, paddingHorizontal: 14 }, olderText: { color: blue, fontSize: 12, fontWeight: "700" },
  historyError: { alignSelf: "center", backgroundColor: "#fff0ef", paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10 }, historyErrorText: { color: "#c33", fontSize: 12, fontWeight: "700" },
  empty: { flex: 1, minHeight: 240, justifyContent: "center", alignItems: "center" }, emptyTitle: { fontSize: 17, color: ink, fontWeight: "800" }, emptyText: { marginTop: 7, color: muted, fontSize: 13 },
  bubbleWrap: { width: "100%", alignItems: "stretch", minWidth: 0 }, ownWrap: { alignItems: "stretch" }, swipeMessage: { width: "100%", alignItems: "flex-start", minWidth: 0 }, swipeMessageOwn: { alignItems: "flex-end" }, bubble: { maxWidth: "88%", minWidth: 0, flexShrink: 1, borderRadius: 17, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 5, borderWidth: 1, borderColor: "#e9edf3" },
  ownBubble: { alignSelf: "flex-end", backgroundColor: "#e4f1ff", borderColor: "#c8e0fb", borderBottomRightRadius: 5 }, otherBubble: { alignSelf: "flex-start", backgroundColor: "#fff", borderColor: "#e2e8f0", borderBottomLeftRadius: 5 },
  sender: { fontSize: 12, color: blue, fontWeight: "800", marginBottom: 3, maxWidth: "100%", flexShrink: 1 }, messageText: ({ color: ink, fontSize: 16, lineHeight: 22, maxWidth: "100%", flexShrink: 1, overflowWrap: "anywhere", wordBreak: "break-word" } as any), linkText: { color: blue, textDecorationLine: "underline" }, deleted: { color: muted, fontStyle: "italic" }, forwarded: { fontSize: 11, color: muted, marginBottom: 4 },
  replyQuote: { borderLeftWidth: 3, borderColor: blue, paddingLeft: 8, paddingVertical: 4, marginBottom: 6, backgroundColor: "rgba(23,105,232,.055)", borderTopRightRadius: 7, borderBottomRightRadius: 7, maxWidth: "100%", minWidth: 0 },
  statusReplyCard: { maxWidth: "100%", minWidth: 0, marginBottom: 6, padding: 7, borderLeftWidth: 3, borderLeftColor: blue, borderRadius: 8, backgroundColor: "rgba(23,105,232,.06)" },
  statusReplyHeader: { flexDirection: "row", alignItems: "center", gap: 7, minWidth: 0 },
  statusReplyCopy: { flex: 1, minWidth: 0 },
  statusReplyTitle: { color: blue, fontSize: 11, fontWeight: "800" },
  statusReplyText: ({ color: muted, fontSize: 11, marginTop: 2, overflowWrap: "anywhere" } as any),
  statusReplyMedia: { marginTop: 6, maxWidth: 220, alignSelf: "flex-start" },
  replyQuoteSender: ({ color: blue, fontSize: 11, fontWeight: "800", maxWidth: "100%", flexShrink: 1, overflowWrap: "anywhere" } as any), replyQuotePreview: ({ color: muted, fontSize: 11, marginTop: 2, maxWidth: "100%", flexShrink: 1, overflowWrap: "anywhere" } as any),
  fileChip: { flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: "#f2f6fd", borderRadius: 10, padding: 9, marginTop: 5, maxWidth: 250 }, mediaGroup: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap: 4, maxWidth: 260, alignSelf: "flex-start" }, ownAttachment: { alignSelf: "flex-end" }, voiceCard: { maxWidth: 280, minWidth: 220, borderRadius: 14, paddingHorizontal: 8, marginTop: 4, alignSelf: "flex-start" }, fileLabel: { flex: 1, fontSize: 13, color: ink },
  meta: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 5, marginTop: 4 }, time: { fontSize: 10, color: muted }, receipt: { color: "#9aa5b5", fontSize: 11, fontWeight: "700" }, receiptDelivered: { color: "#8793a4" }, receiptRead: { color: blue }, retryText: { color: "#c33", fontWeight: "800", fontSize: 10 },
  reaction: { alignSelf: "flex-start", backgroundColor: "#fff", borderRadius: 12, paddingHorizontal: 7, paddingVertical: 2, fontSize: 12, marginTop: 3 }, actions: { flexDirection: "row", flexWrap: "wrap", gap: 10, borderTopWidth: 1, borderColor: "#e9edf3", paddingTop: 6, marginTop: 5 }, actionText: { fontSize: 11, color: blue, fontWeight: "700" },
  replyBanner: { backgroundColor: "#fff", borderTopWidth: 1, borderColor: "#e8edf5", flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 13, paddingVertical: 8, gap: 8 }, replyBannerCopy: { flex: 1, borderLeftWidth: 3, borderColor: blue, paddingLeft: 9 }, replyBannerLabel: { color: blue, fontSize: 11, fontWeight: "800" }, replyBannerText: { color: muted, fontSize: 12, flex: 1 },
  recordStatus: { flexDirection: "row", alignItems: "center", backgroundColor: "#fff", paddingHorizontal: 16, paddingVertical: 9, gap: 8 }, recordDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#dd3e45" }, recordText: { flex: 1, color: ink, fontSize: 13 }, cancelText: { color: "#d64545", fontWeight: "700", padding: 7 },
  readOnly: { flexDirection: "row", alignItems: "center", gap: 7, paddingVertical: 7, paddingHorizontal: 14, backgroundColor: "#fff" }, readOnlyText: { color: muted, fontSize: 11, flex: 1 }, disabled: { opacity: .45 }, readOnlyInput: { opacity: .65 },
  emojiPickerPanel: { height: 420, flexShrink: 0, overflow: "hidden", backgroundColor: "#fff", borderTopWidth: 1, borderColor: "#e8edf5" },
  composer: { flexDirection: "row", alignItems: "flex-end", backgroundColor: "#fff", marginHorizontal: 10, marginBottom: 10, paddingHorizontal: 7, paddingVertical: 7, borderWidth: 1, borderColor: "#e7ecf3", borderRadius: 30, gap: 5, shadowColor: "#102042", shadowOffset: { width: 0, height: 4 }, shadowOpacity: .12, shadowRadius: 10, elevation: 6, flexShrink: 0 },
  composerIcon: { width: 37, height: 44, alignItems: "center", justifyContent: "center" }, inputShell: { flex: 1, flexDirection: "row", alignItems: "flex-end", minWidth: 0, minHeight: 42, backgroundColor: "#f2f5f9", borderRadius: 24, paddingLeft: 11, paddingRight: 5 }, input: { flex: 1, flexShrink: 1, minWidth: 0, maxHeight: 176, minHeight: 42, borderRadius: 21, backgroundColor: "transparent", paddingHorizontal: 3, paddingTop: 10, paddingBottom: 8, color: ink, fontSize: 16, lineHeight: 22, outlineStyle: "none" as any }, inputAttach: { width: 36, height: 42, alignItems: "center", justifyContent: "center" },
  sendButton: { width: 46, height: 46, borderRadius: 23, backgroundColor: blue, alignItems: "center", justifyContent: "center", overflow: "hidden", flexShrink: 0 }, recordButton: { width: 46, height: 46, borderRadius: 23, backgroundColor: blue, alignItems: "center", justifyContent: "center", flexShrink: 0 }, sendLogo: { width: 37, height: 37, borderRadius: 19, backgroundColor: "#fff" },
  composerActionsBackdrop: { flex: 1, backgroundColor: "rgba(15,28,50,.35)", justifyContent: "flex-end", paddingHorizontal: 12, paddingBottom: 16 }, composerActionsDismiss: { flex: 1 }, composerActionsSheet: { backgroundColor: "#fff", borderRadius: 22, padding: 12 }, actionsTitle: { color: ink, fontSize: 16, fontWeight: "800", paddingHorizontal: 9, paddingBottom: 8 }, composerActionRow: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 13, paddingHorizontal: 10, borderTopWidth: 1, borderColor: "#edf0f5" }, composerActionText: { color: ink, fontSize: 14, fontWeight: "600" },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(15,28,50,.35)", justifyContent: "center", alignItems: "center", padding: 20 }, forwardModal: { backgroundColor: "#fff", borderRadius: 18, padding: 18, width: "100%", maxWidth: 380 }, modalTitle: { fontSize: 18, fontWeight: "800", color: ink, marginBottom: 12 }, targetRow: { minHeight: 48, borderBottomWidth: 1, borderColor: "#edf0f4", flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, targetName: { color: ink, fontWeight: "700" },
});
