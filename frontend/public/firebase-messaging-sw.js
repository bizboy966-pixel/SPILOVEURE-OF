/* eslint-disable */
// Firebase Cloud Messaging Service Worker for SPILOVEURE
// Served at https://<origin>/firebase-messaging-sw.js (root scope required).
// Uses classic (importScripts) SDK because service workers must load
// synchronously across all supported browsers.

importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyBzaI6o5DdN9szRVxHn1tLtyV4phlq1sXI",
  authDomain: "spiloveure-40954.firebaseapp.com",
  projectId: "spiloveure-40954",
  storageBucket: "spiloveure-40954.firebasestorage.app",
  messagingSenderId: "60770299183",
  appId: "1:60770299183:web:3801e1dbcb12625b30c5da",
});

const messaging = firebase.messaging();

// Background messages: browser tab closed / not focused.
messaging.onBackgroundMessage(async (payload) => {
  const n = payload.notification || {};
  const link = (payload.fcmOptions && payload.fcmOptions.link) ||
               (payload.data && payload.data.link) || "/";
  const data = payload.data || {};
  let preview = null;
  if (data.kind === "chat") {
    if (!data.conversation_id || !data.message_id) return;
    try {
      const response = await fetch(`/api/messenger/conversations/${encodeURIComponent(data.conversation_id)}/messages/${encodeURIComponent(data.message_id)}/notification`, { credentials: "include" });
      if (!response.ok) return;
      preview = await response.json();
      if (!preview.enabled) return;
    } catch { return; }
  }
  return self.registration.showNotification(preview?.title || n.title || data.title || "SPILOVEURE", {
    body: preview?.body || n.body || data.body || "",
    icon: preview?.avatar || "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: link, conversation_id: data.conversation_id, kind: data.kind },
    tag: (payload.data && payload.data.tag) || "spiloveure",
    ...(data.kind === "chat" ? {
      silent: preview ? !preview.settings.sound_enabled : data.silent === "true",
      actions: [
        { action: "reply", title: "Répondre" },
        { action: "unread", title: "Marquer comme non lu" },
      ],
    } : {}),
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  if (data.kind === "chat" && event.action === "unread" && data.conversation_id) {
    event.waitUntil((async () => {
      try {
        const response = await fetch(`/api/messenger/conversations/${encodeURIComponent(data.conversation_id)}/unread`, {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" }, body: "{}",
        });
        if (response.ok) return;
      } catch {}
      // An expired session must not silently discard the user's action.
      await clients.openWindow(`/messenger?conversation=${encodeURIComponent(data.conversation_id)}&notificationAction=unread`);
    })());
    return;
  }
  const url = (event.notification.data && event.notification.data.url) || "/";
  let target;
  try {
    target = new URL(url, self.location.origin);
    if (target.origin !== self.location.origin) return;
    if (data.kind === "chat" && event.action === "reply") target.searchParams.set("notificationAction", "reply");
  } catch { return; }
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url === target.href && "focus" in w) return w.focus();
      }
      if (clients.openWindow) return clients.openWindow(target.href);
    })
  );
});
