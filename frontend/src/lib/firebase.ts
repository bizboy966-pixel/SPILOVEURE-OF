/**
 * Firebase Cloud Messaging bootstrap for SPILOVEURE (Expo Web).
 *
 * - Guards against Node/native calls (Firebase Messaging is web-only here).
 * - Initialises the Firebase JS SDK v10 modular API.
 * - Registers the classic service worker at `/firebase-messaging-sw.js`.
 * - Requests notification permission, fetches an FCM token via VAPID,
 *   POSTs it to the backend `/api/push/tokens` endpoint.
 * - Wires `onMessage` for foreground toasts so notifications also fire
 *   while the tab is focused.
 */
import { Platform } from "react-native";
import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import {
  getMessaging,
  getToken,
  isSupported,
  onMessage,
  type Messaging,
} from "firebase/messaging";

import { api } from "@/src/api";

const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

const VAPID_KEY = process.env.EXPO_PUBLIC_FIREBASE_VAPID_KEY;

let _app: FirebaseApp | null = null;
let _messaging: Messaging | null = null;
let _unsubscribeForeground: (() => void) | null = null;

function isWeb(): boolean {
  return Platform.OS === "web" && typeof window !== "undefined";
}

function getDeviceId(): string {
  const KEY = "spilv_push_device_id";
  try {
    const existing = window.localStorage.getItem(KEY);
    if (existing) return existing;
    const uuid =
      (window.crypto && "randomUUID" in window.crypto)
        ? window.crypto.randomUUID()
        : `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(KEY, uuid);
    return uuid;
  } catch {
    return `dev-${Date.now()}`;
  }
}

/** Detect if the environment can actually run web push (browser support + SDK support). */
export async function canUseWebPush(): Promise<boolean> {
  if (!isWeb()) return false;
  if (!("serviceWorker" in navigator)) return false;
  if (!("Notification" in window)) return false;
  try {
    return await isSupported();
  } catch {
    return false;
  }
}

/** Initialise Firebase App singletons and register the service worker. */
async function ensureInitialised(): Promise<Messaging | null> {
  if (!(await canUseWebPush())) return null;
  if (!_app) {
    _app = getApps()[0] || initializeApp(firebaseConfig as any);
  }
  if (!_messaging) {
    _messaging = getMessaging(_app);
  }
  return _messaging;
}

/**
 * Public entry point — call once after the user is authenticated.
 * `onToast` receives foreground notification payloads so the caller can
 * render them with its own toast library (sonner / RN Toast).
 * Returns the registered FCM token (or null when unavailable / refused).
 */
export async function setupWebPush(
  onToast: (title: string, body: string, data?: Record<string, string>) => void
): Promise<string | null> {
  try {
    const messaging = await ensureInitialised();
    if (!messaging) return null;

    // Ask permission (browser handles no-op if already granted / denied).
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return null;

    // Register (or reuse) the service worker at root scope.
    const registration = await navigator.serviceWorker.register(
      "/firebase-messaging-sw.js",
      { scope: "/" }
    );
    // Ensure it's active before requesting a token.
    await navigator.serviceWorker.ready;

    const token = await getToken(messaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: registration,
    });
    if (!token) return null;

    // Ship token to the backend so admins can broadcast to this device.
    try {
      await api.post("/push/tokens", {
        token,
        device_id: getDeviceId(),
        platform: "web",
        user_agent: navigator.userAgent?.slice(0, 500) || null,
      });
    } catch (e) {
      // Non-fatal — token is still valid in the browser; the next login
      // attempt will re-post it.
      console.warn("[FCM] token upload failed", e);
    }

    // Foreground handler — re-subscribe on every setup so we don't leak.
    if (_unsubscribeForeground) _unsubscribeForeground();
    _unsubscribeForeground = onMessage(messaging, (payload) => {
      const title = payload.notification?.title || "Notification";
      const body = payload.notification?.body || "";
      const data = (payload.data || {}) as Record<string, string>;
      try {
        onToast(title, body, data);
      } catch {
        /* swallow — the notification is still visible via the SW when app is closed */
      }
    });

    return token;
  } catch (e) {
    console.warn("[FCM] setupWebPush failed", e);
    return null;
  }
}

/** Ask the current browser about the notification permission state. */
export function currentPermission(): NotificationPermission | "unsupported" {
  if (!isWeb() || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}
