---
name: Identifiants natifs de téléchargement
description: Conversion des identifiants DownloadManager entre JavaScript et Capacitor Android.
---

Les valeurs numériques envoyées depuis JavaScript peuvent arriver à Android sous la forme `Integer` pour les petits nombres, et pas seulement `Long`. Dans ce projet, `PluginCall.getLong` n’accepte pas l’`Integer` et renvoie alors sa valeur par défaut, ce qui fait échouer le suivi ou l’installation d’un APK en indiquant que l’identifiant de téléchargement est invalide. Valider et convertir explicitement les types numériques entiers avant d’utiliser un identifiant de téléchargement.

**Why:** Le type choisi lors du décodage JSON dépend de la valeur et ne correspond pas forcément au type Java demandé par `getLong`.

**How to apply:** Pour les arguments numériques de plugins Capacitor Android, inspecter la valeur brute et accepter les types numériques entiers pris en charge plutôt que de dépendre de `getLong`.
