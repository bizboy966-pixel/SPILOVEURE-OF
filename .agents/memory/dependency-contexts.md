---
name: Contextes de dépendances
description: Pourquoi l’environnement de validation local et le build Hostinger doivent rester distincts.
---

Ne pas confondre le verrouillage du workspace de développement avec celui du frontend construit sur Hostinger, et ne pas remplacer automatiquement le second par le premier.

**Why:** La résolution fraîche des outils locaux a nécessité un runtime Node plus récent que celui du build Hostinger verrouillé. Une installation locale réussie ne prouve donc pas que les dépendances utilisées sur le VPS sont les mêmes.

**How to apply:** Vérifier les dépendances et capacités du conteneur cible avant de livrer une fonctionnalité dépendante du runtime, notamment les transports WebSocket. Conserver les validations dans une base locale isolée : le démarrage complet de la plateforme lance aussi des traitements métier existants.
