---
name: Affectation exclusive Mobile Money
description: Règle métier du choix des prestataires par pays et opérateur.
---

« On peut activer plusieurs prestataires mais pas les mêmes pays et opérateurs
sur tout simultanément. »

**Why:** L’utilisateur veut que le prestataire affecté au couple choisi
prenne en charge le lancement, la vérification et l’activation du compte.

**How to apply:** Un couple pays + opérateur physique appartient à un seul
prestataire Mobile Money, y compris entre encaissements et retraits.
Des opérateurs différents d’un même pays peuvent utiliser des prestataires
différents. Ne pas réintroduire une cascade par priorité pour une même
destination ni réaffecter une transaction déjà lancée. Les alias marchands
d’un même opérateur ne doivent pas permettre de contourner cette règle.

Les catalogues actuels restent les catalogues Pay-in. MoneyFusion et Biz-transPay ont chacun un catalogue Pay-out distinct pour les retraits automatiques; une nouvelle route Pay-out est inactive jusqu’à son activation explicite par l’admin. La séparation des catalogues ne permet pas d’attribuer le même opérateur physique à deux prestataires entre les flux Pay-in et Pay-out.

**Why:** L’utilisateur a demandé de préserver le catalogue existant pour les dépôts/activations et d’ajouter un catalogue séparé pour les retraits. Garder les nouvelles routes de retrait désactivées évite d’envoyer de l’argent à un opérateur avant validation, et l’exclusivité historique reste en vigueur.

**How to apply:** Lire et modifier la collection Pay-in pour les dépôts, celle de Pay-out pour les retraits; conserver la vérification d’exclusivité entre les deux. Ne jamais reprendre automatiquement les interrupteurs Pay-in pour activer des retraits.

Dans les écrans de paiement et de portefeuille destinés aux utilisateurs,
ne jamais afficher les noms des prestataires : seuls les opérateurs et les
actifs doivent être visibles.

**Why:** L’utilisateur a explicitement demandé que les opérateurs suffisent
et que les prestataires restent absents de ces écrans.

**How to apply:** Masquer les badges, sous-titres et messages d’erreur qui
nomment un prestataire dans les parcours utilisateurs; les réglages internes
de l’administration peuvent conserver leurs libellés de gestion.
