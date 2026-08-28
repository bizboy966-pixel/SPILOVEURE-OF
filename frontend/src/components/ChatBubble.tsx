/**
 * Floating chat bubble → conversation with SPILOVEURE support (admins).
 *
 * Telegram-style features:
 *  ▸ Tap image → full-screen MediaLightbox with pinch/zoom.
 *  ▸ Long-press (mobile) / right-click (web) on a bubble → context menu
 *    with Répondre, Copier, Supprimer (own messages only).
 *  ▸ Ticks : ✓ sent, ✓✓ delivered, ✓✓ blue = read.
 *  ▸ Voice notes : native <audio> controls (progress + play/pause).
 *  ▸ Global master switch : if admin disabled chat, the bubble is hidden.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, Alert, Image, Modal, Platform, Pressable, ScrollView,
  StyleSheet, Text, TextInput, TouchableOpacity, View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api";
import { useAuth } from "@/src/auth";
import { theme } from "@/src/theme";
import { MediaLightbox, Slide } from "@/src/components/MediaLightbox";
import VoiceMessage from "@/src/components/VoiceMessage";

type Msg = {
  id: string;
  conversation_id: string;
  sender_id: string;
  sender_role: "user" | "admin";
  sender_username?: string;
  text: string;
  images: string[];
  audio?: string | null;
  status: "sent" | "delivered" | "read";
  reply_to?: string | null;
  reply_preview?: { id: string; sender_role: string; sender_username: string; preview: string } | null;
  created_at: string;
  read_at?: string | null;
  deleted?: boolean;
};

type Payload = {
  conversation: { id: string; user_unread: number; last_message_at: string | null };
  support_online: boolean;
  messages: Msg[];
};

async function compressImageFile(file: File, maxBytes = 780 * 1024): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onerror = reject;
    r.onload = () => resolve(String(r.result));
    r.readAsDataURL(file);
  });
  if (dataUrl.length * 0.75 <= maxBytes) return dataUrl;
  const img = new window.Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
  const canvas = document.createElement("canvas");
  let scale = 1;
  let quality = 0.8;
  const ctx = canvas.getContext("2d")!;
  for (let i = 0; i < 6; i++) {
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const out = canvas.toDataURL("image/jpeg", quality);
    if (out.length * 0.75 <= maxBytes) return out;
    if (i % 2 === 0) quality = Math.max(0.4, quality - 0.15);
    else scale = Math.max(0.4, scale - 0.15);
  }
  return canvas.toDataURL("image/jpeg", 0.5);
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

function TicksIcon({ status }: { status: Msg["status"] }) {
  if (status === "read") return <Text style={{ color: "#60A5FA", fontSize: 11, fontWeight: "800" }}>✓✓</Text>;
  if (status === "delivered") return <Text style={{ color: "rgba(255,255,255,0.75)", fontSize: 11, fontWeight: "800" }}>✓✓</Text>;
  return <Text style={{ color: "rgba(255,255,255,0.6)", fontSize: 11, fontWeight: "800" }}>✓</Text>;
}

export default function ChatBubble() {
  const { user } = useAuth();
  const [chatEnabled, setChatEnabled] = useState<boolean>(true);
  const [open, setOpen] = useState(false);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [unread, setUnread] = useState(0);
  const [supportOnline, setSupportOnline] = useState(false);
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [replyTo, setReplyTo] = useState<Msg | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordSecs, setRecordSecs] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunks = useRef<BlobPart[]>([]);
  const recordTimer = useRef<any>(null);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [menuMsg, setMenuMsg] = useState<Msg | null>(null);
  const [lightbox, setLightbox] = useState<{ slides: Slide[]; index: number } | null>(null);
  const timer = useRef<any>(null);
  const scrollRef = useRef<any>(null);

  // Poll global chat-enabled every 60s (not open-dependent).
  useEffect(() => {
    if (!user) return;
    const check = async () => {
      try {
        const r = await api.get<{ enabled: boolean }>("/support/chat-enabled");
        setChatEnabled(!!r.enabled);
      } catch { /* silent */ }
    };
    check();
    const t = setInterval(check, 60_000);
    return () => clearInterval(t);
  }, [user]);

  const fetchState = useCallback(async () => {
    try {
      const r = await api.get<Payload>("/chat/me");
      setPayload(r);
      setUnread(r.conversation.user_unread || 0);
      setSupportOnline(!!r.support_online);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    if (!user || !chatEnabled) return;
    fetchState();
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(fetchState, open ? 3000 : 20000);
    return () => clearInterval(timer.current);
  }, [user, open, fetchState, chatEnabled]);

  useEffect(() => {
    if (!open || !payload) return;
    (async () => {
      try {
        await api.post("/chat/me/mark-read", {});
        setUnread(0);
      } catch { /* silent */ }
    })();
    setTimeout(() => scrollRef.current?.scrollToEnd?.({ animated: false }), 60);
  }, [open, payload?.messages.length]);

  // Re-check chat-enabled flag when user opens the panel (avoids waiting for
  // the 60s background poll if the admin just flipped the switch).
  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const r = await api.get<{ enabled: boolean }>("/support/chat-enabled");
        if (!r.enabled) { setChatEnabled(false); setOpen(false); }
      } catch { /* silent */ }
    })();
  }, [open]);

  const pickImages = async () => {
    if (Platform.OS !== "web") { setErr("Attachements photo disponibles uniquement sur le web pour l'instant."); return; }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp";
    input.multiple = true;
    input.onchange = async () => {
      const files = Array.from(input.files || []).slice(0, 4 - images.length);
      const added: string[] = [];
      for (const f of files) {
        try { added.push(await compressImageFile(f)); }
        catch { setErr(`Impossible de traiter ${f.name}.`); }
      }
      setImages((prev) => [...prev, ...added].slice(0, 4));
    };
    input.click();
  };

  const send = async () => {
    const t = text.trim();
    if (!t && images.length === 0) return;
    setSending(true); setErr(null);
    try {
      const msg = await api.post<Msg>("/chat/me/messages", {
        text: t, images, reply_to: replyTo?.id || null,
      });
      setText(""); setImages([]); setReplyTo(null);
      setPayload((p) => p ? { ...p, messages: [...p.messages, msg] } : p);
      setTimeout(() => scrollRef.current?.scrollToEnd?.({ animated: true }), 40);
    } catch (e: any) {
      setErr(e?.detail || "Envoi impossible.");
    } finally { setSending(false); }
  };

  const startRecording = async () => {
    if (Platform.OS !== "web") { setErr("Enregistrement vocal disponible uniquement sur le web."); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const rec = new MediaRecorder(stream, { mimeType: mime });
      recordedChunks.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.current.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(recordedChunks.current, { type: "audio/webm" });
        if (blob.size < 1500) { setErr("Enregistrement trop court."); return; }
        if (blob.size > 1.9 * 1024 * 1024) { setErr("Enregistrement trop long (max 2 Mo)."); return; }
        const dataUrl: string = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onerror = rej; r.onload = () => res(String(r.result));
          r.readAsDataURL(blob);
        });
        setSending(true);
        try {
          const msg = await api.post<Msg>("/chat/me/messages", {
            text: "", audio: dataUrl, reply_to: replyTo?.id || null,
          });
          setReplyTo(null);
          setPayload((p) => p ? { ...p, messages: [...p.messages, msg] } : p);
          setTimeout(() => scrollRef.current?.scrollToEnd?.({ animated: true }), 40);
        } catch (e: any) {
          setErr(e?.detail || "Envoi du vocal impossible.");
        } finally { setSending(false); }
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true); setRecordSecs(0);
      recordTimer.current = setInterval(() => setRecordSecs((s) => {
        if (s >= 59) { stopRecording(); return 60; }
        return s + 1;
      }), 1000);
    } catch (e: any) {
      setErr("Micro refusé : autorisez l'accès micro dans votre navigateur.");
    }
  };
  const stopRecording = () => {
    try { recorderRef.current?.stop(); } catch {}
    if (recordTimer.current) clearInterval(recordTimer.current);
    setRecording(false); setRecordSecs(0);
  };
  const cancelRecording = () => {
    try {
      if (recorderRef.current) {
        recorderRef.current.onstop = null as any;
        recorderRef.current.stop();
      }
    } catch {}
    if (recordTimer.current) clearInterval(recordTimer.current);
    setRecording(false); setRecordSecs(0);
  };

  const openImage = (m: Msg, i: number) => {
    const slides: Slide[] = (m.images || []).map((u) => ({ kind: "image", url: u }));
    if (slides.length > 0) setLightbox({ slides, index: i });
  };

  const doReply = (m: Msg) => { setReplyTo(m); setMenuMsg(null); };
  const doCopy = (m: Msg) => {
    setMenuMsg(null);
    if (!m.text) return;
    try { navigator?.clipboard?.writeText(m.text); } catch {}
  };
  const runDelete = async (m: Msg) => {
    try {
      await api.delete(`/chat/me/messages/${m.id}`);
      setPayload((p) => p ? {
        ...p,
        messages: p.messages.map((x) => x.id === m.id
          ? { ...x, deleted: true, text: "", images: [], audio: null, reply_preview: null } : x),
      } : p);
    } catch (e: any) {
      setErr(e?.detail || "Suppression impossible.");
    }
  };
  const doDelete = (m: Msg) => {
    setMenuMsg(null);
    if (Platform.OS === "web") {
      if (typeof window !== "undefined" && !window.confirm("Supprimer ce message ?")) return;
      void runDelete(m);
    } else {
      Alert.alert("Supprimer ce message ?", "", [
        { text: "Annuler", style: "cancel" },
        { text: "Supprimer", style: "destructive", onPress: () => runDelete(m) },
      ]);
    }
  };

  const openMenuFor = (m: Msg) => { if (!m.deleted) setMenuMsg(m); };

  if (!user) return null;
  if (!chatEnabled) return null;

  return (
    <>
      <TouchableOpacity
        onPress={() => setOpen(true)}
        style={styles.bubble}
        testID="chat-bubble"
        accessibilityLabel="Ouvrir le chat support"
      >
        <Ionicons name="chatbubble-ellipses" size={26} color="#fff" />
        {unread > 0 ? (
          <View style={styles.badge}>
            <Text style={styles.badgeT}>{unread > 99 ? "99+" : unread}</Text>
          </View>
        ) : null}
      </TouchableOpacity>

      <Modal visible={open} animationType="slide" transparent onRequestClose={() => setOpen(false)}>
        <View style={styles.backdrop}>
          <View style={styles.panel}>
            <View style={styles.header}>
              <View style={{ flex: 1 }}>
                <Text style={styles.headerT}>💬 Support SPILOVEURE</Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 }}>
                  <View style={[styles.dot, { backgroundColor: supportOnline ? "#10B981" : "#9CA3AF" }]} />
                  <Text style={{ color: "rgba(255,255,255,0.9)", fontSize: 11, fontWeight: "600" }}>
                    {supportOnline ? "En ligne" : "Hors ligne · nous répondons dès que possible"}
                  </Text>
                </View>
              </View>
              <TouchableOpacity onPress={() => setOpen(false)} style={styles.closeBtn} testID="chat-close">
                <Ionicons name="close" size={22} color="#fff" />
              </TouchableOpacity>
            </View>

            <ScrollView
              ref={scrollRef}
              style={styles.msgs}
              contentContainerStyle={{ padding: 12, gap: 6 }}
              onContentSizeChange={() => scrollRef.current?.scrollToEnd?.({ animated: true })}
            >
              {!payload ? (
                <View style={{ alignItems: "center", padding: 24 }}>
                  <ActivityIndicator color={theme.colors.primary} />
                </View>
              ) : payload.messages.length === 0 ? (
                <View style={{ alignItems: "center", padding: 24 }}>
                  <Text style={{ color: theme.colors.textSecondary, fontSize: 13, textAlign: "center" }}>
                    👋 Bienvenue. L'équipe support SPILOVEURE est à votre écoute — écrivez votre message ci-dessous.
                  </Text>
                </View>
              ) : payload.messages.map((m) => {
                const mine = m.sender_role === "user";
                const isDeleted = !!m.deleted;
                return (
                  <View key={m.id} style={{ alignItems: mine ? "flex-end" : "flex-start" }}>
                    <Pressable
                      onLongPress={() => openMenuFor(m)}
                      // @ts-ignore web-only contextmenu
                      onContextMenu={Platform.OS === "web" ? (e: any) => { e.preventDefault?.(); openMenuFor(m); } : undefined}
                      delayLongPress={350}
                      style={({ pressed }) => [
                        styles.bubbleMsg,
                        mine ? styles.bubbleMsgMe : styles.bubbleMsgOther,
                        pressed && { opacity: 0.85 },
                        isDeleted && { opacity: 0.75 },
                      ]}
                      testID={`chat-msg-${m.id}`}
                    >
                      {isDeleted ? (
                        <Text style={[mine ? styles.msgTextMe : styles.msgText, { fontStyle: "italic", opacity: 0.85 }]}>
                          🚫 Message supprimé
                        </Text>
                      ) : (
                        <>
                          {m.reply_preview ? (
                            <View style={[styles.replyQuote, mine && { borderLeftColor: "rgba(255,255,255,0.6)" }]}>
                              <Text style={{ color: mine ? "rgba(255,255,255,0.9)" : theme.colors.primary, fontSize: 10, fontWeight: "800" }}>
                                {m.reply_preview.sender_role === "admin" ? "Support" : (m.reply_preview.sender_username || "Vous")}
                              </Text>
                              <Text numberOfLines={2} style={{ color: mine ? "rgba(255,255,255,0.85)" : theme.colors.textSecondary, fontSize: 11 }}>
                                {m.reply_preview.preview}
                              </Text>
                            </View>
                          ) : null}
                          {m.text ? (
                            <Text style={mine ? styles.msgTextMe : styles.msgText} selectable>
                              {m.text}
                            </Text>
                          ) : null}
                          {m.images && m.images.length > 0 ? (
                            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: m.text ? 6 : 0 }}>
                              {m.images.map((src, i) => (
                                <TouchableOpacity key={i} onPress={() => openImage(m, i)}
                                  activeOpacity={0.85}
                                  testID={`chat-msg-img-${m.id}-${i}`}>
                                  <Image source={{ uri: src }} style={styles.msgImg} />
                                </TouchableOpacity>
                              ))}
                            </View>
                          ) : null}
                          {m.audio ? (
                            Platform.OS === "web" ? (
                              <VoiceMessage src={m.audio} tint={mine ? "own" : "other"} testID={`chat-voice-${m.id}`} />
                            ) : (
                              <Text style={mine ? styles.msgTextMe : styles.msgText}>🎤 Message vocal</Text>
                            )
                          ) : null}
                        </>
                      )}
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 3, justifyContent: "flex-end" }}>
                        <Text style={mine ? styles.msgTsMe : styles.msgTs}>
                          {fmtTime(m.created_at)}
                        </Text>
                        {mine && !isDeleted ? <TicksIcon status={m.status} /> : null}
                      </View>
                    </Pressable>
                  </View>
                );
              })}
            </ScrollView>

            {images.length > 0 ? (
              <View style={styles.previewRow}>
                {images.map((src, i) => (
                  <View key={i} style={{ position: "relative" }}>
                    <Image source={{ uri: src }} style={styles.previewImg} />
                    <TouchableOpacity
                      style={styles.previewRemove}
                      onPress={() => setImages((prev) => prev.filter((_, ix) => ix !== i))}
                      testID={`chat-preview-remove-${i}`}
                    >
                      <Ionicons name="close" size={13} color="#fff" />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            ) : null}

            {err ? (
              <View style={{ paddingHorizontal: 12, paddingBottom: 4 }}>
                <Text style={{ color: theme.colors.danger, fontSize: 11, fontWeight: "600" }}>❌ {err}</Text>
              </View>
            ) : null}

            {replyTo ? (
              <View style={styles.replyBar}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: theme.colors.primary, fontSize: 10, fontWeight: "800" }}>
                    ↩ Répondre à {replyTo.sender_role === "admin" ? "Support" : "vous"}
                  </Text>
                  <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 11 }}>
                    {replyTo.text || (replyTo.audio ? "🎤 Message vocal" : "📷 Photo")}
                  </Text>
                </View>
                <TouchableOpacity onPress={() => setReplyTo(null)} testID="chat-cancel-reply">
                  <Ionicons name="close" size={16} color={theme.colors.textSecondary} />
                </TouchableOpacity>
              </View>
            ) : null}

            <View style={styles.composer}>
              {recording ? (
                <>
                  <TouchableOpacity onPress={cancelRecording} style={[styles.attachBtn, { backgroundColor: "#FEE2E2" }]} testID="chat-cancel-rec">
                    <Ionicons name="trash" size={18} color="#DC2626" />
                  </TouchableOpacity>
                  <View style={[styles.input, { flexDirection: "row", alignItems: "center", gap: 8 }]}>
                    <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: "#EF4444" }} />
                    <Text style={{ color: theme.colors.textPrimary, fontWeight: "700" }}>Enregistrement… {recordSecs}s</Text>
                  </View>
                  <TouchableOpacity onPress={stopRecording} style={styles.sendBtn} testID="chat-send-rec">
                    <Ionicons name="send" size={18} color="#fff" />
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <TouchableOpacity onPress={pickImages} style={styles.attachBtn} testID="chat-attach">
                    <Ionicons name="image" size={20} color={theme.colors.primary} />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={startRecording} style={styles.attachBtn} testID="chat-mic">
                    <Ionicons name="mic" size={20} color={theme.colors.primary} />
                  </TouchableOpacity>
                  <TextInput
                    style={styles.input}
                    value={text}
                    onChangeText={setText}
                    placeholder="Écrivez votre message…"
                    placeholderTextColor={theme.colors.textSecondary}
                    multiline
                    maxLength={4000}
                    testID="chat-input"
                  />
                  <TouchableOpacity
                    onPress={send}
                    disabled={sending || (!text.trim() && images.length === 0)}
                    style={[
                      styles.sendBtn,
                      (sending || (!text.trim() && images.length === 0)) && { opacity: 0.4 },
                    ]}
                    testID="chat-send"
                  >
                    {sending ? <ActivityIndicator color="#fff" size="small" /> :
                      <Ionicons name="send" size={18} color="#fff" />}
                  </TouchableOpacity>
                </>
              )}
            </View>
          </View>
        </View>
      </Modal>

      {/* Context menu */}
      <Modal transparent visible={!!menuMsg} animationType="fade" onRequestClose={() => setMenuMsg(null)}>
        <Pressable style={styles.menuBackdrop} onPress={() => setMenuMsg(null)}>
          <Pressable style={styles.menuCard} onPress={(e) => e.stopPropagation()} testID="chat-msg-menu">
            <Text style={styles.menuTitle}>Actions</Text>
            <TouchableOpacity style={styles.menuItem} onPress={() => menuMsg && doReply(menuMsg)} testID="chat-menu-reply">
              <Ionicons name="arrow-undo" size={18} color={theme.colors.primary} />
              <Text style={styles.menuItemT}>Répondre</Text>
            </TouchableOpacity>
            {menuMsg?.text ? (
              <TouchableOpacity style={styles.menuItem} onPress={() => menuMsg && doCopy(menuMsg)} testID="chat-menu-copy">
                <Ionicons name="copy" size={18} color={theme.colors.textPrimary} />
                <Text style={styles.menuItemT}>Copier le texte</Text>
              </TouchableOpacity>
            ) : null}
            {menuMsg?.sender_id === user?.id ? (
              <TouchableOpacity style={[styles.menuItem, styles.menuItemDanger]} onPress={() => menuMsg && doDelete(menuMsg)} testID="chat-menu-delete">
                <Ionicons name="trash" size={18} color={theme.colors.danger} />
                <Text style={[styles.menuItemT, { color: theme.colors.danger }]}>Supprimer</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity style={[styles.menuItem, { justifyContent: "center" }]} onPress={() => setMenuMsg(null)}>
              <Text style={{ color: theme.colors.textSecondary, fontWeight: "700", fontSize: 13 }}>Annuler</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Fullscreen image viewer */}
      {lightbox ? (
        <MediaLightbox
          open
          slides={lightbox.slides}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
          onIndexChange={(i) => setLightbox((lb) => lb ? { ...lb, index: i } : lb)}
          testID="chat-lightbox"
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  bubble: {
    position: "absolute", right: 18, bottom: 90,
    width: 56, height: 56, borderRadius: 30,
    backgroundColor: theme.colors.primary,
    alignItems: "center", justifyContent: "center",
    ...theme.shadow.button,
    zIndex: 9999,
  },
  badge: {
    position: "absolute", top: -4, right: -4,
    backgroundColor: "#EF4444", borderRadius: 12, minWidth: 22, height: 22,
    paddingHorizontal: 5, alignItems: "center", justifyContent: "center",
    borderWidth: 2, borderColor: "#fff",
  },
  badgeT: { color: "#fff", fontSize: 11, fontWeight: "800" },
  backdrop: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "flex-end", alignItems: "center",
  },
  panel: {
    width: "100%", maxWidth: 460, height: "90%",
    backgroundColor: theme.colors.background,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row", alignItems: "center", gap: 8,
    padding: 14, paddingTop: 18,
    backgroundColor: theme.colors.primaryDark,
  },
  headerT: { color: "#fff", fontWeight: "800", fontSize: 16, letterSpacing: -0.3 },
  dot: { width: 8, height: 8, borderRadius: 5 },
  closeBtn: {
    width: 34, height: 34, borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.16)",
    alignItems: "center", justifyContent: "center",
  },
  msgs: { flex: 1, backgroundColor: theme.colors.surfaceMuted },
  bubbleMsg: {
    maxWidth: "80%", padding: 10, borderRadius: 14,
    marginBottom: 4,
  },
  bubbleMsgMe: {
    backgroundColor: theme.colors.primary,
    borderBottomRightRadius: 4,
  },
  bubbleMsgOther: {
    backgroundColor: "#fff",
    borderBottomLeftRadius: 4,
    borderWidth: 1, borderColor: theme.colors.border,
  },
  msgText: { color: theme.colors.textPrimary, fontSize: 13.5, lineHeight: 19 },
  msgTextMe: { color: "#fff", fontSize: 13.5, lineHeight: 19 },
  msgTs: { color: theme.colors.textSecondary, fontSize: 10 },
  msgTsMe: { color: "rgba(255,255,255,0.8)", fontSize: 10 },
  msgImg: { width: 130, height: 130, borderRadius: 8, backgroundColor: "#000" },
  previewRow: {
    flexDirection: "row", gap: 6, paddingHorizontal: 12, paddingVertical: 6,
    backgroundColor: theme.colors.surface,
    borderTopWidth: 1, borderTopColor: theme.colors.border,
  },
  previewImg: { width: 52, height: 52, borderRadius: 6, backgroundColor: "#000" },
  previewRemove: {
    position: "absolute", top: -4, right: -4,
    backgroundColor: "#EF4444", width: 18, height: 18, borderRadius: 10,
    alignItems: "center", justifyContent: "center",
  },
  composer: {
    flexDirection: "row", alignItems: "flex-end", gap: 6,
    padding: 8, backgroundColor: theme.colors.surface,
    borderTopWidth: 1, borderTopColor: theme.colors.border,
  },
  attachBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: theme.colors.surfaceMuted,
    alignItems: "center", justifyContent: "center",
  },
  input: {
    flex: 1, minHeight: 40, maxHeight: 120,
    paddingHorizontal: 12, paddingVertical: 10,
    borderRadius: 20, backgroundColor: theme.colors.surfaceMuted,
    color: theme.colors.textPrimary, fontSize: 13.5,
    borderWidth: 1, borderColor: theme.colors.border,
  },
  sendBtn: {
    width: 42, height: 42, borderRadius: 22,
    backgroundColor: theme.colors.primary,
    alignItems: "center", justifyContent: "center",
    ...theme.shadow.button,
  },
  replyBar: {
    flexDirection: "row", alignItems: "center", gap: 8,
    padding: 8, paddingHorizontal: 12,
    backgroundColor: theme.colors.primary + "10",
    borderTopWidth: 1, borderTopColor: theme.colors.primary + "40",
  },
  replyQuote: {
    borderLeftWidth: 3, borderLeftColor: theme.colors.primary,
    paddingLeft: 8, paddingVertical: 3, marginBottom: 4,
  },
  menuBackdrop: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center", justifyContent: "center", padding: 20,
  },
  menuCard: {
    width: "100%", maxWidth: 320,
    backgroundColor: theme.colors.surface,
    borderRadius: 16, padding: 8,
    ...theme.shadow.lifted,
  },
  menuTitle: { color: theme.colors.textSecondary, fontWeight: "800", fontSize: 11, textTransform: "uppercase", padding: 8, letterSpacing: 0.5 },
  menuItem: {
    flexDirection: "row", alignItems: "center", gap: 10,
    padding: 12, borderRadius: 10,
  },
  menuItemDanger: { backgroundColor: theme.colors.danger + "10" },
  menuItemT: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 13.5 },
});
