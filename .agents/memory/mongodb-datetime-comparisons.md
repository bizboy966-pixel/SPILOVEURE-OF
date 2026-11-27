---
name: Dates MongoDB et fuseaux horaires
description: Comparaisons Python entre dates UTC et dates relues depuis MongoDB.
---

Les pilotes MongoDB peuvent restituer des dates UTC sans `tzinfo`, même quand l’application crée ses dates avec un fuseau UTC explicite. Normaliser les dates relues avant les comparaisons; ne pas supprimer le fuseau de l’horloge applicative.

**Why:** Une comparaison entre datetime naïve et datetime aware lève `TypeError` au lieu d’indiquer si un devis ou un délai a expiré.

**How to apply:** Pour toute date venant de MongoDB et comparée à l’heure courante, traiter une valeur naïve comme UTC, puis comparer des valeurs UTC aware.
