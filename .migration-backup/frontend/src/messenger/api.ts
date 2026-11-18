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
  pinnedMessages: (id: string) =>
    api.get<{ items: Message[]; has_more: boolean }>(
      `/messenger/conversations/${encodeURIComponent(id)}/messages?limit=50&pinned_only=true`,
    ),
  message: (conversationId: string, messageId: string) =>
    api.get<Message>(`/messenger/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`),
  send: (id: string, payload: {
    text: string; client_id: string; attachments?: Attachment[]; reply_to?: string;
    forwarded_from?: string; silent?: boolean; status_reply_id?: string;
  }) =>
    api.post<Message>(`/messenger/conversations/${encodeURIComponent(id)}/messages`, payload),
  markConversationDelivered: (conversationId: string) =>
    api.post(`/messenger/conversations/${encodeURIComponent(conversationId)}/delivered`, {}),
  file: (id: string, file: File, durationSeconds?: number, viewOnce = false, sticker = false) =>
    uploadChatFile(
      `/messenger/conversations/${encodeURIComponent(id)}/files/upload-url`,
      `/messenger/conversations/${encodeURIComponent(id)}/files`,
      file,
      {
        ...(durationSeconds === undefined ? {} : { duration_seconds: durationSeconds }),
        ...(viewOnce ? { view_once: true } : {}),
        ...(sticker ? { sticker: true } : {}),
      },
      {
        ...(durationSeconds === undefined ? {} : { duration_seconds: durationSeconds }),
        ...(viewOnce ? { view_once: "true" } : {}),
        ...(sticker ? { sticker: "true" } : {}),
      },
    ),
  feedFile: (file: File) =>
    uploadChatFile("/messenger/feed/files/upload-url", "/messenger/feed/files", file, {}, {}),
  stickers: () => api.get<Attachment[]>("/messenger/stickers"),
  stickerPack: () => api.get<Attachment[]>("/messenger/sticker-pack"),
  myStickerPack: () => api.get<Attachment[]>("/messenger/sticker-pack/mine"),
  addStickerToPack: (conversationId: string, messageId: string, fileId: string) =>
    api.post<Attachment>(`/messenger/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/stickers/${encodeURIComponent(fileId)}/pack`, {}),
  removeStickerFromPack: (fileId: string) => api.delete(`/messenger/stickers/${encodeURIComponent(fileId)}/pack`),
  removeSticker: (id: string) => api.delete(`/messenger/stickers/${encodeURIComponent(id)}`),
  videoSticker: (id: string, file: File, start: number, duration: number) =>
    api.upload<Attachment>(`/messenger/conversations/${encodeURIComponent(id)}/stickers/video`, file, "file", { start, duration }),
  saveSticker: (conversationId: string, messageId: string, fileId: string) =>
    api.post<Attachment>(
      `/messenger/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/stickers/${encodeURIComponent(fileId)}/save`,
      {},
    ),
  copySticker: (conversationId: string, fileId: string) =>
    api.post<Attachment>(`/messenger/stickers/${encodeURIComponent(fileId)}/copy`, {
      conversation_id: conversationId,
    }),
  people: (q = "", limit = 50, offset = 0) =>
    api.get<Person[]>(`/messenger/people?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`),
  publicChannels: (q = "") => api.get<PublicChannel[]>(`/messenger/channels?q=${encodeURIComponent(q)}`),
  joinChannel: (id: string) => api.post<Conversation>(`/messenger/channels/${encodeURIComponent(id)}/join`),
  scheduledMessages: (id: string) => api.get<ScheduledMessage[]>(`/messenger/conversations/${encodeURIComponent(id)}/scheduled`),
  scheduleMessage: (id: string, payload: Record<string, unknown>) =>
    api.post<ScheduledMessage>(`/messenger/conversations/${encodeURIComponent(id)}/scheduled`, payload),
  cancelScheduledMessage: (id: string, scheduledId: string) =>
    api.delete(`/messenger/conversations/${encodeURIComponent(id)}/scheduled/${encodeURIComponent(scheduledId)}`),
  capabilities: () => api.get<MessengerCapabilities>("/messenger/capabilities"),
};

type UploadTicket = { id: string; upload_url: string; headers: Record<string, string> };
let capabilitiesCache: { value: MessengerCapabilities; expiresAt: number } | null = null;

async function getMessengerCapabilities(): Promise<MessengerCapabilities> {
  if (capabilitiesCache && capabilitiesCache.expiresAt > Date.now()) return capabilitiesCache.value;
  const value = await messengerApi.capabilities();
  capabilitiesCache = { value, expiresAt: Date.now() + 60_000 };
  return value;
}

function uploadFilename(file: File): string {
  if (file.name && /\.[a-z0-9]{2,8}$/i.test(file.name)) return file.name;
  const mime = file.type.split(";")[0].toLowerCase();
  const extByMime: Record<string, string> = {
    "audio/webm": ".webm", "audio/ogg": ".ogg", "audio/mp4": ".m4a",
    "audio/mpeg": ".mp3", "audio/wav": ".wav", "video/mp4": ".mp4",
    "video/webm": ".webm", "video/quicktime": ".mov", "video/3gpp": ".3gp",
    "video/3gpp2": ".3g2", "image/jpeg": ".jpg", "image/png": ".png",
    "image/gif": ".gif", "image/webp": ".webp", "application/pdf": ".pdf",
    "text/plain": ".txt", "text/csv": ".csv", "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.ms-powerpoint": ".ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "application/zip": ".zip", "application/gzip": ".gz", "text/vcard": ".vcf",
  };
  return `upload${extByMime[mime] || ""}`;
}

function decodeR2ErrorBody(body: string): { code?: string; message?: string } {
  const text = body.trim();
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    const code = value?.Code || value?.code;
    const message = value?.Message || value?.message || value?.detail;
    return {
      ...(typeof code === "string" ? { code: code.slice(0, 100) } : {}),
      ...(typeof message === "string" ? { message: message.slice(0, 240) } : {}),
    };
  } catch {
    const xmlCode = text.match(/<Code>([^<]{1,100})<\/Code>/i)?.[1];
    const xmlMessage = text.match(/<Message>([^<]{1,240})<\/Message>/i)?.[1];
    if (xmlCode || xmlMessage) {
      return {
        ...(xmlCode ? { code: xmlCode } : {}),
        ...(xmlMessage ? { message: xmlMessage.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") } : {}),
      };
    }
    if (text.length <= 240 && !/^<!doctype html|^<html/i.test(text)) return { message: text };
    return {};
  }
}

async function responseError(response: Response, operation: string): Promise<Error & { status?: number; code?: string }> {
  const details = decodeR2ErrorBody(await response.text().catch(() => ""));
  const reason = [details.code, details.message].filter(Boolean).join(" — ");
  const error: Error & { status?: number; code?: string } = new Error(
    `${operation} (HTTP ${response.status})${reason ? ` : ${reason}` : ""}`,
  );
  error.status = response.status;
  error.code = details.code;
  return error;
}

function directUploadNetworkError(error: unknown): Error {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return new Error("Envoi R2 impossible : cet appareil indique qu’il est hors connexion.");
  }
  const nativeMessage = error instanceof Error ? error.message : "";
  const detail = nativeMessage && !/failed to fetch|network request failed|load failed/i.test(nativeMessage)
    ? ` (${nativeMessage})`
    : "";
  return new Error(
    `Aucune réponse de R2${detail}. Le navigateur masque la cause exacte d’un échec réseau (par exemple CORS ou connexion interrompue). Vérifiez le réseau et la règle CORS pour https://spiloveure.org.`,
  );
}

export function messengerErrorMessage(error: any, fallback: string): string {
  const detail = typeof error?.detail === "string" ? error.detail.trim() : "";
  const message = typeof error?.message === "string" ? error.message.trim() : "";
  const status = Number.isFinite(error?.status) ? Number(error.status) : undefined;
  if (detail) return `${detail}${status ? ` (HTTP ${status})` : ""}`;
  if (message && !/^(failed to fetch|network request failed|load failed)$/i.test(message)) return message;
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "Envoi impossible : cet appareil indique qu’il est hors connexion.";
  }
  if (error instanceof TypeError || /^(failed to fetch|network request failed|load failed)$/i.test(message)) {
    return "Aucune réponse du serveur. Le navigateur masque la cause exacte (réseau ou CORS). Vérifiez la connexion puis réessayez.";
  }
  if (status) return `La requête a échoué (HTTP ${status}).`;
  return fallback;
}

async function uploadChatFile(
  ticketPath: string,
  legacyPath: string,
  file: File,
  metadata: Record<string, string | number | boolean>,
  legacyFields: Record<string, string | number>,
): Promise<Attachment> {
  const capabilities = await getMessengerCapabilities();
  if (capabilities.r2_direct_uploads === undefined) {
    // Keep previews and older VPS builds working while the new backend is
    // prepared. The updated backend reports false if its R2 credentials are
    // missing, in which case we fail rather than silently storing locally.
    return api.upload<Attachment>(legacyPath, file, "file", legacyFields);
  }
  if (!capabilities.r2_direct_uploads) {
    throw new Error("Le stockage R2 du Chat n’est pas encore configuré sur le serveur.");
  }
  const ticket = await api.post<UploadTicket>(ticketPath, {
    name: uploadFilename(file),
    size: file.size,
    mime: file.type,
    ...metadata,
  });
  let response: Response;
  try {
    response = await fetch(ticket.upload_url, {
      method: "PUT",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      headers: ticket.headers,
      body: file,
    });
  } catch (error) {
    await api.delete(`/messenger/uploads/${encodeURIComponent(ticket.id)}`).catch(() => {});
    throw directUploadNetworkError(error);
  }
  if (!response.ok) {
    const error = await responseError(response, "R2 a refusé le transfert");
    await api.delete(`/messenger/uploads/${encodeURIComponent(ticket.id)}`).catch(() => {});
    throw error;
  }
  return api.post<Attachment>(`/messenger/uploads/${encodeURIComponent(ticket.id)}/complete`, {});
}

export async function protectedFileUrl(fileId: string, download = false): Promise<string> {
  if (typeof window === "undefined" || typeof URL === "undefined") throw new Error("Fichier indisponible");
  const base = (process.env.EXPO_PUBLIC_BACKEND_URL || "").replace(/\/+$/, "");
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), 30_000) : null;
  try {
    const capabilities = await getMessengerCapabilities();
    if (capabilities.r2_direct_uploads === undefined) {
      // Older VPS versions stream the file from their protected endpoint and
      // do not expose the short-lived R2 URL route yet.
      const legacyResponse = await fetch(
        `${base}/api/messenger/files/${encodeURIComponent(fileId)}`,
        { credentials: "include", cache: "no-store", signal: controller?.signal },
      );
      if (legacyResponse.status === 401) reportChatUnauthorized();
      if (!legacyResponse.ok) throw await responseError(legacyResponse, "Impossible d’ouvrir ce fichier");
      return URL.createObjectURL(await legacyResponse.blob());
    }
    const query = download ? "?download=true" : "";
    const response = await fetch(`${base}/api/messenger/files/${encodeURIComponent(fileId)}/url${query}`, {
      credentials: "include", cache: "no-store", signal: controller?.signal,
    });
    if (response.status === 401) reportChatUnauthorized();
    if (!response.ok) throw await responseError(response, "Impossible d’obtenir le lien du fichier");
    const result = await response.json();
    if (result.direct && typeof result.url === "string") return result.url;
    const fileUrl = new URL(result.url, base || window.location.origin).toString();
    const fileResponse = await fetch(fileUrl, {
      credentials: "include", cache: "no-store", signal: controller?.signal,
    });
    if (fileResponse.status === 401) reportChatUnauthorized();
    if (!fileResponse.ok) throw await responseError(fileResponse, "Impossible de télécharger le fichier");
    return URL.createObjectURL(await fileResponse.blob());
  } catch (error: any) {
    if (controller?.signal.aborted) throw new Error("Le chargement du fichier a expiré. Réessayez.");
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
