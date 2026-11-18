---
name: APK Android en WebView
description: Choix d’architecture de l’APK Android pour reprendre exactement l’interface web.
---

Pour l’APK Android, charger le site SPILOVEURE de production dans une WebView plutôt que de montrer les écrans React Native Expo. Garder visibles les barres système Android. Le backend reste hébergé sur le VPS; l’APK contient seulement l’enveloppe frontale.

**Why:** L’utilisateur veut que les dispositions du site web — notamment en-têtes, navigation basse et Chat — soient identiques dans l’APK.

**How to apply:** Réserver le wrapper WebView à Android et préserver la version web/iOS existante. Les versions APK doivent garder le même identifiant de paquet et la même signature pour les mises à jour. Tester le Chat, le micro, les fichiers, les paiements et les notifications dans WebView avant de considérer l’APK comme validé.
