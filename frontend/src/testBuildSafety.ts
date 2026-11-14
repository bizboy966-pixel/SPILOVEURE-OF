/** Safeguards for the isolated test APK only; never enabled on the live site. */
export function assertIsolatedTestRequest(backend: string, path: string, method = "GET") {
  let origin: URL;
  try { origin = new URL(backend); } catch {
    throw { status: 403, detail: "Le serveur de test n’est pas configuré." };
  }
  if (origin.protocol !== "https:" || !origin.hostname.endsWith(".replit.dev") ||
      origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw { status: 403, detail: "Cette version de test ne peut pas utiliser le serveur officiel." };
  }
  const target = new URL(`${backend}/api${path}`);
  const pathname = target.pathname;
  if (target.origin !== origin.origin || !pathname.startsWith("/api/") ||
      /%(?:2e|2f|5c)/i.test(pathname)) {
    throw { status: 403, detail: "Adresse refusée dans la version de test." };
  }
  // Browsing local test data is allowed. Mutations are limited to onboarding,
  // authentication and Chat; no payment, withdrawal or admin action can start.
  if (!["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase()) &&
      !/^\/api\/(?:auth|identity|messenger)\//.test(pathname)) {
    throw { status: 403, detail: "Action indisponible dans l’APK de test : aucun paiement, retrait ou changement administratif n’est autorisé." };
  }
}
