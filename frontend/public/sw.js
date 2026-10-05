/* SPILOVEURE Service Worker — v27an (2026-03-04)
 *
 * Role :
 *   • Cache the full PWA app shell (HTML, JS bundles, CSS, assets) so the
 *     user has an installable "native-like" experience on Android / iOS / PC.
 *   • Serve from cache first (offline-capable) and fall back to network.
 *   • Accept messages from the main thread to pre-cache a list of URLs with
 *     real byte progress reporting (`CACHE_URLS` message).
 *   • Accept SKIP_WAITING to activate a new SW immediately after an update.
 *
 * No admin configuration — version is driven by the frontend build + backend
 * `/api/app/version` endpoint. See UpdateGate.tsx and InstallAppCard.tsx.
 */

const SHELL_CACHE_PREFIX = "spiloveure-shell-";
const RUNTIME_CACHE = "spiloveure-runtime";

self.addEventListener("install", (event) => {
  // Don't skipWaiting here — we let the user click "Installer maintenant"
  // which posts SKIP_WAITING to trigger activation. This ensures the user
  // sees the real progress bar reach 100% before the swap happens.
  self.skipWaiting(); // actually, let's skip-wait by default to speed up first install
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Clean every old shell cache (keep only the current one if any).
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith(SHELL_CACHE_PREFIX))
        .slice(0, -1)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  if (data.type === "CACHE_URLS") {
    const { urls, cacheName, requestId } = data;
    const target = cacheName || `${SHELL_CACHE_PREFIX}${Date.now()}`;
    event.waitUntil(cacheWithProgress(urls, target, requestId, event.source).catch((err) => {
      try {
        event.source && event.source.postMessage({
          type: "CACHE_ERROR", requestId, error: String(err && err.message || err),
        });
      } catch {}
    }));
    return;
  }
});

async function cacheWithProgress(urls, cacheName, requestId, client) {
  const cache = await caches.open(cacheName);
  // First pass: HEAD each URL to compute total expected bytes. If HEAD is
  // unsupported, we fall back to counting items instead of bytes.
  let totalBytes = 0;
  const sizes = new Array(urls.length).fill(0);
  for (let i = 0; i < urls.length; i++) {
    try {
      const h = await fetch(urls[i], { method: "HEAD" });
      const len = parseInt(h.headers.get("content-length") || "0", 10);
      if (len > 0) { sizes[i] = len; totalBytes += len; }
    } catch { /* ignore */ }
  }
  const useBytes = totalBytes > 0;
  let loaded = 0;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      const resp = await fetch(url, { credentials: "same-origin" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
      // Clone before caching — streams can only be consumed once.
      const total = sizes[i] || parseInt(resp.headers.get("content-length") || "0", 10);
      if (resp.body && typeof resp.body.getReader === "function") {
        const reader = resp.body.getReader();
        const chunks = [];
        let fileLoaded = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          fileLoaded += value.byteLength;
          if (useBytes) {
            // Only count net new bytes beyond this file's expected size to
            // avoid overshoot when content-length wasn't available.
            const inc = total > 0 ? Math.min(value.byteLength, total - (fileLoaded - value.byteLength)) : value.byteLength;
            loaded += Math.max(0, inc);
            if (client) {
              client.postMessage({
                type: "CACHE_PROGRESS",
                requestId,
                loaded,
                total: totalBytes,
                percent: Math.min(100, Math.round((loaded / totalBytes) * 100)),
                url,
              });
            }
          }
        }
        const blob = new Blob(chunks, { type: resp.headers.get("content-type") || "application/octet-stream" });
        const newResp = new Response(blob, { headers: resp.headers, status: resp.status, statusText: resp.statusText });
        await cache.put(url, newResp);
      } else {
        const blob = await resp.blob();
        await cache.put(url, new Response(blob, { headers: resp.headers }));
      }
      if (!useBytes) {
        loaded = i + 1;
        if (client) {
          client.postMessage({
            type: "CACHE_PROGRESS",
            requestId,
            loaded,
            total: urls.length,
            percent: Math.round(((i + 1) / urls.length) * 100),
            url,
          });
        }
      }
    } catch (err) {
      // Report the specific file failure but keep going for the rest.
      if (client) {
        client.postMessage({
          type: "CACHE_WARN",
          requestId,
          url,
          error: String(err && err.message || err),
        });
      }
    }
  }
  if (client) {
    client.postMessage({ type: "CACHE_DONE", requestId, cacheName, loaded, total: useBytes ? totalBytes : urls.length });
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Never intercept the API — always go to network so auth / data stay fresh.
  if (url.pathname.startsWith("/api/")) return;
  // Never cache the version endpoint — must be fresh on every call.
  if (url.pathname.includes("/app/version")) return;

  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) {
      // Opportunistic revalidate in the background.
      fetch(req).then((resp) => {
        if (resp && resp.ok) {
          caches.open(RUNTIME_CACHE).then((c) => c.put(req, resp.clone())).catch(() => {});
        }
      }).catch(() => {});
      return cached;
    }
    try {
      const resp = await fetch(req);
      if (resp && resp.ok && (resp.type === "basic" || resp.type === "cors")) {
        const copy = resp.clone();
        caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return resp;
    } catch (err) {
      // Last-chance fallback: serve the cached root HTML so the SPA shell
      // can still render offline. This is what makes the installed PWA
      // feel like a native app.
      const fallback = await caches.match("/");
      if (fallback) return fallback;
      throw err;
    }
  })());
});
