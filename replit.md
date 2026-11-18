# SPILOVEURE

## Structure et démarrage

- `frontend/` : application Expo existante, partagée par le site et l'APK natif.
- `backend/` : backend Python existant, exécuté sur le VPS ; aucune conversion
  vers Express/PostgreSQL n'a été demandée.
- `artifacts/spiloveure-web/` : adaptateur Replit qui exécute le script historique
  `scripts/start-dev.sh` en mode VPS. Le workflow géré s'appelle
  `artifacts/spiloveure-web: web`.
- `artifacts/api-server/` et `lib/` : scaffold réservé, non utilisé par SPILOVEURE.
  Le service API du scaffold est désactivé pour ne pas intercepter `/api`.
- `.migration-backup/` : copie de sécurité créée avant la migration.

Installation locale : `pnpm install --frozen-lockfile`.
Régression ciblée : `pnpm run test:migration`.
Build web : `pnpm --filter frontend run build` (sortie `frontend/build/`).
Le démarrage web utilise le workflow Replit. La passerelle prend `PORT`, Metro
son port interne `SPV_METRO_PORT`. Les chemins API et WebSocket gardent leur URL.

## Contraintes à conserver

- Le site en production et la base restent sur le VPS. Ne jamais déployer,
  lancer des tâches métier, ni modifier sa base sans demande explicite.
- Le preview passe par la passerelle vers le VPS ; les tests automatiques
  utilisent des services simulés ou des GET publics uniquement.
- L'APK existant reste natif Expo, avec son identité et sa signature EAS.
  Garder les profils `test-apk` et `production-apk` dans `frontend/eas.json`.
- Les dépendances locales pnpm et le lockfile Yarn du frontend construit sur
  Hostinger sont deux contextes distincts. Ne pas régénérer ce dernier à partir
  d'une installation locale. Les deux lockfiles Yarn historiques sont conservés.
- EAS se lance depuis `frontend/`, dans le workspace pnpm (Node de production
  déjà fixé dans `eas.json`). Aucun build distant n'est lancé par la migration.
- Un futur prototype Capacitor doit être un autre artefact, avec un autre
  identifiant Android et un chemin de preview distinct. Ne pas remplacer Expo.
- Le script après fusion installe et teste uniquement ; aucune migration de
  base de données du scaffold n'est autorisée.

## Documentation

Voir `docs/multi-artifact-migration.md` pour l'inventaire et les limites de
validation, et les procédures VPS existantes dans `deploy/`.
