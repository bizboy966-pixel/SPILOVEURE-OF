---
name: Inscription et sessions distinctes
description: Nouvelle règle produit séparant l’accès au Chat de l’activation et de la session principale.
---

Le Chat doit être accessible après vérification unique de l’e-mail par code à six chiffres, même sans paiement d’activation. Sa session persistante sécurisée doit être distincte de la session principale, révocable et rester valide quand celle-ci expire pour inactivité.

**Why:** L’utilisateur le demande dans « NOUVELLE PROCÉDURE D’INSCRIPTION, DE VÉRIFICATION EMAIL ET DE GESTION DES SESSIONS – SPILOVEURE ».

**How to apply:** Faire respecter les états côté serveur. Retour depuis le Chat : compte non activé vers paiement ; compte activé vers saisie simple du mot de passe avant le tableau de bord. Ne pas modifier la durée d’inactivité existante, les montants, prestataires, confirmations ou règles d’activation. Conserver la landing page, le parrainage et les données existantes ; préparer une migration sauvegardable et réversible.

Conserver le formulaire (pseudo, téléphone, pays, parrainage et conditions) avant le paiement. Le préremplir depuis les nouvelles étapes de pays et d’e-mail. Resend est le fournisseur choisi pour SPILOVEURE.

**Why:** L’utilisateur a confirmé « Conserver le formulaire avant paiement » puis « Resend pour SPILOVEURE ».

**How to apply:** Garder une couche fournisseur indépendante. Codes expirables, usage unique, tentatives limitées et délai de renvoi ; aucun code ni secret dans les journaux ou réponses publiques. Ne pas prétendre que les e-mails sont envoyés avant la validation du domaine et la configuration réelle du fournisseur. Ne pas utiliser par défaut les autres domaines déjà vérifiés du compte Resend.

Créer et confirmer désormais le mot de passe sur « Créer votre compte », avant le paiement. Sur ce formulaire, l’e-mail et le pays choisis aux étapes précédentes sont préremplis et non modifiables. La connexion accepte le nom d’utilisateur, l’e-mail ou le numéro de téléphone avec ce même mot de passe.

**Why:** L’utilisateur a remplacé explicitement l’ancienne création du mot de passe après paiement et a précisé que « numéro du compte » signifie le numéro de téléphone.

**How to apply:** Conserver les contrôles distincts de vérification e-mail et d’activation ; ne pas demander aux comptes qui ont déjà un mot de passe de le recréer. Garder la création différée pour les anciens comptes qui n’en ont pas encore.
