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
