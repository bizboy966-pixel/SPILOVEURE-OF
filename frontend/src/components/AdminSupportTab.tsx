/**
 * Admin Support tab — inbox of user↔admin conversations.
 *
 * Displays all conversations sorted by most-recent-activity. Selecting a
 * conversation opens the messages panel with an inline composer. A background
 * heartbeat every 30 s keeps the admin marked as "online" for user-facing
 * status without needing WebSockets.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, Image, ScrollView, StyleSheet,
  Text, TextInput, TouchableOpacity, View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api";
import { theme } from "@/src/theme";

type ConvItem = {
  id: string; user_id: string; username: string; email: string;
  last_message_at: string | null; admin_unread: number;
  preview: string; last_sender_role: string;
};
type Msg = {
  id: string; sender_role: "user" | "admin"; sender_username?: string;
  text: string; images: string[]; audio?: string | null;
  status: "sent" | "delivered" | "read";
  reply_to?: string | null;
  reply_preview?: { id: string; sender_role: string; sender_username: string; preview: string } | null;
  created_at: string; read_at?: string | null;
};

function fmtDate(iso: string | null) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString([], { day: "2-digit", month: "2-digit" });
  } catch { return ""; }
}

async function compressImage(file: File, maxBytes = 780 * 1024): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onerror = reject; r.onload = () => resolve(String(r.result));
    r.readAsDataURL(file);
  });
  if (dataUrl.length * 0.75 <= maxBytes) return dataUrl;
  const img = new window.Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
  const canvas = document.createElement("canvas");
  let scale = 1, quality = 0.8;
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

export default function AdminSupportTab() {
  const [convs, setConvs] = useState<ConvItem[]>([]);
  const [selected, setSelected] = useState<ConvItem | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [replyTo, setReplyTo] = useState<Msg | null>(null);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<any>(null);
  const hbTimer = useRef<any>(null);
  const pollTimer = useRef<any>(null);

  const loadConvs = useCallback(async () => {
    try {
      const r = await api.get<{ conversations: ConvItem[] }>("/chat/admin/conversations");
      setConvs(r.conversations || []);
    } catch { /* silent */ }
  }, []);

  const loadMsgs = useCallback(async (cid: string, opts?: { silentMarkRead?: boolean }) => {
    try {
      const r = await api.get<{ messages: Msg[] }>(`/chat/admin/conversations/${cid}/messages`);
      setMsgs(r.messages || []);
      if (!opts?.silentMarkRead) {
        try { await api.post(`/chat/admin/conversations/${cid}/mark-read`, {}); } catch {}
      }
      setTimeout(() => scrollRef.current?.scrollToEnd?.({ animated: true }), 40);
    } catch (e: any) {
      setErr(e?.detail || "Chargement impossible.");
    }
  }, []);

  // Heartbeat: keep admin marked as online.
  useEffect(() => {
    const beat = () => { api.post("/chat/admin/heartbeat", {}).catch(() => {}); };
    beat();
    hbTimer.current = setInterval(beat, 30_000);
    return () => clearInterval(hbTimer.current);
  }, []);

  // Load conversation list every 5 s.
  useEffect(() => {
    loadConvs();
    const t = setInterval(loadConvs, 5_000);
    return () => clearInterval(t);
  }, [loadConvs]);

  // Poll selected conversation every 2 s.
  useEffect(() => {
    if (!selected) return;
    loadMsgs(selected.id);
    pollTimer.current = setInterval(() => loadMsgs(selected.id, { silentMarkRead: true }), 2_000);
    return () => clearInterval(pollTimer.current);
  }, [selected?.id, loadMsgs]);

  const pickImages = () => {
    const input = document.createElement("input");
    input.type = "file"; input.accept = "image/png,image/jpeg,image/webp"; input.multiple = true;
    input.onchange = async () => {
      const files = Array.from(input.files || []).slice(0, 4 - images.length);
      const added: string[] = [];
      for (const f of files) { try { added.push(await compressImage(f)); } catch {} }
      setImages((prev) => [...prev, ...added].slice(0, 4));
    };
    input.click();
  };

  const send = async () => {
    if (!selected) return;
    const t = text.trim();
    if (!t && images.length === 0) return;
    setSending(true); setErr(null);
    try {
      const msg = await api.post<Msg>(`/chat/admin/conversations/${selected.id}/messages`,
        { text: t, images, reply_to: replyTo?.id || null });
      setText(""); setImages([]); setReplyTo(null);
      setMsgs((prev) => [...prev, msg]);
      setTimeout(() => scrollRef.current?.scrollToEnd?.({ animated: true }), 40);
      loadConvs();
    } catch (e: any) {
      setErr(e?.detail || "Envoi impossible.");
    } finally { setSending(false); }
  };

  return (
    <View style={{ flexDirection: "row", flex: 1, minHeight: 500, gap: 12 }} testID="admin-support-tab">
      {/* Left column — conversation list */}
      <View style={styles.leftCol}>
        <Text style={styles.leftTitle}>💬 Support · {convs.length} conversation{convs.length > 1 ? "s" : ""}</Text>
        <ScrollView style={{ flex: 1 }}>
          {convs.length === 0 ? (
            <Text style={{ color: theme.colors.textSecondary, fontSize: 12, padding: 12, textAlign: "center" }}>
              Aucune conversation pour l'instant.
            </Text>
          ) : convs.map((c) => (
            <TouchableOpacity
              key={c.id}
              style={[styles.convItem, selected?.id === c.id && styles.convItemActive]}
              onPress={() => setSelected(c)}
              testID={`chat-conv-${c.id}`}
            >
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Text style={styles.convName} numberOfLines={1}>{c.username || c.email || c.user_id.slice(0, 8)}</Text>
                  {c.admin_unread > 0 ? (
                    <View style={styles.convBadge}><Text style={styles.convBadgeT}>{c.admin_unread}</Text></View>
                  ) : null}
                </View>
                <Text style={styles.convPrev} numberOfLines={1}>
                  {c.last_sender_role === "admin" ? "Vous : " : ""}{c.preview || "…"}
                </Text>
              </View>
              <Text style={styles.convDate}>{fmtDate(c.last_message_at)}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* Right column — messages */}
      <View style={styles.rightCol}>
        {!selected ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
            <Ionicons name="chatbubbles-outline" size={40} color={theme.colors.textSecondary} />
            <Text style={{ color: theme.colors.textSecondary, marginTop: 8, fontSize: 13 }}>
              Sélectionnez une conversation à gauche.
            </Text>
          </View>
        ) : (
          <>
            <View style={styles.chatHeader}>
              <Text style={styles.chatHeaderT}>{selected.username || selected.email}</Text>
              <Text style={styles.chatHeaderS}>{selected.email}</Text>
            </View>
            <ScrollView ref={scrollRef} style={{ flex: 1, backgroundColor: theme.colors.surfaceMuted }} contentContainerStyle={{ padding: 12, gap: 6 }}>
              {msgs.map((m) => (
                <TouchableOpacity key={m.id} activeOpacity={0.85} onPress={() => setReplyTo(m)} style={[styles.msg, m.sender_role === "admin" ? styles.msgAdmin : styles.msgUser]} testID={`admin-msg-${m.id}`}>
                  {m.reply_preview ? (
                    <View style={{ borderLeftWidth: 3, borderLeftColor: m.sender_role === "admin" ? "rgba(255,255,255,0.6)" : theme.colors.primary, paddingLeft: 8, marginBottom: 4 }}>
                      <Text style={{ color: m.sender_role === "admin" ? "rgba(255,255,255,0.9)" : theme.colors.primary, fontSize: 10, fontWeight: "800" }}>
                        {m.reply_preview.sender_role === "admin" ? "Support" : (m.reply_preview.sender_username || "Utilisateur")}
                      </Text>
                      <Text numberOfLines={2} style={{ color: m.sender_role === "admin" ? "rgba(255,255,255,0.85)" : theme.colors.textSecondary, fontSize: 11 }}>
                        {m.reply_preview.preview}
                      </Text>
                    </View>
                  ) : null}
                  {m.text ? (
                    <Text style={m.sender_role === "admin" ? styles.msgTextAdmin : styles.msgText}>{m.text}</Text>
                  ) : null}
                  {m.images && m.images.length > 0 ? (
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: m.text ? 6 : 0 }}>
                      {m.images.map((src, i) => (<Image key={i} source={{ uri: src }} style={styles.msgImg} />))}
                    </View>
                  ) : null}
                  {m.audio ? (
                    /* @ts-ignore */
                    <audio controls src={m.audio} style={{ display: "block", marginTop: 4, height: 34, width: 220 }} />
                  ) : null}
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 3, justifyContent: "flex-end" }}>
                    <Text style={{ color: m.sender_role === "admin" ? "rgba(255,255,255,0.8)" : theme.colors.textSecondary, fontSize: 10 }}>
                      {fmtDate(m.created_at)}
                    </Text>
                    {m.sender_role === "admin" ? (
                      <Text style={{ color: m.status === "read" ? "#3B82F6" : "rgba(255,255,255,0.8)", fontSize: 11 }}>
                        {m.status === "sent" ? "✓" : "✓✓"}
                      </Text>
                    ) : null}
                  </View>
                </TouchableOpacity>
              ))}
            </ScrollView>
            {images.length > 0 ? (
              <View style={{ flexDirection: "row", gap: 6, padding: 6, backgroundColor: theme.colors.surface }}>
                {images.map((src, i) => (
                  <View key={i} style={{ position: "relative" }}>
                    <Image source={{ uri: src }} style={{ width: 50, height: 50, borderRadius: 6 }} />
                    <TouchableOpacity onPress={() => setImages((p) => p.filter((_, ix) => ix !== i))} style={{ position: "absolute", top: -4, right: -4, backgroundColor: "#EF4444", width: 18, height: 18, borderRadius: 10, alignItems: "center", justifyContent: "center" }}>
                      <Ionicons name="close" size={12} color="#fff" />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            ) : null}
            {err ? <Text style={{ color: theme.colors.danger, fontSize: 11, paddingHorizontal: 12 }}>❌ {err}</Text> : null}
            {replyTo ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 8, paddingHorizontal: 12, backgroundColor: theme.colors.primary + "10", borderTopWidth: 1, borderTopColor: theme.colors.primary + "40" }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: theme.colors.primary, fontSize: 10, fontWeight: "800" }}>↩ Répondre à {replyTo.sender_role === "admin" ? "vous" : (replyTo.sender_username || "utilisateur")}</Text>
                  <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 11 }}>{replyTo.text || (replyTo.audio ? "🎤 Message vocal" : "📷 Photo")}</Text>
                </View>
                <TouchableOpacity onPress={() => setReplyTo(null)} testID="admin-cancel-reply"><Ionicons name="close" size={16} color={theme.colors.textSecondary} /></TouchableOpacity>
              </View>
            ) : null}
            <View style={styles.composer}>
              <TouchableOpacity onPress={pickImages} style={styles.attach}><Ionicons name="image" size={20} color={theme.colors.primary} /></TouchableOpacity>
              <TextInput style={styles.input} value={text} onChangeText={setText} multiline placeholder="Répondre…" placeholderTextColor={theme.colors.textSecondary} testID="admin-chat-input" />
              <TouchableOpacity onPress={send} disabled={sending || (!text.trim() && images.length === 0)} style={[styles.send, (sending || (!text.trim() && images.length === 0)) && { opacity: 0.4 }]} testID="admin-chat-send">
                {sending ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="send" size={18} color="#fff" />}
              </TouchableOpacity>
            </View>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  leftCol: { width: 260, backgroundColor: theme.colors.surface, borderRadius: theme.radius.lg, borderWidth: 1, borderColor: theme.colors.border, padding: 8 },
  leftTitle: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 13, padding: 6, marginBottom: 4 },
  convItem: { flexDirection: "row", alignItems: "center", gap: 6, padding: 8, borderRadius: 8 },
  convItemActive: { backgroundColor: theme.colors.primary + "18" },
  convName: { color: theme.colors.textPrimary, fontWeight: "700", fontSize: 12.5 },
  convPrev: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 2 },
  convDate: { color: theme.colors.textSecondary, fontSize: 10 },
  convBadge: { backgroundColor: "#EF4444", borderRadius: 10, minWidth: 18, height: 18, paddingHorizontal: 5, alignItems: "center", justifyContent: "center" },
  convBadgeT: { color: "#fff", fontSize: 10, fontWeight: "800" },
  rightCol: { flex: 1, backgroundColor: theme.colors.surface, borderRadius: theme.radius.lg, borderWidth: 1, borderColor: theme.colors.border, overflow: "hidden" },
  chatHeader: { padding: 10, backgroundColor: theme.colors.primaryDark },
  chatHeaderT: { color: "#fff", fontWeight: "800", fontSize: 14 },
  chatHeaderS: { color: "rgba(255,255,255,0.8)", fontSize: 11 },
  msg: { maxWidth: "80%", padding: 10, borderRadius: 14 },
  msgAdmin: { alignSelf: "flex-end", backgroundColor: theme.colors.primary, borderBottomRightRadius: 4 },
  msgUser: { alignSelf: "flex-start", backgroundColor: "#fff", borderWidth: 1, borderColor: theme.colors.border, borderBottomLeftRadius: 4 },
  msgText: { color: theme.colors.textPrimary, fontSize: 13, lineHeight: 18 },
  msgTextAdmin: { color: "#fff", fontSize: 13, lineHeight: 18 },
  msgImg: { width: 120, height: 120, borderRadius: 6 },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 6, padding: 8, backgroundColor: theme.colors.surface, borderTopWidth: 1, borderTopColor: theme.colors.border },
  attach: { width: 40, height: 40, borderRadius: 20, backgroundColor: theme.colors.surfaceMuted, alignItems: "center", justifyContent: "center" },
  input: { flex: 1, minHeight: 40, maxHeight: 120, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, backgroundColor: theme.colors.surfaceMuted, color: theme.colors.textPrimary, fontSize: 13, borderWidth: 1, borderColor: theme.colors.border },
  send: { width: 42, height: 42, borderRadius: 22, backgroundColor: theme.colors.primary, alignItems: "center", justifyContent: "center" },
});
