import { storage } from "@/src/utils/storage";

const CHAT_LOGOUT_MARKER = "spiloveure_chat_explicit_logout";

export async function wasChatExplicitlyLoggedOut(): Promise<boolean> {
  return (await storage.getItem(CHAT_LOGOUT_MARKER, false as boolean)) === true;
}

export async function markChatLoggedOut(): Promise<void> {
  await storage.setItem(CHAT_LOGOUT_MARKER, true);
}

export async function clearChatLogoutMarker(): Promise<void> {
  await storage.removeItem(CHAT_LOGOUT_MARKER);
}
