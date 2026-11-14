import { api, reportChatUnauthorized } from "@/src/api";
import type { Attachment, Conversation, Message, Person, PublicChannel, ScheduledMessage, MessengerCapabilities } from "./types";

export const messengerApi = {
  conversations: (archived = false) => api.get<Conversation[]>(`/messenger/conversations?archived=${archived}`),
  conversation: (id: string) => api.get<Conversation>(`/messenger/conversations/${encodeURIComponent(id)}`),
  createConversation: (body: { kind: string; title?: string; member_ids?: string[]; is_public?: boolean }) =>
    api.post<Conversation>("/messenger/conversations", body),
  patchConversation: (id: string, body: Record<string, unknown>) =>
    api.patch<Conversation>(`/messenger/conversations/${encodeURIComponent(id)}`, body),
  messages: (id: string, before?: string, q?: string) => {
    const params = new URLSearchParams({ limit: "50" });
    if (before) params.set("before", before);
    if (q) params.set("q", q);
    return api.get<{ items: Message[]; has_more: boolean }>(`/messenger/conversations/${encodeURIComponent(id)}/messages?${params}`);
  },
  send: (id: string, payload: { text: string; client_id: string; attachments?: Attachment[]; reply_to?: string; forwarded_from?: string; silent?: boolean }) =>
    api.post<Message>(`/messenger/conversations/${encodeURIComponent(id)}/messages`, payload),
  file: async (id: string, file: File) => api.upload<Attachment>(`/messenger/conversations/${encodeURIComponent(id)}/files`, file),
  people: (q: string) => api.get<Person[]>(`/messenger/people?q=${encodeURIComponent(q)}`),
  publicChannels: (q = "") => api.get<PublicChannel[]>(`/messenger/channels?q=${encodeURIComponent(q)}`),
  joinChannel: (id: string) => api.post<Conversation>(`/messenger/channels/${encodeURIComponent(id)}/join`),
  scheduledMessages: (id: string) => api.get<ScheduledMessage[]>(`/messenger/conversations/${encodeURIComponent(id)}/scheduled`),
  scheduleMessage: (id: string, payload: Record<string, unknown>) =>
    api.post<ScheduledMessage>(`/messenger/conversations/${encodeURIComponent(id)}/scheduled`, payload),
  cancelScheduledMessage: (id: string, scheduledId: string) =>
    api.delete(`/messenger/conversations/${encodeURIComponent(id)}/scheduled/${encodeURIComponent(scheduledId)}`),
  capabilities: () => api.get<MessengerCapabilities>("/messenger/capabilities"),
};

export async function protectedFileUrl(fileId: string): Promise<string> {
  if (typeof window === "undefined" || typeof URL === "undefined") throw new Error("Fichier indisponible");
  const base = process.env.EXPO_PUBLIC_BACKEND_URL || "";
  const response = await fetch(`${base}/api/messenger/files/${encodeURIComponent(fileId)}`, {
    credentials: "include", cache: "no-store",
  });
  if (response.status === 401) reportChatUnauthorized();
  if (!response.ok) throw new Error("Impossible d’ouvrir ce fichier.");
  return URL.createObjectURL(await response.blob());
}
