---
name: Secrets hors du code
description: Règle du projet pour les identifiants administrateur et les clés des prestataires.
---

Ne jamais coder en dur les identifiants d’administration, mots de passe ou clés réelles de prestataire dans le code, les tests ou les scripts. Utiliser les variables d’environnement et le gestionnaire de secrets. Les tests d’intégration qui nécessitent un compte réel doivent utiliser des variables de test dédiées et être ignorés si elles ne sont pas configurées.

**Why:** Des identifiants sensibles avaient été ajoutés aux tests, où ils risquaient d’être exposés dans le dépôt.

**How to apply:** Distinguer les faux secrets propres aux tests des vraies informations d’accès; ne jamais publier les valeurs, même dans un diff ou un journal. Après exposition d’une vraie valeur, la révoquer ou la changer; supprimer le texte d’un commit ultérieur ne l’efface pas de l’historique Git.
