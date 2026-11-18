export function chatNotificationAvailability(): { canRequest: boolean; message: string; action: string } {
  if (typeof window === "undefined" || typeof Notification === "undefined") return {
    canRequest: false, action: "Notifications système non disponibles",
    message: "Ce navigateur ne propose pas les notifications système. Les bannières dans le Chat restent disponibles. Sur iPhone, installez le Chat sur l’écran d’accueil puis ouvrez-le depuis son icône.",
  };
  if (window.isSecureContext === false) return {
    canRequest: false, action: "Connexion HTTPS requise", message: "Les notifications nécessitent une connexion HTTPS.",
  };
  if (Notification.permission === "granted") return {
    canRequest: true, action: "Vérifier l’activation", message: "Les notifications sont autorisées dans ce navigateur.",
  };
  if (Notification.permission === "denied") return {
    canRequest: false, action: "Notifications bloquées dans le navigateur",
    message: "Les notifications sont bloquées pour ce site. Autorisez-les dans les paramètres du navigateur, puis revenez ici. Le site ne peut pas modifier cette autorisation à votre place.",
  };
  if (window.self !== window.top) return {
    canRequest: false, action: "Ouvrir le Chat hors de l’aperçu",
    message: "L’aperçu intégré ne peut pas demander cette autorisation. Ouvrez le Chat dans un nouvel onglet, puis réessayez.",
  };
  return { canRequest: true, action: "Activer les notifications du navigateur", message: "Votre navigateur va demander l’autorisation. Choisissez « Autoriser » pour recevoir les notifications système." };
}

/** Must be called directly from the user's click, before any async SDK checks. */
export function requestChatNotificationPermission(): Promise<NotificationPermission> {
  const availability = chatNotificationAvailability();
  if (!availability.canRequest) return Promise.reject(new Error(availability.message));
  if (Notification.permission === "granted") return Promise.resolve("granted");
  return Notification.requestPermission();
}
