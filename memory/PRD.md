# SPILIVERE — PRD

## Problem Statement (original)
Importer le code depuis ce repo GitHub : https://github.com/bizboy966-pixel/Spiloveure
App Expo Router (Web) + backend FastAPI + MongoDB. Déploiement web sur `spiloveure.com`.
Plateforme MLM matrice binaire 12 niveaux, paiements mobile money (AshTechPay), commissions immédiates à l'activation.

## Architecture
- Frontend: Expo Router (SDK 54) — TypeScript + React Native Web, Metro bundler, port 3000.
- Backend: FastAPI + Motor (MongoDB async) port 8001, préfixe `/api`.
- DB: MongoDB locale (`MONGO_URL`, `DB_NAME=spilivere`).
- Reverse-proxy K8s : `/api/*` → backend:8001, le reste → frontend:3000.
- Preview : `https://spiloveure-deploy.preview.emergentagent.com`.

## Règles MLM critiques
- Matrice binaire forcée 12 niveaux. Niveau N a 2^N positions descendantes (N1=2, N2=4, … N12=4096).
- Activation Niveau N → commission payée **immédiatement** à l'ancêtre **exactement N hops au-dessus** via la chaîne de **parrainage** (sponsor_id).
- Si cet ancêtre n'a pas activé le niveau N → commission **ignorée** (non rétroactive).
- Spillover (parent matrice ≠ sponsor direct) → commission **split 50/50** entre ancêtre N-hops du sponsor et ancêtre N-hops du parent matrice.
- Chaque crédit est split entre `balance_profit` (retirable) et `balance_upgrade` (réserve pour activer le niveau suivant), ratio par niveau dans `levels.py`.

## Implementation Status (à jour 2026-06-06)
- ✅ Auth complet (register, login, change/confirm password, update profile)
- ✅ Matrice binaire 12 niveaux + auto-upgrade en cascade
- ✅ Activations manuelles (admin) + automatiques (AshTechPay)
- ✅ Wallet + retraits (création, fee_percent/fee_flat, min/max, validation admin)
- ✅ Tableau de bord (balance, total_profit, total_withdrawn, spillover_count, niveau courant)
- ✅ **Logique commission distribute_commission** (4/4 tests OK + 12/12 testing agent):
    - chaîne linéaire: ancêtre N hops via sponsor reçoit la commission
    - skip si ancêtre pas qualifié au niveau N
    - **SPILLOVER (nouvelles règles)**: split 50/50 entre parrain direct et bénéficiaire matrice
      * Parrain direct → 100% profit, 0 upgrade
      * Bénéficiaire spillover → 50/50 profit/upgrade JUSQU'À ce que la réserve niveau N+1 soit pleine, puis 100% profit
- ✅ **Paiement manuel restrict par pays** (NEW):
    - Admin Réglages: grille de 12 pays avec checkboxes (allowed_countries)
    - Lien de paiement modifiable
    - POST /api/activations/manual-request : enregistre activation pending + retourne payment_url pour redirection
    - Côté user: formulaire pays/opérateur/numéro/montant verrouillé → bouton PAYER → redirection
    - Admin voit la demande dans Activations → En attente avec tous les champs
- ✅ Équipe directe (arbre binaire visuel gauche/droite, badges Spillover, profondeur 2/3/4)
- ✅ Détails d'équipe (onglets N1..N12 par profondeur matrice, capacité 2^k, barre de progression)
- ✅ Endpoint `GET /api/team/level?level=N` (Query ge=1 le=12 → 422)
- ✅ Historique transactions unifié
- ✅ Admin panel complet (users, activations/withdrawals tri pending/validated/rejected, settings, IP serveur)
- ✅ Logo Spiloveure intégré partout (login, register, dashboard, activation, icon, splash, favicon)
- ✅ Fix race-condition auth (cache in-memory token avant écriture AsyncStorage)
- ✅ backend/.env unquoted + .gitignore corrigé pour deployment
- ✅ Indexes MongoDB

## API Key Endpoints
- `POST /api/auth/login|register|change-password|confirm-password`
- `GET /api/dashboard|team/direct|team/tree|team/level?level=N`
- `POST /api/activations/request` (L1 manuel admin, L2+ auto)
- `POST /api/payments/secure/initiate|webhook|verify/{ref}` (AshTechPay)
- `POST /api/withdrawals` + `GET /api/withdrawals/mine`
- Admin: `/api/admin/users|activations|withdrawals|settings/*|stats|logs`

## DB Schema clés
- `users`: id, email, username, role, status, max_level, sponsor_id, sponsor_username, balance_profit, balance_upgrade, commission_direct, commission_spillover, total_earned, total_withdrawn
- `matrix_placements`: user_id, parent_id (placement matrice), leg (left/right), sponsor_id, level, is_spillover (parent_id ≠ sponsor_id)
- `payments`: reference (SPV-...), transaction_id, status (pending/paid/failed), amount, currency, level, events[], activation_done
- `commissions`: user_id, from_user_id, level, kind (direct/spillover_sponsor/spillover_beneficiary), amount, upgrade_share, profit_share
- `app_settings`: _id ∈ {manual_payment, withdrawal_settings, support_links}

## Test credentials
Voir `/app/memory/test_credentials.md`. Admin: `kossikotokou4@gmail.com` / `@Emma91972006`.

## Roadmap / Backlog
- **P1** : Restaurer `admin.max_level=12` en prod (actuellement 2 — bloque tests commissions L3+ en environnement live).
- **P1** : Tests e2e complets sur staging (parrainage → registration → activation L1 → spillover → L2 → retrait).
- **P2** : Notifications (email/push) sur validations admin.
- **P2** : Déploiement public sur `*.emergent.host` + DNS `spiloveure.com`.
- **P2** : Webhooks AshTechPay validés en environnement de production réel.
- **P3** : Localisation EN + autres langues.

## Known caveats
- Metro tourne en `CI=1` mode (pas de watch). Un changement de code peut nécessiter `supervisorctl restart frontend` pour purger le cache de bundle SSR.
- AsyncStorage web v2 stocke dans `localStorage` (clé `auth_token`, valeur JSON.stringified).
- React Native `Alert.alert` ne fonctionne pas sur Expo Web — utiliser `window.confirm`/`window.alert` côté web.
