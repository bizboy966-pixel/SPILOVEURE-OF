import React, { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api, setChatUnauthorizedHandler } from "@/src/api";
import { markChatLoggedOut } from "./chatLaunchState";

export type ChatUser = { id: string; username: string; account_username?: string; chat_username?: string; email?: string; profile_photo?: string };
type ChatContextType = { user: ChatUser | null; loading: boolean; sessionExpired: boolean; refresh: () => Promise<ChatUser | null>; logout: () => Promise<void> };
const ChatContext = createContext<ChatContextType | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<ChatUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);
  const userRef = useRef<ChatUser | null>(null);
  userRef.current = user;
  const refresh = useCallback(async () => {
    try {
      const state = await api.get<{ user: ChatUser }>("/identity/chat/session", { auth: false, credentials: "include" });
      const chatUser = {
        ...state.user,
        account_username: state.user.username,
        username: state.user.chat_username || state.user.username,
      };
      setUser(chatUser);
      setSessionExpired(false);
      return chatUser;
    } catch (error: any) {
      if (error?.status === 401) {
        setUser(null);
        setSessionExpired(true);
        return null;
      }
      // A network/server failure is not proof that the cookie was revoked.
      return userRef.current;
    }
  }, []);
  useEffect(() => { refresh().finally(() => setLoading(false)); }, [refresh]);
  useEffect(() => {
    setChatUnauthorizedHandler(() => { void refresh(); });
    return () => setChatUnauthorizedHandler(null);
  }, [refresh]);
  const logout = useCallback(async () => {
    try { await api.post("/identity/chat/logout", undefined, { auth: false, credentials: "include" }); }
    finally {
      await markChatLoggedOut();
      setUser(null);
      setSessionExpired(false);
    }
  }, []);
  return <ChatContext.Provider value={{ user, loading, sessionExpired, refresh, logout }}>{children}</ChatContext.Provider>;
}
export function useChat() {
  const context = useContext(ChatContext);
  if (!context) throw new Error("useChat must be inside ChatProvider");
  return context;
}
