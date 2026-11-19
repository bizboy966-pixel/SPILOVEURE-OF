---
name: Front embarqué Capacitor
description: Architecture Capacitor retenue pour l’APK officielle et le Chat.
---

L'APK officielle Capacitor embarque le front-end ; le backend et les données
restent sur le VPS. Le prototype initial a été essayé par l’utilisateur, qui a
ensuite confirmé que Capacitor doit remplacer Expo comme APK officielle.

**Why:** L'utilisateur ne veut plus d'une APK WebView qui charge tout le site
depuis Internet ; l’interface doit être embarquée dans l’application.

**How to apply:** Garder `server.url` absent, embarquer les ressources web et
conserver l’API sur `https://spiloveure.org`. Garder les essais sur Infinix
distincts des vérifications de compilation.

Une origine Capacitor locale `localhost` n'est pas interchangeable avec
l'origine du VPS pour ce Chat.

**Why:** Le backend vérifie l'Origin du WebSocket contre son propre hôte, et
les sessions Chat dépendent de cookies SameSite. Assouplir ces contrôles côté
serveur sortirait du périmètre de l’APK.

**How to apply:** Préserver une origine locale compatible et un transport
explicite des API vers le VPS ; Capacitor ne relaie pas automatiquement les
fetch visant son propre nom d'hôte local. Tester aussi multipart et médias.

L'utilisateur a indiqué que son essai initial du prototype Capacitor était
satisfaisant. Cela ne valide pas automatiquement tous les scénarios de la grille
de test physique.

**Why:** Un résultat général rapporté par l'utilisateur ne précise pas quels
scénarios de stabilité, de connexion et de médias ont été vérifiés.

**How to apply:** Présenter l’essai initial comme réussi,
mais ne pas annoncer la validation complète de toute la grille sans détails.

Pour remettre une APK compilée à l’utilisateur, ne pas utiliser la carte
`presentAsset` : les fichiers APK non pris en charge peuvent lui parvenir
comme des archives ZIP. Le serveur de preview peut fournir le binaire brut sur
`/downloads/spiloveure.apk`, avec le nom `.apk` et le type MIME Android.

**Why:** L’utilisateur a besoin d’un package directement installable, pas d’une
archive renommée ou d’un paquet de fichiers.

**How to apply:** Après compilation, servir l’APK via la passerelle, puis
télécharger à nouveau le lien et vérifier le type de fichier et l’égalité du
SHA-256 avant de le partager. Ce lien de preview est temporaire ; la diffusion
permanente doit utiliser l’hébergement officiel.

Les polices et autres ressources embarquées ne doivent pas dépendre d'un
chemin pnpm caché : le paquet Android peut écarter ces fichiers. Pour un
téléchargement binaire avec progression, utiliser le gestionnaire Android,
pas le transport CapacitorHttp configuré en texte.

**Why:** Le format texte ne fournit pas un flux binaire fidèle ni une progression
réseau exploitable, et Android a ignoré les polices sous `.pnpm`.

**How to apply:** Copier uniquement les polices utilisées vers un chemin
d'assets visible avant l'export, puis charger explicitement la famille. Garder
un pont Android dédié pour les téléchargements APK et suivre les octets réels.
