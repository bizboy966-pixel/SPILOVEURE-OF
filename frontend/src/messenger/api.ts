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
  message: (conversationId: string, messageId: string) =>
    api.get<Message>(`/messenger/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`),
  send: (id: string, payload: {
    text: string; client_id: string; attachments?: Attachment[]; reply_to?: string;
    forwarded_from?: string; silent?: boolean; status_reply_id?: string;
  }) =>
    api.post<Message>(`/messenger/conversations/${encodeURIComponent(id)}/messages`, payload),
  markConversationDelivered: (conversationId: string) =>
    api.post(`/messenger/conversations/${encodeURIComponent(conversationId)}/delivered`, {}),
  file: async (id: string, file: File, durationSeconds?: number, viewOnce = false) =>
    api.upload<Attachment>(
      `/messenger/conversations/${encodeURIComponent(id)}/files`,
      file,
      "file",
      {
        ...(durationSeconds === undefined ? {} : { duration_seconds: durationSeconds }),
        ...(viewOnce ? { view_once: "true" } : {}),
      },
    ),
  stickers: () => api.get<Attachment[]>("/messenger/stickers"),
  saveSticker: (conversationId: string, messageId: string, fileId: string) =>
    api.post<Attachment>(
      `/messenger/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/stickers/${encodeURIComponent(fileId)}/save`,
      {},
    ),
  copySticker: (conversationId: string, fileId: string) =>
    api.post<Attachment>(`/messenger/stickers/${encodeURIComponent(fileId)}/copy`, {
      conversation_id: conversationId,
    }),
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
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), 30_000) : null;
  try {
    const response = await fetch(`${base}/api/messenger/files/${encodeURIComponent(fileId)}`, {
      credentials: "include", cache: "no-store", signal: controller?.signal,
    });
    if (response.status === 401) reportChatUnauthorized();
    if (!response.ok) {
      const error: any = new Error("Impossible d’ouvrir ce fichier.");
      error.status = response.status;
      throw error;
    }
    return URL.createObjectURL(await response.blob());
  } catch (error: any) {
    if (controller?.signal.aborted) throw new Error("Le chargement du fichier a expiré. Réessayez.");
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
