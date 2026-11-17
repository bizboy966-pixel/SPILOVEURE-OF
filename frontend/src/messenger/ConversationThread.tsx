import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Animated, Image, Keyboard, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, useWindowDimensions, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import Svg, { Path } from "react-native-svg";
import { createMemoryAdapter, EmojiKeyboard, type CategoryTypes } from "@softwhere-uz/react-native-emoji-keyboard";
import { api } from "@/src/api";
import { messengerApi, messengerErrorMessage, protectedFileUrl } from "./api";
import type { Attachment, ContactState, Conversation, Message, Person, ReadReceipts } from "./types";
import ScheduledMessages from "./ScheduledMessages";
import { openProtectedAttachment, ProtectedAttachmentViewer, type AttachmentPreview } from "./ProtectedAttachmentViewer";
import MediaComposer from "./MediaComposer";
import { normalizeMediaFile, validateChatFiles } from "./mediaFiles";
import ProtectedMessageMedia from "./ProtectedMessageMedia";
import StickerPickerPanel from "./StickerPickerPanel";
import StickerActionSheet from "./StickerActionSheet";
import VideoStickerComposer from "./VideoStickerComposer";
import SwipeToReply from "@/src/components/SwipeToReply";
import VoiceMessage from "@/src/components/VoiceMessage";
import VoiceRecorderControls from "@/src/components/VoiceRecorderControls";
import { chatProfileUrl } from "./userLinks";
import ChatWallpaper from "./ChatWallpaper";
import MessageContextMenu from "./MessageContextMenu";
import { chatVisual } from "./chatVisualTokens";

type Props = {
  conversation: Conversation; userId: string; onBack: () => void; onChanged: () => void;
  onDetails: () => void; onViewPhoto: (uri: string, label: string) => void; onOpenUsername?: (username: string) => void;
  hasActiveStatus?: boolean; onOpenStatus?: (authorId?: string, statusId?: string) => void;
  version: number; typing?: { username?: string }; scheduledEnabled?: boolean;
  readReceipts?: ReadReceipts;
  focusComposer?: boolean;
  focusMessageId?: string;
};
const blue = chatVisual.brand, ink = chatVisual.ink, muted = chatVisual.muted;
type ChatVisualSettings = {
  appearance?: "light" | "dark";
  message_color?: "blue" | "green" | "gold";
  font_scale?: number;
  high_contrast?: boolean;
  auto_load_media?: boolean;
};

function AnimatedReactionChip({ emoji, ids, userId, onPress, testID }: {
  emoji: string;
  ids: string[];
  userId: string;
  onPress: () => void;
  testID?: string;
}) {
  const scale = useRef(new Animated.Value(0.35)).current;
  useEffect(() => {
    Animated.sequence([
      Animated.spring(scale, { toValue: 1.18, damping: 6, stiffness: 260, mass: 0.55, useNativeDriver: true }),
      Animated.spring(scale, { toValue: 1, damping: 8, stiffness: 230, mass: 0.65, useNativeDriver: true }),
    ]).start();
  }, [scale]);
  const mine = ids.includes(userId);
  return (
    <Animated.View style={[styles.reactionChip, mine && styles.reactionChipMine, { transform: [{ scale }] }]}>
      <TouchableOpacity onPress={onPress} accessibilityRole="button" testID={testID}
        accessibilityLabel={`${mine ? "Retirer" : "Ajouter"} la réaction ${emoji}`}>
        <Text style={styles.reaction}>{emoji} {ids.length}</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}
function AnimatedEmojiMessage({ text, style }: { text: string; style: any }) {
  const scale = useRef(new Animated.Value(0.55)).current;
  useEffect(() => {
    Animated.sequence([
      Animated.spring(scale, { toValue: 1.12, damping: 6, stiffness: 240, mass: 0.6, useNativeDriver: true }),
      Animated.spring(scale, { toValue: 1, damping: 8, stiffness: 220, mass: 0.7, useNativeDriver: true }),
    ]).start();
  }, [scale]);
  return <Animated.Text style={[style, { fontSize: text.trim().length <= 4 ? 38 : 30, lineHeight: 46, transform: [{ scale }] }]}>{text}</Animated.Text>;
}
const isEmojiOnlyMessage = (value: string) => {
  const text = value.trim();
  return !!text && !/[A-Za-z0-9]/.test(text) && /[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u.test(text);
};
const messageColors = { blue: "#dbeafe", green: chatVisual.sentBubble, gold: "#fff1cc" };
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

function ProtectedVoicePlayer({ file, own, autoLoad = true }: { file: Attachment; own: boolean; autoLoad?: boolean }) {
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const viewOnce = Boolean(file.view_once && !own);
  const [viewOnceOpened, setViewOnceOpened] = useState(Boolean(file.view_once_opened));
  const [requested, setRequested] = useState(autoLoad && !viewOnce);
  useEffect(() => {
    if (viewOnce) setViewOnceOpened(Boolean(file.view_once_opened));
    if (autoLoad && !viewOnce) setRequested(true);
  }, [autoLoad, file.view_once_opened, viewOnce]);
  useEffect(() => {
    if (!requested) return;
    let active = true;
    let url = "";
    protectedFileUrl(file.id).then(value => {
      url = value;
      if (active) {
        setSrc(value);
        if (viewOnce) setViewOnceOpened(true);
      }
      else URL.revokeObjectURL(value);
    }).catch((loadError: any) => {
      if (!active) return;
      if (viewOnce && loadError?.status === 410) setViewOnceOpened(true);
      else setError(messengerErrorMessage(loadError, "Impossible de charger ce vocal."));
    });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.id, requested, attempt, viewOnce]);
  if (viewOnce && viewOnceOpened && !src) return <View style={styles.onceOpened}>
    <Ionicons name="checkmark-circle-outline" size={19} color="#6d9271" />
    <Text style={styles.onceOpenedText}>Vocal déjà écouté</Text>
    <Ionicons name="timer-outline" size={18} color="#6d9271" />
  </View>;
  if (viewOnce && !requested) return <TouchableOpacity
    onPress={() => { setError(""); setRequested(true); }}
    accessibilityRole="button"
    accessibilityLabel="Ouvrir le message vocal une seule fois"
    testID={`messenger-voice-once-open-${file.id}`}
    style={styles.voiceLoad}
  >
    <Ionicons name="play-circle-outline" size={24} color={blue} />
    <Text style={styles.fileLabel}>Écouter une fois</Text>
    <Ionicons name="timer-outline" size={18} color={blue} />
  </TouchableOpacity>;
  if (!requested) return <TouchableOpacity onPress={() => setRequested(true)} accessibilityRole="button" accessibilityLabel={`Charger le vocal ${file.name}`} testID={`messenger-voice-load-${file.id}`} style={styles.voiceLoad}>
    <Ionicons name="download-outline" size={20} color={blue} /><Text style={styles.fileLabel}>Charger le vocal</Text>
  </TouchableOpacity>;
  if (error) return <View style={styles.voiceLoadError}>
    <TouchableOpacity onPress={() => { setError(""); setAttempt(value => value + 1); }} accessibilityRole="button" accessibilityLabel="Réessayer de charger le vocal" testID={`messenger-voice-retry-${file.id}`} style={styles.voiceLoad}>
      <Ionicons name="refresh-outline" size={18} color={blue} /><Text style={styles.fileLabel}>Réessayer le vocal</Text>
    </TouchableOpacity>
    <Text style={styles.voiceLoadErrorText} numberOfLines={4}>{error}</Text>
  </View>;
  return <VoiceMessage
    src={src}
    durationSeconds={file.duration_seconds}
    loading={!src}
    tint={own ? "own" : "other"}
    testID={`messenger-voice-${file.id}`}
    viewOnce={viewOnce}
  />;
}

export default function ConversationThread({ conversation, userId, onBack, onChanged, onDetails, onViewPhoto, onOpenUsername, hasActiveStatus, onOpenStatus, version, typing, scheduledEnabled = true, readReceipts, focusComposer = false, focusMessageId }: Props) {
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const emojiPickerHeight = Math.min(420, Math.max(180, windowHeight - 300));
  const [messages, setMessages] = useState<Message[]>([]);
  const [pinnedMessages, setPinnedMessages] = useState<Message[]>([]);
  const [jumpingToPinned, setJumpingToPinned] = useState(false);
  const [visualSettings, setVisualSettings] = useState<ChatVisualSettings>({});
  useEffect(() => {
    let active = true;
    api.get<ChatVisualSettings>("/messenger/settings").then(value => {
      if (active) setVisualSettings(value);
    }).catch(() => {});
    return () => { active = false; };
  }, [conversation.id]);
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
  const [savedStickers, setSavedStickers] = useState<Attachment[]>([]);
  const [packStickers, setPackStickers] = useState<Attachment[]>([]);
  const [builtinStickers, setBuiltinStickers] = useState<Attachment[]>([]);
  const [stickerLibraryError, setStickerLibraryError] = useState("");
  const [pendingMedia, setPendingMedia] = useState<File[] | null>(null);
  const [text, setText] = useState(conversation.draft || "");
  const [composerInputHeight, setComposerInputHeight] = useState(42);
  const [composerSelection, setComposerSelection] = useState({ start: (conversation.draft || "").length, end: (conversation.draft || "").length });
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [pickerTab, setPickerTab] = useState<"emoji" | "stickers">("emoji");
  const [composerActionsOpen, setComposerActionsOpen] = useState(false);
  const [pendingStickerCreation, setPendingStickerCreation] = useState(false);
  const [stickerVideo, setStickerVideo] = useState<File | null>(null);
  const [reply, setReply] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [historyQuery, setHistoryQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [contextMessage, setContextMessage] = useState<Message | null>(null);
  const [deletePromptMessage, setDeletePromptMessage] = useState<Message | null>(null);
  const [contextAnchor, setContextAnchor] = useState({ left: 12, top: 100, width: 1, height: 1 });
  const messagePressables = useRef(new Map<string, any>());
  const messageLayoutY = useRef(new Map<string, number>());
  const [focusedMessageId, setFocusedMessageId] = useState<string | null>(null);
  const [forwarding, setForwarding] = useState<Message | null>(null);
  const [targets, setTargets] = useState<Conversation[]>([]);
  const [recording, setRecording] = useState(false);
  const [recordingLocked, setRecordingLocked] = useState(false);
  const [recordingPaused, setRecordingPaused] = useState(false);
  const [recordingViewOnce, setRecordingViewOnce] = useState(false);
  const [recordingWaveform, setRecordingWaveform] = useState<number[]>(() => Array.from({ length: 38 }, () => 5));
  const [voiceSending, setVoiceSending] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [failedIds, setFailedIds] = useState<string[]>([]);
  const [failedMessages, setFailedMessages] = useState<Record<string, string>>({});
  const [sharingContact, setSharingContact] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [silent, setSilent] = useState(false);
  const [shareContacts, setShareContacts] = useState<Person[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const recentStickers = useMemo(
    () => messages
      .filter(message => message.sender_id === userId)
      .flatMap(message => message.attachments || [])
      .filter(file => (file.sticker || file.name.startsWith("sticker-")) && file.mime.startsWith("image/") && !file.view_once)
      .reverse()
      .slice(0, 24),
    [messages, userId],
  );
  const clearFailedMessage = (clientId: string) => setFailedMessages(previous => {
    if (!previous[clientId]) return previous;
    const next = { ...previous };
    delete next[clientId];
    return next;
  });
  useEffect(() => {
    let active = true;
    Promise.all([messengerApi.stickers(), messengerApi.stickerPack(), messengerApi.myStickerPack()])
      .then(([items, pack, mine]) => { if (active) { setSavedStickers(items); setBuiltinStickers(pack); setPackStickers(mine); setStickerLibraryError(""); } })
      .catch((error: any) => { if (active) setStickerLibraryError(error?.detail || "Les stickers enregistrés ne sont pas disponibles."); });
    return () => { active = false; };
  }, [userId]);
  const recorder = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const recordingElapsed = useRef({ activeMs: 0, segmentStartedAt: 0 });
  const voiceHold = useRef({
    active: false,
    started: false,
    locked: false,
    releasePending: false,
    startY: 0,
    timer: null as ReturnType<typeof setTimeout> | null,
    suppressPress: false,
  });
  const localVoiceUrls = useRef(new Set<string>());
  const discardRecording = useRef(false);
  const sendRecordingAfterStop = useRef(false);
  const recordingViewOnceRef = useRef(false);
  const sendVoiceRef = useRef<(blob: Blob, durationSeconds: number, viewOnce: boolean) => Promise<void>>(async () => {});
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
  const focusPendingMessage = useRef<string | null>(null);
  const focusedMessageRequest = useRef("");
  useEffect(() => {
    if (focusComposer) requestAnimationFrame(() => composerInput.current?.focus());
  }, [focusComposer, conversation.id]);
  const composerTextWidth = useRef(190);
  const changeDraft = (value: string) => {
    draftValue.current = value;
    setText(value);
    setComposerInputHeight(composerHeightFor(value, composerTextWidth.current));
  };
  const beginReply = (message: Message) => {
    setReply(message);
    setContextMessage(null);
    setEmojiPickerOpen(false);
    requestAnimationFrame(() => composerInput.current?.focus());
  };
  const openMessageContext = (message: Message, event?: any) => {
    const native = event?.nativeEvent || {};
    const pageX = Number(native.pageX ?? native.clientX) || windowWidth / 2;
    const pageY = Number(native.pageY ?? native.clientY) || windowHeight / 2;
    const setAnchor = (left: number, top: number, width: number, height: number) => {
      setContextAnchor({ left, top, width: Math.max(1, width), height: Math.max(1, height) });
      setContextMessage(message);
    };
    const target = messagePressables.current.get(message.id);
    if (target?.measureInWindow) {
      target.measureInWindow((left: number, top: number, width: number, height: number) => {
        if (Number.isFinite(top) && height > 1) setAnchor(left, top, width, height);
        else setAnchor(pageX, pageY - 24, 1, 48);
      });
    } else {
      setAnchor(pageX, pageY - 24, 1, 48);
    }
  };

  const loadMessages = async (q?: string, mode: "replace" | "merge" = "replace") => {
    setLoading(true);
    try {
      const result = await messengerApi.messages(conversation.id, undefined, q);
      setMessages(previous => mode === "merge" || (focusMessageId && !q)
        ? mergeMessages(previous, result.items)
        : result.items);
      if (mode === "merge") {
        const resolved = new Set(result.items.filter(message => message.sender_id === userId).map(message => message.client_id).filter(Boolean));
        setFailedIds(previous => previous.filter(id => !resolved.has(id)));
        setFailedMessages(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !resolved.has(id))));
        resolved.forEach(id => { if (id) delete retries.current[id]; });
      }
      setMore(result.has_more);
      setMessageError("");
    } catch (e: any) { setMessageError(e?.detail || "Impossible de charger l’historique."); }
    finally { setLoading(false); }
  };
  const loadPinnedMessages = async () => {
    try {
      const result = await messengerApi.pinnedMessages(conversation.id);
      setPinnedMessages(result.items);
    } catch {
      setPinnedMessages([]);
    }
  };
  useEffect(() => {
    setMessages([]);
    setPinnedMessages([]);
    messageLayoutY.current.clear();
    loadMessages();
    loadPinnedMessages();
  // The thread belongs to a conversation id; text is intentionally not a fetch dependency.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id]);
  useEffect(() => {
    if (!focusMessageId) return;
    const requestKey = `${conversation.id}:${focusMessageId}`;
    if (focusedMessageRequest.current === requestKey) return;
    focusedMessageRequest.current = requestKey;
    focusPendingMessage.current = focusMessageId;
    nearBottom.current = false;
    initialScrollPending.current = false;
    setFocusedMessageId(focusMessageId);
    let active = true;
    messengerApi.message(conversation.id, focusMessageId)
      .then(message => { if (active) setMessages(previous => mergeMessages(previous, [message])); })
      .catch(() => {
        if (!active) return;
        setMessageError("Ce message est introuvable ou a expiré.");
        initialScrollPending.current = true;
        nearBottom.current = true;
        requestAnimationFrame(() => scroll.current?.scrollToEnd({ animated: false }));
      });
    return () => { active = false; };
  }, [conversation.id, focusMessageId]);
  useEffect(() => {
    if (lastVersion.current !== version) {
      lastVersion.current = version;
      loadMessages(undefined, "merge");
      loadPinnedMessages();
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
    const timer = setInterval(() => {
      const now = Date.now();
      const elapsed = recordingElapsed.current.activeMs
        + (recordingPaused || !recordingElapsed.current.segmentStartedAt
          ? 0
          : now - recordingElapsed.current.segmentStartedAt);
      setRecordSeconds(Math.floor(elapsed / 1000));
      const analyser = analyserRef.current;
      if (!recordingPaused && analyser) {
        const samples = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, value) => sum + (value - 128) ** 2, 0) / samples.length) / 128;
        const height = Math.max(4, Math.min(38, Math.round(4 + rms * 96)));
        setRecordingWaveform(previous => [...previous.slice(1), height]);
      } else if (!recordingPaused) {
        const height = 5 + Math.round(Math.abs(Math.sin(now / 95)) * 17);
        setRecordingWaveform(previous => [...previous.slice(1), height]);
      }
    }, 90);
    return () => clearInterval(timer);
  }, [recording, recordingPaused]);
  useEffect(() => () => {
    if (voiceHold.current.timer) clearTimeout(voiceHold.current.timer);
    voiceHold.current.active = false;
    discardRecording.current = true;
    sendRecordingAfterStop.current = false;
    if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop();
    streamRef.current?.getTracks().forEach(track => track.stop());
    audioContextRef.current?.close().catch(() => {});
  }, []);
  useEffect(() => () => {
    localVoiceUrls.current.forEach(url => URL.revokeObjectURL(url));
    localVoiceUrls.current.clear();
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
  const jumpToMessage = async (messageId: string, missingMessage: string) => {
    let loadedMessages = messages;
    let hasOlder = more;
    while (!loadedMessages.some(message => message.id === messageId) && hasOlder && loadedMessages.length) {
      const page = await messengerApi.messages(conversation.id, loadedMessages[0].id);
      if (!page.items.length) {
        hasOlder = false;
        break;
      }
      loadedMessages = mergeMessages(loadedMessages, page.items);
      hasOlder = page.has_more;
      setMessages(loadedMessages);
      setMore(hasOlder);
    }
    if (!loadedMessages.some(message => message.id === messageId)) {
      setMessageError(missingMessage);
      return;
    }
    nearBottom.current = false;
    focusPendingMessage.current = messageId;
    setFocusedMessageId(messageId);
    const y = messageLayoutY.current.get(messageId);
    if (y !== undefined) {
      focusPendingMessage.current = null;
      requestAnimationFrame(() => scroll.current?.scrollTo({ y: Math.max(0, y - 64), animated: true }));
      setTimeout(() => setFocusedMessageId(current => current === messageId ? null : current), 2400);
    }
  };
  const jumpToPinnedMessage = async (messageId: string) => {
    if (jumpingToPinned) return;
    setJumpingToPinned(true);
    try {
      await jumpToMessage(messageId, "Le message épinglé n’est plus disponible.");
    } catch (error: any) {
      setMessageError(error?.detail || "Impossible d’ouvrir le message épinglé.");
    } finally {
      setJumpingToPinned(false);
    }
  };
  const jumpToReplyMessage = async (messageId: string) => {
    try {
      await jumpToMessage(messageId, "Le message cité n’est plus disponible.");
    } catch (error: any) {
      setMessageError(error?.detail || "Impossible d’ouvrir le message cité.");
    }
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
    } catch (error) {
      setFailedIds(prev => prev.includes(client_id) ? prev : [...prev, client_id]);
      setFailedMessages(previous => ({
        ...previous,
        [client_id]: messengerErrorMessage(error, "L’envoi du message a échoué."),
      }));
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
    if (initialScrollPending.current) {
      scroll.current?.scrollToEnd({ animated: false });
      nearBottom.current = true;
      return;
    }
    if (!nearBottom.current) return;
    scroll.current?.scrollToEnd({ animated: true });
  };
  const handleHistoryScroll = (event: any) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    nearBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 90;
  };
  useEffect(() => {
    if (loading || !initialScrollPending.current || focusMessageId) return;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      if (!initialScrollPending.current) return;
      scroll.current?.scrollToEnd({ animated: false });
      secondFrame = requestAnimationFrame(() => {
        if (!initialScrollPending.current) return;
        scroll.current?.scrollToEnd({ animated: false });
        initialScrollPending.current = false;
        nearBottom.current = true;
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [loading, messages.length, conversation.id, focusMessageId]);
  const insertEmoji = (emoji: string) => {
    const current = draftValue.current;
    const start = Math.max(0, Math.min(composerSelection.start, current.length));
    const end = Math.max(start, Math.min(composerSelection.end, current.length));
    const next = `${current.slice(0, start)}${emoji}${current.slice(end)}`;
    const cursor = start + emoji.length;
    setComposerSelection({ start: cursor, end: cursor });
    updateComposer(next);
    setPickerTab("emoji");
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
    setPickerTab("emoji");
    setEmojiPickerOpen(true);
  };
  const toggleStickerPicker = () => {
    Keyboard.dismiss();
    composerInput.current?.blur();
    setPickerTab("stickers");
    setEmojiPickerOpen(true);
  };
  const retrySend = async (clientId: string) => {
    const retry = retries.current[clientId];
    if (!retry) return;
    const pendingUrls = messages
      .find(message => message.client_id === clientId)?.attachments
      .map(file => file.local_url)
      .filter((url): url is string => Boolean(url)) || [];
    setFailedIds(prev => prev.filter(id => id !== clientId));
    clearFailedMessage(clientId);
    setMessages(previous => previous.map(message => message.client_id === clientId ? {
      ...message,
      attachments: message.attachments.map(file => file.local_url
        ? { ...file, uploading: true, upload_failed: false }
        : file),
    } : message));
    try {
      const sent = await retry();
      setMessages(prev => prev.map(m => m.client_id === clientId ? sent : m));
      delete retries.current[clientId];
      clearFailedMessage(clientId);
      pendingUrls.forEach(url => {
        URL.revokeObjectURL(url);
        localVoiceUrls.current.delete(url);
      });
      onChanged();
    } catch (error) {
      setFailedIds(prev => [...prev, clientId]);
      setFailedMessages(previous => ({
        ...previous,
        [clientId]: messengerErrorMessage(error, "L’envoi du message a échoué."),
      }));
      setMessages(previous => previous.map(message => message.client_id === clientId ? {
        ...message,
        attachments: message.attachments.map(file => file.local_url
          ? { ...file, uploading: false, upload_failed: true }
          : file),
      } : message));
    }
  };
  const action = async (message: Message, kind: string, body?: any) => {
    const root = `/messenger/conversations/${encodeURIComponent(conversation.id)}/messages/${encodeURIComponent(message.id)}`;
    try {
      let updated: Message | undefined;
      if (kind === "edit") updated = await messengerApiPatch(root, body);
      if (kind === "delete") await fetchAction(`${root}?scope=${body?.scope === "me" ? "me" : "everyone"}`, "DELETE");
      if (kind === "reaction") updated = await fetchAction(`${root}/reaction`, "POST", body);
      if (kind === "pin") updated = await fetchAction(`${root}/pin`, "POST");
       if (kind === "edit" && updated) setMessages(prev => prev.map(m => m.id === message.id ? updated! : m));
       else if (kind === "delete") {
         setMessages(prev => prev.filter(m => m.id !== message.id));
         setPinnedMessages(prev => prev.filter(item => item.id !== message.id));
       }
      else if (updated) setMessages(prev => prev.map(m => m.id === message.id ? updated! : m));
       if (kind === "pin" && updated) {
         setPinnedMessages(previous => [
           ...previous.filter(item => item.id !== updated!.id),
           ...(updated!.pinned ? [updated!] : []),
         ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()));
       }
      setContextMessage(null);
      setDeletePromptMessage(null);
      return true;
    } catch (e: any) { if (typeof window !== "undefined") window.alert(e?.detail || "Action impossible."); return false; }
  };
  const copyMessage = async (message: Message) => {
    const text = message.text || message.attachments?.map(file => file.name).filter(Boolean).join("\n") || "";
    if (!text) return;
    try { await Clipboard.setStringAsync(text); setContextMessage(null); }
    catch { if (typeof window !== "undefined") window.alert("Copie du message impossible."); }
  };
  const copyMessageLink = async (message: Message) => {
    const origin = typeof window !== "undefined" ? window.location.origin : "https://spiloveure.org";
    const url = `${origin}/messenger?conversation=${encodeURIComponent(conversation.id)}&message=${encodeURIComponent(message.id)}`;
    try { await Clipboard.setStringAsync(url); setContextMessage(null); }
    catch { if (typeof window !== "undefined") window.alert("Copie du lien impossible."); }
  };
  const saveMessageMedia = async (message: Message) => {
    if (Platform.OS !== "web" || typeof document === "undefined") {
      if (typeof window !== "undefined") window.alert("Enregistrement direct disponible depuis la version web.");
      return;
    }
    const files = (message.attachments || []).filter(file => !file.view_once);
    try {
      for (const file of files) {
        const url = await protectedFileUrl(file.id, true);
        const link = document.createElement("a");
        link.href = url;
        link.download = file.name || `spiloveure-${file.id}`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        if (url.startsWith("blob:")) window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
      setContextMessage(null);
    } catch (e: any) {
      if (typeof window !== "undefined") window.alert(e?.message || "Enregistrement du média impossible.");
    }
  };
  const messengerApiPatch = async (path: string, body: any) => {
    return api.patch<Message>(path, body);
  };
  const fetchAction = async (path: string, method: string, body?: any) => {
    if (method === "DELETE") return api.delete(path);
    return api.post<Message>(path, body);
  };
  const openAttachment = async (file: Attachment, loadedUrl?: string) => {
    try {
      await openProtectedAttachment(file, setAttachmentPreview, loadedUrl);
    } catch (e: any) { if (typeof window !== "undefined") window.alert(e.message); }
  };
  const openSticker = async (file: Attachment, messageId: string) => {
    try {
      const url = await protectedFileUrl(file.id);
      setAttachmentPreview({
        url, mime: file.mime, name: file.name, fileId: file.id,
        releaseUrl: url.startsWith("blob:"),
        sticker: { conversationId: conversation.id, messageId },
      });
    } catch (e: any) { if (typeof window !== "undefined") window.alert(e?.message || "Impossible d’ouvrir ce sticker."); }
  };
  const savePreviewSticker = async () => {
    const preview = attachmentPreview;
    if (!preview?.sticker || !preview.fileId) throw new Error("Ce sticker n’est plus disponible.");
    const saved = await messengerApi.saveSticker(
      preview.sticker.conversationId, preview.sticker.messageId, preview.fileId,
    );
    setSavedStickers(current => [saved, ...current.filter(file => file.id !== saved.id)]);
  };
  const removePreviewSticker = async () => {
    if (!attachmentPreview?.fileId) return;
    const id = attachmentPreview.fileId;
    await messengerApi.removeSticker(id);
    setSavedStickers(current => current.filter(file => file.id !== id));
  };
  const addPreviewStickerToPack = async () => {
    const preview = attachmentPreview;
    if (!preview?.sticker || !preview.fileId) throw new Error("Ce sticker n’est plus disponible.");
    const added = await messengerApi.addStickerToPack(
      preview.sticker.conversationId, preview.sticker.messageId, preview.fileId,
    );
    setPackStickers(current => [added, ...current.filter(file => file.id !== added.id)]);
  };
  const removePreviewStickerFromPack = async () => {
    if (!attachmentPreview?.fileId) return;
    const id = attachmentPreview.fileId;
    await messengerApi.removeStickerFromPack(id);
    setPackStickers(current => current.filter(file => file.id !== id));
  };
  const editPreviewSticker = async () => {
    const preview = attachmentPreview;
    if (!preview?.sticker || !preview.url || typeof File === "undefined") return;
    const blob = await (await fetch(preview.url)).blob();
    const originalName = preview.name.replace(/^sticker-/i, "");
    const editedFile = normalizeMediaFile(new File([blob], `sticker-${originalName || "modifie.webp"}`, {
      type: blob.type || preview.mime, lastModified: Date.now(),
    }));
    setPendingStickerCreation(true);
    setPendingMedia([editedFile]);
    if (preview.releaseUrl) URL.revokeObjectURL(preview.url);
    setAttachmentPreview(null);
  };
  const selectSticker = async (file: Attachment) => {
    setEmojiPickerOpen(false);
    try {
      const attachment = file.id.startsWith("pack-") || savedStickers.some(saved => saved.id === file.id) || packStickers.some(saved => saved.id === file.id)
        ? await messengerApi.copySticker(conversation.id, file.id)
        : file;
      await send({ attachments: [attachment], text: "" });
    } catch (error: any) {
      if (typeof window !== "undefined") window.alert(error?.detail || error?.message || "Impossible d’envoyer ce sticker.");
    }
  };
  const attachFile = () => {
    if (!canSend || typeof document === "undefined") return;
    const input = document.createElement("input"); input.type = "file"; input.multiple = true;
    input.accept = "image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.zip,.txt";
    input.onchange = async () => {
      try {
        const files = Array.from(input.files || []).map(normalizeMediaFile);
        if (!files.length) return;
        validateChatFiles(files);
        if (files.some(file => file.type.startsWith("image/") || file.type.startsWith("video/"))) {
          setPendingStickerCreation(false);
          setPendingMedia(files);
          return;
        }
        const attached: Attachment[] = [];
        for (const file of files) {
          attached.push(await messengerApi.file(conversation.id, file));
        }
        await send({ attachments: attached });
      } catch (e: any) { window.alert(e?.detail || e.message || "Envoi du fichier impossible."); }
    };
    input.click();
  };
  const createSticker = () => {
    if (!canSend || typeof document === "undefined") return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/gif,video/*";
    input.onchange = () => {
      try {
        const selected = input.files?.[0];
        if (!selected) return;
        const file = normalizeMediaFile(selected);
        validateChatFiles([file]);
        if (file.type.startsWith("video/")) {
          setStickerVideo(file); setEmojiPickerOpen(false); return;
        }
        setPendingStickerCreation(true);
        setPendingMedia([file]);
        setEmojiPickerOpen(false);
      } catch (e: any) {
        window.alert(e?.detail || e.message || "Impossible de créer le sticker.");
      }
    };
    input.click();
  };
  const sendSelectedMedia = async (files: File[], caption: string) => {
    const filesToSend = pendingStickerCreation
      ? files.map(file => file.name.startsWith("sticker-") ? file : new File(
        [file], `sticker-${file.name}`, { type: file.type, lastModified: file.lastModified },
      ))
      : files;
    validateChatFiles(filesToSend);
    const attached: Attachment[] = [];
    for (const file of filesToSend) {
      attached.push(await messengerApi.file(conversation.id, file, undefined, false, pendingStickerCreation));
    }
    await send({ attachments: attached, text: pendingStickerCreation ? "" : caption });
    setPendingMedia(null);
    setPendingStickerCreation(false);
  };
  const sendVoiceBlob = async (blob: Blob, durationSeconds: number, viewOnce: boolean) => {
    const client_id = makeId();
    try {
      const mime = blob.type || "audio/webm";
      const extension = mime.includes("ogg") ? ".ogg" : mime.includes("mp4") ? ".m4a" : mime.includes("mpeg") ? ".mp3" : ".webm";
      const file = new File([blob], `message-vocal-${Date.now()}${extension}`, { type: mime });
      if (file.size > 20 * 1024 * 1024) throw new Error("Le message vocal dépasse 20 Mo.");
      const localUrl = URL.createObjectURL(blob);
      localVoiceUrls.current.add(localUrl);
      const localAttachment: Attachment = {
        id: `pending:${client_id}`, name: file.name, mime, size: file.size, url: localUrl,
        duration_seconds: durationSeconds, view_once: viewOnce, local_url: localUrl, uploading: true,
      };
      const silentSend = silent;
      const replyTo = reply?.id;
      const optimistic: Message = {
        id: `pending:${client_id}`, client_id, conversation_id: conversation.id, sender_id: userId,
        sender_name: "Vous", text: "", created_at: new Date().toISOString(), deleted: false,
        attachments: [localAttachment], reactions: {}, pinned: false, read_by: [], reply_to: replyTo,
      };
      nearBottom.current = true;
      setMessages(previous => [...previous, optimistic]);
      setReply(null);
      changeDraft("");
      setSilent(false);
      setVoiceSending(false);

      let uploaded: Attachment | null = null;
      const transmit = async () => {
        if (!uploaded) uploaded = await messengerApi.file(conversation.id, file, durationSeconds, viewOnce);
        return messengerApi.send(conversation.id, {
          text: "", client_id, attachments: [uploaded], reply_to: replyTo,
          silent: silentSend || undefined,
        });
      };
      retries.current[client_id] = transmit;
      try {
        const sent = await transmit();
        setMessages(previous => previous.map(message => message.client_id === client_id ? sent : message));
        setFailedIds(previous => previous.filter(id => id !== client_id));
        delete retries.current[client_id];
        localVoiceUrls.current.delete(localUrl);
        URL.revokeObjectURL(localUrl);
        onChanged();
      } catch (error) {
        setFailedIds(previous => previous.includes(client_id) ? previous : [...previous, client_id]);
        setFailedMessages(previous => ({
          ...previous,
          [client_id]: messengerErrorMessage(error, "L’envoi du vocal a échoué."),
        }));
        setMessages(previous => previous.map(message => message.client_id === client_id ? {
          ...message,
          attachments: message.attachments.map(item => item.local_url === localUrl
            ? { ...item, uploading: false, upload_failed: true }
            : item),
        } : message));
      }
    } catch (e: any) {
      setVoiceSending(false);
      if (typeof window !== "undefined") window.alert(e?.detail || e?.message || "Envoi vocal impossible.");
    }
  };
  sendVoiceRef.current = sendVoiceBlob;
  const releaseVoiceResources = () => {
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    analyserRef.current = null;
    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context && context.state !== "closed") void context.close().catch(() => {});
  };
  const cancelVoiceRecording = () => {
    if (voiceHold.current.timer) clearTimeout(voiceHold.current.timer);
    voiceHold.current.active = false;
    voiceHold.current.started = false;
    voiceHold.current.locked = false;
    voiceHold.current.releasePending = false;
    setRecordingLocked(false);
    discardRecording.current = true;
    sendRecordingAfterStop.current = false;
    if (recorder.current?.state !== "inactive") recorder.current?.stop();
    releaseVoiceResources();
    recordingElapsed.current = { activeMs: 0, segmentStartedAt: 0 };
    recordingViewOnceRef.current = false;
    setRecording(false);
    setRecordingPaused(false);
    setRecordingViewOnce(false);
    setRecordSeconds(0);
    setRecordingWaveform(Array.from({ length: 38 }, () => 5));
  };
  const toggleVoicePause = () => {
    const rec = recorder.current;
    const now = Date.now();
    if (!rec) return;
    if (rec.state === "recording") {
      recordingElapsed.current.activeMs += Math.max(0, now - recordingElapsed.current.segmentStartedAt);
      recordingElapsed.current.segmentStartedAt = 0;
      rec.pause();
      setRecordingPaused(true);
    } else if (rec.state === "paused") {
      recordingElapsed.current.segmentStartedAt = now;
      rec.resume();
      setRecordingPaused(false);
    }
  };
  const sendVoiceRecording = () => {
    const rec = recorder.current;
    if (!rec || rec.state === "inactive") return;
    voiceHold.current.active = false;
    voiceHold.current.releasePending = false;
    sendRecordingAfterStop.current = true;
    setVoiceSending(true);
    rec.stop();
    setRecording(false);
    setRecordingLocked(false);
    setRecordingPaused(false);
  };
  const toggleRecordingViewOnce = () => {
    const next = !recordingViewOnceRef.current;
    recordingViewOnceRef.current = next;
    setRecordingViewOnce(next);
  };
  const voice = async () => {
    if (!canSend) return;
    if (recording || voiceSending) return;
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
      sendRecordingAfterStop.current = false;
      recordingViewOnceRef.current = false;
      setRecordingViewOnce(false);
      setRecordingPaused(false);
      setRecordingWaveform(Array.from({ length: 38 }, () => 5));
      try {
        const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioContextCtor) {
          const context = new AudioContextCtor();
          const analyser = context.createAnalyser();
          analyser.fftSize = 256;
          context.createMediaStreamSource(stream).connect(analyser);
          audioContextRef.current = context;
          analyserRef.current = analyser;
          if (context.state === "suspended") await context.resume();
        }
      } catch {
        analyserRef.current = null;
      }
      rec.onstop = () => {
        const recordedType = rec.mimeType || chunks.find(chunk => chunk instanceof Blob)?.type || "audio/webm";
        const elapsed = recordingElapsed.current.activeMs
          + (recordingElapsed.current.segmentStartedAt
            ? Date.now() - recordingElapsed.current.segmentStartedAt
            : 0);
        const durationSeconds = Math.max(0.1, elapsed / 1000);
        recordingElapsed.current = { activeMs: 0, segmentStartedAt: 0 };
        setRecording(false);
        setRecordingLocked(false);
        setRecordingPaused(false);
        if (!discardRecording.current && sendRecordingAfterStop.current) {
          sendRecordingAfterStop.current = false;
          const blob = new Blob(chunks, { type: recordedType });
          if (blob.size) void sendVoiceRef.current(blob, durationSeconds, recordingViewOnceRef.current);
          else {
            setVoiceSending(false);
            if (typeof window !== "undefined") window.alert("Aucun son n’a été enregistré. Réessayez.");
          }
        }
        releaseVoiceResources();
        recordingViewOnceRef.current = false;
        setRecordingViewOnce(false);
      };
      recorder.current = rec;
      recordingElapsed.current = { activeMs: 0, segmentStartedAt: Date.now() };
      setRecordSeconds(0);
      setRecordingLocked(voiceHold.current.locked);
      setRecording(true);
      rec.start(100);
      if (voiceHold.current.releasePending && !voiceHold.current.locked) {
        voiceHold.current.releasePending = false;
        requestAnimationFrame(sendVoiceRecording);
      }
    } catch {
      voiceHold.current.active = false;
      voiceHold.current.started = false;
      voiceHold.current.locked = false;
      voiceHold.current.releasePending = false;
      setRecordingLocked(false);
      if (typeof window !== "undefined") window.alert("Autorisez le microphone pour enregistrer.");
    }
  };
  const startVoiceHold = (event: any) => {
    if (recording || voiceSending) return;
    const hold = voiceHold.current;
    if (hold.timer) clearTimeout(hold.timer);
    hold.active = true;
    hold.started = false;
    hold.locked = false;
    hold.releasePending = false;
    hold.suppressPress = false;
    hold.startY = Number(event?.nativeEvent?.pageY) || 0;
    hold.timer = setTimeout(() => {
      hold.timer = null;
      if (!hold.active) return;
      hold.started = true;
      void voice();
    }, 280);
  };
  const moveVoiceHold = (event: any) => {
    const hold = voiceHold.current;
    if (!hold.active || !hold.started || hold.locked) return;
    const touch = event?.nativeEvent?.touches?.[0] || event?.nativeEvent?.changedTouches?.[0];
    const currentY = Number(touch?.pageY ?? event?.nativeEvent?.pageY);
    if (!Number.isFinite(currentY) || hold.startY <= 0 || hold.startY - currentY < 72) return;
    hold.locked = true;
    setRecordingLocked(true);
  };
  const finishVoiceHold = () => {
    const hold = voiceHold.current;
    if (hold.timer) {
      clearTimeout(hold.timer);
      hold.timer = null;
    }
    if (!hold.active) return;
    hold.active = false;
    if (!hold.started) return;
    hold.suppressPress = true;
    setTimeout(() => { hold.suppressPress = false; }, 500);
    if (hold.locked) return;
    const rec = recorder.current;
    if (rec && rec.state !== "inactive") sendVoiceRecording();
    else hold.releasePending = true;
  };
  const pressVoiceButton = () => {
    if (voiceHold.current.suppressPress) {
      voiceHold.current.suppressPress = false;
      return;
    }
    if (!voiceHold.current.started) void voice();
  };
  const forward = async (target: Conversation) => {
    if (!forwarding) return;
    try {
      const attachments: Attachment[] = [];
      for (const source of forwarding.attachments || []) {
        if (source.view_once) throw new Error("Les messages vocaux à écoute unique ne peuvent pas être transférés.");
        const protectedUrl = await protectedFileUrl(source.id);
        try {
          const response = await fetch(protectedUrl);
          if (!response.ok) throw new Error("Téléchargement de la pièce jointe impossible.");
          const blob = await response.blob();
          const file = new File([blob], source.name || `fichier-${source.id}`, { type: source.mime || blob.type });
          attachments.push(await messengerApi.file(target.id, file, source.duration_seconds));
        } finally {
          if (protectedUrl.startsWith("blob:")) URL.revokeObjectURL(protectedUrl);
        }
      }
      await messengerApi.send(target.id, { text: forwarding.text, client_id: makeId(), attachments, forwarded_from: forwarding.id });
      setForwarding(null);
      onChanged();
    }
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
      return <Text key={`${index}-${part}`} style={styles.linkText} onPress={event => { event.stopPropagation?.(); openUrl(part); }}>{part}</Text>;
    }
    const handle = part.match(/^SPV@(.+)$/i);
    return handle
      ? <Text key={`${index}-${part}`} style={styles.linkText} onPress={event => { event.stopPropagation?.(); onOpenUsername?.(handle[1]); }}>{part}</Text>
      : <Text key={`${index}-${part}`}>{part}</Text>;
  });
  const otherPerson = conversation.member_profiles.find(person => person.id !== userId);
  const otherPhoto = (conversation.is_saved
    ? conversation.member_profiles.find(person => person.id === userId)?.avatar
    : otherPerson?.avatar) || conversation.photo;
  const isChannelAdmin = conversation.admins.includes(userId) || conversation.owner_id === userId;
  const canSend = conversation.kind !== "channel" || isChannelAdmin;
  const darkMode = visualSettings.appearance === "dark";
  const chatSurface = darkMode ? "#111827" : "transparent";
  const ownBubbleColor = messageColors[visualSettings.message_color || "green"];
  const mediaMaxWidth = Math.max(1, Math.min(240, Math.floor(windowWidth * 0.64)));
  const textScale = Math.min(1.4, Math.max(0.9, Number(visualSettings.font_scale) || 1));
  const presence = conversation.is_saved ? "Votre espace privé" : otherPerson?.online ? "En ligne" : otherPerson?.last_seen
    ? `Vu ${new Date(otherPerson.last_seen).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}`
    : conversation.kind === "private" ? "Membre SPILOVEURE" : `${conversation.member_profiles.length} membres`;
  const pinnedMessage = pinnedMessages[0];
  const pinnedMessagePreview = pinnedMessage?.text
    || pinnedMessage?.attachments?.[0]?.name
    || "Pièce jointe";

  return (
    <View
      style={[styles.thread, { backgroundColor: darkMode ? "#111827" : "#b9e3d9" }]}
      onTouchMove={moveVoiceHold}
      onTouchEnd={finishVoiceHold}
    >
      {!darkMode && <ChatWallpaper />}
      <View style={[styles.threadHead, { backgroundColor: chatSurface }, darkMode && styles.threadHeadDark]}>
        <TouchableOpacity onPress={onBack} style={[styles.backButton, darkMode && styles.headerPillDark]} accessibilityLabel="Retour aux conversations" testID="messenger-back"><Ionicons name="arrow-back" size={23} color={blue} /></TouchableOpacity>
        <View style={[styles.identityPill, darkMode && styles.headerPillDark]}>
          <TouchableOpacity onPress={() => conversation.is_saved ? onDetails() : hasActiveStatus ? onOpenStatus?.() : otherPhoto ? onViewPhoto(otherPhoto, conversation.title) : onDetails()} style={[styles.avatar, conversation.is_saved && styles.savedAvatar, hasActiveStatus && styles.avatarStoryRing]} accessibilityRole="button" accessibilityLabel={hasActiveStatus ? `Voir le statut de ${conversation.title}` : conversation.is_saved ? "Messages enregistrés" : otherPhoto ? `Afficher la photo de ${conversation.title}` : `Détails de ${conversation.title}`} testID="messenger-thread-avatar">
            {conversation.is_saved ? <Ionicons name="bookmark" size={22} color="#fff" /> : otherPhoto ? <Image source={{ uri: otherPhoto }} style={[styles.avatarPhoto, hasActiveStatus && styles.avatarPhotoStory]} /> : <Text style={styles.avatarText}>{conversation.title.slice(0, 1).toUpperCase()}</Text>}
          </TouchableOpacity>
          <TouchableOpacity onPress={onDetails} style={styles.identityText} activeOpacity={0.75} accessibilityRole="button">
            <Text style={[styles.name, darkMode && styles.nameDark]} numberOfLines={1} testID="messenger-thread-title">{conversation.title}</Text><Text style={[styles.presence, darkMode && styles.presenceDark, typing && styles.typing]}>{typing ? `${typing.username || "Quelqu’un"} écrit…` : presence}</Text>
          </TouchableOpacity>
        </View>
        <View style={[styles.headerActionPill, darkMode && styles.headerPillDark]}>
          <TouchableOpacity style={styles.headerAction} onPress={() => setSearching(v => !v)} accessibilityLabel="Rechercher dans la discussion" testID="messenger-thread-search"><Ionicons name="search" size={21} color={blue} /></TouchableOpacity>
          <TouchableOpacity style={styles.headerAction} onPress={() => setHeaderMenuOpen(true)} accessibilityLabel="Plus d’options" testID="messenger-header-more"><Ionicons name="ellipsis-vertical" size={20} color={blue} /></TouchableOpacity>
        </View>
      </View>
      {searching && <View style={[styles.searchRow, { backgroundColor: chatSurface }]}><TextInput value={historyQuery} onChangeText={setHistoryQuery} placeholder="Rechercher dans l’historique" style={styles.searchInput} onSubmitEditing={() => loadMessages(historyQuery)} /><TouchableOpacity onPress={() => loadMessages(historyQuery)}><Ionicons name="search" size={20} color={blue} /></TouchableOpacity></View>}
      {pinnedMessage && <TouchableOpacity
        style={[styles.pinnedMessageBanner, darkMode && styles.pinnedMessageBannerDark]}
        onPress={() => void jumpToPinnedMessage(pinnedMessage.id)}
        disabled={jumpingToPinned}
        accessibilityRole="button"
        accessibilityLabel={`Aller au message épinglé : ${pinnedMessagePreview}`}
        testID="messenger-pinned-message-banner"
      >
        <Ionicons name="pin" size={19} color={blue} />
        <View style={styles.pinnedMessageCopy}>
          <Text style={styles.pinnedMessageLabel}>Message épinglé{pinnedMessages.length > 1 ? ` · ${pinnedMessages.length}` : ""}</Text>
          <Text numberOfLines={1} style={[styles.pinnedMessageText, darkMode && styles.pinnedMessageTextDark]}>{pinnedMessagePreview}</Text>
        </View>
        {jumpingToPinned ? <ActivityIndicator size="small" color={blue} /> : <Ionicons name="chevron-forward" size={19} color={muted} />}
      </TouchableOpacity>}
      <ScrollView ref={scroll} style={[styles.history, { backgroundColor: chatSurface }]} contentContainerStyle={[styles.historyContent, { backgroundColor: chatSurface }]} onContentSizeChange={handleHistoryContentSizeChange} onScroll={handleHistoryScroll} scrollEventThrottle={100}>
        {more && <TouchableOpacity onPress={fetchOlder} style={styles.older}><Text style={styles.olderText}>Charger les messages précédents</Text></TouchableOpacity>}
        {messageError ? <TouchableOpacity onPress={() => loadMessages(historyQuery || undefined)} style={styles.historyError}><Text style={styles.historyErrorText}>{messageError} · Réessayer</Text></TouchableOpacity> : null}
        {loading ? <ActivityIndicator color={blue} /> : messages.length === 0 && !messageError ? <View style={styles.empty}><Text style={styles.emptyTitle}>Votre conversation commence ici</Text><Text style={styles.emptyText}>Envoyez un message à {conversation.title}.</Text></View> : null}
        {messages.map(message => {
          const own = message.sender_id === userId;
          const quoted = message.reply_to ? messages.find(item => item.id === message.reply_to) : undefined;
          const stickerFiles = (message.attachments || []).filter(file => (file.sticker || file.name.toLowerCase().startsWith("sticker-")) && file.mime.startsWith("image/"));
          const mediaFiles = (message.attachments || []).filter(file =>
            (file.mime.startsWith("image/") || file.mime.startsWith("video/"))
            && !(file.sticker || file.name.toLowerCase().startsWith("sticker-")));
          const stickerOnlyMessage = stickerFiles.length === 1 && !mediaFiles.length
            && !message.text && !message.reply_to && !message.forwarded_from && !message.status_reply;
          const mediaOnlyMessage = mediaFiles.length === 1 && !message.text && !message.reply_to
            && !message.forwarded_from && !message.status_reply && !stickerFiles.length;
          const hasStickerAttachment = stickerFiles.length > 0;
          const bubble = <View
             style={[
               styles.bubble, own ? styles.ownBubble : styles.otherBubble,
               stickerOnlyMessage && styles.stickerBubble,
               mediaOnlyMessage && { padding: 3, paddingBottom: 3, borderRadius: 13 },
               { backgroundColor: stickerOnlyMessage ? "transparent" : own ? ownBubbleColor : darkMode ? "#263244" : "#fff" },
               darkMode && { borderColor: "#3a4759" },
                focusedMessageId === message.id && styles.focusedBubble,
             ]}
            accessibilityRole="text"
            accessibilityLabel={`${own ? "Message envoyé" : `Message de ${message.sender_name}`}${message.text ? ` : ${message.text}` : message.attachments?.some(file => file.mime.startsWith("audio/")) ? " : message vocal" : ""}`}
            testID={`messenger-message-bubble-${message.id}`}
          >
              {!own && !stickerOnlyMessage && !mediaOnlyMessage && <Text style={styles.sender}>{message.sender_name}</Text>}
              {message.deleted ? <Text style={styles.deleted}>Message supprimé</Text> : <>
                {message.forwarded_from && <Text style={styles.forwarded}>Message transféré</Text>}
                {!!message.reply_to && <TouchableOpacity
                  style={styles.replyQuote}
                  onPress={event => { event.stopPropagation?.(); void jumpToReplyMessage(message.reply_to!); }}
                  accessibilityRole="button"
                  accessibilityLabel="Aller au message cité"
                  testID={`messenger-reply-quote-${message.id}`}
                >
                  <Text style={styles.replyQuoteSender}>{quoted?.sender_name || "Message précédent"}</Text>
                  <Text numberOfLines={2} style={styles.replyQuotePreview}>{quoted?.deleted ? "Message supprimé" : quoted?.text || quoted?.attachments?.[0]?.name || "Pièce jointe"}</Text>
                </TouchableOpacity>}
                {message.status_reply && <View style={styles.statusReplyCard} testID={`messenger-status-reply-${message.id}`}>
                  <TouchableOpacity style={styles.statusReplyHeader} onPress={event => { event.stopPropagation?.(); onOpenStatus?.(message.status_reply?.author_id, message.status_reply?.status_id); }} accessibilityRole="button" accessibilityLabel={`Revoir le statut de ${message.status_reply.author_name}`}>
                    <View style={styles.statusReplyCopy}>
                      <Text style={styles.statusReplyTitle}>Statut de {message.status_reply.author_name}</Text>
                      <Text numberOfLines={2} style={styles.statusReplyText}>{message.status_reply.text || (message.status_reply.attachments?.length ? "Photo du statut" : "Statut")}</Text>
                    </View>
                    <Ionicons name="arrow-forward" size={15} color={blue} />
                  </TouchableOpacity>
                  {!!message.status_reply.attachments?.length && <View style={styles.statusReplyMedia}>
                     {message.status_reply.attachments.slice(0, 1).map(file =>
                        <ProtectedMessageMedia key={file.id} file={file} compact maxWidth={180} onOpen={url => openAttachment(file, url)} onLongPress={event => openMessageContext(message, event)} />)}
                  </View>}
                </View>}
                {!!stickerFiles.length && <View style={[styles.stickerGroup, { maxWidth: mediaMaxWidth }, own ? { alignSelf: "flex-end", justifyContent: "flex-end" } : { alignSelf: "flex-start" }]}>
                  {stickerFiles.map(file =>
                    <ProtectedMessageMedia key={file.id} file={file} maxWidth={mediaMaxWidth} onOpen={() => openSticker(file, message.id)} onLongPress={event => openMessageContext(message, event)} autoLoad={visualSettings.auto_load_media !== false} />)}
                </View>}
                {!!mediaFiles.length && <View style={[styles.mediaGroup, { maxWidth: mediaMaxWidth }, own ? { alignSelf: "flex-end", justifyContent: "flex-end" } : { alignSelf: "flex-start" }]}>
                  {mediaFiles.map(file =>
                    <ProtectedMessageMedia key={file.id} file={file} compact={message.attachments.length > 1} maxWidth={mediaMaxWidth} onOpen={url => openAttachment(file, url)} onLongPress={event => openMessageContext(message, event)} autoLoad={visualSettings.auto_load_media !== false} />)}
                </View>}
                {!!message.text && (isEmojiOnlyMessage(message.text)
                  ? <AnimatedEmojiMessage
                    text={message.text}
                    style={{ color: visualSettings.high_contrast ? (darkMode && !own ? "#fff" : "#0b111b") : darkMode && !own ? "#f5f7fa" : undefined }}
                  />
                  : <Text style={[
                    styles.messageText,
                    { fontSize: 17 * textScale, color: visualSettings.high_contrast ? (darkMode && !own ? "#fff" : "#0b111b") : darkMode && !own ? "#f5f7fa" : undefined },
                  ]}>{renderText(message.text)}</Text>)}
                {message.attachments?.filter(file => file.mime.startsWith("audio/")).map(file =>
                  <View key={file.id} style={[styles.voiceCard, own && styles.ownAttachment]}>
                    {file.local_url
                      ? <VoiceMessage src={file.local_url} durationSeconds={file.duration_seconds} tint="own" testID={`messenger-pending-voice-${message.client_id}`} />
                      : <ProtectedVoicePlayer file={file} own={own} autoLoad={visualSettings.auto_load_media !== false} />}
                    {file.uploading && <Text style={styles.uploadingText}>Envoi du vocal…</Text>}
                  </View>)}
                {message.attachments?.filter(file => !file.mime.startsWith("audio/") && !file.mime.startsWith("image/") && !file.mime.startsWith("video/")).map(file =>
                  <TouchableOpacity key={file.id} onPress={event => { event.stopPropagation?.(); openAttachment(file); }} style={[styles.fileChip, own && styles.ownAttachment]}>
                    <Ionicons name="document-outline" size={17} color={blue} />
                    <Text style={styles.fileLabel} numberOfLines={1}>{file.name}</Text><Ionicons name="download-outline" size={16} color={blue} />
                  </TouchableOpacity>)}
              </>}
              <View style={[styles.meta, mediaOnlyMessage && { position: "absolute", bottom: 7, right: 8, backgroundColor: "#0007", borderRadius: 10, paddingHorizontal: 5, paddingVertical: 1 }]}><Text style={[styles.time, mediaOnlyMessage && { color: "#fff" }]}>{new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{message.edited_at ? " · modifié" : ""}</Text>{own && (() => {
                const peers = conversation.members.filter(memberId => memberId !== userId);
                const read = peers.length > 0 && peers.every(peerId => message.read_by?.includes(peerId));
                const delivered = peers.some(peerId => message.delivered_by?.includes(peerId));
                return <Text style={[styles.receipt, delivered && styles.receiptDelivered, read && styles.receiptRead]} accessibilityLabel={read ? "Lu" : delivered ? "Distribué" : "Envoyé"}>{read || delivered ? "✓✓" : "✓"}</Text>;
              })()}
              </View>
              {message.client_id && failedIds.includes(message.client_id) && <View style={styles.sendFailure}>
                <Text style={styles.sendFailureText} numberOfLines={4}>
                  {failedMessages[message.client_id] || "L’envoi du message a échoué."}
                </Text>
                <TouchableOpacity onPress={() => retrySend(message.client_id!)}>
                  <Text style={styles.retryText}>Réessayer</Text>
                </TouchableOpacity>
              </View>}
              {Object.entries(message.reactions || {}).filter(([, ids]) => ids.length).map(([emoji, ids]) => <AnimatedReactionChip
                key={`${emoji}-${ids.length}`}
                emoji={emoji}
                ids={ids}
                userId={userId}
                onPress={() => void action(message, "reaction", { emoji })}
                testID={`messenger-message-reaction-${message.id}-${emoji}`}
              />)}
              {!stickerOnlyMessage && <View pointerEvents="none" style={[styles.bubbleTail, own ? styles.ownBubbleTail : styles.otherBubbleTail]}>
                <Svg width={11} height={14} viewBox="0 0 11 14">
                 <Path d={own ? "M0 0 C0 8 3 12 11 14 L0 14 Z" : "M11 0 C11 8 8 12 0 14 L11 14 Z"} fill={own ? ownBubbleColor : "#fff"} />
                </Svg>
              </View>}
            </View>;
          const handleMessageLayout = (event: any) => {
            messageLayoutY.current.set(message.id, event.nativeEvent.layout.y);
            if (focusPendingMessage.current !== message.id) return;
            focusPendingMessage.current = null;
            const y = Math.max(0, event.nativeEvent.layout.y - 64);
            requestAnimationFrame(() => scroll.current?.scrollTo({ y, animated: true }));
            setTimeout(() => setFocusedMessageId(current => current === message.id ? null : current), 2400);
          };
          const rowActionsPressable = <Pressable
            ref={(node: any) => {
              if (node) messagePressables.current.set(message.id, node);
              else messagePressables.current.delete(message.id);
            }}
            style={[styles.swipeMessage, own && styles.swipeMessageOwn]}
            onPress={!hasStickerAttachment ? event => openMessageContext(message, event) : undefined}
            onLongPress={event => openMessageContext(message, event)}
            delayLongPress={420}
            testID={`messenger-message-press-${message.id}`}
          >{bubble}</Pressable>;
          return <View key={message.id} onLayout={handleMessageLayout} style={[styles.bubbleWrap, own && styles.ownWrap]}>
            {!message.deleted
              ? <SwipeToReply direction="left" onReply={() => beginReply(message)}>{rowActionsPressable}</SwipeToReply>
              : rowActionsPressable}
          </View>;
        })}
      </ScrollView>
      {reply && <View style={[styles.replyBanner, { backgroundColor: chatSurface }]} testID="messenger-reply-preview">
        <View style={styles.replyBannerCopy}><Text style={styles.replyBannerLabel}>Réponse à {reply.sender_name}</Text><Text numberOfLines={1} style={styles.replyBannerText}>{reply.deleted ? "Message supprimé" : reply.text || reply.attachments?.[0]?.name || "Pièce jointe"}</Text></View>
        <TouchableOpacity onPress={() => setReply(null)} accessibilityLabel="Annuler la réponse"><Ionicons name="close" size={19} color={blue} /></TouchableOpacity>
      </View>}
      {editing && <View style={styles.replyBanner}><Text style={styles.replyBannerText}>Modification du message</Text><TouchableOpacity onPress={() => { setEditing(null); changeDraft(""); }}><Ionicons name="close" size={19} color={blue} /></TouchableOpacity></View>}
      {!canSend && <View style={[styles.readOnly, { backgroundColor: chatSurface }]}><Ionicons name="eye-outline" size={17} color={muted} /><Text style={styles.readOnlyText}>Lecture seule · seuls les administrateurs peuvent publier dans ce canal.</Text></View>}
      {canSend && (recording || voiceSending) ? <VoiceRecorderControls
        seconds={recordSeconds}
        waveform={recordingWaveform}
        locked={recordingLocked}
        paused={recordingPaused}
        viewOnce={recordingViewOnce}
        darkMode={darkMode}
        sending={voiceSending}
        onCancel={cancelVoiceRecording}
        onTogglePause={toggleVoicePause}
        onToggleViewOnce={toggleRecordingViewOnce}
        onSend={sendVoiceRecording}
      /> : <View style={[styles.composer, darkMode && { backgroundColor: "#1b2635", borderColor: "#344153" }]}>
        <TouchableOpacity onPress={toggleEmojiPicker} style={styles.composerIcon} accessibilityLabel={emojiPickerOpen ? "Revenir au clavier pour écrire" : "Choisir un emoji"} testID="messenger-emoji-toggle"><Ionicons name={emojiPickerOpen ? "keypad-outline" : "happy-outline"} size={23} color={blue} /></TouchableOpacity>
        <View
          style={styles.inputShell}
          onLayout={event => {
            const width = Math.max(48, event.nativeEvent.layout.width - 58);
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
        {canSend && (text.trim() || editing
            ? <TouchableOpacity style={styles.sendButton} onPress={() => editing ? action(editing, "edit", { text }).then(ok => { if (ok) { setEditing(null); changeDraft(""); } }) : send()} accessibilityLabel="Envoyer le message" testID="messenger-send"><Image source={logo} style={styles.sendLogo} resizeMode="contain" testID="messenger-send-brand" /></TouchableOpacity>
            : <TouchableOpacity
              onPress={pressVoiceButton}
              onPressIn={startVoiceHold}
              onPressOut={finishVoiceHold}
              style={styles.recordButton}
              accessibilityLabel="Maintenir puis glisser vers le haut pour verrouiller l’enregistrement vocal"
              testID="messenger-record-voice"
            ><Ionicons name="mic" size={22} color="#fff" /></TouchableOpacity>)}
      </View>}
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
      <Modal visible={!!deletePromptMessage} transparent animationType="fade" onRequestClose={() => setDeletePromptMessage(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.forwardModal} testID="messenger-delete-options">
            <Text style={styles.modalTitle}>Supprimer le message</Text>
            <TouchableOpacity
              style={styles.deleteOption}
              onPress={() => deletePromptMessage && void action(deletePromptMessage, "delete", { scope: "me" })}
              testID="messenger-delete-for-me"
            >
              <Ionicons name="person-outline" size={19} color={blue} />
              <Text style={styles.targetName}>Supprimer pour moi</Text>
            </TouchableOpacity>
            {deletePromptMessage && (
              conversation.kind === "private" || conversation.kind === "saved"
              || deletePromptMessage.sender_id === userId || isChannelAdmin
            ) && <TouchableOpacity
              style={styles.deleteOption}
              onPress={() => deletePromptMessage && void action(deletePromptMessage, "delete", { scope: "everyone" })}
              testID="messenger-delete-for-everyone"
            >
              <Ionicons name="people-outline" size={19} color="#d73546" />
              <Text style={[styles.targetName, { color: "#d73546" }]}>Supprimer pour tout le monde</Text>
            </TouchableOpacity>}
            <TouchableOpacity onPress={() => setDeletePromptMessage(null)} style={styles.deleteCancel}>
              <Text style={styles.cancelText}>Annuler</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
      {canSend && emojiPickerOpen && <View style={[styles.emojiPickerPanel, { height: emojiPickerHeight, backgroundColor: darkMode ? "#101619" : "#fff" }]} testID="messenger-emoji-picker">
        <View style={[styles.pickerTabs, darkMode && styles.pickerTabsDark]}>
          <TouchableOpacity
            onPress={() => { setPickerTab("emoji"); Keyboard.dismiss(); composerInput.current?.blur(); }}
            style={[styles.pickerTab, pickerTab === "emoji" && styles.pickerTabActive, darkMode && styles.pickerTabDark]}
            accessibilityRole="tab"
            accessibilityState={{ selected: pickerTab === "emoji" }}
            testID="messenger-picker-emoji-tab"
          >
            <Ionicons name="happy-outline" size={18} color={pickerTab === "emoji" ? blue : darkMode ? "#aab5c4" : muted} />
            <Text style={[styles.pickerTabText, darkMode && styles.pickerTabTextDark, pickerTab === "emoji" && styles.pickerTabTextActive]}>Émojis</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={toggleStickerPicker}
            style={[styles.pickerTab, pickerTab === "stickers" && styles.pickerTabActive, darkMode && styles.pickerTabDark]}
            accessibilityRole="tab"
            accessibilityLabel="Stickers"
            accessibilityState={{ selected: pickerTab === "stickers" }}
            testID="messenger-picker-sticker-tab"
          >
            <Ionicons name="albums-outline" size={18} color={pickerTab === "stickers" ? blue : darkMode ? "#aab5c4" : muted} />
            <Text style={[styles.pickerTabText, darkMode && styles.pickerTabTextDark, pickerTab === "stickers" && styles.pickerTabTextActive]}>Stickers</Text>
          </TouchableOpacity>
        </View>
        {pickerTab === "emoji" ? <View style={styles.pickerContent}>
          <EmojiKeyboard
            onEmojiSelected={item => insertEmoji(item.emoji)}
            enableRecentlyUsed
            storage={emojiStorage}
            enableSearchBar
            categoryPosition="top"
            defaultHeight={Math.max(150, emojiPickerHeight - 44)}
            hideHeader
            disableSafeArea
            colorScheme={darkMode ? "dark" : "light"}
            translation={emojiTranslation}
            theme={{
              container: darkMode ? "#101619" : "#ffffff",
              header: darkMode ? "#101619" : "#ffffff",
              category: { icon: darkMode ? "#aab5c4" : "#64748b", iconActive: blue, container: darkMode ? "#1e272b" : "#f3f6fb", containerActive: darkMode ? "#26394a" : "#e3efff" },
              search: { background: darkMode ? "#1e272b" : "#f2f5f9", text: darkMode ? "#f1f3f4" : ink, placeholder: muted, icon: muted },
              emoji: { selected: darkMode ? "#26394a" : "#e3efff" },
            }}
          />
        </View> : <StickerPickerPanel
          stickers={recentStickers}
          savedStickers={savedStickers}
          packStickers={packStickers}
          builtinStickers={builtinStickers}
          darkMode={darkMode}
          error={stickerLibraryError}
          onCreate={createSticker}
          onSelect={file => { void selectSticker(file); }}
        />}
      </View>}
      <Modal visible={!!forwarding} transparent animationType="fade" onRequestClose={() => setForwarding(null)}>
        <View style={styles.modalBackdrop}><View style={styles.forwardModal}><Text style={styles.modalTitle}>Transférer vers</Text><ScrollView style={{ maxHeight: 340 }}>{targets.filter(target => target.id !== conversation.id).map(target => <TouchableOpacity key={target.id} onPress={() => forward(target)} style={styles.targetRow}><Text style={styles.targetName}>{target.title}</Text><Ionicons name="chevron-forward" size={18} color={muted} /></TouchableOpacity>)}</ScrollView><TouchableOpacity onPress={() => setForwarding(null)}><Text style={styles.cancelText}>Annuler</Text></TouchableOpacity></View></View>
      </Modal>
      {attachmentPreview?.sticker
        ? <StickerActionSheet
          preview={attachmentPreview}
          saved={Boolean(attachmentPreview.fileId && savedStickers.some(file => file.id === attachmentPreview.fileId))}
          packed={Boolean(attachmentPreview.fileId && packStickers.some(file => file.id === attachmentPreview.fileId))}
          onClose={() => setAttachmentPreview(null)}
          onSave={savePreviewSticker}
          onRemove={removePreviewSticker}
          onAddToPack={addPreviewStickerToPack}
          onRemoveFromPack={removePreviewStickerFromPack}
          onEdit={editPreviewSticker}
        />
        : <ProtectedAttachmentViewer preview={attachmentPreview} onClose={() => setAttachmentPreview(null)} />}
      <MessageContextMenu
        message={contextMessage}
        anchor={contextAnchor}
        screenWidth={windowWidth}
        screenHeight={windowHeight}
        canPin={conversation.kind === "private" || isChannelAdmin}
        canEdit={!!contextMessage && contextMessage.sender_id === userId && !contextMessage.deleted}
        canDelete={!!contextMessage && !contextMessage.deleted}
        onClose={() => setContextMessage(null)}
        onReply={() => contextMessage && beginReply(contextMessage)}
        onReact={emoji => contextMessage && void action(contextMessage, "reaction", { emoji })}
        onCopy={() => contextMessage && void copyMessage(contextMessage)}
        onCopyLink={() => contextMessage && void copyMessageLink(contextMessage)}
        onForward={() => {
          if (!contextMessage) return;
          setForwarding(contextMessage);
          setContextMessage(null);
          messengerApi.conversations().then(setTargets).catch(() => setTargets([]));
        }}
        onPin={() => contextMessage && void action(contextMessage, "pin")}
        onEdit={() => {
          if (!contextMessage) return;
          setEditing(contextMessage);
          changeDraft(contextMessage.text);
          setContextMessage(null);
          requestAnimationFrame(() => composerInput.current?.focus());
        }}
        onDelete={() => {
          if (!contextMessage) return;
          setDeletePromptMessage(contextMessage);
          setContextMessage(null);
        }}
        onSave={() => contextMessage && void saveMessageMedia(contextMessage)}
      />
      <Modal visible={headerMenuOpen} transparent animationType="fade" onRequestClose={() => setHeaderMenuOpen(false)}>
        <View style={styles.headerMenuOverlay}>
          <TouchableOpacity style={styles.headerMenuDismiss} onPress={() => setHeaderMenuOpen(false)} accessibilityLabel="Fermer le menu" />
          <View style={[styles.headerMenu, darkMode && styles.headerMenuDark]}>
            <TouchableOpacity style={styles.headerMenuItem} onPress={() => { setHeaderMenuOpen(false); onDetails(); }}>
              <Ionicons name="information-circle-outline" size={19} color={blue} /><Text style={[styles.headerMenuText, darkMode && styles.nameDark]}>Détails de la discussion</Text>
            </TouchableOpacity>
            {canSend && scheduledEnabled && <TouchableOpacity style={styles.headerMenuItem} onPress={() => { setHeaderMenuOpen(false); setScheduleOpen(true); }} accessibilityLabel="Messages programmés" testID="messenger-scheduled-open">
              <Ionicons name="calendar-outline" size={19} color={blue} /><Text style={[styles.headerMenuText, darkMode && styles.nameDark]}>Messages programmés</Text>
            </TouchableOpacity>}
          </View>
        </View>
      </Modal>
      <MediaComposer
        visible={!!pendingMedia}
        files={pendingMedia || []}
        initialCaption={pendingStickerCreation ? "" : text}
        onClose={() => { setPendingMedia(null); setPendingStickerCreation(false); }}
        onConfirm={sendSelectedMedia}
      />
      {stickerVideo && <VideoStickerComposer
        file={stickerVideo}
        onClose={() => setStickerVideo(null)}
        onConfirm={async (start, duration) => {
          const attachment = await messengerApi.videoSticker(conversation.id, stickerVideo, start, duration);
          await send({ attachments: [attachment], text: "" });
          setStickerVideo(null);
        }}
      />}
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
  thread: { flex: 1, backgroundColor: "#c8ebe3", minHeight: 0, position: "relative" },
  threadHead: { minHeight: 70, flexDirection: "row", alignItems: "center", backgroundColor: "rgba(255,255,255,.91)", paddingHorizontal: 12, gap: 9, borderBottomWidth: 1, borderColor: "rgba(16,32,66,.1)" },
  threadHeadDark: { backgroundColor: "#111827" },
  backButton: { width: 42, height: 42, borderRadius: 13, backgroundColor: "#fffefa", alignItems: "center", justifyContent: "center", flexShrink: 0, borderWidth: 1, borderColor: "#e2e8f0" },
  identityPill: { flex: 1, minWidth: 0, height: 52, flexDirection: "row", alignItems: "center", gap: 9, borderRadius: 15, backgroundColor: "#fffefa", paddingHorizontal: 7, paddingVertical: 4, borderWidth: 1, borderColor: "#e2e8f0" },
  headerPillDark: { backgroundColor: "#202b3a", borderColor: "#37465a", borderWidth: 1 },
  identityText: { flex: 1, minWidth: 0, paddingVertical: 3 },
  avatar: { width: 44, height: 44, borderRadius: 24, backgroundColor: "#e4edff", alignItems: "center", justifyContent: "center", overflow: "hidden", flexShrink: 0 },
  savedAvatar: { backgroundColor: "#2999ef" },
  avatarStoryRing: { width: 49, height: 49, borderRadius: 26, padding: 2, borderWidth: 2, borderColor: "#f2a934" },
  avatarPhoto: { width: 44, height: 44, borderRadius: 24 }, avatarPhotoStory: { width: 39, height: 39, borderRadius: 20 }, avatarText: { color: blue, fontWeight: "900", fontSize: 18 },
  name: { fontSize: 16, color: ink, fontWeight: "800" }, nameDark: { color: "#f3f6fb" }, presence: { fontSize: 12, color: muted, marginTop: 2 }, presenceDark: { color: "#aab5c4" }, typing: { color: blue, fontWeight: "700" },
  headerActionPill: { height: 44, flexDirection: "row", alignItems: "center", borderRadius: 14, backgroundColor: "#fffefa", paddingHorizontal: 3, flexShrink: 0, borderWidth: 1, borderColor: "#e2e8f0" },
  headerAction: { width: 39, height: 40, alignItems: "center", justifyContent: "center" },
  headerMenuOverlay: { flex: 1, backgroundColor: "rgba(16,32,66,.14)" },
  headerMenuDismiss: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  headerMenu: { position: "absolute", top: 64, right: 12, minWidth: 236, borderRadius: 15, backgroundColor: "#fffefa", paddingHorizontal: 12, paddingVertical: 5, borderWidth: 1, borderColor: "#e2e8f0", shadowColor: "#102042", shadowOffset: { width: 0, height: 6 }, shadowOpacity: .14, shadowRadius: 16, elevation: 10 },
  headerMenuDark: { backgroundColor: "#202b3a", borderWidth: 1, borderColor: "#37465a" },
  headerMenuItem: { minHeight: 47, flexDirection: "row", alignItems: "center", gap: 11, borderBottomWidth: 1, borderColor: "#edf0f4" },
  headerMenuText: { fontSize: 13, color: ink, fontWeight: "700" },
  searchRow: { backgroundColor: "#fff", flexDirection: "row", alignItems: "center", paddingHorizontal: 16, gap: 10 },
  searchInput: { flex: 1, height: 44, fontSize: 14, color: ink },
  pinnedMessageBanner: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 12, marginTop: 7, marginBottom: 4, paddingHorizontal: 12, borderRadius: 13, borderWidth: 1, borderColor: "rgba(16,32,66,.08)", borderLeftWidth: 3, borderLeftColor: blue, backgroundColor: "#fffefa" },
  pinnedMessageBannerDark: { backgroundColor: "#1b2635" },
  pinnedMessageCopy: { flex: 1, minWidth: 0 },
  pinnedMessageLabel: { color: blue, fontSize: 11, fontWeight: "800" },
  pinnedMessageText: { color: ink, fontSize: 13, marginTop: 2 },
  pinnedMessageTextDark: { color: "#f3f6fb" },
  history: { flex: 1, minHeight: 0 }, historyContent: { paddingHorizontal: 16, paddingVertical: 16, paddingBottom: 18, gap: 9 },
  older: { alignSelf: "center", backgroundColor: "rgba(255,255,255,.88)", borderWidth: 1, borderColor: "rgba(16,32,66,.09)", borderRadius: 18, paddingVertical: 8, paddingHorizontal: 14 }, olderText: { color: blue, fontSize: 12, fontWeight: "700" },
  historyError: { alignSelf: "center", backgroundColor: "#fff3f1", paddingVertical: 9, paddingHorizontal: 13, borderRadius: 11, borderWidth: 1, borderColor: "#f1d7d5" }, historyErrorText: { color: "#b63d45", fontSize: 12, fontWeight: "700" },
  empty: { flex: 1, minHeight: 240, justifyContent: "center", alignItems: "center" }, emptyTitle: { fontSize: 17, color: ink, fontWeight: "800" }, emptyText: { marginTop: 7, color: muted, fontSize: 13 },
  bubbleWrap: { width: "100%", alignItems: "stretch", minWidth: 0 }, ownWrap: { alignItems: "stretch" }, swipeMessage: { width: "100%", alignItems: "flex-start", minWidth: 0 }, swipeMessageOwn: { alignItems: "flex-end" }, bubble: { maxWidth: "88%", minWidth: 0, flexShrink: 1, position: "relative", borderRadius: 17, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 7, borderWidth: 1, borderColor: "rgba(16,32,66,.08)" }, stickerBubble: { paddingHorizontal: 0, paddingTop: 0, paddingBottom: 0, borderWidth: 0, borderRadius: 0 },
  ownBubble: { alignSelf: "flex-end", backgroundColor: chatVisual.sentBubble, borderColor: "#d4e9c7", borderBottomRightRadius: 6 }, otherBubble: { alignSelf: "flex-start", backgroundColor: chatVisual.receivedBubble, borderColor: "#e1e7ed", borderBottomLeftRadius: 6 },
  bubbleTail: { position: "absolute", bottom: -1, width: 11, height: 14 }, ownBubbleTail: { right: -8 }, otherBubbleTail: { left: -8 },
  sender: { fontSize: 11, color: blue, fontWeight: "800", marginBottom: 4, maxWidth: "100%", flexShrink: 1 }, messageText: ({ color: "#172016", fontSize: 15, lineHeight: 22, maxWidth: "100%", flexShrink: 1, overflowWrap: "anywhere", wordBreak: "break-word" } as any), linkText: { color: blue, textDecorationLine: "underline" }, deleted: { color: muted, fontStyle: "italic" }, forwarded: { fontSize: 10, color: muted, marginBottom: 4 },
  replyQuote: { borderLeftWidth: 3, borderColor: blue, paddingLeft: 8, paddingVertical: 4, marginBottom: 6, backgroundColor: "rgba(23,105,232,.055)", borderTopRightRadius: 7, borderBottomRightRadius: 7, maxWidth: "100%", minWidth: 0 },
  statusReplyCard: { maxWidth: "100%", minWidth: 0, marginBottom: 6, padding: 7, borderLeftWidth: 3, borderLeftColor: blue, borderRadius: 8, backgroundColor: "rgba(23,105,232,.06)" },
  statusReplyHeader: { flexDirection: "row", alignItems: "center", gap: 7, minWidth: 0 },
  statusReplyCopy: { flex: 1, minWidth: 0 },
  statusReplyTitle: { color: blue, fontSize: 11, fontWeight: "800" },
  statusReplyText: ({ color: muted, fontSize: 11, marginTop: 2, overflowWrap: "anywhere" } as any),
  statusReplyMedia: { marginTop: 6, maxWidth: 220, alignSelf: "flex-start" },
  replyQuoteSender: ({ color: blue, fontSize: 11, fontWeight: "800", maxWidth: "100%", flexShrink: 1, overflowWrap: "anywhere" } as any), replyQuotePreview: ({ color: muted, fontSize: 11, marginTop: 2, maxWidth: "100%", flexShrink: 1, overflowWrap: "anywhere" } as any),
  fileChip: { flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: "#f2f6fd", borderRadius: 10, padding: 9, marginTop: 5, maxWidth: "100%", minWidth: 0 }, mediaGroup: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap: 4, maxWidth: "100%", minWidth: 0 }, ownMediaGroup: { alignSelf: "flex-end", alignItems: "flex-end" }, otherMediaGroup: { alignSelf: "flex-start", alignItems: "flex-start" }, stickerGroup: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4, maxWidth: "100%", minWidth: 0 }, ownStickerGroup: { alignSelf: "flex-end", justifyContent: "flex-end" }, otherStickerGroup: { alignSelf: "flex-start", justifyContent: "flex-start" }, ownAttachment: { alignSelf: "flex-end" }, voiceCard: { width: 250, maxWidth: "100%", minWidth: 0, borderRadius: 14, paddingHorizontal: 0, marginTop: 4, alignSelf: "flex-start" }, voiceLoad: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 42, borderRadius: 14, backgroundColor: "#edf2fa", paddingHorizontal: 12 }, voiceLoadError: { width: "100%", maxWidth: 280, gap: 4 }, voiceLoadErrorText: { color: "#a33b35", fontSize: 11, lineHeight: 15, paddingHorizontal: 6 }, sendFailure: { alignSelf: "flex-end", alignItems: "flex-end", maxWidth: 280, paddingTop: 3 }, sendFailureText: { color: "#a33b35", fontSize: 11, lineHeight: 15, textAlign: "right" }, onceOpened: { minHeight: 42, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, borderRadius: 14, backgroundColor: "#edf2fa" }, onceOpenedText: { flex: 1, color: "#66865e", fontSize: 13, fontWeight: "700" }, fileLabel: { flex: 1, fontSize: 13, color: ink },
  meta: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 5, marginTop: 5 }, time: { fontSize: 10, color: "#71836d" }, receipt: { color: "#71836d", fontSize: 11, fontWeight: "700" }, receiptDelivered: { color: "#71836d" }, receiptRead: { color: blue }, retryText: { color: "#c33", fontWeight: "800", fontSize: 10 },
  reactionChip: { alignSelf: "flex-start", marginTop: 3, borderRadius: 12, borderWidth: 1, borderColor: "#e4e9ef", backgroundColor: "#fff" }, reactionChipMine: { borderColor: "#8db4f3", backgroundColor: "#edf4ff" }, reaction: { color: ink, fontSize: 12, paddingHorizontal: 7, paddingVertical: 2 },
  uploadingText: { color: muted, fontSize: 11, marginTop: 3, alignSelf: "flex-end" },
  focusedBubble: { borderColor: "#2684ff", borderWidth: 2 },
  replyBanner: { backgroundColor: "#fffefa", borderTopWidth: 1, borderColor: "#e2e8f0", flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 9, gap: 8 }, replyBannerCopy: { flex: 1, borderLeftWidth: 3, borderColor: blue, paddingLeft: 9 }, replyBannerLabel: { color: blue, fontSize: 11, fontWeight: "800" }, replyBannerText: { color: muted, fontSize: 12, flex: 1 },
  recordStatus: { flexDirection: "row", alignItems: "center", backgroundColor: "#fff", paddingHorizontal: 16, paddingVertical: 9, gap: 8 }, recordDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#dd3e45" }, recordText: { flex: 1, color: ink, fontSize: 13 }, cancelText: { color: "#d64545", fontWeight: "700", padding: 7 },
  readOnly: { flexDirection: "row", alignItems: "center", gap: 7, paddingVertical: 7, paddingHorizontal: 14, backgroundColor: "#fff" }, readOnlyText: { color: muted, fontSize: 11, flex: 1 }, disabled: { opacity: .45 }, readOnlyInput: { opacity: .65 },
   emojiPickerPanel: { height: 420, maxHeight: "100%", flexShrink: 0, overflow: "hidden", backgroundColor: "#fffefa", borderTopWidth: 1, borderColor: "#e2e8f0" },
   pickerTabs: { height: 46, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: 12, backgroundColor: "#fffefa" },
   pickerTabsDark: { backgroundColor: "#101619", borderBottomWidth: 1, borderBottomColor: "#253137" },
   pickerTab: { minWidth: 118, height: 34, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, borderRadius: 12, backgroundColor: "#f1f4f8", paddingHorizontal: 14 },
   pickerTabDark: { backgroundColor: "#1e272b" },
   pickerTabActive: { backgroundColor: "#e5efff" },
   pickerTabText: { color: muted, fontSize: 13, fontWeight: "700" },
   pickerTabTextDark: { color: "#aab5c4" },
   pickerTabTextActive: { color: blue },
   pickerContent: { flex: 1, minHeight: 0, overflow: "hidden" },
  composer: { alignSelf: "stretch", minWidth: 0, maxWidth: "100%", flexDirection: "row", flexWrap: "nowrap", alignItems: "flex-end", backgroundColor: "#fffefa", marginHorizontal: 10, marginBottom: 10, paddingHorizontal: 8, paddingVertical: 7, borderWidth: 1, borderColor: "#dfe6e5", borderRadius: 18, gap: 5, shadowColor: "#102042", shadowOffset: { width: 0, height: 3 }, shadowOpacity: .07, shadowRadius: 9, elevation: 4, flexShrink: 0 },
  composerIcon: { width: 37, height: 44, alignItems: "center", justifyContent: "center", flexShrink: 0 }, inputShell: { flex: 1, flexBasis: 0, flexShrink: 1, flexDirection: "row", alignItems: "flex-end", minWidth: 0, minHeight: 42, backgroundColor: "#f2f5f9", borderRadius: 24, paddingLeft: 11, paddingRight: 5 }, input: { flex: 1, flexBasis: 0, flexShrink: 1, minWidth: 0, maxHeight: 176, minHeight: 42, borderRadius: 21, backgroundColor: "transparent", paddingHorizontal: 3, paddingTop: 10, paddingBottom: 8, color: ink, fontSize: 16, lineHeight: 22, outlineStyle: "none" as any }, inputAttach: { width: 36, height: 42, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  sendButton: { width: 44, height: 44, borderRadius: 14, backgroundColor: blue, alignItems: "center", justifyContent: "center", overflow: "hidden", flexShrink: 0 }, recordButton: { width: 44, height: 44, borderRadius: 14, backgroundColor: blue, alignItems: "center", justifyContent: "center", flexShrink: 0 }, sendLogo: { width: 37, height: 37, borderRadius: 19, backgroundColor: "#fff" },
  composerActionsBackdrop: { flex: 1, backgroundColor: "rgba(15,28,50,.35)", justifyContent: "flex-end", paddingHorizontal: 12, paddingBottom: 16 }, composerActionsDismiss: { flex: 1 }, composerActionsSheet: { backgroundColor: "#fff", borderRadius: 22, padding: 12 }, actionsTitle: { color: ink, fontSize: 16, fontWeight: "800", paddingHorizontal: 9, paddingBottom: 8 }, composerActionRow: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 13, paddingHorizontal: 10, borderTopWidth: 1, borderColor: "#edf0f5" }, composerActionText: { color: ink, fontSize: 14, fontWeight: "600" },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(15,28,50,.35)", justifyContent: "center", alignItems: "center", padding: 20 }, forwardModal: { backgroundColor: "#fff", borderRadius: 18, padding: 18, width: "100%", maxWidth: 380 }, modalTitle: { fontSize: 18, fontWeight: "800", color: ink, marginBottom: 12 }, targetRow: { minHeight: 48, borderBottomWidth: 1, borderColor: "#edf0f4", flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, targetName: { color: ink, fontWeight: "700" }, deleteOption: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 11, borderBottomWidth: 1, borderColor: "#edf0f4" }, deleteCancel: { alignItems: "flex-end", paddingTop: 10 },
});
