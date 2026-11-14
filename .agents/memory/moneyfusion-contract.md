---
name: Contrat MoneyFusion
description: Limites documentaires du Pay-in, catalogue Pay-out et conditions de mise en service.
---

Intégrer MoneyFusion uniquement pour le Mobile Money, avec des frais
d’activation de 2 650 FCFA et des identifiants administrables, jamais codés
en dur. Ne pas étendre cette intégration aux cartes ou à la crypto.

**Why:** L’utilisateur a expressément limité ce prestataire au Mobile Money
et réserve les autres moyens de paiement à une demande ultérieure.

**How to apply:** Conserver les moyens de paiement existants sans les remplacer,
sauf SoleasPay dont l’utilisateur a ensuite demandé la suppression intégrale.
L’ajout du prestataire n’autorise ni paiement réel ni déploiement sur Hostinger.

Ne pas déduire la devise ni les opérateurs du Pay-in du catalogue Pay-out.
La documentation officielle consultée ne décrit pas de champ devise, pays
ou opérateur pour l’encaissement hébergé. L’utilisateur ne connaît pas
le comportement de devise de son compte marchand.

**Why:** Une conversion locale envoyée à une application facturant dans
une autre devise ferait payer un mauvais montant ; un catalogue de retraits
n’établit pas la couverture des encaissements.

**How to apply:** Obtenir de MoneyFusion les devises, pays Pay-in et la
possibilité de limiter la page hébergée au Mobile Money avant activation.
Les taux saisis sont manuels, pas des cours de change en direct.
Le Pay-out exige une clé privée et l’IP fixe de sortie autorisée.

Conserver la clé de chiffrement des identifiants avec les sauvegardes
sécurisées ; une rotation nécessite une migration.

**Why:** Les identifiants administrables sont chiffrés à partir du secret
stable du serveur ; remplacer ce dernier sans migration les rend illisibles.

**How to apply:** Ne pas synchroniser automatiquement les secrets de
l’aperçu avec ceux du VPS. Voir la procédure de configuration dans
`docs/moneyfusion.md`, et ne jamais enregistrer de secret en mémoire.
