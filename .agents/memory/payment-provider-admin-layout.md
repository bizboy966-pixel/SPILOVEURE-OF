---
name: Rattachement des catalogues prestataires
description: Règle de portée pour la présentation des clés API et des catalogues pays/opérateurs dans l’admin.
---

Dans l’admin, la configuration API MoneyFusion doit rester visiblement associée
au catalogue pays/opérateurs MoneyFusion, et la configuration Biz-transPay à
son propre catalogue. Garder les cartes et les commandes disponibles comme
avant ; seul leur regroupement visuel par prestataire peut changer.

**Why:** L’utilisateur a répété qu’il demande uniquement le rattachement des
configurations aux bons catalogues, sans changer le fonctionnement ni la
visibilité des prestataires dans l’admin.

**How to apply:** Lors d’une modification de l’onglet Prestataires, préserver
les routes API, les interrupteurs, l’ordre de visibilité et l’ouverture
existante des cartes. Ne pas modifier le routage ni l’activation des paiements.
