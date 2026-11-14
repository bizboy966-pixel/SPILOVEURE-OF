---
name: Inscription et sessions distinctes
description: Nouvelle règle produit séparant l’accès au Chat de l’activation et de la session principale.
---

Le Chat doit être accessible après vérification unique de l’e-mail par code à six chiffres, même sans paiement d’activation. Sa session persistante sécurisée doit être distincte de la session principale, révocable et rester valide quand celle-ci expire pour inactivité.

**Why:** L’utilisateur le demande dans « NOUVELLE PROCÉDURE D’INSCRIPTION, DE VÉRIFICATION EMAIL ET DE GESTION DES SESSIONS – SPILOVEURE ».

**How to apply:** Faire respecter les états côté serveur. Retour depuis le Chat : compte non activé vers paiement ; compte activé vers saisie simple du mot de passe avant le tableau de bord. Pour les nouvelles inscriptions, création et confirmation du mot de passe une seule fois après confirmation fiable du paiement. Ne pas modifier la durée d’inactivité existante, les montants, prestataires, confirmations ou règles d’activation. Conserver la landing page, le parrainage et les données existantes ; préparer une migration sauvegardable et réversible.

L’envoi des codes doit utiliser une couche indépendante compatible avec une future intégration Resend. Ne pas prétendre que les e-mails sont envoyés sans fournisseur réellement configuré.

**Why:** Le document distingue explicitement la vérification de l’e-mail du paiement, tout en exigeant de préserver l’existant et de pouvoir intégrer Resend ultérieurement.

**How to apply:** Codes expirables, usage unique, tentatives limitées et délai de renvoi ; aucun code ni secret dans les journaux ou réponses publiques. Le texte source contient une ambiguïté à résoudre entre passage direct e-mail → paiement et conservation du formulaire actuel.
