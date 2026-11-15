import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "@/src/api";
import { useChat } from "@/src/chat/ChatContext";
import { canUseWebPush, setupWebPush } from "@/src/lib/firebase";
import { messengerApi } from "@/src/messenger/api";
import { playNotificationSound, unlockNotificationAudio, type NotificationSoundSettings } from "@/src/messenger/notificationSound";
import { chatNotificationEvent, getActiveNotificationConversation } from "@/src/messenger/notificationRuntime";

type Incoming = {
  enabled: boolean; conversation_id: string; message_id: string;
  title: string; body: string; avatar?: string; conversation_title?: string;
  settings: NotificationSoundSettings & { scope: string };
};

export default function ChatPushBootstrap() {
  const { user, loading } = useChat();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [queue, setQueue] = useState<Incoming[]>([]);
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [soundError, setSoundError] = useState("");
  const draftId = useRef("");
  const current = queue[0];
  const replyInput = useRef<TextInput>(null);

  const dismiss = () => {
    setQueue(old => old.slice(1));
    setReplying(false); setText(""); setError(""); setSoundError(""); draftId.current = "";
  };
  useEffect(() => {
    setQueue([]); setReplying(false); setText(""); setError(""); setSoundError("");
  }, [user?.id]);
  useEffect(() => {
    if (!current || replying || busy) return;
    const timer = setTimeout(dismiss, 10_000);
    return () => clearTimeout(timer);
  }, [current?.message_id, replying, busy]);
  useEffect(() => {
    if (!user?.id || loading || Platform.OS !== "web" || typeof WebSocket === "undefined") return;
    let disposed = false, socket: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const seen = new Set<string>();
    const notices = new Set<Notification>();
    const accept = async (cid: string, mid: string) => {
      if (disposed || !cid || !mid || seen.has(mid)) return;
      seen.add(mid);
      if (seen.size > 500) seen.delete(seen.values().next().value!);
      try {
        const notice = await api.get<Incoming>(`/messenger/conversations/${encodeURIComponent(cid)}/messages/${encodeURIComponent(mid)}/notification`);
        if (disposed || !notice.enabled) return;
        void messengerApi.markConversationDelivered(cid).catch(() => undefined);
        if (document.visibilityState === "visible" && getActiveNotificationConversation() === cid) return;
        // Never replace the banner being replied to when other messages arrive.
        setQueue(old => old.length < 8 ? [...old, notice] : [old[0], ...old.slice(2), notice]);
        if (document.visibilityState === "visible") {
          void playNotificationSound(user.id, notice.settings.scope, notice.settings)
            .catch(() => setSoundError("Son non joué. Activez ou testez le son dans les paramètres."));
        } else if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          const systemNotice = new Notification(notice.title, {
            body: notice.body, icon: notice.avatar || "/icon-192.png", tag: `chat-${cid}`,
            silent: !notice.settings.sound_enabled,
          });
          notices.add(systemNotice);
          systemNotice.onclose = () => notices.delete(systemNotice);
          systemNotice.onclick = () => {
            window.focus(); systemNotice.close();
            router.push(`/messenger?conversation=${encodeURIComponent(cid)}` as any);
          };
        }
      } catch (failure) {
        // A revoked, muted or deleted message must never leak a stale preview.
        console.warn("[Chat] Notification indisponible", failure);
      }
    };
    const connect = async () => {
      if (disposed) return;
      try {
        const { ticket } = await api.post<{ ticket: string }>("/messenger/socket-ticket");
        if (disposed) return;
        const base = (process.env.EXPO_PUBLIC_BACKEND_URL || window.location.origin).replace(/^http/, "ws").replace(/\/$/, "");
        socket = new WebSocket(`${base}/api/messenger/ws?ticket=${encodeURIComponent(ticket)}`);
        socket.onopen = () => { attempts = 0; };
        socket.onmessage = event => {
          try {
            const packet = JSON.parse(event.data);
            if (packet.type === "ping") socket?.send(JSON.stringify({ type: "ping" }));
            if (packet.type === "message" && packet.sender_id !== user.id && !packet.silent) {
              void accept(packet.conversation_id, packet.message_id);
            }
            if (packet.type === "notification_preferences") {
              // Remove already visible previews immediately when privacy/mute preferences change.
              setQueue([]); setReplying(false); setText("");
              chatNotificationEvent("spv-notification-settings-changed", {});
            }
          } catch {}
        };
        socket.onclose = event => {
          if (event.code === 4401 || event.code === 4403) return;
          if (!disposed) reconnect = setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempts++));
        };
        socket.onerror = () => socket?.close();
      } catch {
        if (!disposed) reconnect = setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempts++));
      }
    };
    const onPush = (event: Event) => {
      const data = (event as CustomEvent).detail;
      if (data?.conversation_id && data?.message_id) void accept(data.conversation_id, data.message_id);
    };
    const clearNotices = () => {
      setQueue([]); setReplying(false); setText(""); setError("");
      notices.forEach(notice => notice.close()); notices.clear();
    };
    window.addEventListener("spv-chat-push", onPush);
    window.addEventListener("spv-notification-settings-changed", clearNotices);
    window.addEventListener("pointerdown", unlockNotificationAudio);
    window.addEventListener("keydown", unlockNotificationAudio);
    void connect();
    // Never prompt automatically: activation happens from the explicit settings button.
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      void canUseWebPush().then(supported => {
        if (!supported || disposed) return;
        return setupWebPush(() => {}, {
          registerToken: payload => disposed ? Promise.resolve() : api.post("/identity/chat/push-token", payload, {
            auth: false, credentials: "include",
          }),
        });
      }).catch(failure => console.warn("[FCM Chat] Enregistrement indisponible", failure));
    }
    return () => {
      disposed = true; clearTimeout(reconnect); socket?.close();
      notices.forEach(notice => notice.close());
      window.removeEventListener("spv-chat-push", onPush);
      window.removeEventListener("spv-notification-settings-changed", clearNotices);
      window.removeEventListener("pointerdown", unlockNotificationAudio);
      window.removeEventListener("keydown", unlockNotificationAudio);
    };
  }, [user?.id, loading, router]);

  const open = () => {
    if (!current) return;
    router.push(`/messenger?conversation=${encodeURIComponent(current.conversation_id)}` as any);
    dismiss();
  };
  const reply = async () => {
    if (!current || !text.trim() || busy) return;
    setBusy(true); setError("");
    if (!draftId.current) draftId.current = `notification-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      await messengerApi.send(current.conversation_id, {
        text: text.trim(), reply_to: current.message_id, client_id: draftId.current,
      });
      dismiss();
    } catch (failure: any) {
      setError(failure?.detail || "Réponse non envoyée. Réessayez.");
    } finally { setBusy(false); }
  };
  const unread = async () => {
    if (!current || busy) return;
    setBusy(true); setError("");
    try {
      chatNotificationEvent("spv-chat-mark-unread", { conversationId: current.conversation_id });
      await api.post(`/messenger/conversations/${encodeURIComponent(current.conversation_id)}/unread`, {});
      chatNotificationEvent("spv-chat-inbox-refresh", {});
      dismiss();
    } catch (failure: any) { setError(failure?.detail || "Impossible de marquer cette discussion comme non lue."); }
    finally { setBusy(false); }
  };
  if (!user || !current) return null;
  return <View pointerEvents="box-none" style={[styles.overlay, { top: Math.max(insets.top, 10) }]}>
    <View style={styles.banner} testID="chat-live-notification" accessibilityLiveRegion="polite">
      <View style={styles.head}>
        <TouchableOpacity onPress={open} style={styles.identity} accessibilityLabel="Ouvrir la discussion">
          <View style={styles.avatar}>{current.avatar
            ? <Image source={{ uri: current.avatar }} style={styles.photo} />
            : <Text style={styles.initial}>{current.title.slice(0, 1).toUpperCase()}</Text>}</View>
          <View style={styles.copy}><Text numberOfLines={1} style={styles.name}>{current.title}</Text>
            {!!current.conversation_title && <Text numberOfLines={1} style={styles.group}>{current.conversation_title}</Text>}
            <Text numberOfLines={replying ? 1 : 3} style={styles.body}>{current.body}</Text></View>
        </TouchableOpacity>
        <TouchableOpacity onPress={dismiss} accessibilityLabel="Fermer la notification" style={styles.close}><Ionicons name="close" size={20} color="#687991" /></TouchableOpacity>
      </View>
      {!replying ? <View style={styles.actions}>
        <TouchableOpacity testID="chat-notification-reply" onPress={() => { setReplying(true); requestAnimationFrame(() => replyInput.current?.focus()); }} style={styles.action}><Ionicons name="return-up-back" size={16} color="#1769e8" /><Text style={styles.actionText}>Répondre</Text></TouchableOpacity>
        <TouchableOpacity testID="chat-notification-unread" onPress={unread} disabled={busy} style={styles.action}><Ionicons name="mail-unread-outline" size={16} color="#1769e8" /><Text style={styles.actionText}>Marquer comme non lu</Text></TouchableOpacity>
      </View> : <View style={styles.replyRow}>
        <TextInput ref={replyInput} autoFocus value={text} onChangeText={value => { draftId.current = ""; setText(value); }}
          placeholder="Votre réponse…" style={styles.input} multiline maxLength={8000} editable={!busy} testID="chat-notification-reply-input" />
        <TouchableOpacity style={styles.send} onPress={reply} disabled={busy || !text.trim()} accessibilityLabel="Envoyer la réponse" testID="chat-notification-send">{busy ? <ActivityIndicator color="#fff" /> : <Ionicons name="send" size={19} color="#fff" />}</TouchableOpacity>
      </View>}
      {!!error && <Text style={styles.error}>{error}</Text>}
      {!!soundError && <Text style={styles.hint}>{soundError}</Text>}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  overlay: { position: "absolute", left: 10, right: 10, alignItems: "center", zIndex: 10000 },
  banner: { width: "100%", maxWidth: 500, backgroundColor: "#fff", borderRadius: 20, padding: 12, borderWidth: 1, borderColor: "#dce6f3", shadowColor: "#102042", shadowOpacity: .2, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 15 },
  head: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  identity: { flex: 1, minWidth: 0, flexDirection: "row", gap: 10, alignItems: "center" },
  avatar: { width: 44, height: 44, borderRadius: 23, backgroundColor: "#e7effd", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  photo: { width: 44, height: 44 }, initial: { color: "#1769e8", fontSize: 20, fontWeight: "800" },
  copy: { flex: 1, minWidth: 0 }, name: { color: "#102042", fontSize: 14, fontWeight: "800" },
  group: { color: "#687991", fontSize: 11, marginTop: 2 },
  body: ({ color: "#374a67", fontSize: 13, lineHeight: 18, marginTop: 3, overflowWrap: "anywhere" } as any),
  close: { padding: 4 }, actions: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 9 },
  action: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "#edf4ff", borderRadius: 15, paddingVertical: 8, paddingHorizontal: 10 },
  actionText: { color: "#1769e8", fontSize: 11, fontWeight: "800" },
  replyRow: { flexDirection: "row", gap: 8, marginTop: 10, alignItems: "flex-end" },
  input: { flex: 1, minWidth: 0, minHeight: 42, maxHeight: 130, borderRadius: 14, backgroundColor: "#f0f4fa", padding: 10, fontSize: 14, color: "#102042", outlineStyle: "none" as any },
  send: { width: 42, height: 42, borderRadius: 22, backgroundColor: "#1769e8", alignItems: "center", justifyContent: "center" },
  error: { color: "#b63840", fontSize: 12, marginTop: 8 }, hint: { color: "#687991", fontSize: 11, marginTop: 6 },
});
