---
name: Validation admin des retraits
description: Comportement métier requis pour l’action « Valider » dans l’admin.
---

L’action admin « Valider » d’un retrait met à jour le statut local et son suivi comptable/notificatif de façon idempotente. Elle ne doit jamais soumettre ni renvoyer une demande de paiement au prestataire. Les soumissions financières ont lieu dans le flux initial de création du retrait, pas lors d’une validation manuelle.

**Why:** L’utilisateur veut pouvoir déplacer un retrait déjà payé ou envoyé hors de « En attente » sans relancer le transfert.

**How to apply:** Pour toute modification du panneau et des routes de validation de retrait, préserver ce comportement sans POST financier; les webhooks tardifs ne doivent pas écraser une validation manuelle.
