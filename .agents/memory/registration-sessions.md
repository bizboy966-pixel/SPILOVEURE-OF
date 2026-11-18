---
name: Inscription et sessions distinctes
description: Nouvelle règle produit séparant l’accès au Chat de l’activation et de la session principale.
---

Le Chat doit être accessible après vérification unique de l’e-mail par code à six chiffres, même sans paiement d’activation. Sa session persistante sécurisée doit être distincte de la session principale, révocable et rester valide quand celle-ci expire pour inactivité.

**Why:** L’utilisateur le demande dans « NOUVELLE PROCÉDURE D’INSCRIPTION, DE VÉRIFICATION EMAIL ET DE GESTION DES SESSIONS – SPILOVEURE ».

**How to apply:** Faire respecter les états côté serveur. Le Chat reste indépendant de l’activation et de la session principale. Après activation et mot de passe, l’e-mail non vérifié ne bloque pas le tableau de bord ; seule l’entrée au Chat exige sa vérification. Ne pas modifier la durée d’inactivité existante, les montants, prestataires, confirmations ou règles d’activation. Conserver la landing page, le parrainage et les données existantes ; préparer une migration sauvegardable et réversible.

Conserver le formulaire (pseudo, téléphone, pays, parrainage et conditions) avant le paiement. Le préremplir depuis les nouvelles étapes de pays et d’e-mail. Resend est le fournisseur choisi pour SPILOVEURE.

**Why:** L’utilisateur a confirmé « Conserver le formulaire avant paiement » puis « Resend pour SPILOVEURE ».

**How to apply:** Garder une couche fournisseur indépendante. Codes expirables, usage unique, tentatives limitées et délai de renvoi ; aucun code ni secret dans les journaux ou réponses publiques. Ne pas prétendre que les e-mails sont envoyés avant la validation du domaine et la configuration réelle du fournisseur. Ne pas utiliser par défaut les autres domaines déjà vérifiés du compte Resend.

Créer et confirmer désormais le mot de passe sur « Créer votre compte », avant le paiement. Sur ce formulaire, l’e-mail et le pays choisis aux étapes précédentes sont préremplis et non modifiables. La connexion accepte le nom d’utilisateur, l’e-mail ou le numéro de téléphone avec ce même mot de passe.

**Why:** L’utilisateur a remplacé explicitement l’ancienne création du mot de passe après paiement et a précisé que « numéro du compte » signifie le numéro de téléphone.

**How to apply:** Conserver les contrôles distincts de vérification e-mail et d’activation ; ne pas demander aux comptes qui ont déjà un mot de passe de le recréer. Garder la création différée pour les anciens comptes qui n’en ont pas encore.

Le nom d’utilisateur modifiable est propre au Chat et ne remplace pas le nom d’utilisateur du compte principal, utilisé pour la connexion, le parrainage et les paiements.

**Why:** L’utilisateur a confirmé le périmètre « Chat uniquement » le 16 novembre 2026.

**How to apply:** Stocker et afficher séparément l’alias Chat. Ne pas modifier les identifiants ni les liens de la plateforme principale.

Dans le mode de preview local isolé uniquement, le compte de démonstration `preview_test_b02606` peut ouvrir le Chat sans vérification d’e-mail. L’exception ne marque pas l’adresse comme vérifiée et ne s’étend pas aux comptes similaires ni au VPS.

**Why:** L’utilisateur a confirmé le compte précis et choisi des données de test isolées pour tester l’accès direct dans le preview, sans changer l’authentification VPS.

**How to apply:** N’activer l’exception que si le mode de preview isolé, la base locale dédiée et MongoDB local sont tous confirmés. Conserver la vérification réelle ailleurs et ne pas changer l’accès principal, les paiements ou la récupération du mot de passe.

Les liens personnels SPILOVEURE Chat et le lien de support configuré doivent ouvrir directement la conversation du membre visé. Si le Chat doit être vérifié sur cet appareil, conserver la destination pendant la vérification e-mail sans déconnecter la session principale. Les véritables liens Telegram restent externes.

**Why:** L’utilisateur a demandé que les liens personnels et le bouton Support ouvrent directement la discussion, y compris après vérification e-mail.

**How to apply:** Reconnaître seulement les liens de profil Chat SPILOVEURE comme routes internes. Préserver le nom d’utilisateur dans le retour de vérification et ne pas transformer les URL externes en destinations internes.
