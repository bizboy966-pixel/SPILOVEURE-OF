export function parseSpvUserSearch(value: string) {
  const raw = value.trim();
  const match = raw.match(/^(?:SPV)?@(.+)$/i);
  return {
    username: match?.[1]?.trim() || raw,
    isHandle: Boolean(match?.[1]?.trim()),
  };
}

export function normalizeSpvUsername(value: string) {
  return parseSpvUserSearch(value).username;
}

const SPV_USERNAME_PATTERN = /^[\p{L}\p{N}_.-]{2,60}$/u;

/**
 * Convert a SPILOVEURE personal-chat URL into an in-app route.
 * Other hosts and unrelated URLs are intentionally left external.
 */
export function messengerProfileRouteFromUrl(value: string): string | null {
  const currentOrigin = typeof window !== "undefined" && window.location?.origin
    ? window.location.origin
    : "https://spiloveure.org";
  let parsed: URL;
  try {
    parsed = new URL(value.trim(), currentOrigin);
  } catch {
    return null;
  }

  const allowedOrigins = new Set([
    currentOrigin,
    "https://spiloveure.org",
    "https://www.spiloveure.org",
  ]);
  if (!allowedOrigins.has(parsed.origin) || parsed.pathname.replace(/\/+$/, "") !== "/messenger") return null;

  const keys = Array.from(parsed.searchParams.keys());
  if (keys.length !== 1 || keys[0] !== "username") return null;
  const username = normalizeSpvUsername(parsed.searchParams.get("username") || "");
  if (!SPV_USERNAME_PATTERN.test(username)) return null;
  return `/messenger?username=${encodeURIComponent(username)}`;
}

export function safeMessengerReturnTo(target: unknown): string {
  if (target === "/messenger" || target === "/account-access" || target === "/account-access?source=chat") {
    return target;
  }
  if (typeof target === "string") {
    try {
      const parsed = new URL(target, "https://spiloveure.org");
      if (
        parsed.origin === "https://spiloveure.org"
        && ["/marketplace", "/(app)/marketplace"].includes(parsed.pathname)
        && parsed.hash === ""
        && Array.from(parsed.searchParams.keys()).sort().join(",") === "listingId,marketplaceAction,sellerId"
      ) {
        const action = parsed.searchParams.get("marketplaceAction");
        const sellerId = parsed.searchParams.get("sellerId") || "";
        const listingId = parsed.searchParams.get("listingId") || "";
        if (
          (action === "save" || action === "chat")
          && /^[\w.-]{1,100}$/.test(sellerId)
          && /^[\w.-]{1,100}$/.test(listingId)
        ) {
          return `/marketplace?marketplaceAction=${action}&sellerId=${encodeURIComponent(sellerId)}&listingId=${encodeURIComponent(listingId)}`;
        }
      }
    } catch {
      return "/messenger";
    }
  }
  return typeof target === "string" ? messengerProfileRouteFromUrl(target) || "/messenger" : "/messenger";
}

export function chatProfileUrl(username: string) {
  const origin = typeof window !== "undefined" && window.location?.origin
    ? window.location.origin
    : "https://spiloveure.org";
  return `${origin.replace(/\/$/, "")}/messenger?username=${encodeURIComponent(username)}`;
}
