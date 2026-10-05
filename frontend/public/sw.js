/* SPILOVEURE Service Worker — v27at (2026-03-05)
 *
 * Minimal, STABLE service worker whose only purpose is to:
 *   1. Expose a `fetch` handler so Chromium/Edge consider the app
 *      installable as a PWA ("Install app" / WebAPK on Android).
 *   2. Keep passing every request through to the network — zero caching,
 *      zero offline shell, zero reload loops.
 *
 * History :
 *   • v27an shipped an aggressive pre-cache + skipWaiting flow that could
 *     leave old clients reloading forever when the SW self-destructed.
 *   • v27as neutered the SW (self-unregister + client.navigate) which
 *     broke PWA install criteria → Chrome "Impossible d'installer".
 *   • v27at (this file) is the long-term stable baseline: fetch handler
 *     only, no cache, no self-unregister, no client reloads.
 */

const LEGACY_CACHE_PREFIX = "spiloveure-";

self.addEventListener("install", (event) => {
  // Activate immediately so we never leave users stuck on an older SW.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Idempotent one-time clean-up: wipe any stale caches left over by
    // v27an / previous builds. Does nothing after the first run.
    try {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith(LEGACY_CACHE_PREFIX))
          .map((k) => caches.delete(k).catch(() => false)),
      );
    } catch { /* ignore */ }
    try { await self.clients.claim(); } catch { /* ignore */ }
  })());
});

// Network-only fetch handler. We MUST implement this (even as a passthrough)
// for the browser to count the SW towards the PWA install criteria.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  event.respondWith(fetch(req).catch((err) => {
    // If network fails and we have nothing cached, surface a minimal
    // response rather than letting the request hang.
    return new Response("", { status: 504, statusText: "Network error" });
  }));
});

// Allow the page to ask the SW to skip waiting without a page reload loop.
self.addEventListener("message", (event) => {
  if (event?.data?.type === "SKIP_WAITING") {
    try { self.skipWaiting(); } catch { /* ignore */ }
  }
});
