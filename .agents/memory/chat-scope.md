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

Les stickers doivent rester distincts des photos et vidéos dans le Chat : toucher un sticker ouvre une feuille sombre depuis le bas avec poignée, fermeture, aperçu centré et actions Favoris, Pack de stickers et Modifier ; l’appui long ouvre près du sticker les réactions et uniquement Supprimer.

**Why:** L’utilisateur a corrigé plusieurs fois la confusion entre un sticker et une pièce jointe photo.

**How to apply:** Maintenir des chemins d’affichage et d’interaction séparés. L’appui long sur un message ouvre un menu-bulle compact ancré à la bulle, avec réactions proches ; pour un sticker, limiter ce menu à Supprimer. La feuille au toucher gère Favoris, Pack et Modifier.
