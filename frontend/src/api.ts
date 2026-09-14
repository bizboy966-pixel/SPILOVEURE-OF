import { storage } from "@/src/utils/storage";

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL || "";

// In-memory token cache — set synchronously by signIn/signUp/AuthProvider on boot.
// Eliminates the race condition where AsyncStorage (IndexedDB on web) hasn't
// flushed the new token by the time the next request reads it.
let _authToken: string | null = null;

export function setAuthToken(token: string | null) {
  _authToken = token;
}

export function getAuthToken(): string | null {
  return _authToken;
}

export type ApiError = { detail?: string; status?: number };

// ─── Global 401 handler ─────────────────────────────────────────
// AuthProvider registers a callback here on mount so that any request
// hitting an expired / invalid JWT triggers a global sign-out + redirect
// to the login screen. Prior to this, individual screens would show a
// stale "Session expirée" alert on every action while the user stayed
// on the page with a broken token.
type UnauthorizedHandler = (message: string) => void;
let _onUnauthorized: UnauthorizedHandler | null = null;
export function setUnauthorizedHandler(cb: UnauthorizedHandler | null) {
  _onUnauthorized = cb;
}

// ─── Global 403 ACTIVATION_REQUIRED handler (v23) ───────────────
// Any protected-action endpoint on the backend returns 403 with detail
// "ACTIVATION_REQUIRED" for pending users. ActivationProvider registers
// a callback here so we open the activation modal automatically instead
// of surfacing a generic error to the user.
type ActivationRequiredHandler = () => void;
let _onActivationRequired: ActivationRequiredHandler | null = null;
export function setActivationRequiredHandler(cb: ActivationRequiredHandler | null) {
  _onActivationRequired = cb;
}

// Detail strings the backend uses for JWT-related failures (auth.py).
const AUTH_ERROR_STRINGS = new Set([
  "Session expirée.",
  "Token manquant.",
  "Token invalide.",
  "Token expiré.",
  "Type de token invalide.",
  "Utilisateur introuvable.",
]);

async function request<T = any>(
  path: string,
  opts: RequestInit & { auth?: boolean; pwdConfirm?: string } = {}
): Promise<T> {
  const { auth = true, pwdConfirm, headers, ...rest } = opts;
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    ...(headers as any),
  };
  if (auth) {
    // Prefer in-memory cache (set synchronously after login). Fall back to
    // persistent storage on cold boot before AuthProvider has loaded.
    let token = _authToken;
    if (!token) {
      const stored = await storage.secureGet("auth_token", "");
      if (stored) {
        token = stored as string;
        _authToken = token; // hydrate cache
      }
    }
    if (token) h["Authorization"] = `Bearer ${token}`;
  }
  if (pwdConfirm) h["X-Password-Confirm"] = pwdConfirm;
  const res = await fetch(`${BASE}/api${path}`, {
    ...rest,
    headers: h,
    // Never let the browser or any intermediate CDN serve a cached
    // response for authenticated calls — /auth/me, /payments/*/status
    // and everything downstream MUST reflect the fresh DB state right
    // after an activation, otherwise the layout guard reads a stale
    // `max_level=0` and bounces the user to /pay (2026-09-07 bug).
    cache: "no-store",
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    let message: string = "Erreur serveur";
    const d = data?.detail ?? data?.message;
    if (typeof d === "string") {
      message = d;
    } else if (Array.isArray(d)) {
      // FastAPI/Pydantic ValidationError → array of {loc, msg, type, ...}
      message = d
        .map((item: any) => {
          if (typeof item === "string") return item;
          const loc = Array.isArray(item?.loc)
            ? item.loc.filter((p: any) => p !== "body").join(".")
            : "";
          const rawMsg = item?.msg || "champ invalide";
          // Translate common Pydantic English messages to French
          const fr = translatePydanticMsg(rawMsg, item?.ctx);
          const frLoc = translateField(loc);
          return frLoc ? `${frLoc} : ${fr}` : fr;
        })
        .join(" • ");
    } else if (d && typeof d === "object") {
      message = d.msg || JSON.stringify(d);
    }
    // Global auth-expiry hook: any 401 that matches a known JWT failure
    // string should force a clean sign-out + redirect. Prevents the "user
    // stays on a page whose every action fails with 'Session expirée'"
    // dead-end that Challenge Performance was hitting.
    if (res.status === 401 && AUTH_ERROR_STRINGS.has(message)) {
      _authToken = null;
      if (_onUnauthorized) {
        try { _onUnauthorized(message); } catch { /* ignore handler bugs */ }
      }
    }
    // v23 — global ACTIVATION_REQUIRED hook. Any protected-action backend
    // guard sends `403 { detail: "ACTIVATION_REQUIRED" }` for pending
    // users. Route it to the activation modal instead of a generic toast.
    if (res.status === 403 && message === "ACTIVATION_REQUIRED") {
      if (_onActivationRequired) {
        try { _onActivationRequired(); } catch { /* ignore handler bugs */ }
      }
    }
    const err: ApiError = { detail: message, status: res.status };
    throw err;
  }
  return data as T;
}

export const api = {
  get: <T = any>(p: string, opts: any = {}) => request<T>(p, { method: "GET", ...opts }),
  post: <T = any>(p: string, body?: any, opts: any = {}) =>
    request<T>(p, { method: "POST", body: body ? JSON.stringify(body) : undefined, ...opts }),
  put: <T = any>(p: string, body?: any, opts: any = {}) =>
    request<T>(p, { method: "PUT", body: body ? JSON.stringify(body) : undefined, ...opts }),
  patch: <T = any>(p: string, body?: any, opts: any = {}) =>
    request<T>(p, { method: "PATCH", body: body ? JSON.stringify(body) : undefined, ...opts }),
  delete: <T = any>(p: string, opts: any = {}) => request<T>(p, { method: "DELETE", ...opts }),
  /** Upload a single file via multipart/form-data. */
  upload: async <T = any>(p: string, file: File | Blob, fieldName: string = "file"): Promise<T> => {
    const fd = new FormData();
    // @ts-ignore — File on web also has .name
    fd.append(fieldName, file, (file as any).name || "upload");
    let token = _authToken;
    if (!token) {
      const stored = await storage.secureGet("auth_token", "");
      if (stored) { token = stored as string; _authToken = token; }
    }
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`${BASE}/api${p}`, { method: "POST", headers, body: fd as any });
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const err: ApiError = { detail: (data && (data.detail || data.msg)) || `Upload failed (${res.status})`, status: res.status };
      throw err;
    }
    return data as T;
  },
};

/** Resolve a server URL: relative /api/uploads/... → absolute; absolute → unchanged. */
export function resolveMediaUrl(url: string | undefined | null): string {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/api/")) return `${BASE}${url}`;
  return url;
}

function translateField(loc: string): string {
  const map: Record<string, string> = {
    username: "Nom d'utilisateur",
    email: "E-mail",
    password: "Mot de passe",
    password_confirm: "Confirmation du mot de passe",
    phone: "Téléphone",
    country: "Pays",
    sponsor_username: "Parrain",
    accept_terms: "Conditions",
    amount: "Montant",
    full_name: "Nom complet",
    operator: "Opérateur",
    level: "Niveau",
    note: "Note",
    title: "Titre",
    message: "Message",
    url: "URL",
    platform: "Plateforme",
    payment_method: "Mode de paiement",
  };
  return map[loc] || loc;
}

function translatePydanticMsg(msg: string, ctx?: any): string {
  if (!msg) return "champ invalide";
  const min = ctx?.min_length;
  const max = ctx?.max_length;
  if (/at least \d+ character/i.test(msg) || /string_too_short/i.test(msg)) {
    return `doit contenir au moins ${min ?? "?"} caractères`;
  }
  if (/at most \d+ character/i.test(msg) || /string_too_long/i.test(msg)) {
    return `doit contenir au plus ${max ?? "?"} caractères`;
  }
  if (/valid email/i.test(msg)) return "adresse e-mail invalide";
  if (/field required/i.test(msg) || /missing/i.test(msg)) return "champ obligatoire";
  if (/string does not match/i.test(msg) || /string_pattern_mismatch/i.test(msg)) {
    return "format invalide (lettres, chiffres et _ uniquement)";
  }
  if (/value is not a valid integer/i.test(msg) || /int_parsing/i.test(msg)) {
    return "doit être un nombre entier";
  }
  if (/greater than/i.test(msg)) return "valeur trop petite";
  if (/less than/i.test(msg)) return "valeur trop grande";
  if (/bool_parsing/i.test(msg)) return "doit être vrai ou faux";
  return msg;
}
