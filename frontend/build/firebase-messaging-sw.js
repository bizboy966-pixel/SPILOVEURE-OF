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
messaging.onBackgroundMessage((payload) => {
  const n = payload.notification || {};
  const link = (payload.fcmOptions && payload.fcmOptions.link) ||
               (payload.data && payload.data.link) || "/";
  self.registration.showNotification(n.title || "SPILOVEURE", {
    body: n.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: link },
    tag: (payload.data && payload.data.tag) || "spiloveure",
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url.includes(url) && "focus" in w) return w.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
