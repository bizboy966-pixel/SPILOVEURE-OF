type UnreadConversation = { unread?: number | null };

export function sumUnreadMessages(conversations: readonly UnreadConversation[]): number {
  return conversations.reduce((total, conversation) => {
    const unread = conversation.unread;
    if (typeof unread !== "number" || !Number.isFinite(unread)) return total;
    return total + Math.max(0, Math.floor(unread));
  }, 0);
}

export function unreadBadgeLabel(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count > 99 ? "99+" : String(Math.floor(count));
}
