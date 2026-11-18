---
name: Prototype Capacitor isolé
description: Limites du test Capacitor et raison du choix de son origine locale.
---

Le test Capacitor est une exception expérimentale distincte, pas un changement
du choix Expo natif pour l'APK officiel. Il doit coexister avec Expo, avec un
identifiant et une signature distincts. Le front-end est embarqué et le backend
reste sur le VPS. Aucune diffusion officielle ni recommandation de remplacement
avant validation sur l'Infinix Android 15 et accord de l'utilisateur.

**Why:** L'utilisateur veut comparer la stabilité après un crash Expo, sans
modifier l'application actuelle ni toucher au backend.

**How to apply:** Ne pas transformer un build réussi ou un test navigateur en
validation téléphone. Garder les résultats matériels explicitement en attente
tant qu'ils n'ont pas été observés ou rapportés.

Une origine Capacitor locale `localhost` n'est pas interchangeable avec
l'origine du VPS pour ce Chat.

**Why:** Le backend vérifie l'Origin du WebSocket contre son propre hôte, et
les sessions Chat dépendent de cookies SameSite. Assouplir ces contrôles côté
serveur sortirait du périmètre du prototype.

**How to apply:** Préserver une origine locale compatible et un transport
explicite des API vers le VPS ; Capacitor ne relaie pas automatiquement les
fetch visant son propre nom d'hôte local. Tester aussi multipart et médias.
