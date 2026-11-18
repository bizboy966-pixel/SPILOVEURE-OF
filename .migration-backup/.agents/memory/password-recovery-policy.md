---
name: Réinitialisation des mots de passe
description: Pourquoi la récupération d’accès révoque les sessions par version de sécurité plutôt que par date.
---

La réinitialisation doit permettre de définir un nouveau mot de passe, jamais de récupérer l’ancien, et invalider les accès antérieurs.

Seule l’adresse enregistrée sur un compte admissible peut recevoir un code de récupération. Une adresse absente ou partagée par plusieurs comptes ne reçoit aucun code et affiche « Email du compte incorrect ».

**Why:** L’utilisateur a précisé que seul l’e-mail utilisé à la création du compte doit permettre sa récupération. Une version de sécurité du compte évite aussi de confondre d’anciens et de nouveaux jetons émis dans la même seconde.

**How to apply:** Tout chemin qui émet ou vérifie un jeton pour un compte existant doit respecter cette version, y compris le support et les confirmations sensibles. Les codes de récupération restent distincts des codes de vérification e-mail ; leur possession ne doit pas contourner les étapes d’activation. Conserver les limites de requêtes lors de la vérification de l’adresse, car la réponse explicite permet de distinguer une adresse de compte d’une adresse inconnue.
