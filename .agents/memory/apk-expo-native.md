---
name: Nouvelle APK Android officielle
description: Décision de faire de Capacitor la seule APK officielle avec une nouvelle clé permanente.
---

L’utilisateur veut que Capacitor remplace l’APK Expo et devienne l’unique APK officielle, avec le front-end embarqué et le backend sur le VPS. Il accepte de désinstaller l’ancienne APK Expo une fois, car la clé EAS d’origine est inaccessible. Le nouvel APK doit garder l’identifiant Android `com.spilivere.app` et utiliser une nouvelle clé de production durable, réutilisée pour toutes les mises à jour suivantes.

**Why:** L’utilisateur a explicitement choisi une nouvelle signature et confirmé que l’ancienne APK ne sera plus utilisée.

**How to apply:** Lors du basculement, les utilisateurs désinstallent Expo, puis installent l’APK Capacitor avec `com.spilivere.app`. Les données côté VPS restent ; la session locale est recréée. Ne jamais inclure le fichier de clé ou ses mots de passe dans GitHub ; utiliser le stockage sécurisé Replit.

L’ancienne APK Expo ne peut pas être mise à jour sur place avec la nouvelle signature : Android refuserait le remplacement tant qu’elle est installée.

**Why:** Android exige que la signature soit identique pour installer une mise à jour sur une application déjà présente.

**How to apply:** Annoncer clairement l’unique désinstallation requise au moment de la première diffusion Capacitor ; toutes les versions Capacitor ultérieures réutilisent la même clé.
