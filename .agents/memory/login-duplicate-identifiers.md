---
name: Identifiants legacy en double
description: Connexion sûre lorsqu'une ancienne base contient des e-mails ou téléphones dupliqués.
---

Si plusieurs anciens comptes correspondent au même e-mail ou numéro, comparer le mot de passe avec chaque candidat et ouvrir une session seulement si un seul hash correspond. Ne jamais choisir simplement le premier compte retourné par la base ; si plusieurs mots de passe correspondent, refuser la connexion avec le même message générique.

**Why:** Le rejet d'un identifiant dupliqué avant toute vérification de mot de passe rendait impossible la connexion avec des informations valides pour certains comptes historiques.

**How to apply:** Garder les réponses publiques génériques et les limites d'échecs par identifiant et par compte. N'exposer ni le nombre de comptes associés ni lequel des candidats correspond.
