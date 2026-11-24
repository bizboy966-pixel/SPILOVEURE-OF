---
name: Validation admin des retraits
description: Comportement métier requis pour l’action « Valider » dans l’admin.
---

L’action admin « Valider » d’un retrait met à jour le statut local et son suivi comptable/notificatif de façon idempotente. Elle ne doit jamais soumettre ni renvoyer une demande de paiement au prestataire. Les soumissions financières ont lieu dans le flux initial de création du retrait, pas lors d’une validation manuelle.

**Why:** L’utilisateur veut pouvoir déplacer un retrait déjà payé ou envoyé hors de « En attente » sans relancer le transfert.

Pour un retrait automatique qui peut déjà être chez le prestataire, l’admin doit d’abord lancer « Vérifier ». Si la vérification distante ne donne pas de résultat final, seule une confirmation manuelle explicite et auditée après contrôle chez le prestataire déverrouille Valider/Rejeter. Rejeter rembourse localement; cela ne renvoie jamais le payout.

**Why:** L’utilisateur a demandé de débloquer les retraits déjà réglés ou à rejeter après vérification, sans risquer un double envoi ni permettre un remboursement tant que l’état du prestataire est inconnu.

**How to apply:** Garder l’interrogation distante en GET, journaliser la confirmation manuelle, et ne jamais traiter un résultat réseau incertain comme un refus certain. Les webhooks tardifs ne doivent pas écraser une validation manuelle.
