export type Person = { id: string; username: string; avatar?: string; online?: boolean; last_seen?: string };
export type ReadReceipts = Record<string, string>;
export type Attachment = { id: string; name: string; mime: string; size: number; url: string };
export type Message = {
  id: string; conversation_id: string; sender_id: string; sender_name: string; text: string;
  created_at: string; edited_at?: string; deleted: boolean; attachments: Attachment[];
  reply_to?: string; reactions: Record<string, string[]>; pinned: boolean; read_by: string[];
  client_id?: string; forwarded_from?: string;
};
export type Conversation = {
  id: string; kind: "private" | "group" | "channel" | "saved"; title: string; photo?: string;
  members: string[]; admins: string[]; owner_id: string; created_at: string; updated_at: string;
  permissions?: ConversationPermissions;
  last_message?: Message; unread: number; muted: boolean; archived: boolean; pinned: boolean;
  draft: string; read_at?: string; member_profiles: Person[]; is_public?: boolean; is_saved?: boolean;
};
export type Post = {
  id: string; author_id: string; author_name: string; text: string; attachments: Attachment[];
  visibility: "contacts" | "public"; created_at: string; is_official?: boolean;
  reactions: Record<string, string[]>; comments: { id: string; user_id: string; username: string; text: string; created_at: string }[];
};
export type ChatStatus = {
  id: string; author_id: string; author_name: string; author_avatar?: string; text: string;
  attachments: Attachment[]; created_at: string; expires_at: string; viewed_by_me?: boolean;
  views_count?: number; viewed_by?: string[]; viewers?: Person[];
  likes_count?: number; liked_by_me?: boolean;
};
export type ContactState = { contacts: Person[]; blocked: Person[]; requests: Person[]; sent: string[] };
export type ConversationPermissions = {
  send_messages: "all" | "admins";
  add_members: boolean;
  edit_info: boolean;
};
export type PublicChannel = { id: string; title: string; member_count: number; joined: boolean };
export type ScheduledMessage = {
  id: string; scheduled_at: string; status: "pending" | "processing" | "failed";
  error?: string;
  payload: { text: string; attachments?: Attachment[]; silent?: boolean; reply_to?: string; forwarded_from?: string };
};
export type MessengerCapabilities = {
  scheduled_messages: boolean; public_channels: boolean; push_configured: boolean;
  calls: false; calls_reason: string; end_to_end_encryption: false;
};
