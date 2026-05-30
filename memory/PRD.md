# SPILIVERE — PRD

## Problem Statement (original)
Importer le code depuis ce repo GitHub : https://github.com/bizboy966-pixel/Spiloveure
C'est une app Expo Router avec backend FastAPI + MongoDB.
Je veux la déployer comme application Web accessible depuis un navigateur, et connecter le domaine spiloveure.com.

## Architecture
- Frontend: **Expo Router (SDK 54)** — TypeScript + React Native Web. Sortie web statique via Metro. Démarrée en mode `expo start --web --port 3000` (CI=1, no telemetry).
- Backend: **FastAPI + Motor (MongoDB async)** sur port 8001 avec préfixe `/api`.
- DB: MongoDB locale (`MONGO_URL=mongodb://localhost:27017`, `DB_NAME=spilivere`).
- Reverse-proxy Kubernetes : routes `/api/*` → backend:8001, le reste → frontend:3000.
- URL preview : `https://spiloveure-deploy.preview.emergentagent.com`.

## What was done (2026-01-30)
- Import complet du repo GitHub `bizboy966-pixel/Spiloveure` dans `/app`.
- Backend `/app/backend` : 8 modules (auth, levels, matrix, models, server, etc.), seed admin idempotent au démarrage.
- Frontend `/app/frontend` : Expo Router ré-écrit, configuration web Metro bundler.
- `.env` backend : ajout des secrets nécessaires (JWT_SECRET, ADMIN_*, JWT_ALGORITHM, expirations).
- `.env` frontend : `EXPO_PUBLIC_BACKEND_URL` pointant vers l'URL preview.
- Script `start` modifié : `CI=1 EXPO_NO_TELEMETRY=1 expo start --web --port 3000`.
- Dépendances installées (yarn + pip).
- Supervisor : backend + frontend RUNNING, app accessible sur l'URL preview.

## Validations end-to-end
- `GET /api/` → `{"app":"SPILIVERE","ok":true}` ✅
- `GET /api/config` → niveaux + pays + opérateurs renvoyés ✅
- `POST /api/auth/login` (admin@spiloveure.com) → JWT renvoyé ✅
- `GET /api/auth/me` (avec token) → role=admin, status=active ✅
- `GET /api/admin/stats` → stats vides initiales ✅
- `GET /api/dashboard` → balance_total=0 ✅
- Page `/` redirige vers `/login` (route Expo Router fonctionnelle) ✅
- Formulaire de connexion s'affiche correctement (UI vérifiée par screenshot) ✅

## Implementation Status — IMPLÉMENTÉ
- Auth complet : register, login, change-password, confirm-password, update-profile
- Système matrice binaire 12 niveaux (levels.py, matrix.py)
- Activations (demandes utilisateur + validation admin)
- Wallet + retraits (création, validation, refus)
- Tableau de bord utilisateur
- Équipe directe + détails matrice (BFS)
- Annonces + canaux communautaires
- Panel admin : utilisateurs, activations, retraits, annonces, channels, logs, timeseries

## Pending — déploiement public
- **P0** : Click sur "Deploy" depuis l'interface Emergent pour publier sur `*.emergent.host`.
- **P0** : Connecter `spiloveure.com` après déploiement (CNAME / DNS via le bouton Deploy → Custom Domain).
- **P1** : Tests utilisateurs (inscription, parrainage, activation niveau 1, retraits).
- **P2** : Intégration paiements (Mobile Money / carte / crypto) pour activations réelles — actuellement les activations niveau 1 sont en attente de validation manuelle admin.
- **P2** : Notifications (email / push) pour annonces, validations admin.

## Test Credentials (admin par défaut)
Voir `/app/memory/test_credentials.md`.

## Known caveats
- Le `react-native-secure-store` n'est pas dispo sur Web ; le storage utilise `index.web.ts` (AsyncStorage / IndexedDB). Cela est correctement géré par Metro qui pick le bon fichier selon la plateforme.
- L'app n'a pas été testée pour mobile natif (iOS/Android) dans ce passage — uniquement Web. Le code reste compatible pour un `expo build` mobile ultérieur.
