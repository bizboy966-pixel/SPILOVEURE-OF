---
name: Icône Android SPILOVEURE
description: Contraintes de cadrage de l’icône officielle Android.
---

L’icône de l’APK officielle doit reprendre l’image carrée fournie par
l’utilisateur comme fond adaptatif plein cadre, sans marges noires, fond uni,
flou ni logo extrait dans une grande couche de premier plan. Le nom
« SPILOVEURE » et les cinq pictogrammes doivent rester visibles après le masque
arrondi du lanceur Android.

**Why:** L’utilisateur a montré l’image carrée complète comme référence et a
signalé que le masque adaptatif faisait disparaître une partie du logo après
l’installation, malgré un aperçu carré correct.

**How to apply:** Utiliser l’image fournie en plein format comme fond et garder
le premier plan adaptatif transparent afin d’éviter un second recadrage du logo.
Vérifier le rendu après masque circulaire, pas seulement l’image carrée source,
puis reconstruire les ressources Capacitor.
