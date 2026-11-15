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

export function chatProfileUrl(username: string) {
  const origin = typeof window !== "undefined" && window.location?.origin
    ? window.location.origin
    : "https://spiloveure.org";
  return `${origin.replace(/\/$/, "")}/messenger?username=${encodeURIComponent(username)}`;
}
