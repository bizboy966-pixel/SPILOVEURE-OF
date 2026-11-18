---
name: APK Android en WebView
description: Choix d’architecture de l’APK Android pour reprendre exactement l’interface web.
---

Pour l’APK Android, charger le site SPILOVEURE de production dans une WebView plutôt que de montrer les écrans React Native Expo. Garder visibles les barres système Android. Le backend reste hébergé sur le VPS; l’APK contient seulement l’enveloppe frontale.

**Why:** L’utilisateur veut que les dispositions du site web — notamment en-têtes, navigation basse et Chat — soient identiques dans l’APK.

**How to apply:** Réserver le wrapper WebView à Android et préserver la version web/iOS existante. Les versions APK doivent garder le même identifiant de paquet et la même signature pour les mises à jour. Tester le Chat, le micro, les fichiers, les paiements et les notifications dans WebView avant de considérer l’APK comme validé.

Limiter le masque de chargement natif au chargement initial du document, sans le réactiver lors des navigations internes du site.

**Why:** Sur Android, react-native-webview émet un début de chargement depuis les changements d’historique d’une SPA, sans fin de chargement correspondante. Un masque réactivé à chaque début peut donc cacher indéfiniment une page déjà affichée.

**How to apply:** Tester une navigation après le premier chargement avec un événement de début sans événement de fin; conserver les erreurs réseau, la reprise après arrêt du moteur et la relance explicite.
