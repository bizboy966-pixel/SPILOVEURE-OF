export type MarketplaceAction = "save" | "chat";

export function marketplaceReturnRoute(
  action: MarketplaceAction,
  sellerId: string,
  listingId: string,
) {
  const params = new URLSearchParams({
    marketplaceAction: action,
    sellerId,
    listingId,
  });
  return `/marketplace?${params.toString()}`;
}

export function marketplaceConversationRoute(conversationId: string, listingId: string) {
  const params = new URLSearchParams({ conversation: conversationId });
  if (listingId) params.set("marketplaceListingId", listingId);
  return `/messenger?${params.toString()}`;
}

export function marketplaceListingUrl(listingId: string, origin: string) {
  const url = new URL("/marketplace", origin);
  url.searchParams.set("listing_id", listingId);
  return url.toString();
}

export function marketplaceShareMessage(
  name: string,
  price: number,
  currency: string,
  url: string,
) {
  return `${name} — ${price} ${currency}\nDécouvrez cette annonce sur SPILOVEURE : ${url}`;
}
