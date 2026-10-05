/* SPILOVEURE Service Worker — v27as (2026-03-04)
 *
 * The in-app install flow was removed on user request. This file is kept
 * only to self-destruct on existing clients : if someone's browser still
 * holds the previous SW, this one activates, deletes every spiloveure-*
 * cache and unregisters itself. From then on the browser serves the live
 * origin directly (no stale shell) and never shows "Impossible d'installer
 * cette appli" from a mismatched manifest/SW criteria.
 */

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k).catch(() => false)));
    } catch { /* ignore */ }
    try {
      await self.registration.unregister();
    } catch { /* ignore */ }
    // Reload every client so they start running against the live network.
    try {
      const clients = await self.clients.matchAll({ type: "window" });
      clients.forEach((c) => {
        try { c.navigate(c.url); } catch { /* ignore */ }
      });
    } catch { /* ignore */ }
  })());
});

self.addEventListener("fetch", (event) => {
  // Pass-through — no caching whatsoever.
  return;
});
