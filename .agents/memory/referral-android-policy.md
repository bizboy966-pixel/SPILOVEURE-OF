---
name: Parrain par défaut et distribution Android
description: Règles métier approuvées pour le parrainage sans invitation et l’APK officiel.
---

Sans code parrain, attribuer automatiquement le parrain de l’administrateur
principal depuis la configuration officielle. Conserver prioritairement une
invitation valide et ne pas modifier une attribution déjà enregistrée. Un code
fourni mais invalide reste une erreur explicite, sans réattribution silencieuse.

**Why:** L’utilisateur demande de supprimer uniquement l’obligation d’un code dans
le lien, sans changer matrice, spillover, commissions ou validation. Il a accepté
le plan qui conserve une erreur pour les invitations invalides.

**How to apply:** Préremplir le parrain avant inscription, résoudre aussi le défaut
côté serveur et préserver les comptes existants. Ne pas choisir arbitrairement
le premier administrateur trouvé.

La distribution Android doit utiliser un véritable APK de production signé avec
une clé conservée pour les futures versions, depuis le domaine officiel. Ne
publier aucune application sans essais sur plusieurs véritables appareils Android,
vérification d’intégrité et de signature, et analyse de sécurité.

**Why:** L’utilisateur exige expressément de ne pas livrer un raccourci du site
ni un faux fichier APK et interdit la publication avant les essais physiques.

**How to apply:** Distinguer export du bundle, compilation APK, signature, tests
réels et publication. Garder le téléchargement indisponible tant que le fichier
validé n’existe pas. Ne jamais contourner Play Protect ni promettre l’absence
d’avertissement hors Play Store.

Avant la version officielle, l’utilisateur a choisi un APK de test isolé relié
à l’environnement Replit et aux comptes de test, sans mise à jour du VPS.

**Why:** L’utilisateur veut vérifier Android sans risque pour le site Hostinger
en service. Il a explicitement choisi cette étape plutôt qu’une mise à jour du
serveur officiel.

**How to apply:** Maintenir une identité d’application et des données de test
séparées, sans opérations financières réelles. Ne jamais présenter cette
version d’essai comme l’APK officiel validé ni l’installer à la place de celui-ci.

Les dépendances d'une compilation distante doivent être accessibles depuis
le réseau du fournisseur de compilation, pas seulement depuis Replit.

**Why:** La première compilation de test s’est arrêtée pendant l’installation
des paquets, avant toute étape de compilation Android.

**How to apply:** Vérifier les contraintes réseau du service de build et le
gestionnaire de paquets réellement utilisé avant de modifier un verrouillage.
Ne pas reporter une adaptation temporaire de registre sur le contexte VPS.
