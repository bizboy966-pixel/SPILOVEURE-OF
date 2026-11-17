---
name: Périmètre SPILOVEURE Chat
description: Contraintes exprimées par l’utilisateur pour le nouveau module de messagerie.
---

Ajouter uniquement un module SPILOVEURE CHAT, sans refonte ni modification des paiements, comptes, abonnements, données et autres services existants. Présenter l’architecture avant de modifier le code applicatif.

**Why:** L’utilisateur exige explicitement de préserver intégralement la finalité et les fonctionnalités de SPILOVEURE.

**How to apply:** Isoler les données et autorisations du nouveau Chat du support existant. Les comptes existants servent d’identité. Le périmètre initial a ensuite été étendu par la nouvelle procédure d’inscription, de vérification e-mail et de sessions distinctes : voir `registration-sessions.md`. Cette demande autorise uniquement les adaptations d’accès concernées, pas une refonte des autres fonctions.

Reproduire fidèlement l’image fournie, employer le logo officiel existant et remplacer uniquement l’entrée Trading de la navigation principale par Chat. Le logo supérieur et le bouton central SPILOVEURE ramènent à l’interface principale. Conserver les animations inverses synchronisées décrites dans le cahier des charges.

**Why:** L’utilisateur impose cette référence visuelle et ces interactions, sans variante créative.

**How to apply:** Ne pas utiliser les conversations ni les compteurs de l’image comme de fausses données réelles. Ne déclarer fonctionnelles que les capacités effectivement testées, et ne pas annoncer de chiffrement de bout en bout non implémenté.

Pour les bulles de discussion, les nouvelles captures de messages texte et vocaux priment : messages envoyés vert pâle, reçus blancs, mêmes formes arrondies et présentation. Conserver des écrits sombres et lisibles.

**Why:** L’utilisateur a demandé cette couleur et ces caractéristiques précises pour les messages envoyés et reçus, après la référence générale du Chat.

**How to apply:** Ne pas rétablir les anciennes bulles bleues en reprenant la référence générale. Cette correction concerne les messages, pas le bandeau de marque ni les règles des accusés de réception.

Le panneau d’emojis se place sous le champ de message, comme un clavier ; le champ et le bouton d’envoi remontent au-dessus du panneau.

**Why:** L’utilisateur a répété cette disposition après un affichage incorrect des emojis au-dessus du champ.

**How to apply:** Garder le panneau dans la disposition principale de la discussion, sous la saisie, et préserver le bouton emoji/clavier.

Le bouton flottant Support doit être visible uniquement sur la page d’accueil, le dashboard principal, et absent des autres pages.

**Why:** L’utilisateur a explicitement restreint l’affichage de ce bouton au dashboard.

**How to apply:** Cette règle concerne le bouton flottant ; ne pas supprimer les autres accès au support sans demande.

Les stickers doivent rester distincts des photos et vidéos dans le Chat : toucher un sticker ouvre une feuille blanche depuis le bas avec poignée, fermeture, aperçu centré et actions Favoris, Pack de stickers et Modifier ; l’appui long ouvre près du sticker les réactions et uniquement Supprimer.

**Why:** L’utilisateur a corrigé plusieurs fois la confusion entre un sticker et une pièce jointe photo, puis a précisé que la feuille de sticker doit avoir un fond blanc plutôt que noir.

**How to apply:** Maintenir des chemins d’affichage et d’interaction séparés. L’appui long sur un message ouvre un menu-bulle compact ancré à la bulle, avec réactions proches ; pour un sticker, limiter ce menu à Supprimer. La feuille au toucher gère Favoris, Pack et Modifier.

Le Chat suit le standard visuel général SPILOVEURE décrit dans `visual-standard.md`, tout en conservant ses couleurs, sa navigation « Échanges, Contacts, Actus, Profil » et ses fonctions.

**Why:** Le cahier des charges de refonte autorise l’amélioration visuelle du Chat sans changer son identité, son organisation ni son comportement.

**How to apply:** Appliquer le standard visuel général avec des styles adaptés au Chat ; une demande visuelle ne doit pas modifier ses flux, API, données ou règles métier.

Les textes, conversations et métadonnées du Chat restent dans MongoDB sur le VPS. Les fichiers binaires du Chat (photos, vidéos, vocaux, documents, stickers et médias du fil/statuts) doivent être stockés dans un bucket Cloudflare R2 privé, avec envoi direct et liens de lecture temporaires après contrôle des droits.

**Why:** L’utilisateur veut éviter de surcharger le VPS avec les fichiers envoyés dans les conversations.

**How to apply:** Ne pas déplacer les textes ni les métadonnées de MongoDB vers R2. Garder les clés R2 hors du code et des messages; préserver l’écoute unique via un accès protégé; conserver les fichiers locaux tant qu’une migration vers R2 n’a pas été vérifiée. La conversion vidéo des stickers peut utiliser un fichier temporaire sur le VPS, mais le sticker final est stocké dans R2.
