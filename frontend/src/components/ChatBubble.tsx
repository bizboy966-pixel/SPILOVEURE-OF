/**
 * Floating chat bubble → conversation with SPILOVEURE support (admins).
 *
 * Positioned bottom-right on every page under (app). Polls /api/chat/me
 * every 3 seconds while the panel is open, every 20 seconds while closed
 * (only to refresh the unread badge). Admin online status shown in the
 * header. Read receipts: single grey tick = sent, double grey = delivered,
 * double blue = admin has read.
 *
 * Photos: user can attach up to 4 images per message (800 KB max each,
 * client-side compressed to <= 800 KB via canvas). Photos are stored as
 * base64 data-URLs directly in the message document (Phase 1 MVP).
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, Image, Modal, Platform, ScrollView,
  StyleSheet, Text, TextInput, TouchableOpacity, View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api";
import { useAuth } from "@/src/auth";
import { theme } from "@/src/theme";

type Msg = {
  id: string;
  conversation_id: string;
  sender_role: "user" | "admin";
  sender_username?: string;
  text: string;
  images: string[];
  status: "sent" | "delivered" | "read";
  created_at: string;
  read_at?: string | null;
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
  // Load into canvas and iteratively compress.
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
  if (status === "read") return <Text style={{ color: "#3B82F6", fontSize: 11 }}>✓✓</Text>;
  if (status === "delivered") return <Text style={{ color: "#6B7280", fontSize: 11 }}>✓✓</Text>;
  return <Text style={{ color: "#9CA3AF", fontSize: 11 }}>✓</Text>;
}

export default function ChatBubble() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [unread, setUnread] = useState(0);
  const [supportOnline, setSupportOnline] = useState(false);
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<any>(null);
  const scrollRef = useRef<any>(null);

  const fetchState = useCallback(async () => {
    try {
      const r = await api.get<Payload>("/chat/me");
      setPayload(r);
      setUnread(r.conversation.user_unread || 0);
      setSupportOnline(!!r.support_online);
    } catch { /* silent */ }
  }, []);

  // Poll: fast while open, slow while closed. Skip entirely if unauthenticated.
  useEffect(() => {
    if (!user) return;
    fetchState();
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(fetchState, open ? 3000 : 20000);
    return () => clearInterval(timer.current);
  }, [user, open, fetchState]);

  // Mark read on open.
  useEffect(() => {
    if (!open || !payload) return;
    (async () => {
      try {
        await api.post("/chat/me/mark-read", {});
        setUnread(0);
      } catch { /* silent */ }
    })();
    // Scroll to bottom.
    setTimeout(() => scrollRef.current?.scrollToEnd?.({ animated: false }), 60);
  }, [open, payload?.messages.length]);

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
      const msg = await api.post<Msg>("/chat/me/messages", { text: t, images });
      setText(""); setImages([]);
      setPayload((p) => p ? { ...p, messages: [...p.messages, msg] } : p);
      setTimeout(() => scrollRef.current?.scrollToEnd?.({ animated: true }), 40);
    } catch (e: any) {
      setErr(e?.detail || "Envoi impossible.");
    } finally { setSending(false); }
  };

  if (!user) return null;

  return (
    <>
      {/* Bubble */}
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
            {/* Header */}
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

            {/* Messages */}
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
              ) : payload.messages.map((m) => (
                <View
                  key={m.id}
                  style={[
                    styles.bubbleMsg,
                    m.sender_role === "user" ? styles.bubbleMsgMe : styles.bubbleMsgOther,
                  ]}
                >
                  {m.text ? (
                    <Text style={m.sender_role === "user" ? styles.msgTextMe : styles.msgText}>
                      {m.text}
                    </Text>
                  ) : null}
                  {m.images && m.images.length > 0 ? (
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: m.text ? 6 : 0 }}>
                      {m.images.map((src, i) => (
                        <Image key={i} source={{ uri: src }} style={styles.msgImg} />
                      ))}
                    </View>
                  ) : null}
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 3, justifyContent: "flex-end" }}>
                    <Text style={m.sender_role === "user" ? styles.msgTsMe : styles.msgTs}>
                      {fmtTime(m.created_at)}
                    </Text>
                    {m.sender_role === "user" ? <TicksIcon status={m.status} /> : null}
                  </View>
                </View>
              ))}
            </ScrollView>

            {/* Attachments preview */}
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

            {/* Composer */}
            <View style={styles.composer}>
              <TouchableOpacity onPress={pickImages} style={styles.attachBtn} testID="chat-attach">
                <Ionicons name="image" size={20} color={theme.colors.primary} />
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
            </View>
          </View>
        </View>
      </Modal>
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
    alignSelf: "flex-end",
    backgroundColor: theme.colors.primary,
    borderBottomRightRadius: 4,
  },
  bubbleMsgOther: {
    alignSelf: "flex-start",
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
});
