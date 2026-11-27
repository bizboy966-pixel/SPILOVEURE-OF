export function formatFCFA(n: number | undefined | null) {
  if (n == null) return "0 FCFA";
  return `${Math.round(n).toLocaleString("fr-FR").replace(/,/g, " ")} FCFA`;
}

export function formatAssetAmount(amount: number | undefined | null, asset: string) {
  const decimals = asset.includes(".") || /^(USDT|USDC|BTC|ETH)/i.test(asset) ? 6 : 0;
  const formatted = Number(amount || 0).toLocaleString("fr-FR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
  return `${formatted} ${asset}`;
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
