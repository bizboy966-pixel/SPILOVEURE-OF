---
name: Compatibilité native du Chat
description: Piège des événements de navigateur lors de l’ouverture du Chat dans l’APK.
---

Ne pas utiliser la seule présence de `window` pour identifier le navigateur :
React Native définit aussi `window = global`, sans fournir les événements DOM.
Réserver les abonnements DOM au web avec une garde de plateforme explicite et
conserver `AppState` pour les retours au premier plan natifs.

**Why:** L’ouverture du Chat dans l’APK déclenchait des appels à
`window.addEventListener` indisponibles. Un test reproduisant la forme du global
natif a confirmé cette exception, alors que l’export Android compilait.

**How to apply:** Vérifier les effets de montage et de nettoyage lors du portage
d’un écran web vers Android/iOS. Une compilation réussie ne valide pas
l’exécution sur téléphone ; tester aussi avec un `window` natif sans API DOM.
