import { storage } from "@/src/utils/storage";

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL || "";

export type ApiError = { detail?: string; status?: number };

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
    const token = await storage.secureGet("auth_token", "");
    if (token) h["Authorization"] = `Bearer ${token}`;
  }
  if (pwdConfirm) h["X-Password-Confirm"] = pwdConfirm;
  const res = await fetch(`${BASE}/api${path}`, { ...rest, headers: h });
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
};

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
