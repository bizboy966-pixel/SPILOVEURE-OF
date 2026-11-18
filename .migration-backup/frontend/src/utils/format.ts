export function formatFCFA(n: number | undefined | null) {
  if (n == null) return "0 FCFA";
  return `${Math.round(n).toLocaleString("fr-FR").replace(/,/g, " ")} FCFA`;
}

export function formatDate(s?: string) {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleDateString("fr-FR");
  } catch {
    return s;
  }
}

export function formatDateTime(s?: string) {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleString("fr-FR");
  } catch {
    return s;
  }
}
