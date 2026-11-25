---
name: Soldes de portefeuille distincts
description: Distinguer le solde disponible XOF du solde dédié aux dépôts et des actifs crypto.
---

Le solde XOF que l’utilisateur peut convertir est le solde disponible de son compte. Le portefeuille de dépôt reste distinct et ne doit pas être utilisé comme source ou destination de conversion.

**Why:** L’application conserve séparément le solde disponible, le portefeuille de dépôt et les actifs crypto; les réunir ferait apparaître des fonds dans le mauvais portefeuille.

**How to apply:** Pour tout échange XOF ↔ crypto, débiter ou créditer le solde disponible et le portefeuille crypto correspondant; laisser le solde de dépôt inchangé.

Le petit bouton rond de la carte Portefeuille ouvre un parcours indépendant de conversion XOF ↔ crypto et crypto ↔ crypto. Il ne doit pas réutiliser le grand raccourci « Échanger » du tableau de bord; ce parcours général reste distinct.

**Why:** L’utilisateur a explicitement distingué ces deux actions après que le petit bouton a ouvert le même écran que le grand raccourci.

**How to apply:** Garder des routes et des gestionnaires séparés pour le petit bouton du portefeuille et le grand raccourci général.

Le sélecteur de devise du portefeuille doit afficher XAF, les actifs crypto du catalogue Biz-transPay et les actifs configurés pour l’échange, même si leur solde est nul.

**Why:** L’utilisateur a demandé à voir les devises disponibles sans devoir attendre un premier dépôt ou un premier crédit.

**How to apply:** Construire la liste depuis les catalogues/configurations serveur et fusionner les soldes réels, sans créer de codes crypto qui ne viennent pas du catalogue.
