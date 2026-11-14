---
name: Validation Resend
description: Choix du compte Resend et pièges de diagnostic des clés d’envoi et de la protection réseau.
---

Utiliser le compte Resend choisi par l’utilisateur pour les e-mails SPILOVEURE. Ne pas supposer qu’un connecteur déjà disponible correspond à ce compte, ni demander de refaire les DNS uniquement parce que ce connecteur indique un échec.

**Why:** L’utilisateur avait déjà validé son domaine dans Resend et publié les DNS dans Hostinger. La connexion initialement disponible attendait d’autres valeurs. Sa propre clé a permis un envoi natif sans modification DNS, dont l’utilisateur a confirmé la réception dans sa boîte principale.

**How to apply:** Aligner la clé utilisée par l’application avec le compte où le domaine est vérifié. Garder les secrets dans le formulaire sécurisé et distinguer un test accepté par l’API de la réception réelle d’un code.

Une clé limitée à l’envoi peut refuser la lecture des domaines, y compris avec un HTTP 401 et un message de restriction. Ce refus n’est pas une preuve de clé invalide.

**Why:** Le contrôle de domaine a été refusé alors que la même clé a immédiatement permis un envoi technique depuis l’expéditeur validé.

**How to apply:** Ne pas exiger plus de droits pour ce seul contrôle. Tester l’envoi à l’adresse technique prévue par Resend. Un HTTP 403 HTML Cloudflare n’est pas non plus une réponse d’authentification Resend : dans cet environnement, le User-Agent `Replit` a permis d’atteindre l’API native, contrairement au User-Agent personnalisé initial.
