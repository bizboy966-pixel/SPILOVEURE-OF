---
name: Mot de passe admin au démarrage
description: Règle de conservation du mot de passe du compte administrateur amorcé par le VPS.
---

`ADMIN_PASSWORD` sert uniquement à créer le compte administrateur lorsqu’il n’existe pas encore. Les redémarrages suivants ne doivent pas écraser le hash modifié par l’administrateur depuis l’application.

**Why:** Le mot de passe de l’administrateur était réécrit depuis l’environnement à chaque démarrage, ce qui invalidait le mot de passe que le compte utilisait réellement.

**How to apply:** Garder les changements de rôle/état séparés de la gestion du mot de passe. Toute procédure de réinitialisation forcée doit être explicite et ne jamais s’exécuter automatiquement au démarrage.
