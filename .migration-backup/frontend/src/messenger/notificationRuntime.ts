// Shared only within the current browser tab. Never stores credentials or message text.
let activeConversation: string | null = null;
export function setActiveNotificationConversation(id: string | null) {
  activeConversation = id;
}
export function getActiveNotificationConversation() {
  return activeConversation;
}
export function chatNotificationEvent(name: string, detail: unknown) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(name, { detail }));
}
