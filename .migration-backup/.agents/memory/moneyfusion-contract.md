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
Le Pay-out exige une clé privée et l’IP fixe de sortie autorisée.

Le prix d’activation est fixé à 2 650 XOF. Les montants destinés aux pays
utilisant une autre devise doivent être convertis automatiquement ; aucun taux
de conversion ne doit être saisi manuellement.

**Why:** L’utilisateur a explicitement demandé la conversion automatique du
tarif de 2 650 XOF dans la devise locale et a rejeté les taux manuels.

**How to apply:** Garder le montant de base en XOF, utiliser un taux de
référence automatique et ne pas lancer de paiement si le taux nécessaire
n’est pas disponible.

Les 2 650 XOF sont le total client, frais de transaction inclus. Le marchand
reçoit le net après déduction ; cette déduction ne doit pas bloquer l’activation.

**Why:** L’utilisateur a précisé que le prix d’activation plus les frais fait
2 650 francs, et non 2 650 francs nets à recevoir par le marchand.

**How to apply:** Rapprocher le brut, ou le net augmenté des frais confirmés
par le prestataire, avec le total attendu ; ne jamais accepter un écart
inexpliqué ni activer sur une simple redirection du navigateur.

Conserver la clé de chiffrement des identifiants avec les sauvegardes
sécurisées ; une rotation nécessite une migration.

**Why:** Les identifiants administrables sont chiffrés à partir du secret
stable du serveur ; remplacer ce dernier sans migration les rend illisibles.

**How to apply:** Ne pas synchroniser automatiquement les secrets de
l’aperçu avec ceux du VPS. Voir la procédure de configuration dans
`docs/moneyfusion.md`, et ne jamais enregistrer de secret en mémoire.
