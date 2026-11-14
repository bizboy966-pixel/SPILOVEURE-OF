# Retrait d’un ancien prestataire de paiement

L’ancien prestataire a été retiré de l’administration, des pages
d’activation, du routeur de paiement, des retraits automatiques et des
notifications serveur. Son module API et ses tests d’intégration obsolètes
ont été supprimés.

Au démarrage, la synchronisation des prestataires nettoie uniquement
ses anciennes fiches, pays, opérateurs et identifiants enregistrés dans
les réglages. Elle est idempotente et ne réactive aucun autre prestataire.
Le routeur refuse aussi les anciennes fiches avant ce nettoyage.

Les utilisateurs, soldes, paiements, retraits, événements comptables
et journaux historiques ne sont pas supprimés ou renommés. Les totaux
et l’audit conservent les anciens paiements.

## Opérations déjà en cours

Les anciennes URLs d’initiation, de configuration et de webhook
n’existent plus. Aucun appel de suivi n’est envoyé à l’ancien prestataire.
Un paiement ou retrait déjà lancé peut néanmoins se terminer chez lui :
sa suppression du code n’annule pas une transaction externe.

Avant la mise à jour du VPS, vérifier les opérations non terminées dans
le tableau de bord du prestataire et sauvegarder la base de données.
Rapprocher les résultats confirmés manuellement ; ne pas rembourser ni
renvoyer un retrait tant que son résultat réel n’est pas établi.

Ces changements sont préparés dans ce projet. Ils ne mettent pas à jour
automatiquement Hostinger et ne modifient pas ses variables d’environnement.
