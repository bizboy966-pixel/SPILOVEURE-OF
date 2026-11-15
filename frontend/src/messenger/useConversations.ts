import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { api, reportChatUnauthorized } from "@/src/api";
import { messengerApi } from "./api";
import type { Conversation, ReadReceipts } from "./types";

type TypingPresence = { userId?: string; username?: string };
export function useConversations(currentUserId?: string) {
  const [items, setItems] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [archived, setArchived] = useState(false);
  const [version, setVersion] = useState(0);
  const [feedVersion, setFeedVersion] = useState(0);
  const [readReceipts, setReadReceipts] = useState<Record<string, ReadReceipts>>({});
  const [typingByConversation, setTypingByConversation] = useState<Record<string, TypingPresence>>({});
  const typingTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const refresh = useCallback(async () => {
    try {
      const rows = await messengerApi.conversations(archived);
      setItems(rows); setError("");
    } catch (e: any) { setError(e?.detail || "Impossible de charger les conversations."); }
    finally { setLoading(false); }
  }, [archived]);
  useEffect(() => { setLoading(true); refresh(); }, [refresh]);
  useEffect(() => {
    if (typeof WebSocket === "undefined") return;
    let stopped = false, socket: WebSocket | null = null, timer: ReturnType<typeof setTimeout>, attempt = 0;
    const connect = async () => {
      try {
        const { ticket } = await api.post<{ ticket: string }>("/messenger/socket-ticket");
        if (stopped) return;
        const base = process.env.EXPO_PUBLIC_BACKEND_URL || (typeof window !== "undefined" ? window.location.origin : "");
        if (!base) throw new Error("Adresse du serveur Chat non configurée.");
        const wsBase = base.replace(/^http/, "ws").replace(/\/$/, "");
        socket = new WebSocket(`${wsBase}/api/messenger/ws?ticket=${encodeURIComponent(ticket)}`);
        socket.onopen = () => { attempt = 0; setVersion(v => v + 1); refresh(); };
        socket.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === "read" && data.conversation_id && data.user_id && data.read_at) {
              setReadReceipts(previous => ({
                ...previous, [data.conversation_id]: {
                  ...previous[data.conversation_id], [data.user_id]: data.read_at,
                },
              }));
            }
            if (data.type === "ping") socket?.send(JSON.stringify({ type: "ping" }));
            if (data.type === "typing" && data.conversation_id) {
              const userId = data.user_id || data.sender_id || data.person?.id;
              if (!userId || userId !== currentUserId) {
                const conversationId = String(data.conversation_id);
                setTypingByConversation(prev => ({
                  ...prev,
                  [conversationId]: { userId, username: data.username || data.sender_name || data.person?.username },
                }));
                clearTimeout(typingTimers.current[conversationId]);
                typingTimers.current[conversationId] = setTimeout(() => {
                  setTypingByConversation(prev => {
                    const next = { ...prev };
                    delete next[conversationId];
                    return next;
                  });
                  delete typingTimers.current[conversationId];
                }, 3000);
              }
              return;
            }
            if (data.type === "message" || data.type === "updated") setVersion(v => v + 1);
            if (["message", "updated", "read", "presence", "profile"].includes(data.type)) refresh();
            if (data.type === "feed" || data.type === "status" || data.type === "profile") {
              setFeedVersion(v => v + 1);
            }
            if (data.type === "profile") setVersion(v => v + 1);
          } catch { /* ignore malformed event */ }
        };
        socket.onclose = event => {
          if (event.code === 4401 || event.code === 4403) {
            reportChatUnauthorized();
          }
          if (event.code === 4403) {
            stopped = true;
            setError("L’accès au Chat a été retiré. Reconnectez-vous pour vérifier votre compte.");
            return;
          }
          if (!stopped) timer = setTimeout(connect, Math.min(30_000, 900 * 2 ** attempt++));
        };
        socket.onerror = () => socket?.close();
      } catch {
        if (!stopped) timer = setTimeout(connect, Math.min(30_000, 1200 * 2 ** attempt++));
      }
    };
    connect();
    const sub = AppState.addEventListener("change", (state) => { if (state === "active") { setVersion(v => v + 1); refresh(); } });
    const focus = () => { setVersion(v => v + 1); refresh(); };
    if (typeof window !== "undefined") window.addEventListener("focus", focus);
    return () => {
      stopped = true; clearTimeout(timer); socket?.close(); sub.remove();
      if (typeof window !== "undefined") window.removeEventListener("focus", focus);
      Object.values(typingTimers.current).forEach(clearTimeout);
      typingTimers.current = {};
    };
  }, [refresh, currentUserId]);
  return { items, setItems, loading, error, refresh, archived, setArchived, version, feedVersion, typingByConversation, readReceipts };
}
