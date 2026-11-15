---
name: Contextes de dépendances
description: Pourquoi l’environnement de validation local et le build Hostinger doivent rester distincts.
---

Ne pas confondre le verrouillage du workspace de développement avec celui du frontend construit sur Hostinger, et ne pas remplacer automatiquement le second par le premier.

**Why:** La résolution fraîche des outils locaux a nécessité un runtime Node plus récent que celui du build Hostinger verrouillé. Une installation locale réussie ne prouve donc pas que les dépendances utilisées sur le VPS sont les mêmes.

**How to apply:** Vérifier les dépendances et capacités du conteneur cible avant de livrer une fonctionnalité dépendante du runtime, notamment les transports WebSocket. Conserver les validations dans une base locale isolée : le démarrage complet de la plateforme lance aussi des traitements métier existants.

L’utilisateur confirme mettre à jour le site sur le VPS Hostinger manuellement avec des commandes. Séparer explicitement l’envoi du code sur GitHub du déploiement sur le VPS.

**Why:** L’utilisateur veut préparer Android sans perturber son site en service et demande à être prévenu avant une action pouvant affecter Hostinger.

**How to apply:** Un push GitHub n’est pas une autorisation de déployer sur Hostinger. Ne pas exécuter les commandes de mise à jour du VPS sans demande explicite ; revérifier les déclenchements si une automatisation est ajoutée ultérieurement.

Pour les vérifications navigateur locales, préférer le Chromium déjà disponible dans le `PATH` au navigateur téléchargé automatiquement par Playwright.

**Why:** Le binaire Playwright en cache peut exister sans trouver ses bibliothèques natives sous NixOS, alors que le Chromium système est autonome et fonctionne. Cela évite des installations inutiles.

**How to apply:** Détecter `command -v chromium` et le passer comme `executablePath` aux vérifications locales, sans imposer ce chemin Nix au code applicatif ou au VPS.
