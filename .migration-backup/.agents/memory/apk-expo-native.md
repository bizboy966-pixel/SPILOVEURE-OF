---
name: APK Android avec Expo natif
description: Architecture demandée pour le binaire Android SPILOVEURE.
---

L’APK Android doit utiliser les écrans Expo natifs, pas une WebView. Le backend reste sur le VPS et les barres système Android restent visibles.

**Why:** L’utilisateur a remplacé explicitement son choix précédent de WebView par l’interface Expo native.

**How to apply:** Conserver le même identifiant de paquet et la même signature pour les mises à jour installées. Les changements de code natif doivent être inclus dans un nouvel APK. Déployer le frontend/backend web séparément ne modifie pas les écrans déjà intégrés au binaire.

Le parcours natif doit conserver la vérification des mises à jour APK, la progression du téléchargement, l’autorisation Android d’installation et l’installation par-dessus la version existante. Ne rendre une nouvelle version obligatoire qu’après compilation et publication de son fichier signé.

**Why:** Le site ne peut pas remplacer le code Expo embarqué dans les APK installés.

**How to apply:** Vérifier sur un téléphone Android l’installation propre, la mise à jour d’une version précédente et l’ouverture des écrans principaux avant toute diffusion.
