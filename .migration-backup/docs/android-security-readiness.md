# Vérifications de sécurité avant distribution Android

État de l'analyse du dépôt le 14 novembre 2026.
**Il ne s'agit pas d'une analyse d'un APK : aucun APK final n'a été produit.**

Les trois scanners ont terminé :

| Analyse | Résultat |
| --- | --- |
| Dépendances | 6 alertes critiques, 111 élevées, 111 modérées, 22 faibles, 2 informatives |
| Analyse statique | 1 critique, 5 élevées, 1 moyenne |
| Flux de données/confidentialité | 1 faible |

Ces chiffres comptent les alertes brutes. Ils peuvent inclure des doublons
d'avis et ne constituent pas une preuve d'exploitation dans cette application.
Leur applicabilité doit être examinée avant diffusion.

## Priorités

1. `backend/requirements.txt` : le scanner signale notamment
   `emergentintegrations==0.1.2` (alerte de paquet malveillant), `pyjwt`,
   `python-jose` et `black`. Examiner les sources et usages réels avant une mise
   à niveau ou un remplacement. `emergentintegrations` est utilisé par la
   vérification de tâches existante : le supprimer sans adaptation casserait
   cette fonctionnalité.
2. L'analyse statique signale un secret potentiel dans un ancien document de
   diagnostic du dépôt (`deployer-agent-docs/`). Ne pas recopier sa valeur.
   Vérifier sa validité, révoquer/renouveler via le fournisseur si nécessaire,
   puis nettoyer les éléments exposés et l'historique selon le besoin.
3. Examiner les alertes de chemins de fichiers dans `activation_videos.py`,
   `digital_content.py`, `messenger_files.py`, ainsi que les alertes SSRF dans
   `object_storage.py`. Les alertes automatiques ne remplacent pas l'examen
   des contrôles existants.
4. L'alerte Firebase du service worker concerne une clé de configuration Web
   potentiellement publique par conception ; vérifier les restrictions et
   autorisations au lieu de conclure automatiquement à un secret compromis.
5. Éviter de journaliser l'adresse e-mail de l'administrateur au démarrage.

## Décision de publication

Aucune diffusion Android officielle ne doit être autorisée sur la seule base
d'un export de bundle. Les alertes bloquantes doivent être traitées, les parcours
natifs terminés, le véritable APK signé vérifié et testé sur plusieurs appareils
physiques, puis ce même fichier doit faire l'objet d'une analyse dédiée.

Les dépendances et fonctionnalités métier n'ont pas été remplacées dans cet
ajout afin de préserver l'existant. Les mises à jour de dépendances
d'authentification et les changements de fournisseur nécessitent leurs propres
tests de non-régression.
