---
name: Réinitialisation des mots de passe
description: Pourquoi la récupération d’accès révoque les sessions par version de sécurité plutôt que par date.
---

La réinitialisation doit permettre de définir un nouveau mot de passe, jamais de récupérer l’ancien, et invalider les accès antérieurs.

**Why:** Un seuil basé uniquement sur la date d’émission des JWT ne distingue pas correctement un ancien et un nouveau jeton émis dans la même seconde. Une version de sécurité du compte évite cette ambiguïté sans bloquer une reconnexion immédiate.

**How to apply:** Tout chemin qui émet ou vérifie un jeton pour un compte existant doit respecter cette version, y compris le support et les confirmations sensibles. Les codes de récupération restent distincts des codes de vérification e-mail ; leur possession ne doit pas contourner les étapes d’activation.
