/** Must be called directly from the user's click, before any async SDK checks. */
export function requestChatNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === "undefined" || typeof Notification === "undefined") {
    return Promise.reject(new Error("Ce navigateur ne propose pas les notifications système. Les bannières dans le Chat restent disponibles. Sur iPhone, ouvrez le Chat installé sur l’écran d’accueil."));
  }
  if (window.isSecureContext === false) return Promise.reject(new Error("Les notifications nécessitent une connexion HTTPS."));
  if (Notification.permission === "granted") return Promise.resolve("granted");
  if (Notification.permission === "denied") return Promise.reject(new Error("Les notifications sont bloquées pour ce site. Autorisez-les dans les paramètres du navigateur, puis réessayez."));
  if (window.self !== window.top) return Promise.reject(new Error("L’aperçu intégré ne peut pas demander cette autorisation. Ouvrez le Chat dans un nouvel onglet, puis réessayez."));
  return Notification.requestPermission();
}
