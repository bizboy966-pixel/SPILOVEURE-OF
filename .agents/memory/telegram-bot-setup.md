---
name: Configuration du bot Telegram
description: Parcours SPILOVEURE pour connecter un bot Telegram avec un token et un ID de chat.
---

Le token du bot se saisit uniquement dans le champ sécurisé de l’admin. Une fois le webhook connecté, `/start` doit répondre avec l’ID numérique de la conversation. L’administrateur enregistre cet ID dans l’admin ; l’application vérifie que le bot peut écrire dans ce chat, y envoie une confirmation et l’utilise comme cible prioritaire des notifications.

Les notifications de modération doivent annoncer leur catégorie en français : « Marketplace », « Publicité » ou « Tâche spéciale ».

**Why:** l’utilisateur ne possède que le token et veut pouvoir obtenir lui-même l’ID du chat avant de terminer la configuration dans l’admin.

**How to apply:** ne jamais demander le token dans le chat. Conserver le groupe Telegram lié en solution de repli si aucun chat cible n’est enregistré.
