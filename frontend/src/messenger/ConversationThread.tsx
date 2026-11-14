import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Linking, Modal, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api";
import { messengerApi } from "./api";
import type { Attachment, ContactState, Conversation, Message, Person, ReadReceipts } from "./types";
import ScheduledMessages from "./ScheduledMessages";
import { openProtectedAttachment, ProtectedAttachmentViewer, type AttachmentPreview } from "./ProtectedAttachmentViewer";
import SwipeToReply from "@/src/components/SwipeToReply";

type Props = {
  conversation: Conversation; userId: string; onBack: () => void; onChanged: () => void;
  onDetails: () => void; onViewPhoto: (uri: string, label: string) => void;
  version: number; typing?: { username?: string }; scheduledEnabled?: boolean;
  readReceipts?: ReadReceipts;
};
const blue = "#1769e8", ink = "#102042", muted = "#7d879a";
const logo = require("../../assets/images/spiloveure-logo.png");
const makeId = () => typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const messageKey = (message: Message) => message.client_id ? `client:${message.sender_id}:${message.client_id}` : `id:${message.id}`;
function mergeMessages(existing: Message[], incoming: Message[]) {
  const byKey = new Map<string, Message>();
  existing.forEach(message => byKey.set(messageKey(message), message));
  incoming.forEach(message => byKey.set(messageKey(message), message));
  return [...byKey.values()].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
}

export default function ConversationThread({ conversation, userId, onBack, onChanged, onDetails, onViewPhoto, version, typing, scheduledEnabled = true, readReceipts }: Props) {
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
  const [text, setText] = useState(conversation.draft || "");
  const [reply, setReply] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [historyQuery, setHistoryQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [forwarding, setForwarding] = useState<Message | null>(null);
  const [targets, setTargets] = useState<Conversation[]>([]);
  const [recording, setRecording] = useState(false);
  const [recordBlob, setRecordBlob] = useState<Blob | null>(null);
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
  const scroll = useRef<ScrollView>(null);
  const saveDraft = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftValue = useRef(conversation.draft || "");
  const draftQueue = useRef<Promise<void>>(Promise.resolve());
  const retries = useRef<Record<string, () => Promise<Message>>>({});
  const lastVersion = useRef(version);
  const lastTypingAt = useRef(0);
  const changeDraft = (value: string) => {
    draftValue.current = value;
    setText(value);
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
  const send = async (extra: Partial<{ attachments: Attachment[]; forwarded_from: string }> = {}) => {
    if (!canSend || (!text.trim() && !extra.attachments?.length)) return;
    const content = text.trim(), client_id = makeId(), silentSend = silent;
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
    if (value.trim() && Date.now() - lastTypingAt.current > 1800) {
      lastTypingAt.current = Date.now();
      api.post(`/messenger/conversations/${encodeURIComponent(conversation.id)}/typing`).catch(() => {});
    }
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
  const voice = async () => {
    if (!canSend) return;
    if (recording) {
      recorder.current?.stop(); setRecording(false); streamRef.current?.getTracks().forEach(t => t.stop()); return;
    }
    if (recordBlob) {
      const mime = recordBlob.type || "audio/webm";
      const extension = mime.includes("ogg") ? ".ogg" : mime.includes("mp4") ? ".m4a" : mime.includes("mpeg") ? ".mp3" : ".webm";
      const file = new File([recordBlob], `message-vocal-${Date.now()}${extension}`, { type: mime });
      try {
        if (file.size > 20 * 1024 * 1024) throw new Error("Le message vocal dépasse 20 Mo.");
        const attachment = await messengerApi.file(conversation.id, file); await send({ attachments: [attachment] }); setRecordBlob(null);
      }
      catch (e: any) { window.alert(e?.detail || "Envoi vocal impossible."); }
      return;
    }
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
        if (!discardRecording.current) setRecordBlob(new Blob(chunks, { type: recordedType }));
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
        text: `Contact SPILOVEURE : @${person.username}`,
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
  const renderText = (content: string) => content.split(/(https?:\/\/[^\s]+)/gi).map((part, index) =>
    /^https?:\/\//i.test(part)
      ? <Text key={`${index}-${part}`} style={styles.linkText} onPress={() => openUrl(part)}>{part}</Text>
      : <Text key={`${index}-${part}`}>{part}</Text>,
  );
  const otherPerson = conversation.member_profiles.find(person => person.id !== userId);
  const otherPhoto = otherPerson?.avatar || conversation.photo;
  const isChannelAdmin = conversation.admins.includes(userId) || conversation.owner_id === userId;
  const canSend = conversation.kind !== "channel" || isChannelAdmin;
  const presence = otherPerson?.online ? "En ligne" : otherPerson?.last_seen
    ? `Vu ${new Date(otherPerson.last_seen).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}`
    : conversation.kind === "private" ? "Membre SPILOVEURE" : `${conversation.member_profiles.length} membres`;

  return (
    <View style={styles.thread}>
      <View style={styles.threadHead}>
        <TouchableOpacity onPress={onBack} style={styles.back} accessibilityLabel="Retour aux conversations" testID="messenger-back"><Ionicons name="arrow-back" size={23} color={blue} /></TouchableOpacity>
        <View style={styles.identity}>
          <TouchableOpacity onPress={() => otherPhoto ? onViewPhoto(otherPhoto, conversation.title) : onDetails()} style={styles.avatar} accessibilityRole="button" accessibilityLabel={otherPhoto ? `Afficher la photo de ${conversation.title}` : `Détails de ${conversation.title}`} testID="messenger-thread-avatar">
            {otherPhoto ? <Image source={{ uri: otherPhoto }} style={styles.avatarPhoto} /> : <Text style={styles.avatarText}>{conversation.title.slice(0, 1).toUpperCase()}</Text>}
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
      <ScrollView ref={scroll} style={styles.history} contentContainerStyle={styles.historyContent} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}>
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
                {!!message.text && <Text style={styles.messageText}>{renderText(message.text)}</Text>}
                {message.attachments?.map(file => <TouchableOpacity key={file.id} onPress={() => openAttachment(file)} style={styles.fileChip}>
                  {file.mime.startsWith("image/") ? <Ionicons name="image-outline" size={17} color={blue} /> : <Ionicons name="document-outline" size={17} color={blue} />}
                  <Text style={styles.fileLabel} numberOfLines={1}>{file.name}</Text><Ionicons name="download-outline" size={16} color={blue} />
                </TouchableOpacity>)}
              </>}
              <View style={styles.meta}><Text style={styles.time}>{new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{message.edited_at ? " · modifié" : ""}</Text>{own && <Text style={styles.receipt}>{message.read_by?.length > 1 ? "✓✓" : "✓"}</Text>}
                {message.client_id && failedIds.includes(message.client_id) && <TouchableOpacity onPress={() => retrySend(message.client_id!)}><Text style={styles.retryText}>Réessayer</Text></TouchableOpacity>}
                <TouchableOpacity onPress={() => setExpanded(expanded === message.id ? null : message.id)} accessibilityLabel="Actions du message" testID={`messenger-message-menu-${message.id}`}><Ionicons name="ellipsis-horizontal" size={16} color={muted} /></TouchableOpacity>
              </View>
              {Object.entries(message.reactions || {}).filter(([, ids]) => ids.length).map(([emoji, ids]) => <Text key={emoji} style={styles.reaction}>{emoji} {ids.length}</Text>)}
              {expanded === message.id && <View style={styles.actions}>
                <TouchableOpacity onPress={() => { setReply(message); setExpanded(null); }} testID={`messenger-message-reply-${message.id}`}><Text style={styles.actionText}>Répondre</Text></TouchableOpacity>
                <TouchableOpacity onPress={() => action(message, "reaction", { emoji: "👍" })} testID={`messenger-message-react-${message.id}`}><Text style={styles.actionText}>👍</Text></TouchableOpacity>
                <TouchableOpacity onPress={() => { setForwarding(message); messengerApi.conversations().then(setTargets).catch(() => setTargets([])); setExpanded(null); }} testID={`messenger-message-forward-${message.id}`}><Text style={styles.actionText}>Transférer</Text></TouchableOpacity>
                {(conversation.kind === "private" || isChannelAdmin) && <TouchableOpacity onPress={() => action(message, "pin")} testID={`messenger-message-pin-${message.id}`}><Text style={styles.actionText}>{message.pinned ? "Désépingler" : "Épingler"}</Text></TouchableOpacity>}
                {own && <TouchableOpacity onPress={() => { setEditing(message); changeDraft(message.text); setExpanded(null); }} testID={`messenger-message-edit-${message.id}`}><Text style={styles.actionText}>Modifier</Text></TouchableOpacity>}
                {(own || isChannelAdmin) && <TouchableOpacity onPress={() => action(message, "delete")} testID={`messenger-message-delete-${message.id}`}><Text style={[styles.actionText, { color: "#d33" }]}>Supprimer</Text></TouchableOpacity>}
              </View>}
            </View>;
          return <View key={message.id} style={[styles.bubbleWrap, own && styles.ownWrap]}>
            {!own && !message.deleted
              ? <SwipeToReply direction="left" onReply={() => { setReply(message); setExpanded(null); }}><View testID={`messenger-swipe-reply-${message.id}`}>{bubble}</View></SwipeToReply>
              : bubble}
          </View>;
        })}
      </ScrollView>
      {reply && <View style={styles.replyBanner} testID="messenger-reply-preview">
        <View style={styles.replyBannerCopy}><Text style={styles.replyBannerLabel}>Réponse à {reply.sender_name}</Text><Text numberOfLines={1} style={styles.replyBannerText}>{reply.deleted ? "Message supprimé" : reply.text || reply.attachments?.[0]?.name || "Pièce jointe"}</Text></View>
        <TouchableOpacity onPress={() => setReply(null)} accessibilityLabel="Annuler la réponse"><Ionicons name="close" size={19} color={blue} /></TouchableOpacity>
      </View>}
      {editing && <View style={styles.replyBanner}><Text style={styles.replyBannerText}>Modification du message</Text><TouchableOpacity onPress={() => { setEditing(null); changeDraft(""); }}><Ionicons name="close" size={19} color={blue} /></TouchableOpacity></View>}
      {(recording || recordBlob) && <View style={styles.recordStatus}><View style={styles.recordDot} /><Text style={styles.recordText}>{recording ? `Enregistrement · ${recordSeconds}s` : `Vocal prêt · ${recordSeconds}s`}</Text><TouchableOpacity onPress={() => { discardRecording.current = true; recorder.current?.state === "recording" && recorder.current.stop(); streamRef.current?.getTracks().forEach(t => t.stop()); setRecording(false); setRecordBlob(null); }}><Text style={styles.cancelText}>Annuler</Text></TouchableOpacity></View>}
      {!canSend && <View style={styles.readOnly}><Ionicons name="eye-outline" size={17} color={muted} /><Text style={styles.readOnlyText}>Lecture seule · seuls les administrateurs peuvent publier dans ce canal.</Text></View>}
      <View style={styles.composer}>
        <TouchableOpacity onPress={attachFile} style={[styles.composerIcon, !canSend && styles.disabled]} disabled={!canSend} accessibilityLabel="Joindre un fichier"><Ionicons name="attach" size={23} color={canSend ? blue : muted} /></TouchableOpacity>
        <TouchableOpacity onPress={openContactShare} style={[styles.composerIcon, !canSend && styles.disabled]} disabled={!canSend} accessibilityLabel="Partager un contact"><Ionicons name="person-add-outline" size={20} color={canSend ? blue : muted} /></TouchableOpacity>
        <TextInput value={text} onChangeText={updateComposer} editable={canSend} placeholder={canSend ? "Message" : "Lecture seule"} multiline style={[styles.input, !canSend && styles.readOnlyInput]} onSubmitEditing={() => { if (Platform.OS === "web" && canSend) editing ? action(editing, "edit", { text }).then(ok => { if (ok) { setEditing(null); changeDraft(""); } }) : send(); }} />
        {canSend && <TouchableOpacity onPress={() => setSilent(value => !value)} style={[styles.composerIcon, silent && styles.silentActive]} accessibilityRole="checkbox" accessibilityState={{ checked: silent }} accessibilityLabel="Envoi silencieux" testID="messenger-silent-toggle"><Ionicons name={silent ? "notifications-off" : "notifications-outline"} size={19} color={silent ? blue : muted} /></TouchableOpacity>}
        {canSend && (text.trim() || editing ? <TouchableOpacity style={styles.sendButton} onPress={() => editing ? action(editing, "edit", { text }).then(ok => { if (ok) { setEditing(null); changeDraft(""); } }) : send()} accessibilityLabel="Envoyer le message" testID="messenger-send"><Image source={logo} style={styles.sendLogo} resizeMode="contain" testID="messenger-send-brand" /></TouchableOpacity>
          : <TouchableOpacity onPress={voice} style={styles.composerIcon} accessibilityLabel="Enregistrer ou envoyer un message vocal"><Ionicons name={recording ? "stop-circle" : recordBlob ? "send" : "mic"} size={23} color={recording ? "#d44" : blue} /></TouchableOpacity>)}
      </View>
      <Modal visible={!!forwarding} transparent animationType="fade" onRequestClose={() => setForwarding(null)}>
        <View style={styles.modalBackdrop}><View style={styles.forwardModal}><Text style={styles.modalTitle}>Transférer vers</Text><ScrollView style={{ maxHeight: 340 }}>{targets.filter(target => target.id !== conversation.id).map(target => <TouchableOpacity key={target.id} onPress={() => forward(target)} style={styles.targetRow}><Text style={styles.targetName}>{target.title}</Text><Ionicons name="chevron-forward" size={18} color={muted} /></TouchableOpacity>)}</ScrollView><TouchableOpacity onPress={() => setForwarding(null)}><Text style={styles.cancelText}>Annuler</Text></TouchableOpacity></View></View>
      </Modal>
      <ProtectedAttachmentViewer preview={attachmentPreview} onClose={() => setAttachmentPreview(null)} />
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
  thread: { flex: 1, backgroundColor: "#f4f7fb", minHeight: 0 },
  threadHead: { minHeight: 68, flexDirection: "row", alignItems: "center", backgroundColor: "#fff", borderBottomWidth: 1, borderColor: "#e8edf5", paddingHorizontal: 12, gap: 7 },
  back: { padding: 7 }, identity: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10 }, identityText: { flex: 1, minWidth: 0, paddingVertical: 3 },
  avatar: { width: 43, height: 43, borderRadius: 24, backgroundColor: "#e4edff", alignItems: "center", justifyContent: "center", overflow: "hidden" }, avatarPhoto: { width: 43, height: 43, borderRadius: 24 }, avatarText: { color: blue, fontWeight: "900", fontSize: 18 },
  name: { fontSize: 16, color: ink, fontWeight: "800" }, presence: { fontSize: 12, color: muted, marginTop: 2 }, typing: { color: blue, fontWeight: "700" },
  headerIcon: { padding: 9 }, searchRow: { backgroundColor: "#fff", flexDirection: "row", alignItems: "center", paddingHorizontal: 16, gap: 10 },
  searchInput: { flex: 1, height: 44, fontSize: 14, color: ink },
  history: { flex: 1 }, historyContent: { padding: 14, paddingBottom: 24, gap: 8 },
  older: { alignSelf: "center", backgroundColor: "#e8f0ff", borderRadius: 18, paddingVertical: 8, paddingHorizontal: 14 }, olderText: { color: blue, fontSize: 12, fontWeight: "700" },
  historyError: { alignSelf: "center", backgroundColor: "#fff0ef", paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10 }, historyErrorText: { color: "#c33", fontSize: 12, fontWeight: "700" },
  empty: { flex: 1, minHeight: 240, justifyContent: "center", alignItems: "center" }, emptyTitle: { fontSize: 17, color: ink, fontWeight: "800" }, emptyText: { marginTop: 7, color: muted, fontSize: 13 },
  bubbleWrap: { alignItems: "flex-start" }, ownWrap: { alignItems: "flex-end" }, bubble: { maxWidth: "88%", minWidth: 120, borderRadius: 17, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 5, borderWidth: 1, borderColor: "#e9edf3" },
  ownBubble: { backgroundColor: "#e3efff", borderColor: "#d7e7ff", borderBottomRightRadius: 5 }, otherBubble: { backgroundColor: "#fff", borderBottomLeftRadius: 5 },
  sender: { fontSize: 12, color: blue, fontWeight: "800", marginBottom: 3 }, messageText: { color: ink, fontSize: 15, lineHeight: 21 }, linkText: { color: blue, textDecorationLine: "underline" }, deleted: { color: muted, fontStyle: "italic" }, forwarded: { fontSize: 11, color: muted, marginBottom: 4 },
  replyQuote: { borderLeftWidth: 3, borderColor: blue, paddingLeft: 8, paddingVertical: 4, marginBottom: 6, backgroundColor: "rgba(23,105,232,.055)", borderTopRightRadius: 7, borderBottomRightRadius: 7 },
  replyQuoteSender: { color: blue, fontSize: 11, fontWeight: "800" }, replyQuotePreview: { color: muted, fontSize: 11, marginTop: 2 },
  fileChip: { flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: "#f2f6fd", borderRadius: 10, padding: 9, marginTop: 5, maxWidth: 250 }, fileLabel: { flex: 1, fontSize: 13, color: ink },
  meta: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 5, marginTop: 4 }, time: { fontSize: 10, color: muted }, receipt: { color: blue, fontSize: 11 }, retryText: { color: "#c33", fontWeight: "800", fontSize: 10 },
  reaction: { alignSelf: "flex-start", backgroundColor: "#fff", borderRadius: 12, paddingHorizontal: 7, paddingVertical: 2, fontSize: 12, marginTop: 3 }, actions: { flexDirection: "row", flexWrap: "wrap", gap: 10, borderTopWidth: 1, borderColor: "#e9edf3", paddingTop: 6, marginTop: 5 }, actionText: { fontSize: 11, color: blue, fontWeight: "700" },
  replyBanner: { backgroundColor: "#fff", borderTopWidth: 1, borderColor: "#e8edf5", flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 13, paddingVertical: 8, gap: 8 }, replyBannerCopy: { flex: 1, borderLeftWidth: 3, borderColor: blue, paddingLeft: 9 }, replyBannerLabel: { color: blue, fontSize: 11, fontWeight: "800" }, replyBannerText: { color: muted, fontSize: 12, flex: 1 },
  recordStatus: { flexDirection: "row", alignItems: "center", backgroundColor: "#fff", paddingHorizontal: 16, paddingVertical: 9, gap: 8 }, recordDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#dd3e45" }, recordText: { flex: 1, color: ink, fontSize: 13 }, cancelText: { color: "#d64545", fontWeight: "700", padding: 7 },
  readOnly: { flexDirection: "row", alignItems: "center", gap: 7, paddingVertical: 7, paddingHorizontal: 14, backgroundColor: "#fff" }, readOnlyText: { color: muted, fontSize: 11, flex: 1 }, disabled: { opacity: .45 }, readOnlyInput: { opacity: .65 },
  composer: { flexDirection: "row", alignItems: "flex-end", backgroundColor: "#fff", paddingHorizontal: 10, paddingVertical: 9, borderTopWidth: 1, borderColor: "#e7ecf3", gap: 7 },
  composerIcon: { width: 40, height: 42, alignItems: "center", justifyContent: "center" }, input: { flex: 1, maxHeight: 110, minHeight: 42, borderRadius: 23, backgroundColor: "#f2f5f9", paddingHorizontal: 16, paddingTop: 11, paddingBottom: 9, color: ink, fontSize: 15, outlineStyle: "none" as any },
  sendButton: { width: 44, height: 44, borderRadius: 23, backgroundColor: blue, alignItems: "center", justifyContent: "center", overflow: "hidden" }, sendLogo: { width: 37, height: 37, borderRadius: 19, backgroundColor: "#fff" }, silentActive: { borderRadius: 20, backgroundColor: "#eaf1ff" },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(15,28,50,.35)", justifyContent: "center", alignItems: "center", padding: 20 }, forwardModal: { backgroundColor: "#fff", borderRadius: 18, padding: 18, width: "100%", maxWidth: 380 }, modalTitle: { fontSize: 18, fontWeight: "800", color: ink, marginBottom: 12 }, targetRow: { minHeight: 48, borderBottomWidth: 1, borderColor: "#edf0f4", flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, targetName: { color: ink, fontWeight: "700" },
});
