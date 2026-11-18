# SPILOVEURE Web — adaptateur de démarrage

Cet artefact exécute le workflow historique `scripts/start-dev.sh` : Expo Web
et la passerelle HTTP/WebSocket vers le VPS. Il ne contient pas une nouvelle
interface Vite. Les fichiers `src/` issus du scaffold ne sont pas utilisés.

Le code partagé web/Android reste dans `frontend/` pour conserver les chemins
des builds Expo/EAS et des procédures VPS existantes. Le backend Python reste
dans `backend/` et n'est pas lancé par le preview en mode VPS.

Le port public vient de `PORT` (géré par Replit). Le port Metro interne est
19080 pour ne pas concurrencer les services Replit ou un futur prototype mobile.

Le futur prototype Capacitor devra avoir son propre dossier d'artefact, son
propre chemin de preview et son propre identifiant Android. Il n'est pas créé
pendant cette migration.
