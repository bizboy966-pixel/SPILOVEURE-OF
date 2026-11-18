# SPILOVEURE Web — adaptateur de démarrage

Cet artefact exécute le workflow historique `scripts/start-dev.sh` : Expo Web
et la passerelle HTTP/WebSocket vers le VPS. Il ne contient pas une nouvelle
interface Vite. Les fichiers `src/` issus du scaffold ne sont pas utilisés.

Le code partagé web/Android reste dans `frontend/` pour conserver les chemins
des builds Expo/EAS et des procédures VPS existantes. Le backend Python reste
dans `backend/` et n'est pas lancé par le preview en mode VPS.

Le port public vient de `PORT` (géré par Replit). Le port Metro interne est
19080 et ne concurrence pas le projet Android Capacitor.

L'APK Android officielle est préparée dans `tools/capacitor-android`. Elle
embarque le front-end ; l'API et les données restent sur le VPS.
