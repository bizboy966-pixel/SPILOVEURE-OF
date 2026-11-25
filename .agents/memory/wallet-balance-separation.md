---
name: Soldes de portefeuille distincts
description: Distinguer le solde disponible XOF du solde dédié aux dépôts et des actifs crypto.
---

Le solde XOF que l’utilisateur peut convertir est le solde disponible de son compte. Le portefeuille de dépôt reste distinct et ne doit pas être utilisé comme source ou destination de conversion.

**Why:** L’application conserve séparément le solde disponible, le portefeuille de dépôt et les actifs crypto; les réunir ferait apparaître des fonds dans le mauvais portefeuille.

**How to apply:** Pour tout échange XOF ↔ crypto, débiter ou créditer les soldes dédiés concernés; laisser le solde de dépôt inchangé.

Le petit bouton rond de la carte Portefeuille convertit uniquement le solde disponible XOF ↔ le solde dédié USDT.BEP20 pour les retraits. Ce solde est séparé des portefeuilles crypto de dépôt; ne pas transférer automatiquement les soldes entre eux. Les taux sont internes et configurés dans l’admin; aucune route de prestataire ni conversion crypto-crypto ne s’applique.

**Why:** L’utilisateur a précisé que la conversion concerne seulement ses deux soldes disponibles, sans prestataire, et que le solde USDT.BEP20 est réservé aux retraits, pas aux dépôts.

**How to apply:** Garder le parcours petit bouton séparé du grand raccourci général; accepter seulement XOF ↔ USDT.BEP20, utiliser les taux admin et ne jamais modifier `wallet_deposit_balance` ni `wallet_balances`.

Le sélecteur de devise du portefeuille doit afficher XAF, les actifs crypto du catalogue Biz-transPay et les actifs configurés pour l’échange, même si leur solde est nul.

**Why:** L’utilisateur a demandé à voir les devises disponibles sans devoir attendre un premier dépôt ou un premier crédit.

**How to apply:** Construire la liste depuis les catalogues/configurations serveur et fusionner les soldes réels, sans créer de codes crypto qui ne viennent pas du catalogue.
