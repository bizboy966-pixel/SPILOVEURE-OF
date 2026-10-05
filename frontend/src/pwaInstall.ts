// SPILOVEURE — PWA install + download orchestration (v27an / 2026-03-04).
//
// Public API :
//   • registerServiceWorker()        → called once at app boot
//   • getPlatform()                  → "android" | "ios" | "desktop" | "unknown"
//   • getInstallState()              → snapshot of install capabilities
//   • onInstallChange(cb)            → subscribe to state changes
//   • downloadApp(onProgress)        → fetches + caches the whole app shell
//                                      with REAL byte progress reporting
//   • installApp()                   → triggers the native install prompt
//                                      (Android/Desktop) or returns iOS hint
//   • triggerUpdate(onProgress)      → pre-caches the new shell with REAL
//                                      progress, then activates + reloads
//   • getInstalledVersion()          → version string the user previously
//                                      installed, or null
//   • setInstalledVersion(v)         → persist in localStorage after a
//                                      confirmed install (appinstalled event
//                                      or standalone detection).
//
// Design notes :
//   - We rely on `beforeinstallprompt` to detect PWA installability on
//     Android/Chromium/Edge. iOS Safari does not fire this event, so we
//     return a platform-specific instruction object.
//   - Real byte-level progress comes from the service worker streaming
//     each asset through `ReadableStream` and posting `CACHE_PROGRESS`.
//   - We purposefully never ship a .apk / .ipa — the installable artefact
//     IS the PWA, which Chrome packages into a WebAPK on Android, Safari
//     adds to the Home Screen on iOS, and Chrome/Edge installs as a
//     desktop app on PC. Zero admin action, zero file upload.

export type PwaPlatform = "android" | "ios" | "desktop" | "unknown";

export type InstallState = {
  platform: PwaPlatform;
  isStandalone: boolean;   // already installed (running as app)
  canPrompt: boolean;      // beforeinstallprompt was captured
  swRegistered: boolean;
};

// localStorage key — persists the version the user installed, so a page
// refresh / re-login / new device shows the correct "Déjà installée" state
// and a published newer version re-arms the download button.
const INSTALLED_VERSION_KEY = "spiloveure.installed.version";

export function getInstalledVersion(): string | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage.getItem(INSTALLED_VERSION_KEY); } catch { return null; }
}

export function setInstalledVersion(v: string): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(INSTALLED_VERSION_KEY, v); } catch {}
}

export function clearInstalledVersion(): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.removeItem(INSTALLED_VERSION_KEY); } catch {}
}

let deferredPrompt: any = null;
let state: InstallState = {
  platform: "unknown",
  isStandalone: false,
  canPrompt: false,
  swRegistered: false,
};
const listeners = new Set<(s: InstallState) => void>();

function emit() {
  const snapshot = { ...state };
  listeners.forEach((cb) => { try { cb(snapshot); } catch {} });
}

export function onInstallChange(cb: (s: InstallState) => void): () => void {
  listeners.add(cb);
  cb({ ...state });
  return () => { listeners.delete(cb); };
}

export function getInstallState(): InstallState {
  return { ...state };
}

export function getPlatform(): PwaPlatform {
  if (typeof navigator === "undefined") return "unknown";
  const ua = (navigator.userAgent || "").toLowerCase();
  if (/android/.test(ua)) return "android";
  if (/iphone|ipad|ipod/.test(ua)) return "ios";
  // iPadOS 13+ pretends to be a Mac — detect via touch events.
  if (/mac/.test(ua) && (navigator as any).maxTouchPoints && (navigator as any).maxTouchPoints > 1) return "ios";
  if (/win|mac|linux|cros/.test(ua)) return "desktop";
  return "unknown";
}

function detectStandalone(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if ((window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)) return true;
    if ((navigator as any).standalone === true) return true;
  } catch {}
  return false;
}

export async function registerServiceWorker(): Promise<void> {
  state.platform = getPlatform();
  state.isStandalone = detectStandalone();

  if (typeof window === "undefined") { emit(); return; }

  // v27an → publish CLIENT_VERSION on window so the appinstalled handler
  // can persist it without a circular import.
  try {
    const v = require("./version").CLIENT_VERSION;
    (window as any).__SPILOVEURE_CLIENT_VERSION__ = v;
    // If we're already running in standalone mode and no install record
    // exists yet, backfill the installed version — the browser didn't
    // fire appinstalled because the install happened in a previous
    // session.
    if (state.isStandalone && !getInstalledVersion()) {
      setInstalledVersion(String(v));
    }
  } catch {}

  // Capture the native install prompt as soon as the browser offers it.
  window.addEventListener("beforeinstallprompt", (ev: any) => {
    try { ev.preventDefault(); } catch {}
    deferredPrompt = ev;
    state.canPrompt = true;
    emit();
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    state.canPrompt = false;
    state.isStandalone = true;
    // Persist the client version at install-time so the Profil card can
    // decide between "✅ Déjà installée" and "Mettre à jour" after any
    // reload / reconnexion / nouvel appareil.
    try {
      // CLIENT_VERSION is baked at build time; we re-read it from the
      // module instead of importing to avoid a circular dep.
      const v = (window as any).__SPILOVEURE_CLIENT_VERSION__;
      if (v) setInstalledVersion(String(v));
    } catch {}
    emit();
  });

  if ("serviceWorker" in navigator) {
    try {
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      state.swRegistered = !!reg;
      // Listen for a new SW taking over → reload so the user runs new code.
      let refreshing = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (refreshing) return;
        refreshing = true;
        try { window.location.reload(); } catch {}
      });
      emit();
    } catch (err) {
      // SW registration failure must not break the app.
      state.swRegistered = false;
      emit();
    }
  } else {
    emit();
  }
}

// Discover the shell URLs the browser needs to render SPILOVEURE offline.
// We fetch the current HTML, parse <script>/<link>/<img> and the webmanifest
// icons, and return absolute URLs on the current origin.
async function discoverShellUrls(): Promise<string[]> {
  if (typeof window === "undefined") return [];
  const origin = window.location.origin;
  const urls = new Set<string>();
  urls.add(origin + "/");
  urls.add(origin + "/manifest.webmanifest");
  urls.add(origin + "/favicon.ico");
  urls.add(origin + "/icon-192.png");
  urls.add(origin + "/icon-512.png");
  urls.add(origin + "/icon-192-maskable.png");
  urls.add(origin + "/icon-512-maskable.png");
  try {
    const htmlResp = await fetch(origin + "/", { credentials: "same-origin" });
    const html = await htmlResp.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script[src]").forEach((n) => {
      const src = n.getAttribute("src"); if (src) urls.add(new URL(src, origin).toString());
    });
    doc.querySelectorAll("link[href]").forEach((n) => {
      const rel = (n.getAttribute("rel") || "").toLowerCase();
      const href = n.getAttribute("href");
      if (!href) return;
      // Prefetch/preload JS chunks + stylesheets + icons.
      if (/stylesheet|icon|preload|modulepreload|manifest/.test(rel)) {
        urls.add(new URL(href, origin).toString());
      }
    });
    // Expo Router SPA ships a single bundle under /_expo/static/js/...
    // but any <script src> picked above already covers it.
  } catch {
    // Even if HTML discovery fails, the icon/manifest list above gives us
    // enough to show real progress and seed the cache.
  }
  return Array.from(urls);
}

type ProgressCb = (p: { loaded: number; total: number; percent: number; url?: string }) => void;

async function waitForController(timeoutMs = 2000): Promise<ServiceWorker | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
  return await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      clearTimeout(t);
      resolve(navigator.serviceWorker.controller || null);
    }, { once: true });
  });
}

async function cacheViaServiceWorker(urls: string[], cacheName: string, onProgress: ProgressCb): Promise<void> {
  const sw = await waitForController();
  if (!sw) {
    // Fallback: do the caching from the page itself using the Cache API.
    await cacheFromPage(urls, cacheName, onProgress);
    return;
  }
  const requestId = Math.random().toString(36).slice(2);
  await new Promise<void>((resolve, reject) => {
    const handler = (ev: MessageEvent) => {
      const data = ev.data || {};
      if (data.requestId !== requestId) return;
      if (data.type === "CACHE_PROGRESS") {
        onProgress({ loaded: data.loaded, total: data.total, percent: data.percent, url: data.url });
      } else if (data.type === "CACHE_DONE") {
        navigator.serviceWorker.removeEventListener("message", handler);
        resolve();
      } else if (data.type === "CACHE_ERROR") {
        navigator.serviceWorker.removeEventListener("message", handler);
        reject(new Error(data.error || "SW cache error"));
      }
    };
    navigator.serviceWorker.addEventListener("message", handler);
    sw.postMessage({ type: "CACHE_URLS", urls, cacheName, requestId });
  });
}

async function cacheFromPage(urls: string[], cacheName: string, onProgress: ProgressCb): Promise<void> {
  if (typeof caches === "undefined") {
    // Really old browser — just fake the progress linearly.
    for (let i = 0; i < urls.length; i++) {
      try { await fetch(urls[i], { credentials: "same-origin" }); } catch {}
      onProgress({ loaded: i + 1, total: urls.length, percent: Math.round(((i + 1) / urls.length) * 100), url: urls[i] });
    }
    return;
  }
  const sizes: number[] = new Array(urls.length).fill(0);
  let totalBytes = 0;
  for (let i = 0; i < urls.length; i++) {
    try {
      const h = await fetch(urls[i], { method: "HEAD", credentials: "same-origin" });
      const n = parseInt(h.headers.get("content-length") || "0", 10);
      if (n > 0) { sizes[i] = n; totalBytes += n; }
    } catch {}
  }
  const cache = await caches.open(cacheName);
  const useBytes = totalBytes > 0;
  let loaded = 0;
  for (let i = 0; i < urls.length; i++) {
    try {
      const resp = await fetch(urls[i], { credentials: "same-origin" });
      if (!resp.ok) throw new Error("http " + resp.status);
      if (resp.body && typeof (resp.body as any).getReader === "function") {
        const reader = (resp.body as any).getReader();
        const chunks: Uint8Array[] = [];
        let fileLoaded = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          fileLoaded += value.byteLength;
          if (useBytes) {
            loaded += value.byteLength;
            onProgress({ loaded, total: totalBytes, percent: Math.min(100, Math.round((loaded / totalBytes) * 100)), url: urls[i] });
          }
        }
        const blob = new Blob(chunks as any);
        await cache.put(urls[i], new Response(blob, { headers: resp.headers }));
      } else {
        await cache.put(urls[i], resp.clone());
      }
      if (!useBytes) {
        loaded = i + 1;
        onProgress({ loaded, total: urls.length, percent: Math.round(((i + 1) / urls.length) * 100), url: urls[i] });
      }
    } catch {
      // keep going
    }
  }
}

export async function downloadApp(onProgress: ProgressCb, version?: string): Promise<void> {
  const urls = await discoverShellUrls();
  const name = `spiloveure-shell-${version || "latest"}`;
  await cacheViaServiceWorker(urls, name, onProgress);
}

export async function installApp(): Promise<"installed" | "dismissed" | "ios-instructions" | "manual-instructions" | "unsupported"> {
  const plat = getPlatform();
  if (deferredPrompt) {
    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      deferredPrompt = null;
      state.canPrompt = false;
      emit();
      return choice && choice.outcome === "accepted" ? "installed" : "dismissed";
    } catch {
      return "dismissed";
    }
  }
  if (detectStandalone()) {
    // Already running as installed PWA — nothing to prompt.
    state.isStandalone = true;
    emit();
    return "installed";
  }
  if (plat === "ios") return "ios-instructions";
  // Android/Desktop fallback : the beforeinstallprompt may not fire if the
  // user previously dismissed it, if the manifest / SW criteria weren't
  // met yet, or if the browser version doesn't support PWA install (e.g.
  // Firefox mobile). We tell the UI to show the browser-menu instructions
  // ("Chrome menu → Installer l'application / Ajouter à l'écran d'accueil").
  return "manual-instructions";
}

export async function triggerUpdate(onProgress: ProgressCb, version?: string): Promise<void> {
  // Re-download the shell into a fresh cache so progress reflects the
  // actual new-version payload, then tell the waiting SW to take over.
  await downloadApp(onProgress, version);
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        try { await reg.update(); } catch {}
        if (reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
        else if (reg.active) reg.active.postMessage({ type: "SKIP_WAITING" });
      }
    } catch {}
  }
  // Hard reload — the controllerchange listener in registerServiceWorker()
  // will also trigger a reload, but we double-check here for robustness.
  if (typeof window !== "undefined") {
    try { window.location.reload(); } catch {}
  }
}
